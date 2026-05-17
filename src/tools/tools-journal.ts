/**
 * Journal tools — `fills` (recent fill listing) and `pnl` (WAC summary).
 * Pulled out of phoenix-tools.ts to keep the registry under the lint threshold.
 */
import { Connection } from '@solana/web3.js';
import { ToolEngine } from './engine.js';
import { AppCtx } from './tool-helpers.js';
import { getJournal, indexWalletFills } from '../phoenix/journal.js';
import { fetchWalletFills } from '../phoenix/fills.js';
import { renderError, renderInfo, renderKV, renderTable } from '../cli/renderer.js';
import { theme } from '../cli/theme.js';
import { fmtNum, fmtUsd } from '../utils/format.js';

/** Format a value in its native quote currency — USDC/USDT get `$` prefix,
 *  others get the symbol suffix so SOL isn't mistakenly rendered as USD. */
function fmtInQuote(value: number, quote: string, dp = 4): string {
  if (quote === 'USDC' || quote === 'USDT') return fmtUsd(value, dp);
  return `${fmtNum(value, dp)} ${quote}`;
}

export function registerJournalTools(engine: ToolEngine, ctx: AppCtx): void {
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
        const live = await fetchWalletFills(ctx.rpc.connection as Connection, wallet, { scanLimit: limit * 3, resultLimit: limit });
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
        ['unique markets', String(s.uniqueMarkets)],
        ['active days', String(s.uniqueActiveDays)],
      ]));

      // Per-quote-currency breakdown — values are NEVER summed across mismatched
      // units. A trader running USDC pairs + JitoSOL/SOL sees two rows.
      if (s.totalsByQuote.length > 0) {
        lines.push('');
        lines.push(theme.section('  TOTALS BY QUOTE CURRENCY'));
        lines.push(renderTable(
          [
            { header: 'QUOTE', width: 8 },
            { header: 'VOLUME', width: 16, align: 'right' },
            { header: 'REALIZED', width: 16, align: 'right' },
            { header: 'FEES', width: 14, align: 'right' },
            { header: 'NET', width: 16, align: 'right' },
            { header: 'MAKER %', width: 9, align: 'right' },
          ],
          s.totalsByQuote.map((q) => {
            const net = q.totalRealizedPnl - q.totalFees;
            const realizedStr = q.totalRealizedPnl >= 0
              ? theme.success('+' + fmtInQuote(q.totalRealizedPnl, q.quoteSymbol))
              : theme.error(fmtInQuote(q.totalRealizedPnl, q.quoteSymbol));
            const netStr = net >= 0
              ? theme.success('+' + fmtInQuote(net, q.quoteSymbol))
              : theme.error(fmtInQuote(net, q.quoteSymbol));
            const makerPct = q.totalVolume > 0 ? (q.makerVolume / q.totalVolume * 100).toFixed(0) + '%' : '—';
            return [
              q.quoteSymbol,
              fmtInQuote(q.totalVolume, q.quoteSymbol, 2),
              realizedStr,
              fmtInQuote(q.totalFees, q.quoteSymbol),
              netStr,
              makerPct,
            ];
          }),
        ));
      }

      lines.push('');
      lines.push(theme.section('  PER-MARKET'));
      lines.push(renderTable(
        [
          { header: 'MARKET', width: 14 },
          { header: 'FILLS', width: 6, align: 'right' },
          { header: 'VOLUME', width: 16, align: 'right' },
          { header: 'INVENTORY', width: 12, align: 'right' },
          { header: 'AVG COST', width: 14, align: 'right' },
          { header: 'REALIZED', width: 16, align: 'right' },
          { header: 'MAKER %', width: 9, align: 'right' },
        ],
        s.perMarket.map((m) => {
          const totalVol = m.buyNotionalUsd + m.sellNotionalUsd;
          const makerPct = totalVol > 0 ? (m.makerVolumeUsd / totalVol * 100).toFixed(0) + '%' : '—';
          const pnlStr = m.realizedPnlUsd >= 0
            ? theme.success('+' + fmtInQuote(m.realizedPnlUsd, m.quoteSymbol))
            : theme.error(fmtInQuote(m.realizedPnlUsd, m.quoteSymbol));
          return [
            m.market,
            String(m.fills),
            fmtInQuote(totalVol, m.quoteSymbol, 2),
            fmtNum(m.inventoryBase, 4),
            m.avgCostUsd > 0 ? fmtInQuote(m.avgCostUsd, m.quoteSymbol) : '—',
            pnlStr,
            makerPct,
          ];
        }),
      ));
      return lines.join('\n');
    },
  });
}
