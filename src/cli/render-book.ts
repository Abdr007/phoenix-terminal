import { Orderbook } from '../types/index.js';
import { theme } from './theme.js';
import { fmtNum, fmtUsd, pad } from '../utils/format.js';
import { depthBar } from './renderer.js';

export function renderBook(book: Orderbook, depth = 10): string {
  const lines: string[] = [];
  lines.push(theme.highlight(`  ${book.market}  `) + theme.muted(`book · ${new Date(book.timestamp).toLocaleTimeString()}`));
  if (book.midUsd !== null) {
    lines.push(
      `  ${theme.label('mid')}  ${theme.value(fmtUsd(book.midUsd, 4))}   ` +
      `${theme.label('spread')}  ${theme.value((book.spreadBps ?? 0).toFixed(2))}bps`,
    );
  } else {
    lines.push(`  ${theme.muted('(no two-sided market)')}`);
  }
  lines.push('');

  const bids = book.bids.slice(0, depth);
  const asks = book.asks.slice(0, depth);
  const maxDepthBase = Math.max(
    bids[bids.length - 1]?.cumulativeBase ?? 0,
    asks[asks.length - 1]?.cumulativeBase ?? 0,
    1,
  );

  // Header
  lines.push(
    pad(theme.muted('PRICE'), 14) +
    pad(theme.muted('SIZE'), 14) +
    pad(theme.muted('SUM'), 14) +
    pad(theme.muted('DEPTH'), 22),
  );
  lines.push(theme.muted('─'.repeat(64)));

  // Asks descending (worst at top, best near mid)
  for (let i = asks.length - 1; i >= 0; i--) {
    const lvl = asks[i];
    if (!lvl) continue;
    const bar = depthBar(lvl.cumulativeBase, maxDepthBase, 18, 'ask');
    lines.push(
      pad(theme.ask(fmtUsd(lvl.priceUsd, 4)), 14) +
      pad(theme.value(fmtNum(lvl.sizeBase, 4)), 14) +
      pad(theme.muted(fmtNum(lvl.cumulativeBase, 4)), 14) +
      bar,
    );
  }

  // Mid divider
  if (book.midUsd !== null) {
    lines.push(theme.muted('─── mid ') + theme.highlight(fmtUsd(book.midUsd, 4)) + theme.muted(' ───'));
  }

  // Bids descending (best at top, worst at bottom)
  for (const lvl of bids) {
    const bar = depthBar(lvl.cumulativeBase, maxDepthBase, 18, 'bid');
    lines.push(
      pad(theme.bid(fmtUsd(lvl.priceUsd, 4)), 14) +
      pad(theme.value(fmtNum(lvl.sizeBase, 4)), 14) +
      pad(theme.muted(fmtNum(lvl.cumulativeBase, 4)), 14) +
      bar,
    );
  }

  return lines.join('\n');
}
