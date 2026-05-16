/**
 * Multi-market market maker — one bot, N markets, ASSET-level inventory.
 *
 * Key insight: when MM'ing SOL/USDC + SOL/USDT + JitoSOL/SOL, the SOL you buy
 * on SOL/USDC is the same SOL you might sell on SOL/USDT. So inventory must
 * aggregate per ASSET, not per MARKET. That lets the bot:
 *
 *   - Tighten bids on EVERY market when you're already long the base
 *   - Loosen asks on every market when you want to unload
 *   - Capture cross-market dislocation (e.g. SOL/USDC mid $87.10 vs SOL/USDT
 *     mid $87.30): bot reduces bid on the rich market and ask on the cheap one
 *
 * Tick structure: SEQUENTIAL per market (3 markets × ~3-5s each = ~12s/cycle).
 * Each market does cancel-all → bid → ask with the global signing-guard rate
 * limiter naturally pacing things.
 */

import { Connection, Keypair } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getPhoenixClient } from './client.js';
import { placeLimit, cancelAll } from './orders.js';
import { findMarket, MarketDef } from './markets.js';
import { getJournal } from './journal.js';
import { fetchPythPrice } from './oracle.js';
import { getNotifier } from '../network/notifier.js';
import { txLink } from '../utils/explorer.js';
import { getLogger } from '../utils/logger.js';
import { theme } from '../cli/theme.js';
import { fmtNum, fmtUsd } from '../utils/format.js';
import { safeNumber, clamp } from '../utils/safe-number.js';

export interface MultiMakerConfig {
  symbols: string[];                // e.g. ['SOL/USDC', 'SOL/USDT', 'JitoSOL/SOL']
  quoteSizeBase: number;            // per-market size in base units
  baseHalfSpreadBps: number;        // floor half-spread (each side, when balanced)
  riskAversion: number;             // γ in r = mid × (1 − γσ²q̂)
  volatility: number;               // σ estimate (fraction)
  intervalMs: number;               // full-cycle interval (all markets quoted within)
  /** Max NET inventory per ASSET in base units (e.g. SOL=2). Skew normalizes to ±1. */
  maxInventoryByAsset: Map<string, number>;
  maxMidJumpBps: number;
  orderTtlSec: number;
  useJito?: boolean;
  tipLamports?: number;
  /** Oracle anchor: skip per-market tick if |Phoenix mid - Pyth| > maxOracleDevBps. */
  oracleAnchored?: boolean;
  /** Per-market deviation threshold (bps). Default 50. */
  maxOracleDevBps?: number;
}

export interface MultiMakerStats {
  startedAt: number;
  ticks: number;
  totalCancels: number;
  totalPlaces: number;
  totalErrors: number;
  /** Per-market last mid snapshot. */
  mids: Map<string, number | null>;
  /** Per-ASSET net inventory (positive = long that asset). */
  invByAsset: Map<string, number>;
  /** Per-ASSET USD value at last mid (best-effort; uses anchor pair). */
  invUsdByAsset: Map<string, number>;
  fills: number;
  buyFills: number;
  sellFills: number;
  dollarVolume: number;
  realizedEdgeUsd: number;
  lastFillAt: number | null;
  /** Per-market fill counts. */
  fillsByMarket: Map<string, number>;
}

const DEFAULT_MAX_INV: Record<string, number> = {
  SOL: 1.0, JitoSOL: 0.5, mSOL: 0.5,
  USDC: 200, USDT: 200,
  JTO: 50, JUP: 200, BONK: 1e8, WIF: 100, PYTH: 200,
};

export const DEFAULT_MULTI_MAKER: Omit<MultiMakerConfig, 'symbols' | 'quoteSizeBase' | 'maxInventoryByAsset'> = {
  baseHalfSpreadBps: 8,
  riskAversion: 0.5,
  volatility: 0.01,
  intervalMs: 18_000,
  maxMidJumpBps: 200,
  orderTtlSec: 60,
};

export class MultiMarketMaker {
  private cfg: MultiMakerConfig;
  private connection: Connection;
  private signer: Keypair;
  private markets: MarketDef[];
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private logSubId: number | null = null;
  private stats: MultiMakerStats;
  /** Asset symbol → most recent USD price (from a USDC quote market). */
  private priceCache = new Map<string, number>();

  constructor(connection: Connection, signer: Keypair, cfg: MultiMakerConfig) {
    this.connection = connection;
    this.signer = signer;
    this.cfg = cfg;
    this.markets = cfg.symbols.map((s) => {
      const def = findMarket(s);
      if (!def) throw new Error(`unknown market: ${s}`);
      return def;
    });
    this.stats = {
      startedAt: Date.now(),
      ticks: 0, totalCancels: 0, totalPlaces: 0, totalErrors: 0,
      mids: new Map(),
      invByAsset: new Map(),
      invUsdByAsset: new Map(),
      fills: 0, buyFills: 0, sellFills: 0,
      dollarVolume: 0, realizedEdgeUsd: 0,
      lastFillAt: null,
      fillsByMarket: new Map(),
    };
    for (const m of this.markets) this.stats.fillsByMarket.set(m.symbol, 0);
  }

  get status(): MultiMakerStats {
    // Recompute USD values of inventory
    for (const [asset, amt] of this.stats.invByAsset) {
      const price = this.priceCache.get(asset) ?? (asset === 'USDC' || asset === 'USDT' ? 1 : 0);
      this.stats.invUsdByAsset.set(asset, amt * price);
    }
    return { ...this.stats, mids: new Map(this.stats.mids), invByAsset: new Map(this.stats.invByAsset), invUsdByAsset: new Map(this.stats.invUsdByAsset), fillsByMarket: new Map(this.stats.fillsByMarket) };
  }
  get isRunning(): boolean { return this.running; }
  get symbols(): string[] { return this.cfg.symbols.slice(); }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    getLogger().info('mm-multi', `Starting on ${this.markets.map((m) => m.symbol).join(', ')} — size=${this.cfg.quoteSizeBase} base, half=${this.cfg.baseHalfSpreadBps}bps, γ=${this.cfg.riskAversion}`);

    // Subscribe to Phoenix program logs once — handler dispatches per market
    this.logSubId = this.connection.onLogs(
      Phoenix.PROGRAM_ID,
      (info) => this.handleProgramLog(info.signature),
      'confirmed',
    );

    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch((e) => {
        this.stats.totalErrors++;
        getLogger().error('mm-multi', `Tick error: ${(e as Error).message}`);
      });
    }, this.cfg.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.logSubId !== null) {
      try { await this.connection.removeOnLogsListener(this.logSubId); } catch { /* ignore */ }
      this.logSubId = null;
    }
    // Cancel orders on every market
    for (const m of this.markets) {
      try {
        await cancelAll(this.connection, this.signer, m.symbol);
        this.stats.totalCancels++;
      } catch (e) {
        getLogger().warn('mm-multi', `final cancel-all on ${m.symbol} failed: ${(e as Error).message}`);
      }
    }
    getLogger().info('mm-multi', 'Multi-maker stopped — open orders cancelled');
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    this.stats.ticks++;
    const phoenix = getPhoenixClient();

    // 1) Snapshot all market mids in parallel
    await Promise.all(this.markets.map((m) => phoenix.refresh(m.address, true)));
    for (const m of this.markets) {
      const { state } = await phoenix.getMarket(m.symbol);
      const ladder = state.getUiLadder(1);
      const bb = safeNumber(ladder.bids[0]?.price, NaN);
      const ba = safeNumber(ladder.asks[0]?.price, NaN);
      if (Number.isFinite(bb) && Number.isFinite(ba) && bb > 0 && ba > 0) {
        const mid = (bb + ba) / 2;
        this.stats.mids.set(m.symbol, mid);
        // Cache USD price for the base asset (only if quote is USDC/USDT)
        if (m.quoteSymbol === 'USDC' || m.quoteSymbol === 'USDT') {
          this.priceCache.set(m.baseSymbol, mid);
        }
      } else {
        this.stats.mids.set(m.symbol, null);
      }
    }
    // USDC and USDT are pegged ≈ $1
    if (!this.priceCache.has('USDC')) this.priceCache.set('USDC', 1);
    if (!this.priceCache.has('USDT')) this.priceCache.set('USDT', 1);

    // 2) Sequentially: cancel + bid + ask per market, using ASSET-level inventory for skew
    for (const def of this.markets) {
      if (!this.running) return;
      const mid = this.stats.mids.get(def.symbol);
      if (mid === null || mid === undefined) {
        getLogger().warn('mm-multi', `skip ${def.symbol} — no top-of-book`);
        continue;
      }

      // Per-market oracle anchor check
      if (this.cfg.oracleAnchored) {
        const pyth = await fetchPythPrice(def.baseSymbol);
        if (pyth !== null && pyth > 0) {
          const devBps = ((mid - pyth) / pyth) * 10_000;
          const maxDev = this.cfg.maxOracleDevBps ?? 50;
          if (Math.abs(devBps) > maxDev) {
            getLogger().warn('mm-multi', `${def.symbol} oracle-anchor TRIPPED: mid ${mid.toFixed(4)} vs Pyth ${pyth.toFixed(4)} = ${devBps.toFixed(0)}bps. Skipping.`);
            continue;
          }
        }
      }

      // ASSET-LEVEL skew: base inventory normalized to its asset cap
      const baseInv = this.stats.invByAsset.get(def.baseSymbol) ?? 0;
      const baseMax = this.cfg.maxInventoryByAsset.get(def.baseSymbol) ?? DEFAULT_MAX_INV[def.baseSymbol] ?? 1;
      const qNorm = clamp(baseInv / Math.max(baseMax, 0.0001), -1, 1);
      const sigmaSq = Math.max(this.cfg.volatility, 0.0001) ** 2;
      const reservation = mid * (1 - this.cfg.riskAversion * sigmaSq * qNorm);

      const baseHalf = this.cfg.baseHalfSpreadBps / 10_000;
      const skewAdj = Math.abs(qNorm) * baseHalf;
      const bidHalf = qNorm > 0 ? baseHalf + skewAdj : baseHalf;
      const askHalf = qNorm < 0 ? baseHalf + skewAdj : baseHalf;
      const bidPrice = reservation * (1 - bidHalf);
      const askPrice = reservation * (1 + askHalf);

      const skipBid = baseInv >= baseMax;
      const skipAsk = baseInv <= -baseMax;

      process.stdout.write(
        `\n${theme.muted('[mm-multi]')} ${theme.label(def.symbol)}  ` +
        `${theme.label('mid')}=${fmtUsd(mid, 4)}  ` +
        `${theme.label('r')}=${fmtUsd(reservation, 4)}  ` +
        `${theme.bid('bid')}=${fmtUsd(bidPrice, 4)} ${theme.ask('ask')}=${fmtUsd(askPrice, 4)}  ` +
        `${theme.label(def.baseSymbol)}-inv=${fmtNum(baseInv, 4)} (q̂=${qNorm.toFixed(2)})\n`,
      );

      // Cancel
      try {
        await cancelAll(this.connection, this.signer, def.symbol, { useJito: this.cfg.useJito, tipLamports: this.cfg.tipLamports });
        this.stats.totalCancels++;
      } catch (e) {
        getLogger().warn('mm-multi', `cancel-all ${def.symbol}: ${(e as Error).message}`);
        this.stats.totalErrors++;
        continue;
      }
      await new Promise((r) => setTimeout(r, 300));

      // Place bid
      if (!skipBid) {
        try {
          await placeLimit(this.connection, this.signer, {
            symbol: def.symbol, side: 'bid',
            priceUsd: bidPrice, sizeBase: this.cfg.quoteSizeBase,
            ttlSec: this.cfg.orderTtlSec, postOnly: true,
            useJito: this.cfg.useJito, tipLamports: this.cfg.tipLamports,
          });
          this.stats.totalPlaces++;
        } catch (e) {
          this.stats.totalErrors++;
          getLogger().warn('mm-multi', `${def.symbol} bid: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }

      // Place ask
      if (!skipAsk) {
        try {
          await placeLimit(this.connection, this.signer, {
            symbol: def.symbol, side: 'ask',
            priceUsd: askPrice, sizeBase: this.cfg.quoteSizeBase,
            ttlSec: this.cfg.orderTtlSec, postOnly: true,
            useJito: this.cfg.useJito, tipLamports: this.cfg.tipLamports,
          });
          this.stats.totalPlaces++;
        } catch (e) {
          this.stats.totalErrors++;
          getLogger().warn('mm-multi', `${def.symbol} ask: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  /** Detect our fills via program logs, update aggregate inventory + telemetry. */
  private async handleProgramLog(signature: string): Promise<void> {
    try {
      const ptx = await Phoenix.getPhoenixEventsFromTransactionSignature(this.connection, signature);
      const phoenix = getPhoenixClient();
      const client = await phoenix.raw();
      const walletStr = this.signer.publicKey.toBase58();

      for (const ix of ptx.instructions) {
        const marketAddr = ix.header?.market?.toBase58();
        if (!marketAddr) continue;
        // Only care about our watched markets
        const def = this.markets.find((m) => m.address === marketAddr);
        if (!def) continue;

        for (const evt of ix.events) {
          if (!Phoenix.isPhoenixMarketEventFill(evt)) continue;
          const f = evt.fields[0];
          const isMaker = f.makerId.toBase58() === walletStr;
          if (!isMaker) continue;

          const priceTicks = Phoenix.toNum(f.priceInTicks);
          const baseLots = Phoenix.toNum(f.baseLotsFilled);
          if (baseLots === 0) continue;
          const priceUsd = client.ticksToFloatPrice(priceTicks, marketAddr);
          const sizeBase = client.baseAtomsToRawBaseUnits(
            client.baseLotsToBaseAtoms(baseLots, marketAddr),
            marketAddr,
          );
          const notional = priceUsd * sizeBase;
          const mid = this.stats.mids.get(def.symbol) ?? priceUsd;
          const side: 'bid' | 'ask' = priceUsd > mid ? 'ask' : 'bid';
          const edgePerUnit = Math.abs(priceUsd - mid);

          this.stats.fills++;
          if (side === 'bid') this.stats.buyFills++; else this.stats.sellFills++;
          this.stats.dollarVolume += notional;
          this.stats.realizedEdgeUsd += edgePerUnit * sizeBase;
          this.stats.lastFillAt = Date.now();
          this.stats.fillsByMarket.set(def.symbol, (this.stats.fillsByMarket.get(def.symbol) ?? 0) + 1);

          // ASSET-LEVEL inventory update — affects ALL markets sharing these assets
          const baseDelta = side === 'bid' ? sizeBase : -sizeBase;
          const quoteDelta = side === 'bid' ? -notional : notional;
          this.stats.invByAsset.set(def.baseSymbol, (this.stats.invByAsset.get(def.baseSymbol) ?? 0) + baseDelta);
          this.stats.invByAsset.set(def.quoteSymbol, (this.stats.invByAsset.get(def.quoteSymbol) ?? 0) + quoteDelta);

          // Live ticker
          process.stdout.write(
            `\n${theme.muted('[mm-multi fill]')} ${theme.success('●')} ` +
            `${side === 'bid' ? theme.bid('BUY ') : theme.ask('SELL')} ` +
            `${theme.label(def.symbol)}  ` +
            `${fmtNum(sizeBase, 4)} @ ${fmtUsd(priceUsd, 4)}  ` +
            `${theme.label(def.baseSymbol)}-inv=${fmtNum(this.stats.invByAsset.get(def.baseSymbol) ?? 0, 4)}  ` +
            `edge=${fmtUsd(this.stats.realizedEdgeUsd, 4)}  ` +
            `${this.stats.fills} fills\n`,
          );

          // Persist
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
            title: `Multi-MM fill on ${def.symbol} — ${side === 'bid' ? 'BUY' : 'SELL'} ${sizeBase.toFixed(6)} @ $${priceUsd.toFixed(4)}`,
            body: `${def.baseSymbol} inv now ${(this.stats.invByAsset.get(def.baseSymbol) ?? 0).toFixed(6)} · total fills ${this.stats.fills}`,
            fields: { market: def.symbol, side, price: priceUsd.toFixed(4), size: sizeBase.toFixed(6), totalEdge: this.stats.realizedEdgeUsd.toFixed(4) },
            link: { label: 'view on Solscan', url: txLink(signature) },
          });
        }
      }
    } catch {
      /* decode errors common */
    }
  }
}
