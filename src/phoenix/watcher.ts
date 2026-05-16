/**
 * Multi-market live watcher.
 *
 * Subscribes to each market's account (Phoenix stores the full book inline in
 * the market account, so any change pushes a fresh snapshot) AND to Phoenix
 * program logs for a real-time fill ticker.
 *
 * Renders a full-screen dashboard that re-paints on every update, throttled to
 * one frame per ~150ms so a busy market doesn't cause flicker.
 */

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import * as readline from 'readline';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getPhoenixClient } from './client.js';
import { findMarket, MarketDef } from './markets.js';
import { placeLimit, cancelAll } from './orders.js';
import { theme } from '../cli/theme.js';
import { fmtNum, fmtUsd, pad } from '../utils/format.js';
import { depthBar } from '../cli/renderer.js';
import { getLogger } from '../utils/logger.js';

export interface FillTickerEntry {
  ts: number;
  marketSymbol: string;
  priceUsd: number;
  sizeBase: number;
  side: 'bid' | 'ask';
}

export interface MyOrder {
  side: 'bid' | 'ask';
  priceUsd: number;
  sizeBase: number;
  orderSeq: string;
}

export interface MarketSnap {
  def: MarketDef;
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spreadBps: number | null;
  bidDepthBase: number;
  askDepthBase: number;
  lastUpdate: number;
  myOrders: MyOrder[];
}

export class Watcher {
  private connection: Connection;
  private markets: MarketDef[];
  private snaps = new Map<string, MarketSnap>();
  private subIds: number[] = [];
  private logSubId: number | null = null;
  private renderTimer: ReturnType<typeof setInterval> | null = null;
  private renderPending = false;
  private fills: FillTickerEntry[] = [];
  private static readonly MAX_FILLS = 12;
  private static readonly RENDER_FPS_MS = 250;

  private wallet: PublicKey | null;
  private signer: Keypair | null;

  // ─── Hotkey state ──────────────────────────────────────────────────────────
  private focusedIdx = 0;
  private armed = false;            // safety: must explicitly arm via space before any order fires
  private hotkeySize = 0.05;        // base units per hotkey order
  private hotkeyTtlSec = 30;
  private flash: { msg: string; until: number } | null = null;
  private keypressHandler: ((str: string | undefined, key: { name?: string; sequence?: string; ctrl?: boolean }) => void) | null = null;

  constructor(connection: Connection, markets: MarketDef[], wallet: PublicKey | null = null, signer: Keypair | null = null) {
    this.connection = connection;
    this.markets = markets;
    this.wallet = wallet;
    this.signer = signer;
    for (const m of markets) {
      this.snaps.set(m.address, {
        def: m, bestBid: null, bestAsk: null, mid: null, spreadBps: null,
        bidDepthBase: 0, askDepthBase: 0, lastUpdate: 0, myOrders: [],
      });
    }
  }

  private setFlash(msg: string, ms = 3000): void {
    this.flash = { msg, until: Date.now() + ms };
    this.requestRender();
  }

  private async fireBid(): Promise<void> {
    if (!this.signer || !this.armed) {
      this.setFlash(this.armed ? 'no signer wallet' : 'not armed — press SPACE to arm', 2500);
      return;
    }
    const def = this.markets[this.focusedIdx];
    const snap = this.snaps.get(def.address);
    if (!snap?.bestBid) { this.setFlash('no bid available', 2000); return; }
    try {
      await placeLimit(this.connection, this.signer, {
        symbol: def.symbol, side: 'bid',
        priceUsd: snap.bestBid, sizeBase: this.hotkeySize,
        ttlSec: this.hotkeyTtlSec, postOnly: true,
      });
      this.setFlash(`✓ BID ${this.hotkeySize} ${def.baseSymbol} @ ${fmtUsd(snap.bestBid, 4)}`, 3000);
    } catch (e) {
      this.setFlash(`✗ bid failed: ${(e as Error).message.slice(0, 60)}`, 4000);
    }
  }

  private async fireAsk(): Promise<void> {
    if (!this.signer || !this.armed) {
      this.setFlash(this.armed ? 'no signer wallet' : 'not armed — press SPACE to arm', 2500);
      return;
    }
    const def = this.markets[this.focusedIdx];
    const snap = this.snaps.get(def.address);
    if (!snap?.bestAsk) { this.setFlash('no ask available', 2000); return; }
    try {
      await placeLimit(this.connection, this.signer, {
        symbol: def.symbol, side: 'ask',
        priceUsd: snap.bestAsk, sizeBase: this.hotkeySize,
        ttlSec: this.hotkeyTtlSec, postOnly: true,
      });
      this.setFlash(`✓ ASK ${this.hotkeySize} ${def.baseSymbol} @ ${fmtUsd(snap.bestAsk, 4)}`, 3000);
    } catch (e) {
      this.setFlash(`✗ ask failed: ${(e as Error).message.slice(0, 60)}`, 4000);
    }
  }

  private async fireCancelAll(): Promise<void> {
    if (!this.signer || !this.armed) {
      this.setFlash(this.armed ? 'no signer wallet' : 'not armed — press SPACE to arm', 2500);
      return;
    }
    const def = this.markets[this.focusedIdx];
    try {
      const sig = await cancelAll(this.connection, this.signer, def.symbol);
      this.setFlash(`✓ cancel-all on ${def.symbol}: ${sig.slice(0, 12)}…`, 3000);
    } catch (e) {
      this.setFlash(`✗ cancel failed: ${(e as Error).message.slice(0, 60)}`, 4000);
    }
  }

  private installHotkeys(onQuit: () => void): void {
    if (!process.stdin.isTTY) return;
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    this.keypressHandler = (_str, key) => {
      if (!key) return;
      if (key.ctrl && key.name === 'c') { onQuit(); return; }
      switch (key.name) {
        case 'q': onQuit(); return;
        case 'space': this.armed = !this.armed; this.setFlash(this.armed ? 'ARMED — hotkeys live' : 'disarmed', 1500); return;
        case 'j':
        case 'down': this.focusedIdx = (this.focusedIdx + 1) % this.markets.length; this.requestRender(); return;
        case 'k':
        case 'up': this.focusedIdx = (this.focusedIdx - 1 + this.markets.length) % this.markets.length; this.requestRender(); return;
        case 'b': this.fireBid().catch(() => {}); return;
        case 'a': this.fireAsk().catch(() => {}); return;
        case 'c': this.fireCancelAll().catch(() => {}); return;
      }
      // Size adjustments
      if (key.sequence === '+' || key.sequence === '=') {
        this.hotkeySize *= 2; this.setFlash(`size ${this.hotkeySize}`, 1000); return;
      }
      if (key.sequence === '-' || key.sequence === '_') {
        this.hotkeySize = Math.max(0.0001, this.hotkeySize / 2); this.setFlash(`size ${this.hotkeySize}`, 1000); return;
      }
    };
    process.stdin.on('keypress', this.keypressHandler);
  }

  private uninstallHotkeys(): void {
    if (this.keypressHandler) {
      process.stdin.off('keypress', this.keypressHandler);
      this.keypressHandler = null;
    }
    if (process.stdin.isTTY) {
      try { process.stdin.setRawMode(false); } catch { /* ignore */ }
    }
  }

  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly REFRESH_INTERVAL_MS = 4_000;

  async start(): Promise<void> {
    const phoenix = getPhoenixClient();

    // Show loading splash immediately
    this.render();

    // Load all watched markets in PARALLEL (was sequential — caused 10+s startup)
    await Promise.all(this.markets.map((m) => phoenix.addMarket(m.symbol).catch((e) => {
      getLogger().warn('watcher', `failed to load ${m.symbol}: ${(e as Error).message}`);
    })));

    await phoenix.refreshAll();
    for (const m of this.markets) this.computeSnap(m.address);
    this.render(); // re-render with real data

    // Subscribe to each market account for push updates
    for (const m of this.markets) {
      const subId = this.connection.onAccountChange(
        new PublicKey(m.address),
        async () => {
          try {
            await phoenix.refresh(m.address, true);
            this.computeSnap(m.address);
            this.requestRender();
          } catch (e) {
            getLogger().debug('watcher', `account-update handler failed for ${m.symbol}: ${(e as Error).message}`);
          }
        },
        { commitment: 'confirmed' },
      );
      this.subIds.push(subId);
    }

    // Subscribe to Phoenix program logs for the fill ticker
    this.logSubId = this.connection.onLogs(
      Phoenix.PROGRAM_ID,
      (logsInfo) => this.handleProgramLog(logsInfo.signature, logsInfo.logs),
      'confirmed',
    );

    // Periodic poll as a fallback (quiet markets won't push onAccountChange)
    this.refreshTimer = setInterval(async () => {
      try {
        await phoenix.refreshAll();
        for (const m of this.markets) this.computeSnap(m.address);
        this.requestRender();
      } catch { /* ignore */ }
    }, Watcher.REFRESH_INTERVAL_MS);
    this.refreshTimer.unref?.();

    // Render cadence
    this.renderTimer = setInterval(() => {
      if (this.renderPending || (this.flash && this.flash.until + 250 < Date.now())) {
        this.renderPending = false;
        this.render();
      }
    }, Watcher.RENDER_FPS_MS);
    this.renderTimer.unref?.();
  }

  /** Install hotkey handler. Calls onQuit() when user presses q or Ctrl+C. */
  enableHotkeys(onQuit: () => void): void {
    if (!this.signer) return; // no signer, hotkeys would be useless
    this.installHotkeys(onQuit);
  }

  async stop(): Promise<void> {
    this.uninstallHotkeys();
    for (const id of this.subIds) {
      try { await this.connection.removeAccountChangeListener(id); } catch { /* ignore */ }
    }
    this.subIds = [];
    if (this.logSubId !== null) {
      try { await this.connection.removeOnLogsListener(this.logSubId); } catch { /* ignore */ }
      this.logSubId = null;
    }
    if (this.renderTimer) { clearInterval(this.renderTimer); this.renderTimer = null; }
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
  }

  private requestRender(): void { this.renderPending = true; }

  private async handleProgramLog(signature: string, _logs: string[]): Promise<void> {
    // Fetch & decode events for this tx (best-effort, async to keep handler fast)
    try {
      const ptx = await Phoenix.getPhoenixEventsFromTransactionSignature(this.connection, signature);
      const phoenix = getPhoenixClient();
      const client = await phoenix.raw();
      for (const ix of ptx.instructions) {
        // header is top-level on PhoenixEventsFromInstruction (not an event)
        const marketAddr = ix.header?.market?.toBase58();
        if (!marketAddr) continue;
        const def = findMarket(marketAddr);
        if (!def || !this.snaps.has(marketAddr)) continue;

        for (const evt of ix.events) {
          if (!Phoenix.isPhoenixMarketEventFill(evt)) continue;
          const f = evt.fields[0];
          const priceTicks = Phoenix.toNum(f.priceInTicks);
          const baseLots = Phoenix.toNum(f.baseLotsFilled);
          if (baseLots === 0) continue;
          const priceUsd = client.ticksToFloatPrice(priceTicks, marketAddr);
          const sizeBase = client.baseAtomsToRawBaseUnits(
            client.baseLotsToBaseAtoms(baseLots, marketAddr),
            marketAddr,
          );
          // Maker side from orderSequenceNumber sign (canonical SDK pattern).
          // We display the TAKER side in the watcher feed (the side that lifted
          // the resting order) — which is the opposite of the maker side.
          const dir = Phoenix.sign(Phoenix.toBN(f.orderSequenceNumber).fromTwos(64));
          const makerSide: 'bid' | 'ask' = dir < 0 ? 'bid' : 'ask';
          const side: 'bid' | 'ask' = makerSide === 'bid' ? 'ask' : 'bid';
          this.fills.unshift({ ts: Date.now(), marketSymbol: def.symbol, priceUsd, sizeBase, side });
          if (this.fills.length > Watcher.MAX_FILLS) this.fills.length = Watcher.MAX_FILLS;
        }
      }
      this.requestRender();
    } catch {
      /* log fetch failed, skip */
    }
  }

  private computeSnap(address: string): void {
    const snap = this.snaps.get(address);
    if (!snap) return;
    try {
      const phoenix = getPhoenixClient();
      // Synchronous read of cached state
      // Note: this only works after phoenix.refresh() — caller ensures freshness
      const client = (phoenix as unknown as { client: Phoenix.Client | null }).client;
      const state = client?.marketStates.get(address);
      if (!state) return;
      const ladder = state.getUiLadder(10);
      const bb = ladder.bids[0]?.price ?? null;
      const ba = ladder.asks[0]?.price ?? null;
      let mid: number | null = null;
      let spread: number | null = null;
      if (bb !== null && ba !== null && bb > 0 && ba > 0) {
        mid = (bb + ba) / 2;
        spread = ((ba - bb) / mid) * 10_000;
      }
      snap.bestBid = bb;
      snap.bestAsk = ba;
      snap.mid = mid;
      snap.spreadBps = spread;
      snap.bidDepthBase = ladder.bids.reduce((s, l) => s + l.quantity, 0);
      snap.askDepthBase = ladder.asks.reduce((s, l) => s + l.quantity, 0);
      snap.lastUpdate = Date.now();

      // ─── Own orders for this market (filtered from the same cached state) ──
      if (this.wallet && client) {
        const traderStr = this.wallet.toBase58();
        const traderIndex = state.data.traderPubkeyToTraderIndex.get(traderStr);
        const orders: MyOrder[] = [];
        if (traderIndex !== undefined) {
          for (const [orderId, resting] of state.data.bids) {
            if (Phoenix.toNum(resting.traderIndex) !== traderIndex) continue;
            const priceTicks = Phoenix.toNum(orderId.priceInTicks);
            const baseLots = Phoenix.toNum(resting.numBaseLots);
            orders.push({
              side: 'bid',
              priceUsd: client.ticksToFloatPrice(priceTicks, address),
              sizeBase: client.baseAtomsToRawBaseUnits(client.baseLotsToBaseAtoms(baseLots, address), address),
              orderSeq: Phoenix.toNum(orderId.orderSequenceNumber).toString(),
            });
          }
          for (const [orderId, resting] of state.data.asks) {
            if (Phoenix.toNum(resting.traderIndex) !== traderIndex) continue;
            const priceTicks = Phoenix.toNum(orderId.priceInTicks);
            const baseLots = Phoenix.toNum(resting.numBaseLots);
            orders.push({
              side: 'ask',
              priceUsd: client.ticksToFloatPrice(priceTicks, address),
              sizeBase: client.baseAtomsToRawBaseUnits(client.baseLotsToBaseAtoms(baseLots, address), address),
              orderSeq: Phoenix.toNum(orderId.orderSequenceNumber).toString(),
            });
          }
        }
        snap.myOrders = orders;
      }
    } catch {
      /* leave stale */
    }
  }

  private render(): void {
    // Move cursor to top-left, clear from cursor down
    process.stdout.write('\x1b[H\x1b[J');

    const headerLine = theme.highlight('  PHOENIX TERMINAL') + theme.muted('  ·  live multi-market watch  ·  ') + theme.muted(new Date().toLocaleTimeString());
    process.stdout.write(headerLine + '\n\n');

    // Header row
    process.stdout.write(
      pad(theme.muted('MARKET'), 18) +
      pad(theme.muted('BID'), 14, 'right') +
      pad(theme.muted('ASK'), 14, 'right') +
      pad(theme.muted('MID'), 14, 'right') +
      pad(theme.muted('SPREAD'), 10, 'right') +
      pad(theme.muted('DEPTH'), 22) + '\n',
    );
    process.stdout.write(theme.muted('─'.repeat(94)) + '\n');

    // Find max depth for normalized bars
    let maxDepth = 0;
    for (const snap of this.snaps.values()) {
      maxDepth = Math.max(maxDepth, snap.bidDepthBase + snap.askDepthBase);
    }

    let idx = 0;
    for (const snap of this.snaps.values()) {
      const loading = snap.lastUpdate === 0;
      const bidStr = loading ? theme.muted('loading…') : snap.bestBid !== null ? theme.bid(fmtUsd(snap.bestBid, 4)) : theme.muted('—');
      const askStr = loading ? theme.muted('') : snap.bestAsk !== null ? theme.ask(fmtUsd(snap.bestAsk, 4)) : theme.muted('—');
      const midStr = loading ? theme.muted('') : snap.mid !== null ? theme.value(fmtUsd(snap.mid, 4)) : theme.muted('—');
      const spreadStr = snap.spreadBps !== null
        ? (snap.spreadBps < 10 ? theme.success : snap.spreadBps < 50 ? theme.warning : theme.error)(`${snap.spreadBps.toFixed(1)}bps`)
        : theme.muted('—');
      const bid = depthBar(snap.bidDepthBase, Math.max(maxDepth, 1), 10, 'bid');
      const ask = depthBar(snap.askDepthBase, Math.max(maxDepth, 1), 10, 'ask');
      const focusMarker = (this.signer && idx === this.focusedIdx) ? theme.highlight('▸ ') : '  ';
      process.stdout.write(
        focusMarker +
        pad(theme.label(snap.def.symbol), 16) +
        pad(bidStr, 14, 'right') +
        pad(askStr, 14, 'right') +
        pad(midStr, 14, 'right') +
        pad(spreadStr, 10, 'right') +
        '  ' + bid + theme.muted('│') + ask + '\n',
      );
      idx++;
    }

    // ─── Open orders panel ───
    if (this.wallet) {
      const allMyOrders: Array<{ snap: MarketSnap; o: MyOrder }> = [];
      for (const snap of this.snaps.values()) {
        for (const o of snap.myOrders) allMyOrders.push({ snap, o });
      }
      process.stdout.write(
        '\n' + theme.muted('─ Your open orders ').padEnd(94, '─') +
        (allMyOrders.length > 0 ? theme.muted(`  (${allMyOrders.length})`) : '') + '\n',
      );
      if (allMyOrders.length === 0) {
        process.stdout.write(theme.muted('  (no resting orders on watched markets)\n'));
      } else {
        // Sort: bids descending by price, asks ascending
        allMyOrders.sort((a, b) => {
          if (a.snap.def.symbol !== b.snap.def.symbol) return a.snap.def.symbol.localeCompare(b.snap.def.symbol);
          if (a.o.side !== b.o.side) return a.o.side === 'ask' ? -1 : 1;
          return a.o.side === 'bid' ? b.o.priceUsd - a.o.priceUsd : a.o.priceUsd - b.o.priceUsd;
        });
        process.stdout.write(
          '  ' + pad(theme.muted('MARKET'), 14) +
          pad(theme.muted('SIDE'), 6) +
          pad(theme.muted('PRICE'), 14, 'right') +
          pad(theme.muted('SIZE'), 14, 'right') +
          pad(theme.muted('NOTIONAL'), 14, 'right') +
          '  ' + theme.muted('vs MID') + '\n',
        );
        for (const { snap, o } of allMyOrders) {
          const sideStr = o.side === 'bid' ? theme.bid('BID ') : theme.ask('ASK ');
          const notional = o.priceUsd * o.sizeBase;
          let distStr = theme.muted('—');
          if (snap.mid !== null && snap.mid > 0) {
            const bps = ((o.priceUsd - snap.mid) / snap.mid) * 10_000;
            const color = Math.abs(bps) < 20 ? theme.warning : theme.muted;
            distStr = color(`${bps >= 0 ? '+' : ''}${bps.toFixed(1)}bps`);
          }
          process.stdout.write(
            '  ' + pad(theme.label(snap.def.symbol), 14) +
            pad(sideStr, 6) +
            pad(theme.value(fmtUsd(o.priceUsd, 4)), 14, 'right') +
            pad(theme.value(fmtNum(o.sizeBase, 4)), 14, 'right') +
            pad(theme.value(fmtUsd(notional, 2)), 14, 'right') +
            '  ' + distStr + '\n',
          );
        }
      }
    }

    // ─── Fill ticker ───
    process.stdout.write('\n' + theme.muted('─ Recent fills ').padEnd(94, '─') + '\n');
    if (this.fills.length === 0) {
      process.stdout.write(theme.muted('  (waiting for fills…)\n'));
    } else {
      for (const f of this.fills) {
        const sideStr = f.side === 'bid' ? theme.bid('BUY ') : theme.ask('SELL');
        const t = new Date(f.ts).toLocaleTimeString();
        process.stdout.write(
          `  ${theme.muted(t)}  ${sideStr}  ` +
          pad(theme.label(f.marketSymbol), 14) +
          pad(theme.value(fmtUsd(f.priceUsd, 4)), 14, 'right') +
          pad(theme.value(fmtNum(f.sizeBase, 4)), 14, 'right') +
          '\n',
        );
      }
    }
    // ─── Status / hotkey hint line ───
    if (this.signer) {
      const focused = this.markets[this.focusedIdx];
      const armedStr = this.armed ? theme.error('● ARMED') : theme.success('○ safe');
      process.stdout.write(
        '\n' + theme.muted('─ Hotkeys ').padEnd(94, '─') + '\n' +
        '  ' + armedStr +
        '  ' + theme.muted('focus:') + ' ' + theme.highlight(focused.symbol) +
        '  ' + theme.muted('size:') + ' ' + theme.value(String(this.hotkeySize)) + ' ' + focused.baseSymbol +
        '\n' +
        '  ' + theme.muted('[space] arm   [j/k] focus   [b] bid   [a] ask   [c] cancel-all   [+/-] size   [q] quit') + '\n',
      );
    }
    if (this.flash && this.flash.until > Date.now()) {
      process.stdout.write('\n  ' + theme.accent('› ') + this.flash.msg + '\n');
    }
    process.stdout.write('\n' + theme.muted(this.signer ? 'Hotkeys active — Ctrl+C or [q] to exit.' : 'Press Ctrl+C to exit.') + '\n');
  }
}
