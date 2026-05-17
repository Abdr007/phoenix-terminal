/**
 * `examples` — curated NL prompts the AI translator can map. Pure data + a
 * small renderer. Lifted out of phoenix-tools.ts so the registry stays small.
 */
import { ToolEngine } from './engine.js';
import { theme } from '../cli/theme.js';

const EXAMPLE_GROUPS: Array<[string, string[]]> = [
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

export function registerExamplesTool(engine: ToolEngine): void {
  engine.register({
    name: 'examples',
    summary: 'Curated advanced trading prompts you can run via AI.',
    usage: 'examples',
    aliases: ['demo', 'cheatsheet'],
    handler: async () => {
      const out: string[] = [];
      out.push(theme.highlight('  Phoenix Terminal — advanced prompt cheatsheet'));
      out.push(theme.muted('  Any of these can be typed directly (the AI translates them).'));
      out.push('');
      for (const [name, prompts] of EXAMPLE_GROUPS) {
        out.push(`  ${theme.accent('▸ ' + name)}`);
        for (const p of prompts) out.push(`    ${theme.muted('•')} ${theme.value(p)}`);
        out.push('');
      }
      out.push(theme.muted('  Tip: type ') + theme.highlight('ai <prompt>') + theme.muted(' for explicit AI mode, or just type naturally.'));
      return out.join('\n');
    },
  });
}
