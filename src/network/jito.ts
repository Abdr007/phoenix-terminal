/**
 * Jito block engine client — bundle send + tip floor inspection.
 *
 * For market makers and arb takers, sending via Jito instead of the public
 * mempool gives:
 *   - Guaranteed inclusion in a specific block if the tip clears the floor
 *   - Atomic execution of multi-tx bundles (cancel + place atomic-or-revert)
 *   - Resistance to congestion (your tx doesn't compete with retail spam)
 *
 * Endpoints (mainnet, public, no auth):
 *   POST {block-engine}/api/v1/bundles      sendBundle / getBundleStatuses
 *   GET  bundles.jito.wtf/api/v1/bundles/tip_floor  recent tip percentiles
 *
 * Bundle limits:
 *   - Up to 5 txs per bundle
 *   - Each tx < 1232 bytes (Solana standard)
 *   - At least one tx must transfer ≥1000 lamports to a Jito tip account
 *   - Atomic: all txs land in same block or the whole bundle is dropped
 */

import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { getLogger } from '../utils/logger.js';
import { safeEnvString, safeEnvNumber } from '../utils/safe-env.js';

// Stable mainnet Jito tip accounts (rotate randomly to avoid hotspots).
// Source: https://docs.jito.wtf/lowlatencytxnsend/#tip-amount
export const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pivKeVQ6vCBvYf3ELGdR',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

const DEFAULT_BLOCK_ENGINE = 'https://mainnet.block-engine.jito.wtf/api/v1/bundles';
const TIP_FLOOR_URL = 'https://bundles.jito.wtf/api/v1/bundles/tip_floor';
const REQUEST_TIMEOUT_MS = 6_000;

export function blockEngineUrl(): string {
  return safeEnvString('JITO_BLOCK_ENGINE_URL', DEFAULT_BLOCK_ENGINE);
}

export function defaultTipLamports(): number {
  return safeEnvNumber('JITO_DEFAULT_TIP_LAMPORTS', 10_000);
}

export function pickTipAccount(): PublicKey {
  const idx = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return new PublicKey(JITO_TIP_ACCOUNTS[idx]);
}

/** Build a SystemProgram tip transfer to a randomly chosen Jito tip account. */
export function tipInstruction(payer: PublicKey, lamports: number): TransactionInstruction {
  if (lamports < 1000) throw new Error('Jito tip must be ≥ 1000 lamports');
  return SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: pickTipAccount(),
    lamports,
  });
}

// ─── Tip floor inspection ───────────────────────────────────────────────────────

export interface TipFloor {
  time: string;
  /** All values are SOL (not lamports). Multiply by 1e9 to get lamports. */
  landed_tips_25th_percentile: number;
  landed_tips_50th_percentile: number;
  landed_tips_75th_percentile: number;
  landed_tips_95th_percentile: number;
  landed_tips_99th_percentile: number;
  ema_landed_tips_50th_percentile: number;
}

let tipFloorCache: { data: TipFloor; ts: number } | null = null;
const TIP_FLOOR_TTL_MS = 15_000;

export async function fetchTipFloor(): Promise<TipFloor | null> {
  if (tipFloorCache && Date.now() - tipFloorCache.ts < TIP_FLOOR_TTL_MS) {
    return tipFloorCache.data;
  }
  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(TIP_FLOOR_URL, { signal: ctrl.signal });
    clearTimeout(to);
    if (!res.ok) return null;
    const json = (await res.json()) as TipFloor[];
    const data = json[0];
    if (!data) return null;
    tipFloorCache = { data, ts: Date.now() };
    return data;
  } catch (e) {
    getLogger().debug('jito', `tip floor fetch failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Recommended tip in lamports. If a percentile is given, use that floor; otherwise
 * fall back to JITO_DEFAULT_TIP_LAMPORTS (or 10_000).
 */
export async function recommendTipLamports(percentile: 25 | 50 | 75 | 95 | 99 = 50): Promise<number> {
  const floor = await fetchTipFloor();
  if (!floor) return defaultTipLamports();
  const key = `landed_tips_${percentile}th_percentile` as keyof TipFloor;
  const sol = floor[key] as number;
  if (typeof sol !== 'number' || !Number.isFinite(sol) || sol <= 0) return defaultTipLamports();
  return Math.max(1000, Math.ceil(sol * 1e9));
}

// ─── Bundle send + status ───────────────────────────────────────────────────────

export interface JitoSendResult {
  bundleId: string;
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(blockEngineUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(to);
  }
  if (!res.ok) {
    // Surface server body for diagnostics (esp. on 429 / 5xx)
    const body = await res.text().catch(() => '');
    const snippet = body.slice(0, 160);
    throw new Error(`Jito ${method}: HTTP ${res.status}${snippet ? ` — ${snippet}` : ''}`);
  }
  const json = (await res.json()) as JsonRpcResponse<T>;
  if (json.error) throw new Error(`Jito ${method}: ${json.error.message}`);
  if (json.result === undefined) throw new Error(`Jito ${method}: response missing 'result' and 'error'`);
  return json.result;
}

/**
 * Send a bundle of up to 5 fully-signed transactions to the Jito block engine.
 * At least one of the txs MUST contain a tip transfer to a Jito tip account.
 * Returns the bundle id; use `getBundleStatuses` to poll for landing.
 */
export async function sendBundle(txs: Array<VersionedTransaction | Transaction>): Promise<JitoSendResult> {
  if (txs.length === 0) throw new Error('sendBundle: empty bundle');
  if (txs.length > 5) throw new Error('sendBundle: max 5 txs per bundle');
  const encoded = txs.map((tx) => bs58.encode(tx.serialize()));
  const bundleId = await rpc<string>('sendBundle', [encoded]);
  getLogger().debug('jito', `sent bundle ${bundleId} (${txs.length} tx)`);
  return { bundleId };
}

export interface BundleStatus {
  bundle_id: string;
  transactions: string[];
  slot: number;
  confirmation_status: 'processed' | 'confirmed' | 'finalized' | null;
  err: unknown;
}

export async function getBundleStatuses(bundleIds: string[]): Promise<BundleStatus[]> {
  if (bundleIds.length === 0) return [];
  if (bundleIds.length > 5) throw new Error('getBundleStatuses: max 5 ids per call');
  const result = await rpc<{ value: BundleStatus[] | null }>('getBundleStatuses', [bundleIds]);
  return result?.value ?? [];
}

/**
 * Wait for a bundle to land. Returns the first signature once confirmed,
 * or throws after timeoutMs.
 */
export async function awaitBundleLanded(bundleId: string, timeoutMs = 30_000): Promise<{ signature: string; slot: number } | null> {
  const start = Date.now();
  // Adaptive poll: tight (400ms) at first when the bundle is most likely to land,
  // backs off to 1s after 5s have elapsed.
  let consecutive429 = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const statuses = await getBundleStatuses([bundleId]);
      consecutive429 = 0;
      const s = statuses.find((x) => x.bundle_id === bundleId);
      if (s && (s.confirmation_status === 'confirmed' || s.confirmation_status === 'finalized')) {
        return { signature: s.transactions[0] ?? '', slot: s.slot };
      }
      if (s?.err) {
        throw new Error(`bundle ${bundleId} failed: ${JSON.stringify(s.err)}`);
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('429')) consecutive429++;
      getLogger().debug('jito', `poll error: ${msg}`);
    }
    // Back off on 429 to respect Jito's rate limit; otherwise tight poll early, slower later.
    const elapsed = Date.now() - start;
    const delay = consecutive429 > 0 ? Math.min(2000 * consecutive429, 5000) : elapsed < 5000 ? 400 : 1000;
    await new Promise((r) => setTimeout(r, delay));
  }
  return null;
}

/**
 * One-shot: takes an array of unsigned ix lists, signs each, appends a tip
 * to the LAST tx, sends via sendBundle, awaits landing. Returns the signature
 * of the first tx (Phoenix order signature) or throws.
 */
export async function sendBundleSimple(
  signer: Keypair,
  txIxs: TransactionInstruction[][],
  recentBlockhash: string,
  tipLamports: number,
): Promise<{ signature: string; bundleId: string; slot: number }> {
  if (txIxs.length === 0) throw new Error('sendBundleSimple: no instructions');

  // CLONE so we don't mutate the caller's array (defensive — fix from audit)
  const clonedIxs = txIxs.map((arr) => [...arr]);
  const lastIdx = clonedIxs.length - 1;
  clonedIxs[lastIdx].push(tipInstruction(signer.publicKey, tipLamports));

  const txs: Transaction[] = clonedIxs.map((ixs) => {
    const tx = new Transaction({ recentBlockhash, feePayer: signer.publicKey });
    tx.add(...ixs);
    tx.sign(signer);
    return tx;
  });

  // Explicitly check signature presence rather than non-null asserting
  const firstSig = txs[0].signature;
  if (!firstSig) throw new Error('sendBundleSimple: tx[0] failed to sign');

  const { bundleId } = await sendBundle(txs);
  const landed = await awaitBundleLanded(bundleId);
  if (!landed) throw new Error(`bundle ${bundleId} did not land within timeout`);
  return { signature: bs58.encode(firstSig), bundleId, slot: landed.slot };
}
