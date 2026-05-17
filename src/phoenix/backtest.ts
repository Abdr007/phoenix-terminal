/**
 * Phoenix MM backtester — passive replay of historical fills against a
 * simulated maker configuration.
 *
 * Method (PASSIVE — important caveat):
 *   1. Walk recent transactions touching the market account (newest → oldest).
 *   2. Decode each into fill events with (price, size, ts).
 *   3. Maintain a rolling "mid" estimate from recent fill prices.
 *   4. At each historical fill, we know SOMEONE else's quote was crossed.
 *      We assume our maker had a passive bid at mid×(1 - half) and ask at
 *      mid×(1 + half). If the cross-price would have hit OUR resting quote
 *      first (i.e. ours was tighter than the maker who actually got filled),
 *      we count it as our fill.
 *   5. Apply WAC PnL: bid fills add to inventory at avgCost; ask fills realize
 *      (sell_price − avgCost) × size.
 *
 * Limitations (be honest):
 *   - We don't have the actual historical book state — only fills
 *   - "Would my quote have been hit" is a heuristic; in reality there's a
 *     queue at every price level and competing makers
 *   - Doesn't model adverse selection (toxic flow you'd want to AVOID)
 *   - Doesn't model latency or cancel/replace dynamics
 *
 * What it IS good for: rough sanity check that your `--half` is in the right
 * ballpark for current market conditions. If the backtest shows 0 fills at
 * 8bps but 50 fills at 30bps, that tells you something real.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getPhoenixClient } from './client.js';
import { findMarket } from './markets.js';
import { getLogger } from '../utils/logger.js';

export interface BacktestConfig {
  symbol: string;
  /** How far back to scan, in hours. */
  hours: number;
  /** Maker quote size in base units. */
  sizeBase: number;
  /** Half-spread in bps from rolling mid. */
  halfSpreadBps: number;
  /** Hard cap on observed signatures to fetch (RPC budget). */
  maxSignatures: number;
}

export interface BacktestResult {
  symbol: string;
  windowHours: number;
  configHalfBps: number;
  configSize: number;
  scannedSignatures: number;
  observedFills: number;
  observedVolumeUsd: number;
  observedAvgSpreadFromMidBps: number;
  ourFills: number;
  ourBuyFills: number;
  ourSellFills: number;
  ourVolumeUsd: number;
  realizedPnlUsd: number;
  edgeCapturedUsd: number;
  edgePerFillUsd: number;
  maxAbsInventoryBase: number;
  endInventoryBase: number;
  startMid: number | null;
  endMid: number | null;
  midDriftBps: number | null;
  /** Realized fills, in chronological order, capped at last 100 for display. */
  fillLog: Array<{ ts: number; side: 'bid' | 'ask'; price: number; size: number; mid: number }>;
}

const TX_CONCURRENCY = 2;
const TX_DELAY_MS = 300;

/** Scan signatures touching the market account; decode fills. */
async function fetchHistoricalFills(
  connection: Connection,
  marketAddr: string,
  hours: number,
  maxSigs: number,
  onProgress?: (scanned: number, total: number) => void,
): Promise<Array<{ ts: number; price: number; size: number; signature: string }>> {
  const phoenix = getPhoenixClient();
  const client = await phoenix.raw();
  if (!client.marketStates.has(marketAddr)) {
    const def = findMarket(marketAddr);
    if (def) await phoenix.addMarket(def.symbol);
  }

  const cutoffMs = Date.now() - hours * 3600 * 1000;
  const market = new PublicKey(marketAddr);
  const collected: Array<{ ts: number; price: number; size: number; signature: string }> = [];
  let before: string | undefined;
  let scanned = 0;

  while (scanned < maxSigs) {
    const batch = await connection.getSignaturesForAddress(market, {
      limit: Math.min(100, maxSigs - scanned),
      before,
    });
    if (batch.length === 0) break;
    scanned += batch.length;
    onProgress?.(scanned, maxSigs);

    // Stop once we cross the cutoff
    const oldest = batch[batch.length - 1];
    if (!oldest) break; // batch length checked above, but TS doesn't see that
    const oldestTs = (oldest.blockTime ?? 0) * 1000;
    const items = batch.filter((s) => !s.err && (s.blockTime ?? 0) * 1000 >= cutoffMs);

    // Decode in throttled bursts
    for (let i = 0; i < items.length; i += TX_CONCURRENCY) {
      const chunk = items.slice(i, i + TX_CONCURRENCY);
      const results = await Promise.all(chunk.map(async (s) => {
        try {
          const ptx = await Phoenix.getPhoenixEventsFromTransactionSignature(connection, s.signature);
          const out: Array<{ ts: number; price: number; size: number }> = [];
          for (const ix of ptx.instructions) {
            if (ix.header?.market?.toBase58() !== marketAddr) continue;
            for (const evt of ix.events) {
              if (!Phoenix.isPhoenixMarketEventFill(evt)) continue;
              const f = evt.fields[0];
              const priceTicks = Phoenix.toNum(f.priceInTicks);
              const baseLots = Phoenix.toNum(f.baseLotsFilled);
              if (baseLots === 0) continue;
              const price = client.ticksToFloatPrice(priceTicks, marketAddr);
              const size = client.baseAtomsToRawBaseUnits(
                client.baseLotsToBaseAtoms(baseLots, marketAddr),
                marketAddr,
              );
              out.push({ ts: (s.blockTime ?? 0) * 1000, price, size });
            }
          }
          return { sig: s.signature, fills: out };
        } catch (e) {
          getLogger().debug('backtest', `decode ${s.signature.slice(0, 12)}: ${(e as Error).message}`);
          return { sig: s.signature, fills: [] as Array<{ ts: number; price: number; size: number }> };
        }
      }));
      for (const r of results) for (const f of r.fills) collected.push({ ...f, signature: r.sig });
      if (i + TX_CONCURRENCY < items.length) await new Promise((r) => setTimeout(r, TX_DELAY_MS));
    }

    before = oldest.signature;
    if (oldestTs > 0 && oldestTs < cutoffMs) break;
    if (batch.length < 100) break;
  }

  // Sort oldest first for the simulator
  collected.sort((a, b) => a.ts - b.ts);
  return collected;
}

export async function runBacktest(
  connection: Connection,
  cfg: BacktestConfig,
  onProgress?: (scanned: number, total: number) => void,
): Promise<BacktestResult> {
  const def = findMarket(cfg.symbol);
  if (!def) throw new Error(`unknown market: ${cfg.symbol}`);

  const fills = await fetchHistoricalFills(connection, def.address, cfg.hours, cfg.maxSignatures, onProgress);

  // ─── Simulator state ───
  let inv = 0;
  let avgCost = 0;
  let realized = 0;
  let edgeCaptured = 0;
  let ourBuys = 0;
  let ourSells = 0;
  let maxAbsInv = 0;
  let ourVolume = 0;
  let observedVolume = 0;
  let observedSpreadBpsSum = 0;
  let observedSpreadCount = 0;

  // Rolling mid: simple EMA of recent fill prices
  let mid: number | null = null;
  const alpha = 0.2;
  const halfFrac = cfg.halfSpreadBps / 10_000;
  const fillLog: BacktestResult['fillLog'] = [];

  const startMid = fills[0]?.price ?? null;
  let endMid: number | null = null;

  for (const f of fills) {
    observedVolume += f.price * f.size;
    if (mid !== null) {
      const spreadBps = Math.abs(f.price - mid) / mid * 10_000;
      observedSpreadBpsSum += spreadBps;
      observedSpreadCount++;
    }

    if (mid === null) { mid = f.price; continue; }

    // Our resting quotes (BEFORE this fill):
    const ourBid = mid * (1 - halfFrac);
    const ourAsk = mid * (1 + halfFrac);

    // Heuristic match:
    //   - If observed fill price <= ourBid (someone willing to sell that cheap), our bid would have filled
    //   - If observed fill price >= ourAsk, our ask would have filled
    // We fill at OUR quote price (not theirs) — that's the maker's edge.
    let weFilled = false;
    if (f.price <= ourBid) {
      // We bought at ourBid (post-only). Edge = mid - ourBid.
      const fillSize = Math.min(f.size, cfg.sizeBase);
      const newInv = inv + fillSize;
      if (newInv > 0.000001) avgCost = (inv * avgCost + fillSize * ourBid) / newInv;
      inv = newInv;
      ourBuys++;
      ourVolume += ourBid * fillSize;
      edgeCaptured += (mid - ourBid) * fillSize;
      fillLog.push({ ts: f.ts, side: 'bid', price: ourBid, size: fillSize, mid });
      weFilled = true;
    } else if (f.price >= ourAsk) {
      const fillSize = Math.min(f.size, cfg.sizeBase);
      // Realize against avg cost (only on the inventory we have)
      const reducedSize = Math.min(fillSize, Math.max(inv, 0));
      realized += (ourAsk - avgCost) * reducedSize;
      inv -= fillSize;
      if (inv < 0 && reducedSize < fillSize) avgCost = ourAsk;
      ourSells++;
      ourVolume += ourAsk * fillSize;
      edgeCaptured += (ourAsk - mid) * fillSize;
      fillLog.push({ ts: f.ts, side: 'ask', price: ourAsk, size: fillSize, mid });
      weFilled = true;
    }
    void weFilled;
    if (Math.abs(inv) > maxAbsInv) maxAbsInv = Math.abs(inv);

    // Update rolling mid AFTER our quote decision
    mid = alpha * f.price + (1 - alpha) * mid;
    endMid = mid;
  }

  const ourFills = ourBuys + ourSells;
  return {
    symbol: cfg.symbol,
    windowHours: cfg.hours,
    configHalfBps: cfg.halfSpreadBps,
    configSize: cfg.sizeBase,
    scannedSignatures: fills.length, // signatures with at least one fill
    observedFills: fills.length,
    observedVolumeUsd: observedVolume,
    observedAvgSpreadFromMidBps: observedSpreadCount > 0 ? observedSpreadBpsSum / observedSpreadCount : 0,
    ourFills,
    ourBuyFills: ourBuys,
    ourSellFills: ourSells,
    ourVolumeUsd: ourVolume,
    realizedPnlUsd: realized,
    edgeCapturedUsd: edgeCaptured,
    edgePerFillUsd: ourFills > 0 ? edgeCaptured / ourFills : 0,
    maxAbsInventoryBase: maxAbsInv,
    endInventoryBase: inv,
    startMid, endMid,
    midDriftBps: startMid !== null && endMid !== null && startMid > 0 ? ((endMid - startMid) / startMid) * 10_000 : null,
    fillLog: fillLog.slice(-100),
  };
}
