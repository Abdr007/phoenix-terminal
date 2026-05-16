import chalk from 'chalk';
import { theme } from './theme.js';
import { pad } from '../utils/format.js';

export interface Column {
  header: string;
  width: number;
  align?: 'left' | 'right';
}

function termWidth(): number {
  return Math.min(process.stdout.columns || 80, 120);
}

/** A clean section block: title + rule + body. */
export function renderBlock(title: string, body: string): string {
  return [
    theme.header('  ' + title.toUpperCase()),
    '  ' + theme.fullSeparator().slice(0, termWidth() - 2),
    body,
  ].join('\n');
}

export function renderTable(cols: Column[], rows: string[][]): string {
  const headerLine = '  ' + cols
    .map((c) => theme.key(pad(c.header.toUpperCase(), c.width, c.align)))
    .join('  ');
  const totalWidth = cols.reduce((s, c) => s + c.width, 0) + (cols.length - 1) * 2 + 2;
  const sep = '  ' + theme.muted('─'.repeat(Math.min(totalWidth - 2, termWidth() - 2)));
  const dataLines = rows.map(
    (r) => '  ' + cols.map((c, i) => pad(r[i] ?? '', c.width, c.align)).join('  '),
  );
  return [headerLine, sep, ...dataLines].join('\n');
}

export function renderKV(pairs: Array<[string, string]>): string {
  const maxKey = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `  ${theme.key(pad(k, maxKey))}   ${v}`).join('\n');
}

export function renderHeader(title: string, subtitle?: string): string {
  const t = theme.header(title);
  return subtitle ? `${t} ${theme.muted('·')} ${theme.muted(subtitle)}` : t;
}

export function renderError(msg: string): string {
  return '  ' + theme.error('✖') + '  ' + msg;
}

export function renderSuccess(msg: string): string {
  return '  ' + theme.success('✓') + '  ' + msg;
}

export function renderInfo(msg: string): string {
  return '  ' + theme.accent('›') + '  ' + msg;
}

export function renderWarn(msg: string): string {
  return '  ' + theme.warning('⚠') + '  ' + msg;
}

/** Render a depth bar for orderbook visualization. */
export function depthBar(amount: number, max: number, width: number, side: 'bid' | 'ask'): string {
  if (max <= 0 || amount <= 0) return ' '.repeat(width);
  const filled = Math.round((amount / max) * width);
  const color = side === 'bid' ? theme.bid : theme.ask;
  const bar = side === 'bid'
    ? color('█'.repeat(filled)) + ' '.repeat(width - filled)
    : ' '.repeat(width - filled) + color('█'.repeat(filled));
  return bar;
}

export function clearScreen(): void {
  process.stdout.write(chalk.reset(''));
  process.stdout.write('\x1Bc');
}

/**
 * Alt-screen renderer for full-screen views (watch, mm).
 * Mirrors bolt-terminal's TermRenderer: enters alt buffer, overwrites lines
 * in place, caps at terminal height so nothing scrolls.
 */
export class AltScreenRenderer {
  private previous: string[] = [];
  private inAlt = false;

  enter(): void {
    if (!this.inAlt) {
      process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[?25l');
      this.inAlt = true;
    }
  }

  leave(): void {
    if (this.inAlt) {
      process.stdout.write('\x1b[?25h\x1b[?1049l');
      this.inAlt = false;
    }
  }

  render(lines: string[]): void {
    const maxRows = (process.stdout.rows || 24) - 1;
    const visible = lines.slice(0, maxRows);
    let buf = '\x1b[?25l\x1b[H';
    for (const line of visible) buf += line + '\x1b[K\n';
    buf += '\x1b[J\x1b[?25h';
    process.stdout.write(buf);
    this.previous = visible;
  }
}
