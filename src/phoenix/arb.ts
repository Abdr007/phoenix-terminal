/**
 * Triangular arb scanner across Phoenix markets.
 *
 * For each triple (A→B, B→C, C→A) such that all three markets exist on Phoenix
 * and share consistent base/quote mints, compute round-trip return:
 *
 *   start with 1 unit of A
 *   trade A → B using A/B (or B/A) top-of-book
 *   trade B → C using B/C (or C/B) top-of-book
 *   trade C → A using C/A (or A/C) top-of-book
 *   profit_bps = (end / start - 1) * 10_000
 *
 * We DO NOT model fees here — taker fees are per-market and typically small
 * (~2-10 bps total round-trip). Caller decides their min profit threshold.
 *
 * NOTE: this scans on cached ladders. Caller should refresh markets before
 * calling cycle() for fresh quotes.
 */

import { Connection, Keypair } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getPhoenixClient } from './client.js';
import { MARKETS, MarketDef } from './markets.js';
import { placeIoc } from './orders.js';
import { quote } from './routing.js';
import { getLogger } from '../utils/logger.js';

export interface ArbCycle {
  legs: Array<{ marketSymbol: string; from: string; to: string; rate: number }>;
  startMint: string;
  endMint: string;
  profitBps: number;
}

/**
 * Find triangular cycles that exist in the loaded market set.
 * A cycle is three mints (a, b, c) where each pair has a Phoenix market.
 */
export function findTriangles(markets: MarketDef[]): Array<[string, string, string]> {
  const adj = new Map<string, Set<string>>();
  const addEdge = (x: string, y: string) => {
    if (!adj.has(x)) adj.set(x, new Set());
    adj.get(x)!.add(y);
  };
  for (const m of markets) {
    addEdge(m.baseMint, m.quoteMint);
    addEdge(m.quoteMint, m.baseMint);
  }

  const mints = Array.from(adj.keys());
  const triangles: Array<[string, string, string]> = [];
  const seen = new Set<string>();
  for (const a of mints) {
    const neighA = adj.get(a)!;
    for (const b of neighA) {
      const neighB = adj.get(b);
      if (!neighB) continue;
      for (const c of neighB) {
        if (c === a) continue;
        if (!neighA.has(c)) continue;
        const key = [a, b, c].sort().join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        triangles.push([a, b, c]);
      }
    }
  }
  return triangles;
}

/** Find the Phoenix market for an unordered mint pair. */
function findMarketForPair(mintA: string, mintB: string): MarketDef | undefined {
  return MARKETS.find(
    (m) =>
      (m.baseMint === mintA && m.quoteMint === mintB) ||
      (m.baseMint === mintB && m.quoteMint === mintA),
  );
}

/**
 * Convert top-of-book into a rate for "from → to".
 * If the market is base/quote and we want base → quote, the rate is best bid (we sell base).
 * If we want quote → base, the rate is 1 / best ask (we buy base).
 */
function topRate(state: Phoenix.MarketState, fromMint: string, market: MarketDef): number | null {
  const ladder = state.getUiLadder(1);
  const bestBid = ladder.bids[0]?.price ?? null;
  const bestAsk = ladder.asks[0]?.price ?? null;
  if (bestBid === null && bestAsk === null) return null;
  if (fromMint === market.baseMint) {
    // selling base for quote → use bid
    if (bestBid === null || bestBid <= 0) return null;
    return bestBid;
  } else if (fromMint === market.quoteMint) {
    // buying base with quote → use ask
    if (bestAsk === null || bestAsk <= 0) return null;
    return 1 / bestAsk;
  }
  return null;
}

export async function scanArb(): Promise<ArbCycle[]> {
  const phoenix = getPhoenixClient();
  const client = await phoenix.raw();
  // Only consider markets we've actually loaded
  const loaded = MARKETS.filter((m) => client.marketStates.has(m.address));
  const triangles = findTriangles(loaded);
  const cycles: ArbCycle[] = [];

  for (const tri of triangles) {
    // Permute starting mint
    for (const startIdx of [0, 1, 2]) {
      const ordering = [tri[startIdx], tri[(startIdx + 1) % 3], tri[(startIdx + 2) % 3]];
      const [a, b, c] = ordering;

      const mAB = findMarketForPair(a, b);
      const mBC = findMarketForPair(b, c);
      const mCA = findMarketForPair(c, a);
      if (!mAB || !mBC || !mCA) continue;

      const sAB = client.marketStates.get(mAB.address);
      const sBC = client.marketStates.get(mBC.address);
      const sCA = client.marketStates.get(mCA.address);
      if (!sAB || !sBC || !sCA) continue;

      const r1 = topRate(sAB, a, mAB);
      const r2 = topRate(sBC, b, mBC);
      const r3 = topRate(sCA, c, mCA);
      if (r1 === null || r2 === null || r3 === null) continue;

      const product = r1 * r2 * r3;
      const profitBps = (product - 1) * 10_000;
      cycles.push({
        legs: [
          { marketSymbol: mAB.symbol, from: a, to: b, rate: r1 },
          { marketSymbol: mBC.symbol, from: b, to: c, rate: r2 },
          { marketSymbol: mCA.symbol, from: c, to: a, rate: r3 },
        ],
        startMint: a,
        endMint: a,
        profitBps,
      });
    }
  }

  return cycles.sort((a, b) => b.profitBps - a.profitBps);
}

// ─── EXECUTION ───────────────────────────────────────────────────────────────

export interface ExecuteArbArgs {
  cycle: ArbCycle;
  /** Starting amount of the cycle.startMint (in raw token units — e.g. 0.05 SOL or 5 USDC). */
  startSize: number;
  /** Per-leg slippage tolerance in bps. Each leg's IOC rejects if predicted impact exceeds this. */
  maxSlippageBps: number;
  /** Dry-run: simulate via SDK router only, no signing. */
  dryRun: boolean;
}

export interface ExecuteArbLeg {
  marketSymbol: string;
  fromMint: string;
  toMint: string;
  side: 'bid' | 'ask';
  inAmount: number;        // amount of fromMint going in
  expectedOut: number;     // predicted (router) amount of toMint
  actualOut?: number;      // realized (only when not dryRun)
  signature?: string;
  status: 'planned' | 'executed' | 'skipped' | 'failed';
  error?: string;
}

export interface ExecuteArbResult {
  cycle: ArbCycle;
  legs: ExecuteArbLeg[];
  startSize: number;
  endSize: number;          // realized (or simulated) end amount of startMint
  realizedProfitBps: number;
  dryRun: boolean;
  aborted: boolean;
}

/**
 * Execute a triangular arb cycle. Each leg is a separate IOC tx — NOT atomic
 * across the cycle, so price moves between legs can convert profit into loss.
 *
 * Mitigations:
 *   - Per-leg slippage cap (maxSlippageBps) — leg refuses to send if predicted impact too high
 *   - Cycle aborts on first leg failure (subsequent legs not attempted)
 *   - dryRun mode for confidence checks
 */
export async function executeArbCycle(
  connection: Connection,
  signer: Keypair,
  args: ExecuteArbArgs,
): Promise<ExecuteArbResult> {
  const phoenix = getPhoenixClient();
  const legs: ExecuteArbLeg[] = [];
  let aborted = false;
  let currentAmount = args.startSize;
  let currentMint = args.cycle.startMint;

  for (let i = 0; i < args.cycle.legs.length; i++) {
    const leg = args.cycle.legs[i];
    const def = MARKETS.find((m) => m.symbol === leg.marketSymbol)!;
    // Determine IOC side: if our `from` mint is the market's base, we ASK (sell base for quote);
    // if `from` is the quote, we BID (buy base with quote).
    const side: 'bid' | 'ask' = leg.from === def.baseMint ? 'ask' : 'bid';

    // For IOC sizing on Phoenix: `sizeBase` always specifies base units.
    // - If we're asking (selling base), inAmount IS the base amount we're selling.
    // - If we're bidding (buying base), the SDK's router computes base out from quote in.
    //   We approximate sizeBase by dividing in-quote by best-ask price (refreshed below).
    await phoenix.refresh(def.address, true);
    const q = await quote(def.symbol, side, currentAmount);

    let sizeBase: number;
    if (side === 'ask') {
      sizeBase = currentAmount; // selling currentAmount base units
    } else {
      // Bidding: we have currentAmount quote, want base. Use router prediction.
      sizeBase = q.expectedOut;
      if (!Number.isFinite(sizeBase) || sizeBase <= 0) {
        legs.push({
          marketSymbol: def.symbol, fromMint: leg.from, toMint: leg.to, side,
          inAmount: currentAmount, expectedOut: 0, status: 'failed',
          error: `router could not predict output for ${currentAmount} on ${def.symbol}`,
        });
        aborted = true; break;
      }
    }

    const legRecord: ExecuteArbLeg = {
      marketSymbol: def.symbol,
      fromMint: leg.from, toMint: leg.to,
      side, inAmount: currentAmount,
      expectedOut: q.expectedOut,
      status: 'planned',
    };

    // Slippage check — refuse leg if predicted impact > threshold
    if (q.priceImpactBps > args.maxSlippageBps) {
      legRecord.status = 'failed';
      legRecord.error = `predicted impact ${q.priceImpactBps.toFixed(1)}bps > max ${args.maxSlippageBps}bps`;
      legs.push(legRecord);
      aborted = true;
      break;
    }

    if (args.dryRun) {
      // Roll forward as if filled at expectedOut
      legRecord.status = 'executed';
      legRecord.actualOut = q.expectedOut;
      legs.push(legRecord);
      currentAmount = q.expectedOut;
      currentMint = leg.to;
      continue;
    }

    // LIVE: fire the IOC
    try {
      const res = await placeIoc(connection, signer, {
        symbol: def.symbol, side, sizeBase,
        slippageBps: args.maxSlippageBps,
      });
      legRecord.signature = res.signature;
      legRecord.status = 'executed';
      // Compute actual out from the fill:
      //   ask: filledBase × avg fill price = quote received (but we don't have that directly)
      //   bid: filledBase IS the base received
      // Best proxy: trust expectedOut for the next leg's input estimate.
      // (For exact accounting, the journal indexer will record the true balances.)
      legRecord.actualOut = side === 'bid' ? res.filledBase : res.filledNotionalUsd;
      currentAmount = legRecord.actualOut;
      currentMint = leg.to;
      legs.push(legRecord);
      getLogger().info('arb', `Leg ${i + 1}/3 done on ${def.symbol}: ${side} ${sizeBase} → ${legRecord.actualOut}`);
      // Small spacing between legs
      await new Promise((r) => setTimeout(r, 200));
    } catch (e) {
      legRecord.status = 'failed';
      legRecord.error = (e as Error).message;
      legs.push(legRecord);
      aborted = true;
      break;
    }
  }

  const endSize = currentMint === args.cycle.startMint ? currentAmount : 0;
  const realizedProfitBps = args.startSize > 0
    ? ((endSize / args.startSize) - 1) * 10_000
    : 0;

  return {
    cycle: args.cycle,
    legs, startSize: args.startSize, endSize,
    realizedProfitBps, dryRun: args.dryRun, aborted,
  };
}

