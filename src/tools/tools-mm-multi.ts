/**
 * mm-multi tool — cross-market market maker with ASSET-level inventory
 * aggregation. Lifted out of phoenix-tools.ts.
 */
import { ToolEngine } from './engine.js';
import { AppCtx, flagNum } from './tool-helpers.js';
import { MultiMarketMaker, DEFAULT_MULTI_MAKER } from '../phoenix/multi-maker.js';
import { renderError, renderInfo, renderKV, renderSuccess, renderTable, renderWarn } from '../cli/renderer.js';
import { theme } from '../cli/theme.js';
import { fmtNum, fmtUsd } from '../utils/format.js';

export function registerMmMultiTool(engine: ToolEngine, ctx: AppCtx): void {
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
      const size = flagNum(args, '--size', 0.05);
      if (size <= 0) return renderError('--size required');
      const halfBps = flagNum(args, '--half', DEFAULT_MULTI_MAKER.baseHalfSpreadBps);
      const gamma = flagNum(args, '--gamma', DEFAULT_MULTI_MAKER.riskAversion);
      const interval = flagNum(args, '--interval', DEFAULT_MULTI_MAKER.intervalMs);
      const useJito = args.includes('--use-jito') || args.includes('--jito');
      const tip = args.includes('--tip') ? flagNum(args, '--tip', 0) : undefined;
      const oracleAnchored = args.includes('--oracle-anchor') || args.includes('--anchor');
      const maxOracleDev = args.includes('--max-oracle-dev') ? flagNum(args, '--max-oracle-dev', 0) : undefined;

      // Parse --max-inv "SOL=2,USDC=500" into a Map (this flag is not numeric,
      // so it doesn't go through flagNum — but the CSV parser still drops
      // entries that don't parse as finite numbers).
      const maxInv = new Map<string, number>();
      const maxInvIdx = args.indexOf('--max-inv');
      const maxInvRaw = maxInvIdx >= 0 ? args[maxInvIdx + 1] : undefined;
      if (maxInvRaw && !maxInvRaw.startsWith('--')) {
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
}
