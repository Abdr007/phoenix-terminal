/**
 * Inventory-aware market maker — Avellaneda-Stoikov-lite.
 *
 * Strategy:
 *   - At each tick: compute reservation price r = mid - q * γ * σ²
 *     where q = inventory in base units, γ = risk aversion, σ² = vol estimate.
 *   - Quote bid at  r - δ_bid, ask at r + δ_ask
 *     where δ widens as inventory skews and narrows when balanced.
 *   - Post-only, with TTL so missed cancels expire on-chain.
 *   - Cancel-all + re-quote on every cycle (separate txs per SDK example to fit
 *     within packet size + avoid latency stacking).
 *
 * Safety:
 *   - Hard inventory cap (don't accumulate more than maxInventoryBase).
 *   - Stop if mid moves > maxMidJumpBps between ticks (oracle anomaly).
 *   - Stop on signing-guard rate-limit violation (caller will see error).
 */

import { Connection, Keypair } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getPhoenixClient } from './client.js';
import { placeLimit, cancelAll, getOpenOrders } from './orders.js';
import { getJournal } from './journal.js';
import { fetchPythPrice } from './oracle.js';
import { findMarket } from './markets.js';
import { getNotifier } from '../network/notifier.js';
import { txLink } from '../utils/explorer.js';
import { getLogger } from '../utils/logger.js';
import { theme } from '../cli/theme.js';
import { fmtNum, fmtUsd } from '../utils/format.js';
import { safeNumber, clamp } from '../utils/safe-number.js';

export interface MakerConfig {
  symbol: string;
  /** Quoted size on each side, in base units. */
  quoteSizeBase: number;
  /** Base half-spread in bps from mid (the floor when inventory is balanced). */
  baseHalfSpreadBps: number;
  /** Risk aversion γ — higher = more inventory-averse, wider skew adjustment. */
  riskAversion: number;
  /** Volatility estimate (stdev of returns over recent window, expressed as a fraction). */
  volatility: number;
  /** Tick interval ms — re-quote cadence. */
  intervalMs: number;
  /** Max absolute inventory before we stop adding to that side. */
  maxInventoryBase: number;
  /** Halt if mid moves more than this between ticks (basis-point sanity check). */
  maxMidJumpBps: number;
  /** Order TTL on-chain (seconds). Should be > intervalMs so we don't leave stale quotes. */
  orderTtlSec: number;
  /** Route every order via Jito bundle (guaranteed inclusion, tip auto-added). */
  useJito?: boolean;
  /** Jito tip in lamports per order; defaults to JITO_DEFAULT_TIP_LAMPORTS. */
  tipLamports?: number;
  /** Oracle anchor: skip tick if |Phoenix mid - Pyth| > maxOracleDevBps. */
  oracleAnchored?: boolean;
  /** Max allowable deviation from Pyth (bps) before tick is skipped. Default 50. */
  maxOracleDevBps?: number;
}

export const DEFAULT_MAKER: Omit<MakerConfig, 'symbol' | 'quoteSizeBase' | 'maxInventoryBase'> = {
  baseHalfSpreadBps: 8,
  riskAversion: 0.5,
  volatility: 0.01,
  intervalMs: 12_000,
  maxMidJumpBps: 200,
  orderTtlSec: 30,
};

export interface MakerStats {
  ticks: number;
  cancelsSent: number;
  placesSent: number;
  errors: number;
  startedAt: number;
  lastMid: number | null;
  inventoryBase: number;
  // ─── Live telemetry ──────────────────────────────────────────────────
  fills: number;                  // count of fills attributed to us
  buyFills: number;
  sellFills: number;
  dollarVolume: number;           // total notional traded
  realizedEdgeUsd: number;        // Σ |fill_price - mid_at_fill| × size  (rebate proxy)
  inventoryPnlUsd: number;        // mark-to-mid PnL on current inventory
  lastFillAt: number | null;
  lastFillPrice: number | null;
  lastFillSide: 'bid' | 'ask' | null;
}

export class Maker {
  private cfg: MakerConfig;
  private connection: Connection;
  private signer: Keypair;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stats: MakerStats;
  private logSubId: number | null = null;
  /** Tick mutex: prevents overlap if a prior tick is still running. */
  private tickInProgress = false;

  constructor(connection: Connection, signer: Keypair, cfg: MakerConfig) {
    this.connection = connection;
    this.signer = signer;
    this.cfg = cfg;
    this.stats = {
      ticks: 0, cancelsSent: 0, placesSent: 0, errors: 0,
      startedAt: Date.now(), lastMid: null, inventoryBase: 0,
      fills: 0, buyFills: 0, sellFills: 0,
      dollarVolume: 0, realizedEdgeUsd: 0, inventoryPnlUsd: 0,
      lastFillAt: null, lastFillPrice: null, lastFillSide: null,
    };
  }

  get status(): MakerStats {
    // Mark inventory to last known mid before returning
    if (this.stats.lastMid !== null && Number.isFinite(this.stats.lastMid)) {
      // Use lastFillPrice as cost proxy when no avg-cost tracking is available
      // The journal command gives the precise WAC PnL; this is the in-session estimate.
      this.stats.inventoryPnlUsd = this.stats.inventoryBase * this.stats.lastMid;
    }
    return { ...this.stats };
  }
  get isRunning(): boolean { return this.running; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    getLogger().info('mm', `Maker started on ${this.cfg.symbol} — size=${this.cfg.quoteSizeBase} base, half-spread=${this.cfg.baseHalfSpreadBps}bps, γ=${this.cfg.riskAversion}`);
    getNotifier().notify({
      kind: 'mm_started', severity: 'info',
      title: `MM started on ${this.cfg.symbol}`,
      body: `size=${this.cfg.quoteSizeBase} base, half=${this.cfg.baseHalfSpreadBps}bps, γ=${this.cfg.riskAversion}, interval=${this.cfg.intervalMs}ms`,
      fields: { symbol: this.cfg.symbol, size: this.cfg.quoteSizeBase, halfSpreadBps: this.cfg.baseHalfSpreadBps, jito: this.cfg.useJito ? 'yes' : 'no' },
    });

    // Subscribe to Phoenix program logs to detect our own fills in real time
    this.logSubId = this.connection.onLogs(
      Phoenix.PROGRAM_ID,
      (info) => this.handleProgramLog(info.signature),
      'confirmed',
    );

    // first tick immediately, then on interval
    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch((e) => {
        this.stats.errors++;
        getLogger().error('mm', `Tick error: ${(e as Error).message}`);
      });
    }, this.cfg.intervalMs);
    this.timer.unref?.();
  }

  /** Decode the tx behind a Phoenix log; attribute any fills involving our wallet. */
  private async handleProgramLog(signature: string): Promise<void> {
    try {
      const ptx = await Phoenix.getPhoenixEventsFromTransactionSignature(this.connection, signature);
      const phoenix = getPhoenixClient();
      const client = await phoenix.raw();
      const walletStr = this.signer.publicKey.toBase58();
      let attributed = false;
      let attributedFee = 0;

      for (const ix of ptx.instructions) {
        const marketAddr = ix.header?.market?.toBase58();
        if (!marketAddr) continue;
        const { def } = await phoenix.getMarket(this.cfg.symbol);
        if (marketAddr !== def.address) continue; // only fills on our MM market

        // FillSummary carries the fee total for the ix
        let totalFeeLots = 0;
        for (const evt of ix.events) {
          if (Phoenix.isPhoenixMarketEventFillSummary(evt)) {
            totalFeeLots += Phoenix.toNum(evt.fields[0].totalFeeInQuoteLots);
          }
        }

        for (const evt of ix.events) {
          if (!Phoenix.isPhoenixMarketEventFill(evt)) continue;
          const f = evt.fields[0];
          const isMaker = f.makerId.toBase58() === walletStr;
          if (!isMaker) continue; // only our maker fills (rebate path)

          const priceTicks = Phoenix.toNum(f.priceInTicks);
          const baseLots = Phoenix.toNum(f.baseLotsFilled);
          if (baseLots === 0) continue;
          const priceUsd = client.ticksToFloatPrice(priceTicks, marketAddr);
          const sizeBase = client.baseAtomsToRawBaseUnits(
            client.baseLotsToBaseAtoms(baseLots, marketAddr),
            marketAddr,
          );
          const notional = priceUsd * sizeBase;

          // Infer side by comparing fill price to last-known mid
          const mid = this.stats.lastMid ?? priceUsd;
          const side: 'bid' | 'ask' = priceUsd > mid ? 'ask' : 'bid';
          const edgePerUnit = Math.abs(priceUsd - mid);

          this.stats.fills++;
          if (side === 'bid') {
            this.stats.buyFills++;
            this.stats.inventoryBase += sizeBase;
          } else {
            this.stats.sellFills++;
            this.stats.inventoryBase -= sizeBase;
          }
          this.stats.dollarVolume += notional;
          this.stats.realizedEdgeUsd += edgePerUnit * sizeBase;
          this.stats.lastFillAt = Date.now();
          this.stats.lastFillPrice = priceUsd;
          this.stats.lastFillSide = side;
          attributed = true;

          // Persist to journal (idempotent on signature)
          try {
            getJournal().insertFill({
              signature, wallet: walletStr, market: def.symbol, side,
              priceUsd, sizeBase, notionalUsd: notional, isMaker: 1, feeUsd: 0,
              blockTime: Math.floor(Date.now() / 1000), slot: 0,
            });
          } catch { /* journal optional */ }
          // Notification
          getNotifier().notify({
            kind: 'fill', severity: 'success',
            title: `Fill on ${this.cfg.symbol} — ${side === 'bid' ? 'BUY' : 'SELL'} ${sizeBase.toFixed(6)} @ $${priceUsd.toFixed(4)}`,
            body: `inventory ${this.stats.inventoryBase.toFixed(6)} · edge this fill $${(edgePerUnit * sizeBase).toFixed(4)}`,
            fields: { market: this.cfg.symbol, side, price: priceUsd.toFixed(4), size: sizeBase.toFixed(6), notionalUsd: notional.toFixed(4), totalFills: this.stats.fills, totalEdge: this.stats.realizedEdgeUsd.toFixed(4) },
            link: { label: 'view on Solscan', url: txLink(signature) },
          });
        }
        if (attributed && totalFeeLots > 0) {
          // Maker doesn't pay the taker fee in Phoenix; tracked for completeness
          attributedFee += client.quoteAtomsToQuoteUnits(client.quoteLotsToQuoteAtoms(totalFeeLots, marketAddr), marketAddr);
        }
      }
      void attributedFee;
      if (attributed) {
        process.stdout.write(
          `\n${theme.muted('[mm fill]')} ${theme.success('●')} ` +
          `${this.stats.lastFillSide === 'bid' ? theme.bid('BUY ') : theme.ask('SELL')} ` +
          `${fmtNum(this.stats.inventoryBase, 4)} inv  ` +
          `${fmtUsd(this.stats.realizedEdgeUsd, 4)} edge  ` +
          `${this.stats.fills} fills\n`,
        );
      }
    } catch {
      /* decode errors are common for cross-program txs */
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.logSubId !== null) {
      try { await this.connection.removeOnLogsListener(this.logSubId); } catch { /* ignore */ }
      this.logSubId = null;
    }
    try {
      await cancelAll(this.connection, this.signer, this.cfg.symbol);
      this.stats.cancelsSent++;
      getLogger().info('mm', 'Maker stopped — open orders cancelled');
      const uptimeSec = Math.round((Date.now() - this.stats.startedAt) / 1000);
      getNotifier().notify({
        kind: 'mm_stopped', severity: 'info',
        title: `MM stopped on ${this.cfg.symbol}`,
        body: `${uptimeSec}s uptime · ${this.stats.fills} fills · $${this.stats.realizedEdgeUsd.toFixed(4)} edge captured`,
        fields: { fills: this.stats.fills, edgeUsd: this.stats.realizedEdgeUsd.toFixed(4), volumeUsd: this.stats.dollarVolume.toFixed(2), errors: this.stats.errors },
      });
    } catch (e) {
      getLogger().warn('mm', `Final cancel-all failed: ${(e as Error).message}`);
    }
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    // Prevent overlap: if the previous tick took longer than intervalMs, drop this one.
    if (this.tickInProgress) {
      getLogger().debug('mm', 'Skipping tick — previous tick still in progress');
      return;
    }
    this.tickInProgress = true;
    try {
      await this.tickImpl();
    } finally {
      this.tickInProgress = false;
    }
  }

  private async tickImpl(): Promise<void> {
    this.stats.ticks++;

    const phoenix = getPhoenixClient();
    const { def, state } = await phoenix.getMarket(this.cfg.symbol);
    await phoenix.refresh(def.address);

    const ladder = state.getUiLadder(1);
    const bestBid = safeNumber(ladder.bids[0]?.price, NaN);
    const bestAsk = safeNumber(ladder.asks[0]?.price, NaN);
    if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk) || bestBid <= 0 || bestAsk <= 0) {
      getLogger().warn('mm', `Skipping tick — no top-of-book on ${this.cfg.symbol}`);
      return;
    }
    const mid = (bestBid + bestAsk) / 2;

    // Oracle anchor: refuse to quote if Phoenix is way off Pyth (likely a manipulated/empty book)
    if (this.cfg.oracleAnchored) {
      const def = findMarket(this.cfg.symbol);
      const pyth = def ? await fetchPythPrice(def.baseSymbol) : null;
      if (pyth !== null && pyth > 0) {
        const devBps = ((mid - pyth) / pyth) * 10_000;
        const maxDev = this.cfg.maxOracleDevBps ?? 50;
        if (Math.abs(devBps) > maxDev) {
          getLogger().warn('mm', `Oracle anchor TRIPPED on ${this.cfg.symbol}: Phoenix mid ${mid.toFixed(4)} vs Pyth ${pyth.toFixed(4)} = ${devBps.toFixed(0)}bps > ${maxDev}bps. Skipping tick.`);
          this.stats.lastMid = mid;
          return;
        }
      }
    }

    // Sanity check: massive mid jump → halt this tick
    if (this.stats.lastMid !== null && Number.isFinite(this.stats.lastMid)) {
      const jumpBps = Math.abs(mid - this.stats.lastMid) / this.stats.lastMid * 10_000;
      if (jumpBps > this.cfg.maxMidJumpBps) {
        getLogger().warn('mm', `Mid jumped ${jumpBps.toFixed(0)}bps (> ${this.cfg.maxMidJumpBps}). Skipping tick.`);
        this.stats.lastMid = mid;
        return;
      }
    }
    this.stats.lastMid = mid;

    // Inventory-aware reservation price + skew
    // q is normalized by maxInventoryBase so the model is scale-free
    const qNorm = clamp(this.stats.inventoryBase / Math.max(this.cfg.maxInventoryBase, 0.0001), -1, 1);
    const sigmaSq = Math.max(this.cfg.volatility, 0.0001) ** 2;
    const reservation = mid * (1 - this.cfg.riskAversion * sigmaSq * qNorm);

    // Asymmetric half-spread: widen the side that would worsen inventory
    const baseHalf = this.cfg.baseHalfSpreadBps / 10_000;
    const skewAdj = Math.abs(qNorm) * baseHalf; // up to +100% wider when fully loaded
    const bidHalf = qNorm > 0 ? baseHalf + skewAdj : baseHalf; // we're long → make bid less aggressive
    const askHalf = qNorm < 0 ? baseHalf + skewAdj : baseHalf; // we're short → make ask less aggressive

    const bidPrice = reservation * (1 - bidHalf);
    const askPrice = reservation * (1 + askHalf);

    // Inventory caps — skip the side that would breach
    const skipBid = this.stats.inventoryBase >= this.cfg.maxInventoryBase;
    const skipAsk = this.stats.inventoryBase <= -this.cfg.maxInventoryBase;

    process.stdout.write(
      `\n${theme.muted('[mm]')} ${theme.label('mid')}=${fmtUsd(mid, 4)} ` +
      `${theme.label('r')}=${fmtUsd(reservation, 4)} ` +
      `${theme.bid('bid')}=${fmtUsd(bidPrice, 4)} ${theme.ask('ask')}=${fmtUsd(askPrice, 4)} ` +
      `${theme.label('inv')}=${fmtNum(this.stats.inventoryBase, 4)}\n`,
    );

    // 1) Cancel everything — separate tx for size + latency reasons (per SDK example)
    try {
      await cancelAll(this.connection, this.signer, this.cfg.symbol, { useJito: this.cfg.useJito, tipLamports: this.cfg.tipLamports });
      this.stats.cancelsSent++;
    } catch (e) {
      getLogger().warn('mm', `cancel-all failed: ${(e as Error).message}`);
      this.stats.errors++;
      return;
    }
    // Brief pause so the signing-guard rate limiter doesn't reject the follow-on places
    await new Promise((r) => setTimeout(r, 300));

    // 2) Update inventory from on-chain open orders (best-effort)
    try {
      const open = await getOpenOrders(this.cfg.symbol, this.signer.publicKey);
      // We don't track positions on Phoenix (it's a spot CLOB), so inventory is
      // approximated from the diff of base-token balance change at session start.
      // For now we keep this.stats.inventoryBase as caller's running estimate.
      void open;
    } catch { /* ignore */ }

    // 3) Place new quotes SEQUENTIALLY so the per-order rate limiter doesn't reject the second one.
    if (!skipBid) {
      try {
        await placeLimit(this.connection, this.signer, {
          symbol: this.cfg.symbol, side: 'bid',
          priceUsd: bidPrice, sizeBase: this.cfg.quoteSizeBase,
          ttlSec: this.cfg.orderTtlSec, postOnly: true,
          useJito: this.cfg.useJito, tipLamports: this.cfg.tipLamports,
        });
        this.stats.placesSent++;
      } catch (e) {
        this.stats.errors++;
        getLogger().warn('mm', `bid place failed: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!skipAsk) {
      try {
        await placeLimit(this.connection, this.signer, {
          symbol: this.cfg.symbol, side: 'ask',
          priceUsd: askPrice, sizeBase: this.cfg.quoteSizeBase,
          ttlSec: this.cfg.orderTtlSec, postOnly: true,
          useJito: this.cfg.useJito, tipLamports: this.cfg.tipLamports,
        });
        this.stats.placesSent++;
      } catch (e) {
        this.stats.errors++;
        getLogger().warn('mm', `ask place failed: ${(e as Error).message}`);
      }
    }
  }

  /** External hook: when a fill is observed, update inventory. side='bid' = we bought base. */
  recordFill(side: 'bid' | 'ask', sizeBase: number): void {
    if (side === 'bid') this.stats.inventoryBase += sizeBase;
    else this.stats.inventoryBase -= sizeBase;
  }
}
