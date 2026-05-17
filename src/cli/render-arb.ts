import { ArbCycle, ExecuteArbResult } from '../phoenix/arb.js';
import { theme } from './theme.js';
import { pad } from '../utils/format.js';
import { fmtNum } from '../utils/format.js';
import { MARKETS } from '../phoenix/markets.js';
import { renderKV, renderError, renderSuccess, renderWarn } from './renderer.js';
import { txLink } from '../utils/explorer.js';

function mintToSymbol(mint: string): string {
  return MARKETS.find((m) => m.baseMint === mint)?.baseSymbol
    ?? MARKETS.find((m) => m.quoteMint === mint)?.quoteSymbol
    ?? mint.slice(0, 4) + '…';
}

export function renderArbTable(cycles: ArbCycle[], minBps = 0, max = 10): string {
  const lines: string[] = [];
  lines.push(theme.highlight('  Triangular arb scan  ') + theme.muted(`· ${cycles.length} cycles · showing top ${max}`));
  lines.push('');
  lines.push(
    pad(theme.muted('PROFIT'), 12, 'right') +
    pad(theme.muted('LEG 1'), 24) +
    pad(theme.muted('LEG 2'), 24) +
    pad(theme.muted('LEG 3'), 24),
  );
  lines.push(theme.muted('─'.repeat(84)));

  const filtered = cycles.filter((c) => c.profitBps >= minBps).slice(0, max);
  if (filtered.length === 0) {
    lines.push(theme.muted('  (no cycles above threshold)'));
    return lines.join('\n');
  }
  for (const c of filtered) {
    if (c.legs.length < 3) continue; // triangle scanner guarantees 3 legs; defensive skip
    const profitStr = c.profitBps >= 0
      ? theme.success(`+${c.profitBps.toFixed(1)}bps`)
      : theme.error(`${c.profitBps.toFixed(1)}bps`);
    lines.push(
      pad(profitStr, 12, 'right') +
      pad(theme.label(legStr(c.legs[0]!)), 24) +
      pad(theme.label(legStr(c.legs[1]!)), 24) +
      pad(theme.label(legStr(c.legs[2]!)), 24),
    );
  }
  return lines.join('\n');
}

function legStr(leg: { marketSymbol: string; from: string; to: string }): string {
  return `${mintToSymbol(leg.from)}→${mintToSymbol(leg.to)} (${leg.marketSymbol})`;
}

export function renderArbResult(result: ExecuteArbResult, network = 'mainnet-beta'): string {
  const lines: string[] = [];
  lines.push(theme.header('  ARB EXECUTION RESULT'));
  lines.push('  ' + theme.fullSeparator().slice(0, 78));
  const startSym = mintToSymbol(result.cycle.startMint);
  const profitColor = result.realizedProfitBps >= 0 ? theme.success : theme.error;
  lines.push(renderKV([
    ['mode', result.dryRun ? theme.success('DRY RUN (simulated)') : theme.error('LIVE')],
    ['cycle', result.cycle.legs.map((l) => mintToSymbol(l.from)).join(' → ') + ` → ${startSym}`],
    ['start size', `${fmtNum(result.startSize, 6)} ${startSym}`],
    ['end size', `${fmtNum(result.endSize, 6)} ${startSym}`],
    ['realized profit', profitColor(`${result.realizedProfitBps >= 0 ? '+' : ''}${result.realizedProfitBps.toFixed(2)}bps`)],
    ['status', result.aborted ? theme.error('ABORTED') : theme.success('completed')],
  ]));
  lines.push('');
  lines.push(theme.section('  PER-LEG'));
  for (let i = 0; i < result.legs.length; i++) {
    const l = result.legs[i];
    if (!l) continue;
    const status =
      l.status === 'executed' ? theme.success('✓') :
      l.status === 'failed' ? theme.error('✗') :
      l.status === 'skipped' ? theme.warning('—') :
      theme.muted('?');
    lines.push(`  ${status} Leg ${i + 1}: ${l.marketSymbol}  ${l.side === 'bid' ? theme.bid('BID') : theme.ask('ASK')}`);
    lines.push(`      in: ${fmtNum(l.inAmount, 6)} ${mintToSymbol(l.fromMint)}  →  out: ${fmtNum(l.actualOut ?? l.expectedOut, 6)} ${mintToSymbol(l.toMint)}  ${theme.muted(`(predicted ${fmtNum(l.expectedOut, 6)})`)}`);
    if (l.signature) lines.push(`      sig: ${l.signature}`);
    if (l.signature) lines.push(`      ${theme.muted('explorer:')} ${txLink(l.signature, network)}`);
    if (l.error) lines.push(`      ${theme.error('error:')} ${l.error}`);
  }
  if (result.aborted) {
    lines.push('');
    lines.push(renderWarn('Cycle aborted mid-flight — check wallet balances. Remaining inventory may be in a non-startMint asset.'));
  } else if (!result.dryRun && result.realizedProfitBps > 0) {
    lines.push('');
    lines.push(renderSuccess(`profitable cycle landed.`));
  } else if (!result.dryRun && result.realizedProfitBps <= 0) {
    lines.push('');
    lines.push(renderError(`cycle completed at a loss — likely slippage between legs`));
  }
  return lines.join('\n');
}
