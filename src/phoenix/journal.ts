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
  /** Quote-per-base price (NOT necessarily USD — see quoteSymbol). For
   *  SOL/USDC it's USD/SOL; for JitoSOL/SOL it's SOL/JitoSOL. */
  priceUsd: number;
  sizeBase: number;
  /** sizeBase × priceUsd in quote-of-market units. For non-USD-quoted
   *  markets (JitoSOL/SOL, mSOL/SOL) this is a quote-token amount, NOT
   *  USD. Use the quoteSymbol field to disambiguate. */
  notionalUsd: number;
  isMaker: number; // 0 or 1 (SQLite bool)
  feeUsd: number;
  blockTime: number; // unix seconds
  slot: number;
  /** Quote currency symbol (e.g. 'USDC', 'SOL'). Lets cross-market
   *  aggregation segregate values by unit. Defaults to 'USDC' for
   *  rows migrated from the pre-quoteSymbol schema. */
  quoteSymbol?: string;
}

export interface MarketPnl {
  market: string;
  /** Quote currency for THIS market (USDC, SOL, USDT, ...). All notional /
   *  PnL fields below are denominated in this currency. */
  quoteSymbol: string;
  fills: number;
  buyVolumeBase: number;
  sellVolumeBase: number;
  buyNotionalUsd: number;       // really: in quoteSymbol units
  sellNotionalUsd: number;      // really: in quoteSymbol units
  inventoryBase: number;        // current net inventory
  avgCostUsd: number;           // really: avgCost in quoteSymbol per base
  realizedPnlUsd: number;       // really: realized PnL in quoteSymbol
  makerVolumeUsd: number;       // really: in quoteSymbol units
  takerVolumeUsd: number;       // really: in quoteSymbol units
  feesUsd: number;
  firstFillAt: number | null;
  lastFillAt: number | null;
}

/** Aggregate totals split by quote currency so we don't sum USDC and SOL. */
export interface PnlTotalsByQuote {
  quoteSymbol: string;
  totalVolume: number;        // in quoteSymbol units
  totalRealizedPnl: number;   // in quoteSymbol units
  totalFees: number;          // in quoteSymbol units
  makerVolume: number;
  takerVolume: number;
}

export interface PnlSummary {
  wallet: string;
  totalFills: number;
  /** Sum of buy+sell notional for USDC-quoted markets ONLY. Use
   *  `totalsByQuote` for the per-currency breakdown. */
  totalVolumeUsd: number;
  totalRealizedPnlUsd: number;
  totalFeesUsd: number;
  makerVolumeUsd: number;
  takerVolumeUsd: number;
  makerRatio: number;
  /** Per-quote-currency aggregates. USDC + SOL + USDT + ... segregated
   *  so values are never summed across mismatched units. */
  totalsByQuote: PnlTotalsByQuote[];
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
        quoteSymbol TEXT NOT NULL DEFAULT 'USDC',
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
    // Migration 1: old schema (PRIMARY KEY signature alone) → composite (signature, sub_index).
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
            quoteSymbol TEXT NOT NULL DEFAULT 'USDC',
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
      // Best-effort — fresh CREATE TABLE above still applies on a new db.
    }
    // Migration 2: add `quoteSymbol` column if missing (composite-PK schema
    // pre-dates it). SQLite supports ADD COLUMN with DEFAULT, no rebuild needed.
    try {
      const cols = this.db.prepare(`PRAGMA table_info(fills)`).all() as Array<{ name: string }>;
      const hasQuoteSymbol = cols.some((c) => c.name === 'quoteSymbol');
      if (!hasQuoteSymbol && cols.length > 0) {
        this.db.exec(`ALTER TABLE fills ADD COLUMN quoteSymbol TEXT NOT NULL DEFAULT 'USDC'`);
        // Backfill known non-USDC-quoted markets so old rows are correctly tagged.
        this.db.exec(`UPDATE fills SET quoteSymbol = 'SOL'  WHERE market IN ('JitoSOL/SOL', 'mSOL/SOL')`);
        this.db.exec(`UPDATE fills SET quoteSymbol = 'USDT' WHERE market = 'SOL/USDT'`);
      }
    } catch {
      // Best-effort
    }
  }

  /**
   * Insert a fill. `subIndex` distinguishes multiple fills emitted within the
   * same transaction (Phoenix can fill against many resting orders in one ix).
   * Defaults to 0 for callers that have only one fill per tx.
   */
  insertFill(f: JournalFill, subIndex: number = 0): boolean {
    // Default to USDC if not supplied (existing callers; we infer from
    // market def at the call sites for new code).
    const quoteSymbol = f.quoteSymbol ?? inferQuoteSymbol(f.market);
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO fills (signature, sub_index, wallet, market, side, priceUsd, sizeBase, notionalUsd, isMaker, feeUsd, blockTime, slot, quoteSymbol)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(f.signature, subIndex, f.wallet, f.market, f.side, f.priceUsd, f.sizeBase, f.notionalUsd, f.isMaker, f.feeUsd, f.blockTime, f.slot, quoteSymbol);
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

  /**
   * Wallet-wide PnL summary, computed by replaying fills per market with WAC.
   *
   * IMPORTANT: previously this summed `notionalUsd` across all markets, but the
   * value is actually quote-of-market — for JitoSOL/SOL that's SOL, not USD.
   * Adding USDC + SOL produces nonsense. We now segregate totals by quote
   * currency in `totalsByQuote`, and `totalVolumeUsd` (plus the `*Usd` fields)
   * reports ONLY the USDC-quoted slice. UI should render `totalsByQuote` to
   * show the full picture without unit-mixing.
   */
  summary(wallet: string): PnlSummary {
    const markets = this.db
      .prepare(`SELECT DISTINCT market FROM fills WHERE wallet = ?`)
      .all(wallet) as { market: string }[];

    const perMarket: MarketPnl[] = [];
    const days = new Set<string>();
    let totalFills = 0;
    const byQuote = new Map<string, PnlTotalsByQuote>();

    for (const { market } of markets) {
      const fills = this.marketFills(wallet, market);
      const m = computeMarketPnl(market, fills);
      perMarket.push(m);
      totalFills += m.fills;
      const q = m.quoteSymbol;
      const acc = byQuote.get(q) ?? {
        quoteSymbol: q,
        totalVolume: 0, totalRealizedPnl: 0, totalFees: 0,
        makerVolume: 0, takerVolume: 0,
      };
      acc.totalVolume += m.buyNotionalUsd + m.sellNotionalUsd;
      acc.totalRealizedPnl += m.realizedPnlUsd;
      acc.totalFees += m.feesUsd;
      acc.makerVolume += m.makerVolumeUsd;
      acc.takerVolume += m.takerVolumeUsd;
      byQuote.set(q, acc);
      for (const f of fills) {
        days.add(new Date(f.blockTime * 1000).toISOString().slice(0, 10));
      }
    }

    perMarket.sort((a, b) => (b.buyNotionalUsd + b.sellNotionalUsd) - (a.buyNotionalUsd + a.sellNotionalUsd));

    // Back-compat: the *Usd fields report the USDC-quoted slice ONLY so they
    // never mix units. Callers needing non-USDC totals should read totalsByQuote.
    const usdc = byQuote.get('USDC') ?? {
      quoteSymbol: 'USDC',
      totalVolume: 0, totalRealizedPnl: 0, totalFees: 0,
      makerVolume: 0, takerVolume: 0,
    };

    return {
      wallet,
      totalFills,
      totalVolumeUsd: usdc.totalVolume,
      totalRealizedPnlUsd: usdc.totalRealizedPnl,
      totalFeesUsd: usdc.totalFees,
      makerVolumeUsd: usdc.makerVolume,
      takerVolumeUsd: usdc.takerVolume,
      makerRatio: usdc.totalVolume > 0 ? usdc.makerVolume / usdc.totalVolume : 0,
      totalsByQuote: Array.from(byQuote.values()).sort((a, b) => b.totalVolume - a.totalVolume),
      uniqueMarkets: markets.length,
      uniqueActiveDays: days.size,
      perMarket,
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Best-effort quote symbol inference from a market symbol string. Used as a
 * fallback when the caller didn't supply one (legacy rows / older callers).
 * Falls back to 'USDC' for unknown markets to match the schema default.
 */
function inferQuoteSymbol(market: string): string {
  const slashIdx = market.indexOf('/');
  if (slashIdx < 0) return 'USDC';
  return market.slice(slashIdx + 1);
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

  // Quote symbol — prefer the row-level value (set at write time from the
  // market def) but fall back to inferring from the market string for legacy
  // rows where every row was silently labeled as USDC.
  const quoteSymbol = fills[0]?.quoteSymbol ?? inferQuoteSymbol(market);
  return {
    market,
    quoteSymbol,
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
        // Canonical per-fill side detection (SDK example fillListener.ts):
        //   bid orders → seqNum twos-complement-negative → sign(fromTwos(64)) < 0
        //   ask orders → seqNum positive                  → sign(fromTwos(64)) > 0
        // This is the MAKER side. If our wallet is the maker, that's our side;
        // if we're the taker, our side is the opposite.
        //
        // Previously this used a tx-level NET balance delta, which mis-attributed
        // every fill in a multi-fill mixed-side tx (e.g. router that hit both
        // sides of an internal book, or any self-crossing tx).
        const dir = Phoenix.sign(Phoenix.toBN(f.orderSequenceNumber).fromTwos(64));
        const makerSide: 'bid' | 'ask' = dir < 0 ? 'bid' : 'ask';
        const side: 'bid' | 'ask' = isMaker
          ? makerSide
          : (makerSide === 'bid' ? 'ask' : 'bid');
        const notional = priceUsd * sizeBase;
        const ok = journal.insertFill({
          signature, wallet: walletStr, market: def.symbol, side,
          priceUsd, sizeBase, notionalUsd: notional, isMaker: isMaker ? 1 : 0,
          feeUsd: isMaker ? 0 : feeUsd,
          blockTime, slot,
          quoteSymbol: def.quoteSymbol,
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
    if (newestSig === null) newestSig = batch[0]!.signature; // length checked above
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

    before = batch[batch.length - 1]!.signature; // length checked above
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
