/**
 * Risk dashboard — single full-screen aggregating every signal:
 *   - Wallet balances + SOL
 *   - Asset inventory (wallet + seat free-funds)
 *   - Pyth oracle vs Phoenix mid divergence (per asset)
 *   - Active single-market maker (if running)
 *   - Active multi-market maker (if running)
 *   - PnL summary from local journal
 *   - RPC health + slot lag
 *   - Signing-guard limits
 *
 * Refreshes every 5s. Uses inline screen-clear (same approach as watcher).
 */

import { PublicKey } from '@solana/web3.js';
import { WalletManager } from '../wallet/walletManager.js';
import { RpcManager } from '../network/rpc-manager.js';
import { Maker } from './maker.js';
import { MultiMarketMaker } from './multi-maker.js';
import { getJournal } from './journal.js';
import { getFreeFunds } from './vault.js';
import { fetchPythPrice, supportedSymbols } from './oracle.js';
import { fetchOrderbook } from './orderbook.js';
import { MARKETS } from './markets.js';
import { getSigningGuard } from '../security/signing-guard.js';
import { theme } from '../cli/theme.js';
import { fmtNum, fmtUsd } from '../utils/format.js';
import { getLogger } from '../utils/logger.js';

const REFRESH_MS = 5_000;

export interface DashboardDeps {
  wallet: WalletManager;
  rpc: RpcManager;
  maker: () => Maker | null;
  multiMaker: () => MultiMarketMaker | null;
  simulationMode: () => boolean;
}

export class Dashboard {
  private deps: DashboardDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  // Cached signals
  private rpcHealth: { label: string; healthy: boolean; latencyMs: number; slot?: number; slotLag?: number } | null = null;
  private balances: { sol: number; tokens: Array<{ symbol: string; mint: string; amount: number }> } | null = null;
  private oracleByAsset = new Map<string, number | null>();
  private phoenixMidByAsset = new Map<string, number | null>();
  private freeFundsByMarket = new Map<string, { baseUnits: number; quoteUnits: number } | null>();

  constructor(deps: DashboardDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.refresh();
    this.render();
    this.timer = setInterval(async () => {
      try { await this.refresh(); this.render(); }
      catch (e) { getLogger().debug('dashboard', `tick: ${(e as Error).message}`); }
    }, REFRESH_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Pull fresh data from all sources. Best-effort: failures cached as null/empty. */
  private async refresh(): Promise<void> {
    // Wallet balances
    if (this.deps.wallet.hasAddress) {
      try { this.balances = await this.deps.wallet.getTokenBalances(); } catch { this.balances = null; }
    }
    // RPC health
    try {
      this.rpcHealth = await this.deps.rpc.checkOne(this.deps.rpc.active);
    } catch { this.rpcHealth = null; }
    // Oracle vs Phoenix for the major USDC-quoted assets
    const trackedAssets = ['SOL', 'JitoSOL', 'mSOL', 'JTO', 'JUP'];
    await Promise.all(trackedAssets.map(async (sym) => {
      this.oracleByAsset.set(sym, await fetchPythPrice(sym).catch(() => null));
      const market = MARKETS.find((m) => m.baseSymbol === sym && m.quoteSymbol === 'USDC');
      if (market) {
        try {
          const book = await fetchOrderbook(market.symbol, 1, false);
          this.phoenixMidByAsset.set(sym, book.midUsd);
        } catch {
          this.phoenixMidByAsset.set(sym, null);
        }
      }
    }));
    // Seat free funds for the deepest markets the user might have deposits in
    if (this.deps.wallet.hasAddress) {
      const pk = this.deps.wallet.getPublicKey()!;
      const seatMarkets = ['SOL/USDC', 'SOL/USDT', 'JitoSOL/USDC'];
      await Promise.all(seatMarkets.map(async (sym) => {
        const ff = await getFreeFunds(sym, pk).catch(() => null);
        const phoenix = await import('./client.js').then(m => m.getPhoenixClient());
        const client = await phoenix.raw().catch(() => null);
        if (!ff || !client) { this.freeFundsByMarket.set(sym, null); return; }
        const market = MARKETS.find((m) => m.symbol === sym)!;
        const baseUnits = client.baseAtomsToRawBaseUnits(client.baseLotsToBaseAtoms(ff.baseLots, market.address), market.address);
        const quoteUnits = client.quoteAtomsToQuoteUnits(client.quoteLotsToQuoteAtoms(ff.quoteLots, market.address), market.address);
        this.freeFundsByMarket.set(sym, { baseUnits, quoteUnits });
      }));
    }
  }

  private render(): void {
    process.stdout.write('\x1b[H\x1b[J');
    const w = this.deps.wallet;
    const ts = new Date().toLocaleTimeString();
    process.stdout.write(theme.header('  PHOENIX TERMINAL') + theme.muted('  ·  RISK DASHBOARD  ·  ') + theme.muted(ts) + '\n');
    process.stdout.write(theme.muted('═'.repeat(94)) + '\n');

    // ─── WALLET ───
    process.stdout.write('\n' + theme.section('  WALLET') + '\n');
    process.stdout.write('  ' + theme.muted('─'.repeat(92)) + '\n');
    if (!w.hasAddress) {
      process.stdout.write(theme.warning('  no wallet connected\n'));
    } else {
      const modeTag = this.deps.simulationMode() ? theme.success('paper') : theme.error('LIVE');
      const signTag = w.isReadOnly ? theme.warning('read-only') : theme.success('signing');
      process.stdout.write(`  ${theme.label('address  ')} ${w.address}\n`);
      process.stdout.write(`  ${theme.label('mode     ')} ${modeTag}   ${signTag}\n`);
      if (this.balances) {
        process.stdout.write(`  ${theme.label('SOL      ')} ${theme.value(fmtNum(this.balances.sol, 4))}\n`);
        const tokenStr = this.balances.tokens
          .filter((t) => t.symbol !== 'UNKNOWN')
          .map((t) => `${theme.label(t.symbol)} ${theme.value(fmtNum(t.amount, 4))}`)
          .join('   ');
        if (tokenStr) process.stdout.write(`  ${theme.label('tokens   ')} ${tokenStr}\n`);
      }
    }

    // ─── ORACLE DIVERGENCE ───
    process.stdout.write('\n' + theme.section('  ORACLE  ↔  PHOENIX') + '\n');
    process.stdout.write('  ' + theme.muted('─'.repeat(92)) + '\n');
    process.stdout.write(`  ${theme.muted('ASSET'.padEnd(10))}${theme.muted('PYTH'.padStart(14))}${theme.muted('PHOENIX MID'.padStart(16))}${theme.muted('DEVIATION'.padStart(14))}\n`);
    for (const [asset, pyth] of this.oracleByAsset) {
      const mid = this.phoenixMidByAsset.get(asset) ?? null;
      let dev = '—';
      let devColor = theme.muted;
      if (pyth !== null && mid !== null && mid > 0 && pyth > 0) {
        const bps = ((mid - pyth) / pyth) * 10_000;
        dev = `${bps >= 0 ? '+' : ''}${bps.toFixed(1)}bps`;
        devColor = Math.abs(bps) < 10 ? theme.success : Math.abs(bps) < 50 ? theme.warning : theme.error;
      }
      process.stdout.write(
        `  ${theme.label(asset.padEnd(10))}` +
        `${(pyth !== null ? fmtUsd(pyth, 4) : '—').padStart(14)}` +
        `${(mid !== null && mid > 0 ? fmtUsd(mid, 4) : '—').padStart(16)}` +
        `${devColor(dev.padStart(14))}` + '\n',
      );
    }

    // ─── SEAT FREE FUNDS ───
    const hasAnyFunds = Array.from(this.freeFundsByMarket.values()).some((v) => v && (v.baseUnits > 0 || v.quoteUnits > 0));
    if (hasAnyFunds) {
      process.stdout.write('\n' + theme.section('  SEAT DEPOSITED FUNDS') + '\n');
      process.stdout.write('  ' + theme.muted('─'.repeat(92)) + '\n');
      for (const [sym, ff] of this.freeFundsByMarket) {
        if (!ff || (ff.baseUnits === 0 && ff.quoteUnits === 0)) continue;
        const market = MARKETS.find((m) => m.symbol === sym)!;
        process.stdout.write(`  ${theme.label(sym.padEnd(14))} ${theme.value(fmtNum(ff.baseUnits, 6))} ${theme.muted(market.baseSymbol)}   ${theme.value(fmtNum(ff.quoteUnits, 4))} ${theme.muted(market.quoteSymbol)}\n`);
      }
    }

    // ─── ACTIVE MAKER ───
    const mm = this.deps.maker();
    if (mm && mm.isRunning) {
      const s = mm.status;
      const uptime = Math.round((Date.now() - s.startedAt) / 1000);
      process.stdout.write('\n' + theme.section('  ACTIVE MAKER (single-market)') + '\n');
      process.stdout.write('  ' + theme.muted('─'.repeat(92)) + '\n');
      process.stdout.write(`  ${theme.label('uptime    ')} ${uptime}s   ${theme.label('ticks ')} ${s.ticks}   ${theme.label('fills ')} ${s.fills}   ${theme.label('errors ')} ${s.errors > 0 ? theme.warning(String(s.errors)) : '0'}\n`);
      process.stdout.write(`  ${theme.label('inventory ')} ${fmtNum(s.inventoryBase, 4)} base   ${theme.label('edge ')} ${theme.success(fmtUsd(s.realizedEdgeUsd, 4))}   ${theme.label('volume ')} ${fmtUsd(s.dollarVolume, 2)}\n`);
    }

    const multi = this.deps.multiMaker();
    if (multi && multi.isRunning) {
      const s = multi.status;
      const uptime = Math.round((Date.now() - s.startedAt) / 1000);
      process.stdout.write('\n' + theme.section('  ACTIVE MULTI-MAKER (' + multi.symbols.length + ' markets)') + '\n');
      process.stdout.write('  ' + theme.muted('─'.repeat(92)) + '\n');
      process.stdout.write(`  ${theme.label('markets   ')} ${multi.symbols.join(', ')}\n`);
      process.stdout.write(`  ${theme.label('uptime    ')} ${uptime}s   ${theme.label('ticks ')} ${s.ticks}   ${theme.label('fills ')} ${s.fills}   ${theme.label('errors ')} ${s.totalErrors > 0 ? theme.warning(String(s.totalErrors)) : '0'}\n`);
      process.stdout.write(`  ${theme.label('edge      ')} ${theme.success(fmtUsd(s.realizedEdgeUsd, 4))}   ${theme.label('volume ')} ${fmtUsd(s.dollarVolume, 2)}\n`);
      // Per-asset inventory line
      const invParts: string[] = [];
      for (const [asset, amt] of s.invByAsset) {
        if (Math.abs(amt) < 0.0001) continue;
        const usd = s.invUsdByAsset.get(asset) ?? 0;
        const color = amt > 0 ? theme.bid : theme.ask;
        invParts.push(`${theme.label(asset)} ${color((amt >= 0 ? '+' : '') + fmtNum(amt, 4))} ${theme.muted('(' + fmtUsd(usd, 2) + ')')}`);
      }
      if (invParts.length > 0) {
        process.stdout.write(`  ${theme.label('inventory ')} ${invParts.join('   ')}\n`);
      }
    }

    // ─── PNL (from journal, no sync) ───
    if (w.hasAddress) {
      try {
        const summary = getJournal().summary(w.address!);
        if (summary.totalFills > 0) {
          const netPnl = summary.totalRealizedPnlUsd - summary.totalFeesUsd;
          const netColor = netPnl >= 0 ? theme.success : theme.error;
          process.stdout.write('\n' + theme.section('  PNL (local journal)') + '\n');
          process.stdout.write('  ' + theme.muted('─'.repeat(92)) + '\n');
          process.stdout.write(`  ${theme.label('fills    ')} ${summary.totalFills}   ${theme.label('volume ')} ${fmtUsd(summary.totalVolumeUsd, 2)}   ${theme.label('maker ')} ${(summary.makerRatio * 100).toFixed(0)}%\n`);
          process.stdout.write(`  ${theme.label('realized ')} ${(summary.totalRealizedPnlUsd >= 0 ? theme.success : theme.error)((summary.totalRealizedPnlUsd >= 0 ? '+' : '') + fmtUsd(summary.totalRealizedPnlUsd, 4))}   ${theme.label('fees ')} ${fmtUsd(summary.totalFeesUsd, 4)}   ${theme.label('net ')} ${netColor((netPnl >= 0 ? '+' : '') + fmtUsd(netPnl, 4))}\n`);
        }
      } catch {/* no journal yet */}
    }

    // ─── RPC + LIMITS ───
    process.stdout.write('\n' + theme.section('  RPC') + '\n');
    process.stdout.write('  ' + theme.muted('─'.repeat(92)) + '\n');
    if (this.rpcHealth) {
      const statusStr = this.rpcHealth.healthy ? theme.success('healthy') : theme.error('unhealthy');
      const latColor = this.rpcHealth.latencyMs < 500 ? theme.success : this.rpcHealth.latencyMs < 2000 ? theme.warning : theme.error;
      process.stdout.write(`  ${theme.label('endpoint ')} ${this.rpcHealth.label}   ${statusStr}   ${theme.label('latency ')} ${latColor(this.rpcHealth.latencyMs + 'ms')}`);
      if (this.rpcHealth.slot !== undefined) process.stdout.write(`   ${theme.label('slot ')} ${this.rpcHealth.slot}`);
      if (this.rpcHealth.slotLag !== undefined) process.stdout.write(`   ${theme.label('lag ')} ${this.rpcHealth.slotLag}`);
      process.stdout.write('\n');
    } else {
      process.stdout.write(theme.muted('  (no health data)\n'));
    }

    const limits = getSigningGuard().limits;
    process.stdout.write('\n' + theme.section('  SIGNING GUARDS') + '\n');
    process.stdout.write('  ' + theme.muted('─'.repeat(92)) + '\n');
    process.stdout.write(`  ${theme.label('max notional ')} ${limits.maxNotionalPerOrder > 0 ? fmtUsd(limits.maxNotionalPerOrder) : theme.warning('unlimited')}   ${theme.label('max orders/min ')} ${limits.maxOrdersPerMinute}   ${theme.label('min delay ')} ${limits.minDelayBetweenOrdersMs}ms\n`);

    process.stdout.write('\n' + theme.muted(`  refreshing every ${REFRESH_MS / 1000}s · press Ctrl+C to exit\n`));
  }
}
