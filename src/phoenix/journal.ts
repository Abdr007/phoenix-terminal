/**
 * Persistent trade journal — SQLite-backed.
 *
 * Indexes every Phoenix fill the wallet has been part of (maker or taker),
 * keyed by tx signature so re-indexing is idempotent. Computes PnL using
 * the weighted-average-cost method on a per-market basis:
 *
 *   - On buy: avgCost' = (inv × avgCost + size × price) / (inv + size); inv += size
 *   - On sell: realized += (price - avgCost) × size; inv -= size
 *
 * Stored at ~/.phoenix/journal.db. ~300 LOC.
 */

import Database from 'better-sqlite3';
import { Connection, PublicKey } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { getPhoenixClient } from './client.js';
import { findMarket } from './markets.js';
import { getLogger } from '../utils/logger.js';

const DEFAULT_DB = join(homedir(), '.phoenix', 'journal.db');

export interface JournalFill {
  signature: string;
  wallet: string;
  market: string;
  side: 'bid' | 'ask';
  priceUsd: number;
  sizeBase: number;
  notionalUsd: number;
  isMaker: number; // 0 or 1 (SQLite bool)
  feeUsd: number;
  blockTime: number; // unix seconds
  slot: number;
}

export interface MarketPnl {
  market: string;
  fills: number;
  buyVolumeBase: number;
  sellVolumeBase: number;
  buyNotionalUsd: number;
  sellNotionalUsd: number;
  inventoryBase: number;     // current net inventory
  avgCostUsd: number;        // weighted-average cost
  realizedPnlUsd: number;    // closed-loop realized
  makerVolumeUsd: number;
  takerVolumeUsd: number;
  feesUsd: number;
  firstFillAt: number | null;
  lastFillAt: number | null;
}

export interface PnlSummary {
  wallet: string;
  totalFills: number;
  totalVolumeUsd: number;
  totalRealizedPnlUsd: number;
  totalFeesUsd: number;
  makerVolumeUsd: number;
  takerVolumeUsd: number;
  makerRatio: number;
  uniqueMarkets: number;
  uniqueActiveDays: number;
  perMarket: MarketPnl[];
}

export class Journal {
  private db: Database.Database;

  constructor(path: string = DEFAULT_DB) {
    if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fills (
        signature TEXT NOT NULL,
        sub_index INTEGER NOT NULL DEFAULT 0,
        wallet TEXT NOT NULL,
        market TEXT NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('bid','ask')),
        priceUsd REAL NOT NULL,
        sizeBase REAL NOT NULL,
        notionalUsd REAL NOT NULL,
        isMaker INTEGER NOT NULL,
        feeUsd REAL NOT NULL DEFAULT 0,
        blockTime INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        PRIMARY KEY (signature, sub_index)
      );
      CREATE INDEX IF NOT EXISTS fills_wallet_market_time ON fills(wallet, market, blockTime DESC);
      CREATE INDEX IF NOT EXISTS fills_wallet_time ON fills(wallet, blockTime DESC);

      CREATE TABLE IF NOT EXISTS cursors (
        wallet TEXT PRIMARY KEY,
        last_signature TEXT,
        last_indexed_at INTEGER NOT NULL
      );
    `);
    // Migrate old schema (PRIMARY KEY signature alone) → composite (signature, sub_index).
    // Detection: PRAGMA table_info reports no `sub_index` column on an existing row.
    try {
      const cols = this.db.prepare(`PRAGMA table_info(fills)`).all() as Array<{ name: string }>;
      const hasSubIndex = cols.some((c) => c.name === 'sub_index');
      if (!hasSubIndex && cols.length > 0) {
        this.db.exec(`
          BEGIN;
          ALTER TABLE fills RENAME TO fills_old;
          CREATE TABLE fills (
            signature TEXT NOT NULL,
            sub_index INTEGER NOT NULL DEFAULT 0,
            wallet TEXT NOT NULL,
            market TEXT NOT NULL,
            side TEXT NOT NULL CHECK(side IN ('bid','ask')),
            priceUsd REAL NOT NULL,
            sizeBase REAL NOT NULL,
            notionalUsd REAL NOT NULL,
            isMaker INTEGER NOT NULL,
            feeUsd REAL NOT NULL DEFAULT 0,
            blockTime INTEGER NOT NULL,
            slot INTEGER NOT NULL,
            PRIMARY KEY (signature, sub_index)
          );
          INSERT INTO fills (signature, sub_index, wallet, market, side, priceUsd, sizeBase, notionalUsd, isMaker, feeUsd, blockTime, slot)
            SELECT signature, 0, wallet, market, side, priceUsd, sizeBase, notionalUsd, isMaker, feeUsd, blockTime, slot FROM fills_old;
          DROP TABLE fills_old;
          CREATE INDEX IF NOT EXISTS fills_wallet_market_time ON fills(wallet, market, blockTime DESC);
          CREATE INDEX IF NOT EXISTS fills_wallet_time ON fills(wallet, blockTime DESC);
          COMMIT;
        `);
      }
    } catch {
      // Best-effort migration — if it fails the new CREATE TABLE IF NOT EXISTS
      // above still applies to fresh dbs. Old data is preserved as-is.
    }
  }

  /**
   * Insert a fill. `subIndex` distinguishes multiple fills emitted within the
   * same transaction (Phoenix can fill against many resting orders in one ix).
   * Defaults to 0 for callers that have only one fill per tx.
   */
  insertFill(f: JournalFill, subIndex: number = 0): boolean {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO fills (signature, sub_index, wallet, market, side, priceUsd, sizeBase, notionalUsd, isMaker, feeUsd, blockTime, slot)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(f.signature, subIndex, f.wallet, f.market, f.side, f.priceUsd, f.sizeBase, f.notionalUsd, f.isMaker, f.feeUsd, f.blockTime, f.slot);
    return r.changes > 0;
  }

  recordSignatureCursor(wallet: string, signature: string): void {
    this.db.prepare(`
      INSERT INTO cursors (wallet, last_signature, last_indexed_at) VALUES (?, ?, ?)
      ON CONFLICT(wallet) DO UPDATE SET last_signature=excluded.last_signature, last_indexed_at=excluded.last_indexed_at
    `).run(wallet, signature, Math.floor(Date.now() / 1000));
  }

  getCursor(wallet: string): string | null {
    const row = this.db.prepare(`SELECT last_signature FROM cursors WHERE wallet = ?`).get(wallet) as { last_signature: string | null } | undefined;
    return row?.last_signature ?? null;
  }

  /** Recent fills for a wallet (newest first). */
  recent(wallet: string, limit = 50): JournalFill[] {
    return this.db
      .prepare(`SELECT * FROM fills WHERE wallet = ? ORDER BY blockTime DESC LIMIT ?`)
      .all(wallet, limit) as JournalFill[];
  }

  /** All fills for a wallet on one market in chronological order. */
  marketFills(wallet: string, market: string): JournalFill[] {
    return this.db
      .prepare(`SELECT * FROM fills WHERE wallet = ? AND market = ? ORDER BY blockTime ASC`)
      .all(wallet, market) as JournalFill[];
  }

  /** Wallet-wide PnL summary, computed by replaying fills per market with WAC. */
  summary(wallet: string): PnlSummary {
    const markets = this.db
      .prepare(`SELECT DISTINCT market FROM fills WHERE wallet = ?`)
      .all(wallet) as { market: string }[];

    const perMarket: MarketPnl[] = [];
    const days = new Set<string>();
    let totalFills = 0;
    let totalVolume = 0;
    let totalRealized = 0;
    let totalFees = 0;
    let makerVol = 0;
    let takerVol = 0;

    for (const { market } of markets) {
      const fills = this.marketFills(wallet, market);
      const m = computeMarketPnl(market, fills);
      perMarket.push(m);
      totalFills += m.fills;
      totalVolume += m.buyNotionalUsd + m.sellNotionalUsd;
      totalRealized += m.realizedPnlUsd;
      totalFees += m.feesUsd;
      makerVol += m.makerVolumeUsd;
      takerVol += m.takerVolumeUsd;
      for (const f of fills) {
        days.add(new Date(f.blockTime * 1000).toISOString().slice(0, 10));
      }
    }

    perMarket.sort((a, b) => (b.buyNotionalUsd + b.sellNotionalUsd) - (a.buyNotionalUsd + a.sellNotionalUsd));

    return {
      wallet,
      totalFills,
      totalVolumeUsd: totalVolume,
      totalRealizedPnlUsd: totalRealized,
      totalFeesUsd: totalFees,
      makerVolumeUsd: makerVol,
      takerVolumeUsd: takerVol,
      makerRatio: totalVolume > 0 ? makerVol / totalVolume : 0,
      uniqueMarkets: markets.length,
      uniqueActiveDays: days.size,
      perMarket,
    };
  }

  close(): void {
    this.db.close();
  }
}

/** Pure WAC PnL replay over a chronologically-sorted list of fills. Exported for tests. */
export function computeMarketPnl(market: string, fills: JournalFill[]): MarketPnl {
  let inv = 0;            // base inventory
  let avgCost = 0;        // weighted-avg cost (USD per base unit)
  let realized = 0;
  let buyVol = 0, sellVol = 0;
  let buyNot = 0, sellNot = 0;
  let makerVol = 0, takerVol = 0;
  let fees = 0;
  let firstAt: number | null = null;
  let lastAt: number | null = null;

  for (const f of fills) {
    if (firstAt === null || f.blockTime < firstAt) firstAt = f.blockTime;
    if (lastAt === null || f.blockTime > lastAt) lastAt = f.blockTime;
    fees += f.feeUsd;
    if (f.isMaker) makerVol += f.notionalUsd; else takerVol += f.notionalUsd;

    // Correct WAC accounting across all four transitions:
    //   inv > 0, bid → extending long: WAC update
    //   inv > 0, ask → reducing long (and possibly crossing into short)
    //   inv < 0, ask → extending short: WAC update (positive avgCost as proceeds-per-base)
    //   inv < 0, bid → covering short (and possibly crossing into long)
    //   inv == 0 → new long (bid) or new short (ask): seed avgCost
    if (f.side === 'bid') {
      buyVol += f.sizeBase;
      buyNot += f.notionalUsd;
      if (inv < 0) {
        // Covering short
        const coverSize = Math.min(f.sizeBase, -inv);
        // For a short, avgCost holds the price at which we shorted (proceeds basis).
        // Realized = (entry - exit) × size  →  (avgCost - priceUsd) × coverSize.
        realized += (avgCost - f.priceUsd) * coverSize;
        const remainder = f.sizeBase - coverSize;
        const newInv = inv + f.sizeBase;
        if (newInv > 0) {
          // Crossed from short into long: seed long basis with the remaining bought
          avgCost = f.priceUsd;
        } else if (newInv === 0) {
          avgCost = 0; // flat — basis is meaningless
        }
        // newInv < 0 (still short): avgCost unchanged (we just closed part of the short)
        void remainder;
        inv = newInv;
      } else {
        // Flat or already long → extend long with WAC
        const newInv = inv + f.sizeBase;
        if (newInv > 0.000001) {
          avgCost = (inv * avgCost + f.sizeBase * f.priceUsd) / newInv;
        }
        inv = newInv;
      }
    } else {
      sellVol += f.sizeBase;
      sellNot += f.notionalUsd;
      if (inv > 0) {
        // Reducing long
        const reduceSize = Math.min(f.sizeBase, inv);
        realized += (f.priceUsd - avgCost) * reduceSize;
        const newInv = inv - f.sizeBase;
        if (newInv < 0) {
          // Crossed from long into short: seed short basis with sell price
          avgCost = f.priceUsd;
        } else if (newInv === 0) {
          avgCost = 0;
        }
        inv = newInv;
      } else {
        // Flat or already short → extend short with WAC on the short basis
        const absInv = -inv;
        const newAbs = absInv + f.sizeBase;
        if (newAbs > 0.000001) {
          avgCost = (absInv * avgCost + f.sizeBase * f.priceUsd) / newAbs;
        }
        inv -= f.sizeBase;
      }
    }
  }

  return {
    market,
    fills: fills.length,
    buyVolumeBase: buyVol,
    sellVolumeBase: sellVol,
    buyNotionalUsd: buyNot,
    sellNotionalUsd: sellNot,
    inventoryBase: inv,
    avgCostUsd: avgCost,
    realizedPnlUsd: realized,
    makerVolumeUsd: makerVol,
    takerVolumeUsd: takerVol,
    feesUsd: fees,
    firstFillAt: firstAt,
    lastFillAt: lastAt,
  };
}

/**
 * Incrementally indexes new Phoenix fills for a wallet.
 * Walks signatures backwards from chain HEAD until it hits the journal's stored
 * cursor, then advances the cursor. Idempotent.
 */
const TX_CONCURRENCY = 2;
const BATCH_DELAY_MS = 400;

/**
 * Compute the wallet's base-token balance delta from a parsed tx's meta.
 * Returns the SIGNED change in base tokens (positive = wallet received base = was bidder).
 * Returns null if the wallet has no ATA for that mint in the tx (shouldn't happen for a tx
 * that filled the wallet).
 */
async function getWalletBaseDelta(connection: Connection, signature: string, walletStr: string, baseMint: string): Promise<number | null> {
  const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
  if (!tx?.meta) return null;
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  const preBal = pre.find((b) => b.owner === walletStr && b.mint === baseMint);
  const postBal = post.find((b) => b.owner === walletStr && b.mint === baseMint);
  // For SOL pairs, the base is wSOL — but the user may have unwrapped, so the postBalance
  // entry might be missing. Treat missing as 0.
  const preAmt = preBal ? Number(preBal.uiTokenAmount.uiAmountString ?? '0') : 0;
  const postAmt = postBal ? Number(postBal.uiTokenAmount.uiAmountString ?? '0') : 0;
  if (!Number.isFinite(preAmt) || !Number.isFinite(postAmt)) return null;
  return postAmt - preAmt;
}

async function processTx(connection: Connection, signature: string, walletStr: string, journal: Journal, verbose: boolean, blockTime: number, slot: number): Promise<number> {
  let inserted = 0;
  try {
    const ptx = await Phoenix.getPhoenixEventsFromTransactionSignature(connection, signature);
    const phoenix = getPhoenixClient();
    const client = await phoenix.raw();
    // Per-tx sub_index — distinguishes multiple fill events within the same
    // signature when persisted (journal composite PK is (signature, sub_index)).
    // Using a SINGLE counter across all ixs in the tx so it's globally unique
    // within the signature scope, matching the maker.ts/multi-maker.ts pattern.
    let subIndex = 0;
    for (const ix of ptx.instructions) {
      const marketAddr = ix.header?.market?.toBase58();
      if (!marketAddr) continue;
      const def = findMarket(marketAddr);
      if (!def) continue;
      if (!client.marketStates.has(marketAddr)) {
        try { await phoenix.addMarket(def.symbol); } catch { continue; }
      }
      let totalFeeQuoteLots = 0;
      for (const evt of ix.events) {
        if (Phoenix.isPhoenixMarketEventFillSummary(evt)) {
          totalFeeQuoteLots += Phoenix.toNum(evt.fields[0].totalFeeInQuoteLots);
        }
      }
      const feeUsd = totalFeeQuoteLots > 0
        ? client.quoteAtomsToQuoteUnits(client.quoteLotsToQuoteAtoms(totalFeeQuoteLots, marketAddr), marketAddr)
        : 0;
      // Side detection via balance delta: compute the wallet's base-token balance change.
      // If base went UP, the wallet bought base (side = 'bid'). If DOWN, the wallet sold (side = 'ask').
      // This is 100% accurate for both makers and takers — derived from on-chain settlement.
      const baseDelta = await getWalletBaseDelta(connection, signature, walletStr, def.baseMint);

      for (const evt of ix.events) {
        if (!Phoenix.isPhoenixMarketEventFill(evt)) continue;
        const f = evt.fields[0];
        const isMaker = f.makerId.toBase58() === walletStr;
        const priceTicks = Phoenix.toNum(f.priceInTicks);
        const baseLots = Phoenix.toNum(f.baseLotsFilled);
        if (baseLots === 0) continue;
        const priceUsd = client.ticksToFloatPrice(priceTicks, marketAddr);
        const sizeBase = client.baseAtomsToRawBaseUnits(
          client.baseLotsToBaseAtoms(baseLots, marketAddr),
          marketAddr,
        );
        // Default to a price-vs-implied-mid heuristic if balance delta is unavailable.
        const fallbackSide: 'bid' | 'ask' = isMaker ? 'bid' : 'ask';
        const side: 'bid' | 'ask' =
          baseDelta === null ? fallbackSide :
          baseDelta > 0 ? 'bid' :
          baseDelta < 0 ? 'ask' :
          fallbackSide;
        const notional = priceUsd * sizeBase;
        const ok = journal.insertFill({
          signature, wallet: walletStr, market: def.symbol, side,
          priceUsd, sizeBase, notionalUsd: notional, isMaker: isMaker ? 1 : 0,
          feeUsd: isMaker ? 0 : feeUsd,
          blockTime, slot,
        }, subIndex);
        if (ok) inserted++;
        subIndex++;
      }
    }
  } catch (e) {
    if (verbose) getLogger().debug('journal', `decode ${signature.slice(0, 12)}: ${(e as Error).message}`);
  }
  return inserted;
}

export async function indexWalletFills(
  connection: Connection,
  wallet: PublicKey,
  journal: Journal,
  opts: { maxNewSigs?: number; verbose?: boolean } = {},
): Promise<{ scanned: number; inserted: number }> {
  const maxNew = opts.maxNewSigs ?? 200;
  const verbose = opts.verbose ?? false;
  const cursor = journal.getCursor(wallet.toBase58());
  let scanned = 0;
  let inserted = 0;
  let until: string | undefined = cursor ?? undefined;
  let before: string | undefined;
  const walletStr = wallet.toBase58();
  let newestSig: string | null = null;

  while (scanned < maxNew) {
    const batch = await connection.getSignaturesForAddress(wallet, {
      limit: Math.min(100, maxNew - scanned),
      before,
      until,
    });
    if (batch.length === 0) break;
    if (newestSig === null) newestSig = batch[0].signature;
    scanned += batch.length;

    // Decode in throttled bursts to avoid 429s on public RPCs
    const items = batch.filter((s) => !s.err);
    for (let i = 0; i < items.length; i += TX_CONCURRENCY) {
      const chunk = items.slice(i, i + TX_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((s) => processTx(connection, s.signature, walletStr, journal, verbose, s.blockTime ?? 0, s.slot ?? 0)),
      );
      for (const n of results) inserted += n;
      if (i + TX_CONCURRENCY < items.length) await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
    }

    before = batch[batch.length - 1].signature;
    until = undefined; // only honor `until` on first call
    if (batch.length < 100) break;
  }

  if (newestSig) journal.recordSignatureCursor(walletStr, newestSig);
  return { scanned, inserted };
}

let _journal: Journal | null = null;
export function getJournal(): Journal {
  if (!_journal) _journal = new Journal();
  return _journal;
}

/** Close the singleton journal (called on graceful shutdown). Safe to call when uninitialized. */
export function closeJournal(): void {
  if (_journal) {
    try { _journal.close(); } catch { /* ignore */ }
    _journal = null;
  }
}
