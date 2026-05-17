/**
 * AI advisor — gathers live state and asks Claude for actionable trading advice.
 *
 * Different from the interpreter: instead of translating one prompt → one command,
 * the advisor receives a structured snapshot of the trader's full situation
 * (wallet, PnL, MM stats, oracle deviation, market conditions) and returns
 * prioritized risks + opportunities + suggested commands.
 *
 * Best with Sonnet 4.6+ for analysis quality. Falls back to Haiku 4.5
 * (the project's default AI_MODEL) if no advisor-specific override.
 */

import Anthropic from '@anthropic-ai/sdk';
import { WalletManager } from '../wallet/walletManager.js';
import { getJournal } from '../phoenix/journal.js';
import { Maker } from '../phoenix/maker.js';
import { MultiMarketMaker } from '../phoenix/multi-maker.js';
import { fetchPythPrice } from '../phoenix/oracle.js';
import { fetchOrderbook } from '../phoenix/orderbook.js';
import { MARKETS } from '../phoenix/markets.js';
import { safeEnvString } from '../utils/safe-env.js';
import { getLogger } from '../utils/logger.js';

export interface LiveState {
  walletAddress: string | null;
  mode: 'paper' | 'live';
  balances: { sol: number; tokens: Array<{ symbol: string; amount: number }> } | null;
  pnl: {
    totalFills: number;
    totalVolumeUsd: number;
    realizedPnlUsd: number;
    feesUsd: number;
    netPnlUsd: number;
    makerRatio: number;
    activeDays: number;
    perMarket: Array<{ market: string; fills: number; volumeUsd: number; realizedPnlUsd: number; inventoryBase: number; avgCostUsd: number; makerPct: number }>;
  } | null;
  singleMaker: {
    symbol: string;
    uptimeSec: number;
    ticks: number;
    fills: number;
    fillRatePct: number;
    realizedEdgeUsd: number;
    inventoryBase: number;
    errors: number;
  } | null;
  multiMaker: {
    symbols: string[];
    uptimeSec: number;
    ticks: number;
    fills: number;
    realizedEdgeUsd: number;
    dollarVolume: number;
    inventoryByAsset: Array<{ asset: string; amount: number; usdValue: number }>;
    errors: number;
  } | null;
  oracleDeviation: Array<{ asset: string; pythUsd: number | null; phoenixMidUsd: number | null; deviationBps: number | null }>;
  marketSnapshots: Array<{ symbol: string; bestBid: number | null; bestAsk: number | null; midUsd: number | null; spreadBps: number | null }>;
}

const SYSTEM_PROMPT = `You are a senior market-making advisor for Phoenix, a Solana CLOB (Central Limit Order Book) by Ellipsis Labs.

You are advising a trader running \`phoenix-terminal\`, a CLI with these capabilities:
- Market data: \`book\`, \`mid\`, \`l3\`, \`market-info\`, \`oracle\`, \`arb\`
- Execution: \`buy/sell <symbol> <size> [@price] [--ioc] [--max-slippage BPS] [--use-jito]\`
- Single-market MM: \`mm start <symbol> --size N --half BPS --gamma G\`
- Multi-market MM (cross-market inventory): \`mm-multi start <syms-csv> --size N\`
- Surgical cancel: \`cancel-id\`, \`cancel-top\`, \`reduce\`
- Vault: \`deposit <symbol> --quote N\`, \`withdraw\`, \`free-funds\`
- Arb scanner: \`arb\`, \`arb --execute --min-bps N --size B --dry-run\`
- Journal: \`pnl\` (WAC realized PnL from local SQLite), \`fills\`
- Risk: \`dashboard\`

Reality of Phoenix Legacy in 2026:
- TVL ~$1.6M. Volumes compressed since MM attention shifted to Phoenix Perpetuals beta.
- Real liquidity only on SOL/USDC, SOL/USDT, JitoSOL pairs. Most other markets show huge oracle-vs-mid deviations (often 1000+bps) because there's basically no MM.
- Taker fee ~2bps per market, maker rebate effectively 0.
- Typical landed Jito tip floor: 1-5K lamports (50th percentile). 95th: ~87K lamports.

Your job: given the structured state below, return PRIORITIZED ACTIONABLE advice.

Output format (markdown, terse):

## Read
ONE sentence: what's happening right now.

## Risks
List in priority order. Use 🔴/🟡/🟢 for severity. For each: state the issue + the exact terminal command (if any) that would address it. Skip the section if no risks.

## Opportunities
List concrete edges visible in the data (e.g. oracle deviation > 50bps suggesting Phoenix is mispriced, MM-able spread, free-funds sitting idle). Include the command. Skip if none.

## Recommended next actions
Numbered list (max 3). Each must be a SPECIFIC command the user could paste into their terminal. Order by impact.

Rules:
- NEVER invent numbers or facts not present in the state.
- If the state is empty (no PnL, no MM, no positions), say so plainly and suggest a starting move.
- Be CONCISE. Each bullet ≤ 1 sentence.
- Reference the actual asset/market names from the state.
- Do NOT recommend \`--use-jito\` unless you have evidence of congestion.
- Suggest small sizes (e.g. 0.01-0.1 SOL) appropriate to the wallet's actual balance.
- If MM is running and showing high errors or 0 fills despite many ticks, suggest tightening the half-spread or stopping.
- If the wallet has stale free-funds with no active MM, suggest \`withdraw\` or starting the MM.`;

export class Advisor {
  private client: Anthropic;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    if (!key) throw new Error('ANTHROPIC_API_KEY not set');
    this.client = new Anthropic({ apiKey: key });
    // Prefer ADVISOR_MODEL override; fall back to AI_MODEL; fall back to Haiku 4.5
    this.model = model ?? safeEnvString('ADVISOR_MODEL', safeEnvString('AI_MODEL', 'claude-haiku-4-5'));
  }

  async advise(state: LiveState, question?: string): Promise<string> {
    const userContent =
      `# Current state\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\`\n\n` +
      (question ? `# Question\n${question}` : '# Question\nGive me prioritized advice on what to do right now.');

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1500,
      temperature: 0,
      // Cache the static SYSTEM_PROMPT — see interpreter.ts for the same
      // pattern. Advisor calls are bursty (user asks several follow-ups),
      // so the cache hits often within its 5-min TTL.
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: userContent }],
    });

    const block = response.content.find((b) => b.type === 'text');
    if (!block || block.type !== 'text') {
      throw new Error('advisor returned no text content');
    }
    return block.text;
  }
}

/**
 * Gather a structured live-state snapshot. Best-effort: any sub-fetch that
 * fails falls back to null, advisor handles partial data gracefully.
 */
export async function gatherLiveState(deps: {
  wallet: WalletManager;
  simulationMode: boolean;
  maker: Maker | null;
  multiMaker: MultiMarketMaker | null;
  focusedSymbols?: string[];
}): Promise<LiveState> {
  const focused = deps.focusedSymbols ?? ['SOL/USDC', 'SOL/USDT', 'JitoSOL/SOL', 'JitoSOL/USDC'];

  let balances: LiveState['balances'] = null;
  if (deps.wallet.hasAddress) {
    try {
      const raw = await deps.wallet.getTokenBalances();
      balances = {
        sol: raw.sol,
        tokens: raw.tokens.filter((t) => t.symbol !== 'UNKNOWN').map((t) => ({ symbol: t.symbol, amount: t.amount })),
      };
    } catch { /* leave null */ }
  }

  let pnl: LiveState['pnl'] = null;
  if (deps.wallet.hasAddress) {
    try {
      const s = getJournal().summary(deps.wallet.address!);
      if (s.totalFills > 0) {
        pnl = {
          totalFills: s.totalFills,
          totalVolumeUsd: s.totalVolumeUsd,
          realizedPnlUsd: s.totalRealizedPnlUsd,
          feesUsd: s.totalFeesUsd,
          netPnlUsd: s.totalRealizedPnlUsd - s.totalFeesUsd,
          makerRatio: s.makerRatio,
          activeDays: s.uniqueActiveDays,
          perMarket: s.perMarket.map((m) => ({
            market: m.market,
            fills: m.fills,
            volumeUsd: m.buyNotionalUsd + m.sellNotionalUsd,
            realizedPnlUsd: m.realizedPnlUsd,
            inventoryBase: m.inventoryBase,
            avgCostUsd: m.avgCostUsd,
            makerPct: (m.makerVolumeUsd / Math.max(m.buyNotionalUsd + m.sellNotionalUsd, 0.0001)) * 100,
          })),
        };
      }
    } catch { /* no journal */ }
  }

  const singleMaker: LiveState['singleMaker'] = deps.maker && deps.maker.isRunning
    ? (() => {
        const s = deps.maker!.status;
        return {
          symbol: 'configured-market', // single Maker doesn't expose its symbol via status; ok for advisor
          uptimeSec: Math.round((Date.now() - s.startedAt) / 1000),
          ticks: s.ticks,
          fills: s.fills,
          fillRatePct: s.placesSent > 0 ? (s.fills / s.placesSent) * 100 : 0,
          realizedEdgeUsd: s.realizedEdgeUsd,
          inventoryBase: s.inventoryBase,
          errors: s.errors,
        };
      })()
    : null;

  const multiMaker: LiveState['multiMaker'] = deps.multiMaker && deps.multiMaker.isRunning
    ? (() => {
        const s = deps.multiMaker!.status;
        const inv: Array<{ asset: string; amount: number; usdValue: number }> = [];
        for (const [asset, amount] of s.invByAsset) {
          if (Math.abs(amount) < 0.0001) continue;
          inv.push({ asset, amount, usdValue: s.invUsdByAsset.get(asset) ?? 0 });
        }
        return {
          symbols: deps.multiMaker!.symbols,
          uptimeSec: Math.round((Date.now() - s.startedAt) / 1000),
          ticks: s.ticks,
          fills: s.fills,
          realizedEdgeUsd: s.realizedEdgeUsd,
          dollarVolume: s.dollarVolume,
          inventoryByAsset: inv,
          errors: s.totalErrors,
        };
      })()
    : null;

  // Oracle vs Phoenix for tracked assets
  const tracked = ['SOL', 'JitoSOL', 'mSOL', 'JTO', 'JUP'];
  const oracleDeviation: LiveState['oracleDeviation'] = [];
  for (const asset of tracked) {
    const pyth = await fetchPythPrice(asset).catch(() => null);
    const market = MARKETS.find((m) => m.baseSymbol === asset && m.quoteSymbol === 'USDC');
    let mid: number | null = null;
    if (market) {
      try {
        const book = await fetchOrderbook(market.symbol, 1, false);
        mid = book.midUsd;
      } catch { /* leave null */ }
    }
    let bps: number | null = null;
    if (pyth !== null && mid !== null && mid > 0 && pyth > 0) {
      bps = ((mid - pyth) / pyth) * 10_000;
    }
    oracleDeviation.push({ asset, pythUsd: pyth, phoenixMidUsd: mid, deviationBps: bps });
  }

  // Focused market snapshots
  const marketSnapshots: LiveState['marketSnapshots'] = [];
  for (const sym of focused) {
    try {
      const book = await fetchOrderbook(sym, 1, false);
      marketSnapshots.push({
        symbol: sym,
        bestBid: book.bids[0]?.priceUsd ?? null,
        bestAsk: book.asks[0]?.priceUsd ?? null,
        midUsd: book.midUsd,
        spreadBps: book.spreadBps,
      });
    } catch (e) {
      getLogger().debug('advisor', `book ${sym} failed: ${(e as Error).message}`);
    }
  }

  return {
    walletAddress: deps.wallet.address,
    mode: deps.simulationMode ? 'paper' : 'live',
    balances,
    pnl,
    singleMaker,
    multiMaker,
    oracleDeviation,
    marketSnapshots,
  };
}

let _advisor: Advisor | null = null;
export function getAdvisor(): Advisor {
  if (!_advisor) _advisor = new Advisor();
  return _advisor;
}
