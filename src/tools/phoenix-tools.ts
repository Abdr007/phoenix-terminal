import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import { ToolEngine } from './engine.js';
import { getPhoenixClient } from '../phoenix/client.js';
import { fetchOrderbook } from '../phoenix/orderbook.js';
import { placeLimit, placeIoc, cancelAll, getOpenOrders } from '../phoenix/orders.js';
import { findMarket, MARKETS } from '../phoenix/markets.js';
import { scanArb, executeArbCycle, ExecuteArbResult } from '../phoenix/arb.js';
import { Watcher } from '../phoenix/watcher.js';
import { Maker, DEFAULT_MAKER } from '../phoenix/maker.js';
import { MultiMarketMaker, DEFAULT_MULTI_MAKER } from '../phoenix/multi-maker.js';
import { Dashboard } from '../phoenix/dashboard.js';
import { getNotifier } from '../network/notifier.js';
import { runBacktest } from '../phoenix/backtest.js';
import { fetchPythPrice, supportedSymbols } from '../phoenix/oracle.js';
import { fetchWalletFills } from '../phoenix/fills.js';
import { getJournal, indexWalletFills } from '../phoenix/journal.js';
import { deposit, withdraw, getFreeFunds } from '../phoenix/vault.js';
import { placeLadder, LadderLevel } from '../phoenix/ladder-quote.js';
import { cancelById, cancelUpTo, reduceOrder } from '../phoenix/cancel-advanced.js';
import { safeClaimSeatIxs, findEvictionCandidate } from '../phoenix/eviction.js';
import { quote, quoteRequired } from '../phoenix/routing.js';
import { getMarketInfo, isMarketTradable } from '../phoenix/market-info.js';
import { fetchTipFloor, recommendTipLamports, defaultTipLamports, JITO_TIP_ACCOUNTS } from '../network/jito.js';
import { getAiInterpreter } from '../ai/interpreter.js';
import { Advisor, gatherLiveState } from '../ai/advisor.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { WalletManager } from '../wallet/walletManager.js';
import { discoverWallets, resolveWallet } from '../wallet/wallet-registry.js';
import { RpcManager } from '../network/rpc-manager.js';
import { loadConfig } from '../config/index.js';
import { renderBook } from '../cli/render-book.js';
import { renderArbTable, renderArbResult } from '../cli/render-arb.js';
import { renderError, renderInfo, renderKV, renderSuccess, renderTable, renderWarn } from '../cli/renderer.js';
import { theme } from '../cli/theme.js';
import { fmtNum, fmtUsd } from '../utils/format.js';
import { txLink, addrLink } from '../utils/explorer.js';

/** Container for ambient state the tools need. */
export interface AppCtx {
  wallet: WalletManager;
  rpc: RpcManager;
  activeWatcher: Watcher | null;
  activeMaker: Maker | null;
  activeMultiMaker: MultiMarketMaker | null;
  /** Runtime-mutable mode flag — defaults to ctx.simulationMode but can be toggled via `mode` command. */
  simulationMode: boolean;
  /** Callback invoked when mode changes so the REPL prompt can refresh. */
  onModeChange?: (newMode: boolean) => void;
}

export function registerPhoenixTools(engine: ToolEngine, ctx: AppCtx): void {
  const cfg = loadConfig();

  engine.register({
    name: 'help',
    summary: 'List all commands.',
    usage: 'help',
    handler: async () => engine.helpText(),
  });

  engine.register({
    name: 'markets',
    summary: 'List known Phoenix markets.',
    usage: 'markets',
    aliases: ['ls'],
    handler: async () => {
      const rows = MARKETS.map((m) => [
        m.symbol,
        m.liquidity.toUpperCase(),
        m.address,
      ]);
      return renderTable(
        [
          { header: 'SYMBOL', width: 14 },
          { header: 'DEPTH', width: 8 },
          { header: 'MARKET ADDRESS', width: 44 },
        ],
        rows,
      );
    },
  });

  engine.register({
    name: 'book',
    summary: 'Show the L2 orderbook for a market.',
    usage: 'book <symbol> [depth]',
    aliases: ['ob'],
    examples: ['book SOL/USDC', 'book SOL/USDC 20'],
    handler: async (args) => {
      const symbol = args[0];
      if (!symbol) return renderError('usage: book <symbol> [depth]');
      const depth = args[1] ? Math.min(50, Math.max(1, parseInt(args[1], 10))) : 10;
      const book = await fetchOrderbook(symbol, depth);
      return renderBook(book, depth);
    },
  });

  engine.register({
    name: 'mid',
    summary: 'Print mid price for a market.',
    usage: 'mid <symbol>',
    handler: async (args) => {
      const symbol = args[0];
      if (!symbol) return renderError('usage: mid <symbol>');
      const book = await fetchOrderbook(symbol, 1);
      if (book.midUsd === null) return renderWarn(`no two-sided market on ${symbol}`);
      return renderInfo(`${symbol} mid: ${theme.highlight(fmtUsd(book.midUsd, 4))}  (spread ${(book.spreadBps ?? 0).toFixed(2)}bps)`);
    },
  });

  engine.register({
    name: 'wallet',
    summary: 'Wallet status / switch / list. Subcommands: use <name>, list, balance.',
    usage: 'wallet [use <name|addr-prefix>] | wallet list | wallet (default: balance)',
    examples: ['wallet', 'wallet list', 'wallet use dvv', 'wallet use Geb'],
    handler: async (args) => {
      const sub = args[0]?.toLowerCase();

      // wallet list — show every discoverable keypair
      if (sub === 'list' || sub === 'ls') {
        const wallets = discoverWallets();
        if (wallets.length === 0) return renderInfo('no wallets discovered. Try setting WALLETS_DIR or placing keypairs in ~/.flash/wallets/');
        const rows = wallets.map((w) => [
          w.address === ctx.wallet.address ? theme.success('●') : ' ',
          w.name,
          w.address,
          w.path.replace(process.env.HOME ?? '/', '~/'),
        ]);
        return renderTable(
          [
            { header: ' ', width: 1 },
            { header: 'NAME', width: 16 },
            { header: 'ADDRESS', width: 44 },
            { header: 'PATH', width: 40 },
          ],
          rows,
        );
      }

      // wallet use <name-or-prefix> — hot-swap
      if (sub === 'use' || sub === 'switch' || sub === 'load') {
        const id = args[1];
        if (!id) return renderError('usage: wallet use <name|addr-prefix>');
        const target = resolveWallet(id);
        if (!target) {
          const known = discoverWallets().map((w) => w.name).join(', ');
          return renderError(`no wallet matches "${id}". Known: ${known}`);
        }
        ctx.wallet.disconnect();
        try {
          ctx.wallet.loadFromFile(target.path);
        } catch (e) {
          return renderError(`failed to load ${target.name}: ${(e as Error).message}`);
        }
        return renderSuccess(`switched to ${theme.highlight(target.name)}\n  ${theme.muted('address:')} ${target.address}\n  ${theme.muted('explorer:')} ${addrLink(target.address, cfg.network)}`);
      }

      // default: show balances
      if (!ctx.wallet.hasAddress) return renderError('no wallet connected. Try: wallet list, then wallet use <name>');
      const balances = await ctx.wallet.getTokenBalances();
      const lines: string[] = [];
      lines.push(renderKV([
        ['address', theme.value(ctx.wallet.address ?? '—')],
        ['mode', ctx.wallet.isReadOnly ? theme.warning('read-only') : theme.success('signing')],
        ['SOL', theme.value(fmtNum(balances.sol, 4))],
      ]));
      if (balances.tokens.length > 0) {
        lines.push('');
        lines.push(renderTable(
          [{ header: 'TOKEN', width: 10 }, { header: 'AMOUNT', width: 18, align: 'right' }, { header: 'MINT', width: 44 }],
          balances.tokens.map((t) => [t.symbol, fmtNum(t.amount, 6), t.mint]),
        ));
      }
      lines.push('');
      lines.push(theme.muted('  explorer: ') + addrLink(ctx.wallet.address!, cfg.network));
      return lines.join('\n');
    },
  });

  engine.register({
    name: 'mode',
    summary: 'Show or toggle trading mode. paper = no on-chain. live = signs real transactions.',
    usage: 'mode [paper|live]',
    examples: ['mode', 'mode live', 'mode paper'],
    handler: async (args) => {
      const sub = args[0]?.toLowerCase();
      if (!sub) {
        const m = ctx.simulationMode ? theme.success('paper') : theme.error('LIVE');
        const wallet = ctx.wallet.hasAddress ? ctx.wallet.address! : 'no wallet';
        return renderKV([
          ['mode', m + theme.muted(ctx.simulationMode ? ' — orders simulated, nothing signed' : ' — REAL transactions, REAL funds')],
          ['wallet', wallet],
          ['toggle', theme.muted('"mode paper" or "mode live"')],
        ]);
      }
      if (sub === 'paper' || sub === 'sim' || sub === 'simulation') {
        ctx.simulationMode = true;
        ctx.onModeChange?.(true);
        return renderSuccess(`mode → ${theme.success('paper')}  (orders simulated, nothing signed)`);
      }
      if (sub === 'live' || sub === 'real' || sub === 'on') {
        if (!ctx.wallet.isConnected) return renderError('cannot enable live: wallet must be connected with signing capability');
        ctx.simulationMode = false;
        ctx.onModeChange?.(false);
        return [
          renderWarn(`mode → ${theme.error('LIVE')}  (REAL on-chain transactions, REAL funds)`),
          theme.muted(`  signing wallet: ${theme.value(ctx.wallet.address!)}`),
          theme.muted(`  guardrails: max ${cfg.maxOrdersPerMinute} orders/min, ${cfg.maxNotionalPerOrder > 0 ? '$' + cfg.maxNotionalPerOrder + ' notional cap' : 'NO notional cap'}`),
          theme.muted(`  switch back any time with "mode paper".`),
        ].join('\n');
      }
      return renderError(`unknown mode: ${sub}. Use "paper" or "live".`);
    },
  });

  engine.register({
    name: 'rpc',
    summary: 'Show RPC endpoint health.',
    usage: 'rpc',
    handler: async () => {
      const health = await ctx.rpc.checkAll();
      const rows = health.map((h) => [
        h.label,
        h.healthy ? theme.success('healthy') : theme.error('unhealthy'),
        `${h.latencyMs}ms`,
        h.slot ? String(h.slot) : '—',
        h.slotLag !== undefined ? String(h.slotLag) : '—',
      ]);
      return renderTable(
        [
          { header: 'ENDPOINT', width: 18 },
          { header: 'STATUS', width: 10 },
          { header: 'LATENCY', width: 10, align: 'right' },
          { header: 'SLOT', width: 12, align: 'right' },
          { header: 'LAG', width: 6, align: 'right' },
        ],
        rows,
      );
    },
  });

  engine.register({
    name: 'buy',
    summary: 'Place a buy order. Supports --max-slippage BPS (IOC pre-trade guard) and --use-jito.',
    usage: 'buy <symbol> <size> [@price] [--ioc] [--ttl SEC] [--max-slippage BPS] [--use-jito] [--tip LAMPORTS]',
    examples: ['buy SOL/USDC 0.1 @150.25', 'buy SOL/USDC 0.5 --ioc --max-slippage 30', 'buy SOL/USDC 0.5 --ioc --use-jito --tip 20000'],
    handler: async (args) => placeOrderCmd(ctx, 'bid', args),
  });

  engine.register({
    name: 'sell',
    summary: 'Place a sell order. Supports --max-slippage and --use-jito (same as buy).',
    usage: 'sell <symbol> <size> [@price] [--ioc] [--ttl SEC] [--max-slippage BPS] [--use-jito] [--tip LAMPORTS]',
    examples: ['sell SOL/USDC 0.5 --ioc --max-slippage 50 --use-jito'],
    handler: async (args) => placeOrderCmd(ctx, 'ask', args),
  });

  engine.register({
    name: 'orders',
    summary: 'Show open orders for the current wallet on a market.',
    usage: 'orders <symbol>',
    handler: async (args) => {
      const symbol = args[0];
      if (!symbol) return renderError('usage: orders <symbol>');
      if (!ctx.wallet.isConnected) return renderError('wallet must be connected (with keypair) to query open orders');
      const orders = await getOpenOrders(symbol, ctx.wallet.getPublicKey()!);
      if (orders.length === 0) return renderInfo(`no open orders on ${symbol}`);
      return renderTable(
        [
          { header: 'SIDE', width: 6 },
          { header: 'PRICE', width: 14, align: 'right' },
          { header: 'SIZE', width: 14, align: 'right' },
          { header: 'ORDER ID', width: 18 },
        ],
        orders.map((o) => [
          o.side === 'bid' ? theme.bid('BID') : theme.ask('ASK'),
          fmtUsd(o.priceUsd, 4),
          fmtNum(o.sizeBase, 6),
          o.orderId,
        ]),
      );
    },
  });

  engine.register({
    name: 'cancel',
    summary: 'Cancel all your orders on a market.',
    usage: 'cancel <symbol>',
    handler: async (args) => {
      const symbol = args[0];
      if (!symbol) return renderError('usage: cancel <symbol>');
      if (!ctx.wallet.isConnected) return renderError('wallet not connected');
      if (ctx.simulationMode) return renderWarn('simulation mode — no on-chain action');
      const sig = await cancelAll(ctx.rpc.connection, ctx.wallet.getKeypair()!, symbol);
      return renderSuccess(`cancel-all submitted\n  sig: ${sig}\n  ${txLink(sig, cfg.network)}`);
    },
  });

  engine.register({
    name: 'watch',
    summary: 'Full-screen live multi-market dashboard.',
    usage: 'watch [symbol,symbol,...]',
    examples: ['watch', 'watch SOL/USDC,SOL/USDT,JitoSOL/SOL'],
    handler: async (args) => {
      if (ctx.activeWatcher) { await ctx.activeWatcher.stop(); ctx.activeWatcher = null; }
      const symbols = args[0] ? args[0].split(',') : MARKETS.filter((m) => m.liquidity !== 'thin').map((m) => m.symbol);
      const markets = symbols.map((s) => findMarket(s)).filter((m): m is NonNullable<typeof m> => Boolean(m));
      if (markets.length === 0) return renderError('no valid markets to watch');
      // Pass wallet + signer so the watcher can render Open Orders + handle hotkeys
      const signer = ctx.wallet.isConnected ? ctx.wallet.getKeypair() : null;
      ctx.activeWatcher = new Watcher(ctx.rpc.connection, markets, ctx.wallet.getPublicKey(), signer);
      await ctx.activeWatcher.start();
      // Block until SIGINT OR a hotkey-issued quit
      await new Promise<void>((resolve) => {
        let resolved = false;
        const cleanup = async () => {
          if (resolved) return;
          resolved = true;
          process.off('SIGINT', cleanup);
          if (ctx.activeWatcher) { await ctx.activeWatcher.stop(); ctx.activeWatcher = null; }
          process.stdout.write('\n');
          resolve();
        };
        process.on('SIGINT', cleanup);
        ctx.activeWatcher!.enableHotkeys(cleanup);
      });
    },
  });

  engine.register({
    name: 'arb',
    summary: 'Scan for triangular arbitrage. Use --execute to auto-fire profitable cycles (real money).',
    usage: 'arb [minBps] [topN] | arb --execute --min-bps N --size BASE [--max-slippage BPS] [--dry-run]',
    examples: [
      'arb',                                                          // top 10 cycles, view-only
      'arb 5',                                                        // only cycles ≥5bps
      'arb --execute --min-bps 10 --size 0.01 --dry-run',             // simulate
      'arb --execute --min-bps 15 --size 0.05 --max-slippage 30',     // live fire
    ],
    handler: async (args) => {
      const phoenix = getPhoenixClient();
      for (const m of MARKETS) await phoenix.addMarket(m.symbol);
      await phoenix.refreshAll();
      const cycles = await scanArb();

      if (!args.includes('--execute')) {
        const minBps = args[0] && !args[0].startsWith('--') ? Number(args[0]) : 0;
        const topN = args[1] && !args[1].startsWith('--') ? Number(args[1]) : 10;
        return renderArbTable(cycles, minBps, topN);
      }

      // ─── --execute path ───
      if (!ctx.wallet.isConnected) return renderError('arb --execute requires a connected signing wallet');
      const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
      const minBps = Number(flag('min-bps') ?? '10');
      const size = Number(flag('size') ?? '0');
      const maxSlippage = Number(flag('max-slippage') ?? '50');
      const dryRun = args.includes('--dry-run') || ctx.simulationMode;

      if (!Number.isFinite(size) || size <= 0) return renderError('--size required (e.g. --size 0.05)');

      const candidates = cycles.filter((c) => c.profitBps >= minBps);
      if (candidates.length === 0) {
        return renderInfo(`no cycles above ${minBps}bps right now (top: ${cycles[0]?.profitBps.toFixed(1) ?? 'none'}bps)`);
      }
      const cycle = candidates[0];

      // Tag display
      const tagLabel = dryRun ? theme.success('[DRY RUN]') : theme.error('[LIVE]');
      const header = renderInfo(`${tagLabel} executing top cycle (${cycle.profitBps.toFixed(2)}bps quoted, ${size} units, ≤${maxSlippage}bps/leg)`);
      process.stdout.write(header + '\n');
      for (const leg of cycle.legs) {
        process.stdout.write(`  ${theme.muted('•')} ${theme.label(leg.marketSymbol)}  rate ${leg.rate.toFixed(6)}\n`);
      }
      process.stdout.write('\n');

      const result = await executeArbCycle(ctx.rpc.connection, ctx.wallet.getKeypair()!, {
        cycle, startSize: size, maxSlippageBps: maxSlippage, dryRun,
      });

      return renderArbResult(result);
    },
  });

  engine.register({
    name: 'mm',
    summary: 'Start the inventory-aware market maker. Supports --use-jito + --tip for guaranteed inclusion.',
    usage: 'mm start <symbol> --size N [--half BPS] [--gamma G] [--interval MS] [--use-jito] [--tip LAMPORTS] | mm stop | mm status',
    handler: async (args) => {
      const sub = args[0];
      if (sub === 'stop') {
        if (!ctx.activeMaker) return renderInfo('no maker running');
        await ctx.activeMaker.stop();
        ctx.activeMaker = null;
        return renderSuccess('maker stopped');
      }
      if (sub === 'status') {
        if (!ctx.activeMaker) return renderInfo('no maker running');
        const s = ctx.activeMaker.status;
        const uptimeSec = Math.round((Date.now() - s.startedAt) / 1000);
        const fillRate = s.placesSent > 0 ? (s.fills / s.placesSent * 100).toFixed(1) + '%' : '—';
        const edgePerFill = s.fills > 0 ? s.realizedEdgeUsd / s.fills : 0;
        const dollarVolPerHour = uptimeSec > 0 ? (s.dollarVolume / uptimeSec) * 3600 : 0;
        const lines: string[] = [];
        lines.push(theme.header('  MAKER STATUS'));
        lines.push('  ' + theme.fullSeparator().slice(0, 78));
        lines.push(renderKV([
          ['running', theme.success('yes') + theme.muted(`  (${uptimeSec}s uptime)`)],
          ['ticks / cancels / places / errors', `${s.ticks} / ${s.cancelsSent} / ${s.placesSent} / ${s.errors > 0 ? theme.warning(String(s.errors)) : '0'}`],
          ['last mid', s.lastMid !== null ? fmtUsd(s.lastMid, 4) : theme.muted('—')],
        ]));
        lines.push('');
        lines.push(theme.section('  FILLS & EDGE'));
        lines.push(renderKV([
          ['total fills', String(s.fills) + theme.muted(`  (${s.buyFills} bid / ${s.sellFills} ask)`)],
          ['fill rate', fillRate + theme.muted('  (fills / quotes placed)')],
          ['dollar volume', fmtUsd(s.dollarVolume, 2)],
          ['volume per hour', fmtUsd(dollarVolPerHour, 2) + theme.muted('  (extrapolated)')],
          ['realized edge', theme.success(fmtUsd(s.realizedEdgeUsd, 4)) + theme.muted(`  (Σ |fill-mid| × size)`)],
          ['edge per fill', s.fills > 0 ? theme.success(fmtUsd(edgePerFill, 6)) : theme.muted('—')],
          ['inventory', fmtNum(s.inventoryBase, 4) + theme.muted(` base  (≈ ${s.lastMid !== null ? fmtUsd(s.inventoryBase * s.lastMid, 2) : '—'})`)],
          ['last fill', s.lastFillAt !== null ? `${new Date(s.lastFillAt).toLocaleTimeString()}  ${s.lastFillSide === 'bid' ? theme.bid('BUY') : theme.ask('SELL')} @ ${fmtUsd(s.lastFillPrice ?? 0, 4)}` : theme.muted('—')],
        ]));
        return lines.join('\n');
      }
      if (sub !== 'start') return renderError('usage: mm start|stop|status');

      const symbol = args[1];
      if (!symbol) return renderError('usage: mm start <symbol> --size N');
      if (!ctx.wallet.isConnected) return renderError('wallet not connected');
      if (ctx.simulationMode) return renderWarn('simulation mode — maker would run but no orders sent. Set SIMULATION_MODE=false to go live.');

      const flagVal = (name: string): string | undefined => {
        const i = args.indexOf(`--${name}`);
        return i >= 0 ? args[i + 1] : undefined;
      };
      const size = Number(flagVal('size') ?? '0.05');
      if (!Number.isFinite(size) || size <= 0) return renderError('--size must be a positive number (base units)');
      const halfBps = Number(flagVal('half') ?? DEFAULT_MAKER.baseHalfSpreadBps);
      const gamma = Number(flagVal('gamma') ?? DEFAULT_MAKER.riskAversion);
      const interval = Number(flagVal('interval') ?? DEFAULT_MAKER.intervalMs);
      const maxInv = Number(flagVal('max-inv') ?? size * 10);
      const useJito = args.includes('--use-jito') || args.includes('--jito');
      const tip = flagVal('tip') ? Number(flagVal('tip')) : undefined;
      const oracleAnchored = args.includes('--oracle-anchor') || args.includes('--anchor');
      const maxOracleDev = flagVal('max-oracle-dev') ? Number(flagVal('max-oracle-dev')) : undefined;

      if (ctx.activeMaker) {
        await ctx.activeMaker.stop();
        ctx.activeMaker = null;
      }
      ctx.activeMaker = new Maker(ctx.rpc.connection, ctx.wallet.getKeypair()!, {
        ...DEFAULT_MAKER,
        symbol,
        quoteSizeBase: size,
        baseHalfSpreadBps: halfBps,
        riskAversion: gamma,
        intervalMs: interval,
        maxInventoryBase: maxInv,
        useJito,
        tipLamports: tip,
        oracleAnchored,
        maxOracleDevBps: maxOracleDev,
      });
      await ctx.activeMaker.start();
      const jitoTag = useJito ? theme.accent(`  + Jito tip ${(tip ?? defaultTipLamports()).toLocaleString()} lamports`) : '';
      return renderSuccess(`maker started on ${symbol} (size=${size}, half=${halfBps}bps, γ=${gamma}, interval=${interval}ms)${jitoTag}`);
    },
  });

  engine.register({
    name: 'config',
    summary: 'Show effective configuration.',
    usage: 'config',
    handler: async () => {
      return renderKV([
        ['rpc', cfg.rpcUrl],
        ['network', cfg.network],
        ['simulation', ctx.simulationMode ? theme.success('ON (safe)') : theme.error('OFF (LIVE)')],
        ['trading enabled', cfg.tradingEnabled ? 'yes' : theme.warning('NO')],
        ['CU limit', String(cfg.computeUnitLimit)],
        ['CU price', String(cfg.computeUnitPrice)],
        ['max notional', cfg.maxNotionalPerOrder > 0 ? fmtUsd(cfg.maxNotionalPerOrder) : 'unlimited'],
        ['max orders/min', String(cfg.maxOrdersPerMinute)],
      ]);
    },
  });

  engine.register({
    name: 'fills',
    summary: 'Recent fills for this wallet (from local journal — instant after first sync).',
    usage: 'fills [limit] [--sync]',
    examples: ['fills', 'fills 50', 'fills --sync  (force re-index from chain)'],
    handler: async (args) => {
      if (!ctx.wallet.hasAddress) return renderError('wallet not connected');
      const limit = args[0] && !args[0].startsWith('--') ? Math.min(100, Math.max(1, parseInt(args[0], 10))) : 20;
      const journal = getJournal();
      const wallet = ctx.wallet.getPublicKey()!;
      const sync = args.includes('--sync') || journal.getCursor(wallet.toBase58()) === null;
      if (sync) {
        const { scanned, inserted } = await indexWalletFills(ctx.rpc.connection, wallet, journal, { maxNewSigs: 500 });
        if (inserted > 0) {
          process.stdout.write(renderInfo(`indexed ${inserted} new fill(s) (scanned ${scanned} sigs)`) + '\n');
        }
      }
      const fills = journal.recent(wallet.toBase58(), limit);
      if (fills.length === 0) {
        // Fallback to live RPC scan if journal empty after sync (e.g. ZSTD failure)
        const live = await fetchWalletFills(ctx.rpc.connection, wallet, { scanLimit: limit * 3, resultLimit: limit });
        if (live.length === 0) return renderInfo('no Phoenix fills found for this wallet');
        return renderTable(
          [
            { header: 'TIME', width: 12 },
            { header: 'MARKET', width: 14 },
            { header: 'ROLE', width: 6 },
            { header: 'PRICE', width: 14, align: 'right' },
            { header: 'SIZE', width: 14, align: 'right' },
            { header: 'NOTIONAL', width: 12, align: 'right' },
            { header: 'SIGNATURE', width: 88 },
          ],
          live.map((f) => [
            f.timestamp ? new Date(f.timestamp).toLocaleString().split(',')[1]?.trim() ?? '—' : '—',
            f.market, f.isMaker ? theme.bid('MAKER') : theme.ask('TAKER'),
            fmtUsd(f.priceUsd, 4), fmtNum(f.sizeBase, 6), fmtUsd(f.notionalUsd, 2), f.signature,
          ]),
        );
      }
      return renderTable(
        [
          { header: 'TIME', width: 12 },
          { header: 'MARKET', width: 14 },
          { header: 'ROLE', width: 6 },
          { header: 'PRICE', width: 14, align: 'right' },
          { header: 'SIZE', width: 14, align: 'right' },
          { header: 'NOTIONAL', width: 12, align: 'right' },
          { header: 'SIGNATURE', width: 88 },
        ],
        fills.map((f) => [
          f.blockTime ? new Date(f.blockTime * 1000).toLocaleString().split(',')[1]?.trim() ?? '—' : '—',
          f.market,
          f.isMaker ? theme.bid('MAKER') : theme.ask('TAKER'),
          fmtUsd(f.priceUsd, 4),
          fmtNum(f.sizeBase, 6),
          fmtUsd(f.notionalUsd, 2),
          f.signature,
        ]),
      );
    },
  });

  engine.register({
    name: 'pnl',
    summary: 'Realized PnL per market + total (weighted-avg-cost from indexed fills).',
    usage: 'pnl [--sync]',
    aliases: ['p&l'],
    handler: async (args) => {
      if (!ctx.wallet.hasAddress) return renderError('wallet not connected');
      const wallet = ctx.wallet.getPublicKey()!;
      const journal = getJournal();
      const needsSync = args.includes('--sync') || journal.getCursor(wallet.toBase58()) === null;
      if (needsSync) {
        process.stdout.write(renderInfo('syncing journal from on-chain (one-time, then instant)…') + '\n');
        const r = await indexWalletFills(ctx.rpc.connection, wallet, journal, { maxNewSigs: 500 });
        process.stdout.write(renderInfo(`indexed ${r.inserted} new fill(s)`) + '\n');
      }
      const s = journal.summary(wallet.toBase58());
      if (s.totalFills === 0) return renderInfo('no Phoenix fills indexed yet for this wallet. Try: pnl --sync');

      const lines: string[] = [];
      lines.push(theme.header('  PNL SUMMARY'));
      lines.push('  ' + theme.fullSeparator().slice(0, 78));
      lines.push(renderKV([
        ['wallet', wallet.toBase58()],
        ['total fills', String(s.totalFills)],
        ['total volume', fmtUsd(s.totalVolumeUsd, 2)],
        ['realized PnL', s.totalRealizedPnlUsd >= 0 ? theme.success('+' + fmtUsd(s.totalRealizedPnlUsd, 4)) : theme.error(fmtUsd(s.totalRealizedPnlUsd, 4))],
        ['fees paid', fmtUsd(s.totalFeesUsd, 4)],
        ['net PnL after fees', (s.totalRealizedPnlUsd - s.totalFeesUsd) >= 0 ? theme.success('+' + fmtUsd(s.totalRealizedPnlUsd - s.totalFeesUsd, 4)) : theme.error(fmtUsd(s.totalRealizedPnlUsd - s.totalFeesUsd, 4))],
        ['maker / taker volume', `${fmtUsd(s.makerVolumeUsd, 2)} / ${fmtUsd(s.takerVolumeUsd, 2)}`],
        ['maker ratio', `${(s.makerRatio * 100).toFixed(1)}%`],
        ['unique markets', String(s.uniqueMarkets)],
        ['active days', String(s.uniqueActiveDays)],
      ]));
      lines.push('');
      lines.push(theme.section('  PER-MARKET'));
      lines.push(renderTable(
        [
          { header: 'MARKET', width: 14 },
          { header: 'FILLS', width: 6, align: 'right' },
          { header: 'VOLUME', width: 14, align: 'right' },
          { header: 'INVENTORY', width: 12, align: 'right' },
          { header: 'AVG COST', width: 12, align: 'right' },
          { header: 'REALIZED', width: 14, align: 'right' },
          { header: 'MAKER %', width: 9, align: 'right' },
        ],
        s.perMarket.map((m) => {
          const totalVol = m.buyNotionalUsd + m.sellNotionalUsd;
          const makerPct = totalVol > 0 ? (m.makerVolumeUsd / totalVol * 100).toFixed(0) + '%' : '—';
          const pnlStr = m.realizedPnlUsd >= 0 ? theme.success('+' + fmtUsd(m.realizedPnlUsd, 4)) : theme.error(fmtUsd(m.realizedPnlUsd, 4));
          return [
            m.market,
            String(m.fills),
            fmtUsd(totalVol, 2),
            fmtNum(m.inventoryBase, 4),
            m.avgCostUsd > 0 ? fmtUsd(m.avgCostUsd, 4) : '—',
            pnlStr,
            makerPct,
          ];
        }),
      ));
      return lines.join('\n');
    },
  });

  engine.register({
    name: 'oracle',
    summary: 'Pyth Hermes prices for tracked assets, plus deviation vs Phoenix mid.',
    usage: 'oracle [symbol]',
    handler: async (args) => {
      const symbols = args[0] ? [args[0].toUpperCase()] : supportedSymbols();
      const rows: string[][] = [];
      for (const sym of symbols) {
        const oracle = await fetchPythPrice(sym);
        // Try to fetch a Phoenix mid for this base symbol (vs USDC)
        const market = MARKETS.find((m) => m.baseSymbol === sym && m.quoteSymbol === 'USDC');
        let phoenixMid: number | null = null;
        let devBps: number | null = null;
        if (market) {
          try {
            const book = await fetchOrderbook(market.symbol, 1);
            phoenixMid = book.midUsd;
            if (oracle !== null && phoenixMid !== null) devBps = ((phoenixMid - oracle) / oracle) * 10_000;
          } catch { /* ignore */ }
        }
        rows.push([
          theme.label(sym),
          oracle !== null ? fmtUsd(oracle, 4) : theme.muted('—'),
          phoenixMid !== null ? fmtUsd(phoenixMid, 4) : theme.muted('—'),
          devBps !== null
            ? (Math.abs(devBps) < 10 ? theme.success(`${devBps.toFixed(1)}bps`) : Math.abs(devBps) < 50 ? theme.warning(`${devBps.toFixed(1)}bps`) : theme.error(`${devBps.toFixed(1)}bps`))
            : theme.muted('—'),
        ]);
      }
      return renderTable(
        [
          { header: 'SYMBOL', width: 10 },
          { header: 'PYTH', width: 14, align: 'right' },
          { header: 'PHOENIX MID', width: 14, align: 'right' },
          { header: 'DEVIATION', width: 12, align: 'right' },
        ],
        rows,
      );
    },
  });

  engine.register({
    name: 'deposit',
    summary: 'Deposit base/quote into your seat (enables fast WithFreeFunds order path).',
    usage: 'deposit <symbol> [--base AMOUNT] [--quote AMOUNT]',
    examples: ['deposit SOL/USDC --quote 100', 'deposit SOL/USDC --base 0.5 --quote 50'],
    handler: async (args) => {
      if (!ctx.wallet.isConnected) return renderError('wallet not connected');
      if (ctx.simulationMode) return renderWarn('simulation mode — no on-chain action');
      const symbol = args[0];
      if (!symbol) return renderError('usage: deposit <symbol> [--base N] [--quote N]');
      const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : undefined; };
      const base = flag('base');
      const quote = flag('quote');
      const sig = await deposit(ctx.rpc.connection, ctx.wallet.getKeypair()!, {
        symbol, baseUnits: base, quoteUnits: quote,
      });
      return [
        renderSuccess(`deposit confirmed`),
        `  ${theme.muted('sig:')} ${sig}`,
        `  ${theme.muted('explorer:')} ${txLink(sig, cfg.network)}`,
      ].join('\n');
    },
  });

  engine.register({
    name: 'withdraw',
    summary: 'Withdraw deposited funds from your seat (default: all).',
    usage: 'withdraw <symbol> [--base AMOUNT] [--quote AMOUNT]',
    handler: async (args) => {
      if (!ctx.wallet.isConnected) return renderError('wallet not connected');
      if (ctx.simulationMode) return renderWarn('simulation mode — no on-chain action');
      const symbol = args[0];
      if (!symbol) return renderError('usage: withdraw <symbol> [--base N] [--quote N]');
      const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : undefined; };
      const sig = await withdraw(ctx.rpc.connection, ctx.wallet.getKeypair()!, {
        symbol, baseUnits: flag('base'), quoteUnits: flag('quote'),
      });
      return [
        renderSuccess(`withdraw confirmed`),
        `  ${theme.muted('sig:')} ${sig}`,
        `  ${theme.muted('explorer:')} ${txLink(sig, cfg.network)}`,
      ].join('\n');
    },
  });

  engine.register({
    name: 'free-funds',
    summary: 'Show base/quote currently deposited in your seat.',
    usage: 'free-funds <symbol>',
    handler: async (args) => {
      const symbol = args[0];
      if (!symbol) return renderError('usage: free-funds <symbol>');
      if (!ctx.wallet.hasAddress) return renderError('wallet not connected');
      const funds = await getFreeFunds(symbol, ctx.wallet.getPublicKey()!);
      if (!funds) return renderInfo(`no seat / no deposit on ${symbol}`);
      const phoenix = getPhoenixClient();
      const { def } = await phoenix.getMarket(symbol);
      const client = await phoenix.raw();
      const baseUnits = client.baseAtomsToRawBaseUnits(client.baseLotsToBaseAtoms(funds.baseLots, def.address), def.address);
      const quoteUnits = client.quoteAtomsToQuoteUnits(client.quoteLotsToQuoteAtoms(funds.quoteLots, def.address), def.address);
      return renderKV([
        ['market', def.symbol],
        [`${def.baseSymbol} (deposited)`, fmtNum(baseUnits, 6)],
        [`${def.quoteSymbol} (deposited)`, fmtNum(quoteUnits, 6)],
        ['base lots', String(funds.baseLots)],
        ['quote lots', String(funds.quoteLots)],
      ]);
    },
  });

  engine.register({
    name: 'ladder',
    summary: 'Place an N-level post-only ladder in one tx (uses PlaceMultiplePostOnly).',
    usage: 'ladder <symbol> --levels N --size BASE --step BPS [--use-free] [--mid PRICE]',
    examples: ['ladder SOL/USDC --levels 3 --size 0.05 --step 5', 'ladder SOL/USDC --levels 5 --size 0.1 --step 8 --use-free'],
    handler: async (args) => {
      if (!ctx.wallet.isConnected) return renderError('wallet not connected');
      if (ctx.simulationMode) return renderWarn('simulation mode — no on-chain action');
      const symbol = args[0];
      if (!symbol) return renderError('usage: ladder <symbol> --levels N --size BASE --step BPS');
      const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : undefined; };
      const n = flag('levels') ?? 3;
      const size = flag('size') ?? 0.05;
      const stepBps = flag('step') ?? 5;
      const useFree = args.includes('--use-free');
      let mid = flag('mid') ?? NaN;
      if (!Number.isFinite(mid)) {
        const book = await fetchOrderbook(symbol, 1);
        if (book.midUsd === null) return renderError(`no mid on ${symbol}; pass --mid PRICE`);
        mid = book.midUsd;
      }
      const levels: LadderLevel[] = [];
      const step = stepBps / 10_000;
      for (let i = 1; i <= n; i++) {
        levels.push({ side: 'bid', priceUsd: mid * (1 - step * i), sizeBase: size });
        levels.push({ side: 'ask', priceUsd: mid * (1 + step * i), sizeBase: size });
      }
      const sig = await placeLadder(ctx.rpc.connection, ctx.wallet.getKeypair()!, {
        symbol, levels, ttlSec: 60, useFreeFunds: useFree,
      });
      return renderSuccess(`${levels.length}-level ladder placed\n  sig: ${sig}\n  ${txLink(sig, cfg.network)}`);
    },
  });

  engine.register({
    name: 'l3',
    summary: 'Show the L3 (per-order) book for a market.',
    usage: 'l3 <symbol> [ordersPerSide]',
    handler: async (args) => {
      const symbol = args[0];
      if (!symbol) return renderError('usage: l3 <symbol> [ordersPerSide]');
      const perSide = args[1] ? Math.min(50, parseInt(args[1], 10)) : 10;
      const phoenix = getPhoenixClient();
      const { def, state } = await phoenix.getMarket(symbol);
      await phoenix.refresh(def.address);
      const book = Phoenix.getMarketL3UiBook(state.data, perSide);
      const rows: string[][] = [];
      for (let i = book.asks.length - 1; i >= 0; i--) {
        const o = book.asks[i];
        rows.push([theme.ask('ASK'), fmtUsd(o.price, 4), fmtNum(o.size, 6), o.makerPubkey]);
      }
      rows.push([theme.muted('—'), theme.muted('— mid —'), '', '']);
      for (const o of book.bids) {
        rows.push([theme.bid('BID'), fmtUsd(o.price, 4), fmtNum(o.size, 6), o.makerPubkey]);
      }
      return renderTable(
        [
          { header: 'SIDE', width: 6 },
          { header: 'PRICE', width: 14, align: 'right' },
          { header: 'SIZE', width: 14, align: 'right' },
          { header: 'MAKER', width: 44 },
        ],
        rows,
      );
    },
  });

  engine.register({
    name: 'ai',
    summary: 'Translate a natural-language prompt into a terminal command (Claude Haiku 4.5).',
    usage: 'ai <prompt...>',
    aliases: ['?'],
    examples: ['ai show me the SOL book', 'ai what is sol trading at', '? cancel everything on sol/usdc'],
    handler: async (args) => {
      const interpreter = getAiInterpreter();
      if (!interpreter) return renderError('AI not configured. Set ANTHROPIC_API_KEY in .env.');
      const prompt = args.join(' ').trim();
      if (!prompt) return renderError('usage: ai <prompt>');
      try {
        const t = await interpreter.translate(prompt);
        const confTag = t.confidence === 'high' ? theme.success('high') : t.confidence === 'medium' ? theme.warning('med') : theme.error('low');
        const header = renderInfo(
          `${theme.label('AI')} → ${theme.highlight(t.command)}  ${theme.muted('[' )}${confTag}${theme.muted(']')}  ${theme.muted('(' + t.reasoning + ')')}`,
        );
        // Clarification path: don't execute, just ask
        if (t.clarificationNeeded) {
          return [
            header,
            renderWarn(`Need clarification: ${t.clarificationNeeded}`),
            theme.muted(`(I'd run: ${t.command} — re-prompt with more detail to confirm or change.)`),
          ].join('\n');
        }
        // Destructive path: always confirm explicitly
        if (t.isDestructive) {
          return [header, renderWarn('destructive command — re-run it explicitly to confirm:'), `  ${theme.highlight(t.command)}`].join('\n');
        }
        // Low-confidence safe commands: still surface the warning but execute
        const result = await engine.run(t.command);
        return result ? `${header}\n\n${result}` : header;
      } catch (e) {
        return renderError(`ai: ${(e as Error).message}`);
      }
    },
  });

  engine.register({
    name: 'quote',
    summary: 'Predict the fill amount and price impact for an IOC before sending it.',
    usage: 'quote <symbol> <buy|sell> <inAmount>',
    examples: ['quote SOL/USDC buy 100', 'quote SOL/USDC sell 0.5'],
    handler: async (args) => {
      const [symbol, sideStr, inStr] = args;
      if (!symbol || !sideStr || !inStr) return renderError('usage: quote <symbol> <buy|sell> <inAmount>');
      const side = sideStr.toLowerCase() === 'buy' || sideStr.toLowerCase() === 'bid' ? 'bid' : 'ask';
      const inAmount = Number(inStr);
      if (!Number.isFinite(inAmount) || inAmount <= 0) return renderError('inAmount must be > 0');
      const q = await quote(symbol, side, inAmount);
      const impactColor = q.priceImpactBps < 10 ? theme.success : q.priceImpactBps < 50 ? theme.warning : theme.error;
      return renderKV([
        ['market', q.market],
        ['side', side === 'bid' ? theme.bid('BUY') : theme.ask('SELL')],
        ['in', fmtNum(q.inAmount, 6)],
        ['expected out', fmtNum(q.expectedOut, 6)],
        ['effective price', fmtUsd(q.effectivePrice, 6)],
        ['mid price', q.midPrice !== null ? fmtUsd(q.midPrice, 6) : '—'],
        ['price impact', impactColor(`${q.priceImpactBps.toFixed(2)}bps`)],
      ]);
    },
  });

  engine.register({
    name: 'quote-out',
    summary: 'Reverse quote: how much input do I need to receive outAmount?',
    usage: 'quote-out <symbol> <buy|sell> <outAmount>',
    handler: async (args) => {
      const [symbol, sideStr, outStr] = args;
      if (!symbol || !sideStr || !outStr) return renderError('usage: quote-out <symbol> <buy|sell> <outAmount>');
      const side = sideStr.toLowerCase() === 'buy' || sideStr.toLowerCase() === 'bid' ? 'bid' : 'ask';
      const outAmount = Number(outStr);
      if (!Number.isFinite(outAmount) || outAmount <= 0) return renderError('outAmount must be > 0');
      const r = await quoteRequired(symbol, side, outAmount);
      return renderKV([
        ['market', r.market],
        ['side', side],
        ['target out', fmtNum(r.outAmount, 6)],
        ['required in', fmtNum(r.requiredIn, 6)],
      ]);
    },
  });

  engine.register({
    name: 'market-info',
    summary: 'Full per-market metadata: status, tick/lot, traders, seat manager.',
    usage: 'market-info <symbol>',
    aliases: ['info'],
    handler: async (args) => {
      const symbol = args[0];
      if (!symbol) return renderError('usage: market-info <symbol>');
      const m = await getMarketInfo(symbol);
      const statusColor = m.status === 'Active' ? theme.success : m.status === 'PostOnly' ? theme.warning : theme.error;
      return renderKV([
        ['symbol', m.symbol],
        ['market address', m.address],
        ['status', statusColor(m.status) + (isMarketTradable(m.status) ? theme.muted(' (tradable)') : theme.muted(' (NOT tradable)'))],
        ['program', m.programId],
        ['base', `${m.baseSymbol} (${m.baseDecimals} dec)`],
        ['base mint', m.baseMint],
        ['quote', `${m.quoteSymbol} (${m.quoteDecimals} dec)`],
        ['quote mint', m.quoteMint],
        ['tick size', fmtNum(m.tickSize, 8)],
        ['base lot size (atoms)', String(m.baseLotSize)],
        ['price decimals', String(m.priceDecimalPlaces)],
        ['traders', String(m.totalTraders)],
        ['resting bids / asks', `${m.numBids} / ${m.numAsks}`],
        ['seat manager', m.seatManagerAddress],
        ['seat deposit collector', m.seatDepositCollectorAddress],
        ['log authority', m.logAuthority],
        ['explorer', addrLink(m.address, cfg.network)],
      ]);
    },
  });

  engine.register({
    name: 'cancel-id',
    summary: 'Cancel a specific resting order by side + price-in-ticks + seq number.',
    usage: 'cancel-id <symbol> <bid|ask> <priceInTicks> <orderSeq> [--use-free]',
    handler: async (args) => {
      if (!ctx.wallet.isConnected) return renderError('wallet not connected');
      if (ctx.simulationMode) return renderWarn('simulation mode — no on-chain action');
      const [symbol, sideStr, priceStr, seq] = args;
      if (!symbol || !sideStr || !priceStr || !seq) return renderError('usage: cancel-id <symbol> <bid|ask> <priceInTicks> <orderSeq>');
      const useFree = args.includes('--use-free');
      const side = sideStr.toLowerCase() as 'bid' | 'ask';
      const sig = await cancelById(ctx.rpc.connection, ctx.wallet.getKeypair()!, {
        symbol,
        orders: [{ side, priceInTicks: Number(priceStr), orderSequenceNumber: seq }],
        useFreeFunds: useFree,
      });
      return [
        renderSuccess(`cancel-id confirmed`),
        `  ${theme.muted('sig:')} ${sig}`,
        `  ${theme.muted('explorer:')} ${txLink(sig, cfg.network)}`,
      ].join('\n');
    },
  });

  engine.register({
    name: 'cancel-top',
    summary: 'Cancel up to N orders per side (optionally on one side only).',
    usage: 'cancel-top <symbol> <N> [--side bid|ask] [--use-free]',
    handler: async (args) => {
      if (!ctx.wallet.isConnected) return renderError('wallet not connected');
      if (ctx.simulationMode) return renderWarn('simulation mode — no on-chain action');
      const [symbol, nStr] = args;
      if (!symbol || !nStr) return renderError('usage: cancel-top <symbol> <N>');
      const n = parseInt(nStr, 10);
      const sideIdx = args.indexOf('--side');
      const side = (sideIdx >= 0 ? args[sideIdx + 1] : 'both') as 'bid' | 'ask' | 'both';
      const useFree = args.includes('--use-free');
      const sig = await cancelUpTo(ctx.rpc.connection, ctx.wallet.getKeypair()!, {
        symbol, side, numOrders: n, useFreeFunds: useFree,
      });
      return [
        renderSuccess(`cancel-top confirmed`),
        `  ${theme.muted('sig:')} ${sig}`,
        `  ${theme.muted('explorer:')} ${txLink(sig, cfg.network)}`,
      ].join('\n');
    },
  });

  engine.register({
    name: 'reduce',
    summary: 'Shrink an existing resting order without canceling it.',
    usage: 'reduce <symbol> <bid|ask> <priceInTicks> <orderSeq> <newSizeLots> [--use-free]',
    handler: async (args) => {
      if (!ctx.wallet.isConnected) return renderError('wallet not connected');
      if (ctx.simulationMode) return renderWarn('simulation mode — no on-chain action');
      const [symbol, sideStr, priceStr, seq, sizeStr] = args;
      if (!symbol || !sideStr || !priceStr || !seq || !sizeStr) {
        return renderError('usage: reduce <symbol> <bid|ask> <priceInTicks> <orderSeq> <newSizeLots>');
      }
      const useFree = args.includes('--use-free');
      const sig = await reduceOrder(ctx.rpc.connection, ctx.wallet.getKeypair()!, {
        symbol,
        side: sideStr.toLowerCase() as 'bid' | 'ask',
        priceInTicks: Number(priceStr),
        orderSequenceNumber: seq,
        newSizeBaseLots: Number(sizeStr),
        useFreeFunds: useFree,
      });
      return [
        renderSuccess(`reduce confirmed`),
        `  ${theme.muted('sig:')} ${sig}`,
        `  ${theme.muted('explorer:')} ${txLink(sig, cfg.network)}`,
      ].join('\n');
    },
  });

  engine.register({
    name: 'evict-check',
    summary: 'Find an evictable trader on this market (when seat registry is full).',
    usage: 'evict-check <symbol>',
    handler: async (args) => {
      const symbol = args[0];
      if (!symbol) return renderError('usage: evict-check <symbol>');
      const candidate = await findEvictionCandidate(symbol);
      if (!candidate) return renderInfo(`no evictable trader found on ${symbol} (registry may not be full)`);
      return renderInfo(`evictable trader: ${candidate.toBase58()}`);
    },
  });

  engine.register({
    name: 'claim-seat',
    summary: 'Claim a maker seat on a market (handles eviction if registry is full).',
    usage: 'claim-seat <symbol>',
    handler: async (args) => {
      if (!ctx.wallet.isConnected) return renderError('wallet not connected');
      if (ctx.simulationMode) return renderWarn('simulation mode — no on-chain action');
      const symbol = args[0];
      if (!symbol) return renderError('usage: claim-seat <symbol>');
      const ixs = await safeClaimSeatIxs(ctx.rpc.connection, symbol, ctx.wallet.getPublicKey()!);
      if (ixs.length === 0) return renderInfo(`seat already active on ${symbol}`);
      return renderInfo(`seat setup needs ${ixs.length} ix(s) — placing a limit order will include them automatically.`);
    },
  });

  engine.register({
    name: 'mm-multi',
    summary: 'Multi-market MM — quotes N markets with ASSET-level inventory aggregation.',
    usage: 'mm-multi start <symbols-csv> --size N [--half BPS] [--gamma G] [--interval MS] [--max-inv ASSET=N,...] [--use-jito] [--tip LAMPORTS] | mm-multi stop | mm-multi status',
    examples: [
      'mm-multi start SOL/USDC,SOL/USDT --size 0.05',
      'mm-multi start SOL/USDC,SOL/USDT,JitoSOL/SOL --size 0.05 --half 10 --max-inv SOL=2',
      'mm-multi status',
    ],
    handler: async (args) => {
      const sub = args[0];
      if (sub === 'stop') {
        if (!ctx.activeMultiMaker) return renderInfo('no multi-maker running');
        await ctx.activeMultiMaker.stop();
        ctx.activeMultiMaker = null;
        return renderSuccess('multi-maker stopped');
      }
      if (sub === 'status') {
        if (!ctx.activeMultiMaker) return renderInfo('no multi-maker running');
        const s = ctx.activeMultiMaker.status;
        const uptimeSec = Math.round((Date.now() - s.startedAt) / 1000);
        const fillRate = s.totalPlaces > 0 ? (s.fills / s.totalPlaces * 100).toFixed(1) + '%' : '—';
        const edgePerFill = s.fills > 0 ? s.realizedEdgeUsd / s.fills : 0;
        const dollarVolPerHour = uptimeSec > 0 ? (s.dollarVolume / uptimeSec) * 3600 : 0;
        const lines: string[] = [];
        lines.push(theme.header('  MULTI-MARKET MAKER STATUS'));
        lines.push('  ' + theme.fullSeparator().slice(0, 78));
        lines.push(renderKV([
          ['running', theme.success('yes') + theme.muted(`  (${uptimeSec}s uptime)`)],
          ['markets', ctx.activeMultiMaker.symbols.join(', ')],
          ['ticks / cancels / places / errors', `${s.ticks} / ${s.totalCancels} / ${s.totalPlaces} / ${s.totalErrors > 0 ? theme.warning(String(s.totalErrors)) : '0'}`],
        ]));
        lines.push('');
        lines.push(theme.section('  PER-MARKET MIDS'));
        const midRows: string[][] = [];
        for (const [sym, mid] of s.mids) {
          midRows.push([sym, mid !== null ? fmtUsd(mid, 4) : theme.muted('—'), String(s.fillsByMarket.get(sym) ?? 0)]);
        }
        lines.push(renderTable(
          [{ header: 'MARKET', width: 14 }, { header: 'MID', width: 14, align: 'right' }, { header: 'FILLS', width: 6, align: 'right' }],
          midRows,
        ));
        lines.push('');
        lines.push(theme.section('  ASSET INVENTORY (shared across all markets)'));
        const invRows: string[][] = [];
        for (const [asset, amt] of s.invByAsset) {
          const usd = s.invUsdByAsset.get(asset) ?? 0;
          const color = Math.abs(amt) < 0.000001 ? theme.muted : amt > 0 ? theme.bid : theme.ask;
          invRows.push([asset, color((amt >= 0 ? '+' : '') + fmtNum(amt, 6)), fmtUsd(usd, 2)]);
        }
        if (invRows.length === 0) invRows.push([theme.muted('(empty)'), '', '']);
        lines.push(renderTable(
          [{ header: 'ASSET', width: 10 }, { header: 'DELTA', width: 16, align: 'right' }, { header: 'USD VALUE', width: 14, align: 'right' }],
          invRows,
        ));
        lines.push('');
        lines.push(theme.section('  FILLS & EDGE (aggregate)'));
        lines.push(renderKV([
          ['total fills', String(s.fills) + theme.muted(`  (${s.buyFills} bid / ${s.sellFills} ask)`)],
          ['fill rate', fillRate + theme.muted('  (fills / quotes placed)')],
          ['dollar volume', fmtUsd(s.dollarVolume, 2) + theme.muted(`  (≈ ${fmtUsd(dollarVolPerHour, 2)}/hr)`)],
          ['realized edge', theme.success(fmtUsd(s.realizedEdgeUsd, 4)) + theme.muted(`  (Σ |fill-mid| × size)`)],
          ['edge per fill', s.fills > 0 ? theme.success(fmtUsd(edgePerFill, 6)) : theme.muted('—')],
          ['last fill', s.lastFillAt !== null ? new Date(s.lastFillAt).toLocaleTimeString() : theme.muted('—')],
        ]));
        return lines.join('\n');
      }
      if (sub !== 'start') return renderError('usage: mm-multi start|stop|status');

      const symbolsArg = args[1];
      if (!symbolsArg || !symbolsArg.includes(',')) {
        return renderError('mm-multi requires 2+ comma-separated symbols. For single-market, use `mm start`.');
      }
      if (!ctx.wallet.isConnected) return renderError('wallet not connected');
      if (ctx.simulationMode) return renderWarn('simulation mode — set live with "mode live" first');

      const symbols = symbolsArg.split(',').map((s) => s.trim()).filter(Boolean);
      const flagVal = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
      const size = Number(flagVal('size') ?? '0.05');
      if (!Number.isFinite(size) || size <= 0) return renderError('--size required');
      const halfBps = Number(flagVal('half') ?? DEFAULT_MULTI_MAKER.baseHalfSpreadBps);
      const gamma = Number(flagVal('gamma') ?? DEFAULT_MULTI_MAKER.riskAversion);
      const interval = Number(flagVal('interval') ?? DEFAULT_MULTI_MAKER.intervalMs);
      const useJito = args.includes('--use-jito') || args.includes('--jito');
      const tip = flagVal('tip') ? Number(flagVal('tip')) : undefined;
      const oracleAnchored = args.includes('--oracle-anchor') || args.includes('--anchor');
      const maxOracleDev = flagVal('max-oracle-dev') ? Number(flagVal('max-oracle-dev')) : undefined;

      // Parse --max-inv "SOL=2,USDC=500" into a Map
      const maxInv = new Map<string, number>();
      const maxInvRaw = flagVal('max-inv');
      if (maxInvRaw) {
        for (const pair of maxInvRaw.split(',')) {
          const [asset, amt] = pair.split('=');
          if (asset && Number.isFinite(Number(amt))) maxInv.set(asset.trim(), Number(amt));
        }
      }

      if (ctx.activeMultiMaker) {
        await ctx.activeMultiMaker.stop();
        ctx.activeMultiMaker = null;
      }
      try {
        ctx.activeMultiMaker = new MultiMarketMaker(ctx.rpc.connection, ctx.wallet.getKeypair()!, {
          ...DEFAULT_MULTI_MAKER,
          symbols,
          quoteSizeBase: size,
          baseHalfSpreadBps: halfBps,
          riskAversion: gamma,
          intervalMs: interval,
          maxInventoryByAsset: maxInv,
          useJito,
          tipLamports: tip,
          oracleAnchored,
          maxOracleDevBps: maxOracleDev,
        });
        await ctx.activeMultiMaker.start();
      } catch (e) {
        return renderError(`failed to start multi-maker: ${(e as Error).message}`);
      }
      const jitoTag = useJito ? theme.accent('  + Jito') : '';
      return renderSuccess(`multi-maker started on ${symbols.length} markets (size=${size}, half=${halfBps}bps, γ=${gamma}, interval=${interval}ms)${jitoTag}`);
    },
  });

  engine.register({
    name: 'dashboard',
    summary: 'Full-screen risk dashboard — wallet, exposure, makers, PnL, oracle, RPC, limits. Refreshes every 5s.',
    usage: 'dashboard',
    aliases: ['risk', 'panel'],
    handler: async () => {
      const dash = new Dashboard({
        wallet: ctx.wallet,
        rpc: ctx.rpc,
        maker: () => ctx.activeMaker,
        multiMaker: () => ctx.activeMultiMaker,
        simulationMode: () => ctx.simulationMode,
      });
      await dash.start();
      await new Promise<void>((resolve) => {
        const onSig = async () => {
          process.off('SIGINT', onSig);
          await dash.stop();
          process.stdout.write('\n');
          resolve();
        };
        process.on('SIGINT', onSig);
      });
    },
  });

  engine.register({
    name: 'advise',
    summary: 'AI advisor — analyzes live state (wallet, PnL, MM, oracle) and gives prioritized actions.',
    usage: 'advise [question]',
    aliases: ['advisor'],
    examples: ['advise', 'advise should i tighten my mm spread', 'advise where is the best edge right now'],
    handler: async (args) => {
      if (!process.env.ANTHROPIC_API_KEY) return renderError('ANTHROPIC_API_KEY not set');
      const question = args.join(' ').trim() || undefined;
      const lines: string[] = [];
      lines.push(theme.header('  AI ADVISOR'));
      lines.push('  ' + theme.fullSeparator().slice(0, 78));
      process.stdout.write(lines.join('\n') + '\n');
      process.stdout.write(renderInfo('gathering live state (wallet, PnL, oracle, markets)…') + '\n');
      const t0 = Date.now();
      let state;
      try {
        state = await gatherLiveState({
          wallet: ctx.wallet,
          simulationMode: ctx.simulationMode,
          maker: ctx.activeMaker,
          multiMaker: ctx.activeMultiMaker,
        });
      } catch (e) {
        return renderError(`state gather failed: ${(e as Error).message}`);
      }
      process.stdout.write(renderInfo(`state gathered in ${Date.now() - t0}ms · sending to ${process.env.ADVISOR_MODEL ?? process.env.AI_MODEL ?? 'claude-haiku-4-5'}…`) + '\n\n');

      try {
        const advisor = new Advisor();
        const t1 = Date.now();
        const advice = await advisor.advise(state, question);
        // Render markdown with light theming — bold headings, bullets indented
        const formatted = advice
          .split('\n')
          .map((l) => {
            if (l.startsWith('## ')) return '\n' + theme.header('  ' + l.slice(3)) + '\n  ' + theme.muted('─'.repeat(60));
            if (l.startsWith('- ') || l.match(/^\d+\./)) return '  ' + l;
            return '  ' + l;
          })
          .join('\n');
        return formatted + '\n\n  ' + theme.muted(`(advisor responded in ${Date.now() - t1}ms)`);
      } catch (e) {
        return renderError(`advisor: ${(e as Error).message}`);
      }
    },
  });

  engine.register({
    name: 'backtest',
    summary: 'Passive MM backtest — replay historical fills, simulate your quotes at the configured spread.',
    usage: 'backtest <symbol> --hours N --size BASE --half BPS [--max-sigs N]',
    examples: [
      'backtest SOL/USDC --hours 4 --size 0.05 --half 8',
      'backtest SOL/USDC --hours 12 --size 0.1 --half 20 --max-sigs 1000',
    ],
    handler: async (args) => {
      const symbol = args[0];
      if (!symbol || symbol.startsWith('--')) return renderError('usage: backtest <symbol> --hours N --size B --half BPS');
      const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
      const hours = Number(flag('hours') ?? '4');
      const size = Number(flag('size') ?? '0.05');
      const halfBps = Number(flag('half') ?? '8');
      const maxSigs = Number(flag('max-sigs') ?? '500');
      if (!Number.isFinite(hours) || hours <= 0) return renderError('--hours must be > 0');
      if (!Number.isFinite(size) || size <= 0) return renderError('--size must be > 0');
      if (!Number.isFinite(halfBps) || halfBps <= 0) return renderError('--half must be > 0');

      process.stdout.write(renderInfo(`scanning last ${hours}h of ${symbol} (up to ${maxSigs} sigs, throttled)…`) + '\n');
      const t0 = Date.now();
      const result = await runBacktest(ctx.rpc.connection, {
        symbol, hours, sizeBase: size, halfSpreadBps: halfBps, maxSignatures: maxSigs,
      }, (scanned, total) => {
        if (scanned % 100 === 0) process.stdout.write(theme.muted(`  …${scanned}/${total} sigs scanned\n`));
      });
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      const pnlColor = result.realizedPnlUsd >= 0 ? theme.success : theme.error;
      const lines: string[] = [];
      lines.push('');
      lines.push(theme.header(`  BACKTEST: ${symbol} over last ${hours}h`));
      lines.push('  ' + theme.fullSeparator().slice(0, 78));
      lines.push(renderKV([
        ['config', `size ${size} ${symbol.split('/')[0]}, half-spread ${halfBps}bps`],
        ['scan time', `${elapsed}s`],
        ['observed fills', `${result.observedFills}  (${fmtUsd(result.observedVolumeUsd, 2)} total volume)`],
        ['observed avg spread vs mid', `${result.observedAvgSpreadFromMidBps.toFixed(1)}bps`],
        ['mid drift over window', result.midDriftBps !== null ? `${result.midDriftBps >= 0 ? '+' : ''}${result.midDriftBps.toFixed(1)}bps  (${fmtUsd(result.startMid ?? 0, 4)} → ${fmtUsd(result.endMid ?? 0, 4)})` : '—'],
      ]));
      lines.push('');
      lines.push(theme.section('  YOUR SIMULATED MM RESULTS'));
      lines.push(renderKV([
        ['captured fills', `${result.ourFills}  (${result.ourBuyFills} bid / ${result.ourSellFills} ask)`],
        ['fill rate', result.observedFills > 0 ? `${(result.ourFills / result.observedFills * 100).toFixed(1)}% of market activity` : '—'],
        ['volume traded', fmtUsd(result.ourVolumeUsd, 2)],
        ['edge captured', theme.success(fmtUsd(result.edgeCapturedUsd, 4)) + theme.muted(`  (Σ |mid - quote| × size)`)],
        ['edge per fill', result.ourFills > 0 ? theme.success(fmtUsd(result.edgePerFillUsd, 6)) : theme.muted('—')],
        ['realized PnL (WAC)', pnlColor((result.realizedPnlUsd >= 0 ? '+' : '') + fmtUsd(result.realizedPnlUsd, 4))],
        ['max abs inventory', `${fmtNum(result.maxAbsInventoryBase, 4)} base`],
        ['end inventory', `${fmtNum(result.endInventoryBase, 4)} base  ${theme.muted('(unrealized at end mid)')}`],
      ]));
      lines.push('');
      lines.push(theme.muted('  Caveat: passive sim — assumes your quote was always resting at the configured offset.'));
      lines.push(theme.muted('  Reality has queue priority, latency, and adverse-selection effects. Use as a SANITY CHECK.'));
      return lines.join('\n');
    },
  });

  engine.register({
    name: 'notify',
    summary: 'Test push notifications (Discord/Slack/Telegram/generic webhook) or check config.',
    usage: 'notify [test|status]',
    examples: ['notify status', 'notify test'],
    handler: async (args) => {
      const sub = args[0] ?? 'status';
      const n = getNotifier();
      if (sub === 'status') {
        return renderKV([
          ['configured', n.configured ? theme.success('yes') : theme.muted('no channels set')],
          ['channels', n.channelNames.join(', ') || theme.muted('—')],
          ['min severity', process.env.ALERT_MIN_SEVERITY ?? 'info'],
          ['setup', theme.muted('set DISCORD_WEBHOOK_URL / SLACK_WEBHOOK_URL / TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID / ALERT_WEBHOOK_URL in .env')],
        ]);
      }
      if (sub === 'test') {
        if (!n.configured) return renderError('no notification channels configured — set one of the env vars first');
        await n.notifyAwait({
          kind: 'custom', severity: 'info',
          title: 'phoenix-terminal · test',
          body: 'this is a test notification fired from `notify test`',
          fields: { wallet: ctx.wallet.address ?? 'not connected', mode: ctx.simulationMode ? 'paper' : 'LIVE' },
        });
        return renderSuccess(`test fired to ${n.channelNames.length} channel(s): ${n.channelNames.join(', ')}`);
      }
      return renderError('usage: notify [status|test]');
    },
  });

  engine.register({
    name: 'examples',
    summary: 'Curated advanced trading prompts you can run via AI.',
    usage: 'examples',
    aliases: ['demo', 'cheatsheet'],
    handler: async () => {
      const groups: Array<[string, string[]]> = [
        ['Market data', [
          'whats sol trading at',
          'show me the sol usdc orderbook',
          'deep orderbook on sol with 30 levels',
          'show individual orders on sol/usdc',
          'whats the spread on jto usdc',
        ]],
        ['Oracle / risk', [
          'sol vs pyth deviation',
          'is sol mispriced on phoenix',
          'oracle prices for everything',
        ]],
        ['Multi-market monitoring', [
          'watch sol jto and pyth',
          'monitor all the deep markets',
          'show me whats happening live',
        ]],
        ['Pre-trade quoting', [
          'predict my fill for buying 100 usdc of sol',
          'what would i get if i sold 0.5 sol',
          'how much usdc do i need for 1 sol',
        ]],
        ['Surgical cancels', [
          'cancel my top 5 orders on sol/usdc',
          'cancel my top 3 bids on jto',
          'is anyone evictable on sol/usdc',
        ]],
        ['Market introspection', [
          'show me the tick size for sol',
          'is sol/usdc tradable right now',
          'claim a seat on sol/usdc',
        ]],
        ['Triangular arb', [
          'scan triangular arb across all phoenix markets',
          'find me arb above 10 bps',
        ]],
        ['Execution', [
          'buy 0.1 sol market with 1% slippage',
          'place a tight bid at 85 size 0.1',
          'sell half my sol at 90',
          'ape 0.05 sol right now',
          'dump 1 sol asap',
        ]],
        ['Inventory-aware market making', [
          'make markets on sol/usdc with tight 5bps spread size 0.05',
          'deposit 200 usdc to my sol seat',
          'place a 5 level ladder size 0.1 step 3bps using free funds',
          'mm status',
          'stop the maker bot',
        ]],
        ['Seat / vault management', [
          'free funds sol/usdc',
          'withdraw all my sol/usdc seat funds',
        ]],
        ['Wallet / system', [
          'wallet',
          'rpc status',
          'show my recent fills',
        ]],
        ['PnL & journal', [
          'whats my pnl',
          'show me my realized profit',
          'resync my fills from chain',
          'mm status',
        ]],
        ['Risk-aware execution', [
          'buy 1 sol but reject if slippage over 30bps',
          'sell 0.5 sol market with tight slippage',
          'ape 0.2 sol but cap impact at 50bps',
        ]],
        ['Jito bundles (guaranteed inclusion)', [
          'whats the jito tip floor',
          'recommend a 75th percentile tip',
          'buy 0.5 sol via jito',
          'start mm via jito',
        ]],
        ['Multi-market MM (cross-market inventory)', [
          'make markets on sol/usdc and sol/usdt',
          'mm-multi start SOL/USDC,SOL/USDT,JitoSOL/SOL --size 0.05',
          'mm-multi status',
          'stop the multi maker',
        ]],
        ['Risk dashboard (full-screen control room)', [
          'dashboard',
          'open the dashboard',
          'control room',
        ]],
        ['AI advisor (live-state coaching)', [
          'advise',
          'what should i do',
          'advise where is the best edge right now',
          'advise should i tighten my mm spread',
        ]],
        ['Backtester (passive sim against historical fills)', [
          'backtest SOL/USDC --hours 4 --size 0.05 --half 8',
          'would 20bps spread have made money on sol last 12 hours',
          'simulate mm for the last 6 hours',
        ]],
      ];
      const out: string[] = [];
      out.push(theme.highlight('  Phoenix Terminal — advanced prompt cheatsheet'));
      out.push(theme.muted('  Any of these can be typed directly (the AI translates them).'));
      out.push('');
      for (const [name, prompts] of groups) {
        out.push(`  ${theme.accent('▸ ' + name)}`);
        for (const p of prompts) out.push(`    ${theme.muted('•')} ${theme.value(p)}`);
        out.push('');
      }
      out.push(theme.muted('  Tip: type ') + theme.highlight('ai <prompt>') + theme.muted(' for explicit AI mode, or just type naturally.'));
      return out.join('\n');
    },
  });

  engine.register({
    name: 'jito',
    summary: 'Show current Jito bundle tip floor + tip account roster.',
    usage: 'jito [recommend PERCENTILE]',
    examples: ['jito', 'jito recommend 75'],
    handler: async (args) => {
      if (args[0] === 'recommend') {
        const pct = Number(args[1]) as 25 | 50 | 75 | 95 | 99;
        const lamports = await recommendTipLamports(pct);
        return renderInfo(`Recommended tip @ ${pct}th percentile: ${lamports.toLocaleString()} lamports (${(lamports/1e9).toFixed(6)} SOL)`);
      }
      const floor = await fetchTipFloor();
      const lines: string[] = [];
      lines.push(theme.header('  JITO BUNDLE TIP FLOOR'));
      lines.push('  ' + theme.fullSeparator().slice(0, 78));
      if (!floor) {
        lines.push(renderError('failed to fetch tip floor (network or Jito API unavailable)'));
      } else {
        lines.push(renderKV([
          ['updated', floor.time],
          ['25th percentile', `${(floor.landed_tips_25th_percentile * 1e9).toLocaleString()} lamports  (${(floor.landed_tips_25th_percentile).toFixed(8)} SOL)`],
          ['50th percentile', `${(floor.landed_tips_50th_percentile * 1e9).toLocaleString()} lamports  (${(floor.landed_tips_50th_percentile).toFixed(8)} SOL)`],
          ['75th percentile', `${(floor.landed_tips_75th_percentile * 1e9).toLocaleString()} lamports  (${(floor.landed_tips_75th_percentile).toFixed(8)} SOL)`],
          ['95th percentile', `${(floor.landed_tips_95th_percentile * 1e9).toLocaleString()} lamports  (${(floor.landed_tips_95th_percentile).toFixed(8)} SOL)`],
          ['99th percentile', `${(floor.landed_tips_99th_percentile * 1e9).toLocaleString()} lamports  (${(floor.landed_tips_99th_percentile).toFixed(8)} SOL)`],
          ['EMA 50th', `${(floor.ema_landed_tips_50th_percentile * 1e9).toLocaleString()} lamports`],
          ['your default', `${defaultTipLamports().toLocaleString()} lamports  (set JITO_DEFAULT_TIP_LAMPORTS in .env)`],
        ]));
      }
      lines.push('');
      lines.push(theme.section('  TIP ACCOUNTS (8 rotating)'));
      for (const a of JITO_TIP_ACCOUNTS) lines.push(`  ${theme.muted('•')} ${a}`);
      lines.push('');
      lines.push(theme.muted('  Use --use-jito on buy/sell/cancel/mm for guaranteed inclusion. Tip is auto-added.'));
      return lines.join('\n');
    },
  });

  engine.register({
    name: 'quit',
    summary: 'Exit the terminal.',
    usage: 'quit',
    aliases: ['exit', 'q'],
    handler: async () => {
      if (ctx.activeMaker) await ctx.activeMaker.stop();
      if (ctx.activeWatcher) await ctx.activeWatcher.stop();
      process.exit(0);
    },
  });
}

async function placeOrderCmd(ctx: AppCtx, side: 'bid' | 'ask', args: string[]): Promise<string> {
  if (!ctx.wallet.isConnected) return renderError('wallet not connected');
  const cfg = loadConfig();
  if (ctx.simulationMode) return renderWarn('simulation mode — no on-chain action. Set SIMULATION_MODE=false to go live.');
  const symbol = args[0];
  const size = Number(args[1]);
  if (!symbol || !Number.isFinite(size) || size <= 0) {
    return renderError(`usage: ${side === 'bid' ? 'buy' : 'sell'} <symbol> <size> [@price] [--ioc] [--ttl SEC]`);
  }
  const ioc = args.includes('--ioc');
  const priceFlag = args.find((a) => a.startsWith('@'));
  const priceUsd = priceFlag ? Number(priceFlag.slice(1)) : NaN;
  const ttlIdx = args.indexOf('--ttl');
  const ttlSec = ttlIdx >= 0 ? Number(args[ttlIdx + 1]) : 30;
  const slipIdx = args.indexOf('--max-slippage');
  const maxSlippageBps = slipIdx >= 0 ? Number(args[slipIdx + 1]) : undefined;
  const useJito = args.includes('--use-jito') || args.includes('--jito');
  const tipIdx = args.indexOf('--tip');
  const tipLamports = tipIdx >= 0 ? Number(args[tipIdx + 1]) : undefined;

  const signer = ctx.wallet.getKeypair()!;
  const def = findMarket(symbol);
  if (!def) return renderError(`unknown market: ${symbol}`);

  // For SOL-base bids, auto-wrap rough notional
  let wrapSolLamports = 0;
  if (def.baseSymbol === 'SOL' && side === 'bid' && !ioc) {
    // Estimate wrap need from explicit price * size (limit case)
    if (Number.isFinite(priceUsd)) wrapSolLamports = Math.ceil(priceUsd * size * LAMPORTS_PER_SOL);
  }

  if (ioc) {
    const res = await placeIoc(ctx.rpc.connection, signer, { symbol, side, sizeBase: size, wrapSolLamports, maxSlippageBps, useJito, tipLamports });
    return [
      renderSuccess(`IOC ${side.toUpperCase()} ${size} ${def.baseSymbol} → filled ${fmtNum(res.filledBase, 6)} ${def.baseSymbol} (${fmtUsd(res.filledNotionalUsd)})`),
      `  ${theme.muted('sig:')} ${res.signature}`,
      `  ${theme.muted('explorer:')} ${txLink(res.signature, cfg.network)}`,
    ].join('\n');
  }
  if (!Number.isFinite(priceUsd)) return renderError('limit orders require a @price (use --ioc for market)');
  const res = await placeLimit(ctx.rpc.connection, signer, { symbol, side, priceUsd, sizeBase: size, ttlSec, wrapSolLamports, useJito, tipLamports });
  return [
    renderSuccess(`LIMIT ${side.toUpperCase()} ${size} ${def.baseSymbol} @ ${fmtUsd(priceUsd, 4)} → ${res.filledBase > 0 ? `filled ${fmtNum(res.filledBase, 6)}` : 'resting'}`),
    `  ${theme.muted('sig:')} ${res.signature}`,
    `  ${theme.muted('explorer:')} ${txLink(res.signature, cfg.network)}`,
  ].join('\n');
}
