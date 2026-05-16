import chalk from 'chalk';

export function fmtUsd(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtNum(v: number, decimals = 4): string {
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

export function fmtPct(v: number, decimals = 2): string {
  if (!Number.isFinite(v)) return '—';
  return v.toFixed(decimals) + '%';
}

export function shortAddr(addr: string): string {
  if (addr.length <= 12) return addr;
  return addr.slice(0, 4) + '…' + addr.slice(-4);
}

export function colorSide(side: string): string {
  const u = side.toUpperCase();
  if (u === 'BID' || u === 'BUY' || u === 'LONG') return chalk.green(u);
  if (u === 'ASK' || u === 'SELL' || u === 'SHORT') return chalk.red(u);
  return u;
}

export function pad(s: string, width: number, align: 'left' | 'right' = 'left'): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  const gap = Math.max(0, width - visible.length);
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}
