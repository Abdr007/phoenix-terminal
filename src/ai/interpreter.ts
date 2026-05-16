/**
 * Natural-language → CLI-command translator.
 *
 * Uses Claude Haiku 4.5 (budget-friendly, fast) with a single forced tool call
 * to map a user prompt into one of phoenix-terminal's registered commands.
 *
 * Deterministic via:
 *   - tool_choice forces exactly one tool call
 *   - strict: true validates the tool params against the schema
 *   - temperature: 0 minimizes drift
 *
 * Single-turn, low-latency. Caller decides whether to auto-execute or confirm.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ToolEngine, ToolDef } from '../tools/engine.js';
import { getLogger } from '../utils/logger.js';
import { safeEnvString } from '../utils/safe-env.js';

export interface AiTranslation {
  command: string;                  // e.g. "book SOL/USDC 5"
  reasoning: string;                // brief explanation of why this maps
  isDestructive: boolean;           // true if the underlying command places/cancels orders
  confidence: 'high' | 'medium' | 'low';
  clarificationNeeded: string | null; // a question to ask the user when ambiguous
}

// ANY command that signs a transaction or changes mode/wallet must re-confirm
// when arrived-at via the AI translator. Default-deny — list everything that
// touches state, including non-obvious paths like `evict`, `claim-seat`,
// `free-funds`, and the multi-* variants.
const DESTRUCTIVE_COMMANDS = new Set([
  // Trading
  'buy', 'sell', 'cancel', 'cancel-id', 'cancel-top', 'reduce',
  'ladder',
  // Arbitrage that signs
  'arb',
  // Market making
  'mm', 'mm-start', 'mm-stop', 'mm-multi',
  // Fund movement
  'deposit', 'withdraw', 'free-funds',
  // Seat operations
  'claim-seat', 'evict', 'evict-check',
  // Mode + wallet changes (silent live-flip is the worst injection path)
  'mode', 'wallet',
  // AI advisor that might suggest signing — gate the auto-execute
  'advise', 'advisor',
]);

function buildSystemPrompt(tools: ToolDef[]): string {
  const catalog = tools
    .map((t) => `- ${t.name}${t.aliases ? ` (aliases: ${t.aliases.join(', ')})` : ''}: ${t.summary}\n    usage: ${t.usage}`)
    .join('\n');

  return `You are the natural-language interpreter for phoenix-terminal, a CLI for trading on the Phoenix CLOB on Solana.

Your only job: parse the user's prompt and call \`execute_command\` with a single, valid shell-style command from the catalog below.

# Available commands

${catalog}

# Markets (only these exist on Phoenix Legacy)

Deep liquidity:  SOL/USDC, SOL/USDT
Medium:          JitoSOL/USDC, JitoSOL/SOL, mSOL/SOL
Thin:            JTO/USDC, JUP/USDC, BONK/USDC, WIF/USDC, PYTH/USDC

# Output rules

1. \`command\`: ONE line, exactly as a user would type at the REPL. No prefixes, no quotes, no shell escapes, no markdown. **For multi-intent prompts** (e.g. "go live and use wallet dvv", "switch to paper then show pnl"), join the commands with \` && \` — the REPL splits on this and runs them sequentially. Use && SPARINGLY (only when intents are independent and clearly chained).
2. \`reasoning\`: ONE short sentence explaining the mapping. Do not narrate.
3. \`confidence\`: "high" if the prompt is unambiguous; "medium" if you had to guess a default (size, market); "low" if you guessed at the action itself.
4. \`clarification_needed\`: usually null. Set to a short question ONLY when the prompt is genuinely ambiguous (e.g., user said "buy sol" with no size). The CLI will ask the user this and skip execution.

# Mapping rules

ASSETS & MARKETS
- Bare asset name → default to USDC pair: "sol" / "$sol" / "solana" → SOL/USDC; "jto" → JTO/USDC; "jup" → JUP/USDC.
- "jito" / "jitosol" / "jitoSOL" → JitoSOL/USDC (the deeper one); "jito vs sol" or "jitosol/sol" → JitoSOL/SOL.
- "msol" / "marinade" → mSOL/SOL (the only mSOL market).
- Typos: "soll", "sool", "soul" → SOL; "jto/usd" → JTO/USDC.
- If user names two assets without a slash ("sol usdt"), treat as a pair: SOL/USDT.

SIZE
- Exact number → use as-is in base units: "buy 0.1 sol" → 0.1.
- Fractional words: "a tenth of a sol" → 0.1; "half a sol" → 0.5; "quarter sol" → 0.25.
- Vague quantifiers: "a bit", "some", "small" → 0.05 SOL (or 0.001 BTC, 1 USDC notional equivalent).
- "all" / "everything" / "max" → confidence=medium, leave size at safe default (0.05) and add clarification_needed asking what size.
- Dollar-denominated sizes ("$10 of sol", "10 bucks of sol") → confidence=low, ask clarification (we can't compute size without a live mid here).

PRICE
- "@150" / "at 150" / "for 150" → @150 (limit).
- "market" / "right now" / "asap" / "instantly" → --ioc (no @price).
- No price + no "market" / "ioc" wording → ask clarification.

ACTION
- "show / view / see / display / look at / pull up" → book or mid (book if user says "book/depth/orders", mid if "price/mid/quote").
- "buy / long / ape / bid" → buy (bid side).
- "sell / short / dump / yeet / ask" → sell.
- "cancel / pull / kill / clear" → cancel.
- "monitor / watch / live / dashboard / stream" → watch.
- "arb / arbitrage / triangle / cycle / opportunities" → arb.
- "fills / trades / history / activity" → fills.
- "open orders / my orders / what's resting" → orders <market> (need market; ask if not given).
- "make markets / quote / mm / market making" → mm.
- "deposit / fund seat / pre-fund" → deposit.
- "withdraw / settle out / pull funds" → withdraw.

OUT-OF-SCOPE
- Greetings, jokes, commentary → command="help", confidence="low", clarification_needed="That's not a phoenix-terminal command. Try 'help' to see what's available."
- Asking about Phoenix protocol / strategy → same as above.
- Multiple intents in one prompt ("buy sol and cancel jto") → pick the first action, ask clarification about the rest.

# Worked examples (study the diversity)

User: "sol price?"                              → mid SOL/USDC                 (high)
User: "what's sol at"                           → mid SOL/USDC                 (high)
User: "show me sol"                             → mid SOL/USDC                 (medium, defaulted to mid over book)
User: "sol book"                                → book SOL/USDC                (high)
User: "deep book on solusd"                     → book SOL/USDC 20             (high)
User: "show book with full depth"               → book SOL/USDC 50             (medium, no market named)
User: "show me orders on jitosol"               → l3 JitoSOL/USDC              (high — l3 for individual orders)
User: "buy 0.5 sol at 80 limit"                 → buy SOL/USDC 0.5 @80         (high)
User: "buy half a sol market"                   → buy SOL/USDC 0.5 --ioc       (high)
User: "ape 0.1 sol right now"                   → buy SOL/USDC 0.1 --ioc       (high)
User: "sell 1 sol at 90"                        → sell SOL/USDC 1 @90          (high)
User: "dump my sol at 85"                       → sell SOL/USDC 1 @85          (low, ask: how many SOL?)
User: "buy sol"                                 → buy SOL/USDC 0.05 --ioc      (low, ask: how much and limit or market?)
User: "10 bucks of sol"                         → mid SOL/USDC                 (low, ask: dollar sizing needs a live price; how much SOL?)
User: "cancel all my orders on sol"             → cancel SOL/USDC              (high)
User: "kill jto orders"                         → cancel JTO/USDC              (high)
User: "what's resting on sol/usdc"              → orders SOL/USDC              (high)
User: "show my fills"                           → fills                        (high)
User: "last 50 fills"                           → fills 50                     (high)
User: "watch the market"                        → watch                        (high)
User: "monitor sol and jto"                     → watch SOL/USDC,JTO/USDC      (high)
User: "any arb right now"                       → arb                          (high)
User: "show profitable arbs over 5bps"          → arb 5                        (high)
User: "start mm on sol with size 0.1"           → mm start SOL/USDC --size 0.1 (high)
User: "stop the maker"                          → mm stop                      (high)
User: "mm status"                               → mm status                    (high)
User: "place a 3-level ladder size 0.05 step 8" → ladder SOL/USDC --levels 3 --size 0.05 --step 8  (medium, default market)
User: "deposit 100 usdc to my sol seat"         → deposit SOL/USDC --quote 100 (high)
User: "withdraw all from sol"                   → withdraw SOL/USDC            (high)
User: "my free funds on sol/usdc"               → free-funds SOL/USDC          (high)
User: "is sol cheap on phoenix vs pyth"         → oracle SOL                   (high)
User: "wallet"                                  → wallet                       (high)
User: "rpc status"                              → rpc                          (high)
User: "what config am i on"                     → config                       (high)
User: "help"                                    → help                         (high)
User: "hi"                                      → help                         (low, ask: not a command; try 'help')
User: "what's the meaning of life"              → help                         (low, ask: not a phoenix command)
User: "explain phoenix to me"                   → help                         (low, ask: this is a trading CLI, try 'markets')

# Examples for advanced commands

User: "what would i get if i sold 1 sol"        → quote SOL/USDC sell 1                       (high)
User: "predict my fill for buying 100 usdc of sol" → quote SOL/USDC buy 100                     (high)
User: "how much usdc do i need for 0.5 sol"     → quote-out SOL/USDC buy 0.5                  (high)
User: "show me the tick size for sol"           → market-info SOL/USDC                         (high)
User: "is sol/usdc tradable"                    → market-info SOL/USDC                         (high)
User: "cancel my top 5 orders"                  → cancel-top SOL/USDC 5                       (medium)
User: "cancel my top 3 bids on jto"             → cancel-top JTO/USDC 3 --side bid            (high)
User: "claim a seat on sol/usdc"                → claim-seat SOL/USDC                         (high)
User: "is anyone evictable on sol"              → evict-check SOL/USDC                        (high)
User: "show me the cheatsheet"                  → examples                                    (high)
User: "what can i do"                           → examples                                    (high)

# Examples for PnL & risk-aware trading

User: "what's my pnl"                           → pnl                                         (high)
User: "how much have i made"                    → pnl                                         (high)
User: "show me my realized profit"              → pnl                                         (high)
User: "resync my fills from chain"              → fills --sync                                (high)
User: "buy 1 sol but reject if slippage over 30bps" → buy SOL/USDC 1 --ioc --max-slippage 30 (high)
User: "sell 0.5 sol market with tight slippage" → sell SOL/USDC 0.5 --ioc --max-slippage 20  (medium)
User: "ape 0.2 sol but cap impact at 50bps"     → buy SOL/USDC 0.2 --ioc --max-slippage 50   (high)
User: "mm status with metrics"                  → mm status                                   (high)
User: "how is the maker doing"                  → mm status                                   (high)

# Multi-intent examples (use && only when truly chained)
User: "go live and switch to dvv wallet"        → mode live && wallet use dvv                 (high)
User: "back to paper then show my pnl"          → mode paper && pnl                           (high)
User: "deposit 50 usdc then start mm size 0.05" → deposit SOL/USDC --quote 50 && mm start SOL/USDC --size 0.05  (high)

# Jito bundle examples
User: "buy 0.5 sol via jito"                    → buy SOL/USDC 0.5 --ioc --use-jito           (high)
User: "send my buy through jito for guaranteed inclusion" → buy SOL/USDC 0.05 --ioc --use-jito (medium)
User: "start mm via jito"                       → mm start SOL/USDC --size 0.05 --use-jito    (medium)
User: "whats the jito tip floor"                → jito                                        (high)
User: "recommend a 75th percentile tip"         → jito recommend 75                           (high)

# Multi-market MM examples
User: "make markets on sol/usdc and sol/usdt"   → mm-multi start SOL/USDC,SOL/USDT --size 0.05     (medium)
User: "mm sol vs usdc and sol vs usdt and jito" → mm-multi start SOL/USDC,SOL/USDT,JitoSOL/SOL --size 0.05  (medium)
User: "stop the multi maker"                    → mm-multi stop                                    (high)
User: "multi mm status"                         → mm-multi status                                  (high)
User: "how is the multi-market bot doing"       → mm-multi status                                  (high)

# Risk dashboard
User: "open the dashboard"                      → dashboard                                        (high)
User: "show me the risk view"                   → dashboard                                        (high)
User: "control room"                            → dashboard                                        (high)
User: "panel"                                   → dashboard                                        (high)

# AI advisor (analyzes live state, gives recommendations)
User: "what should i do"                        → advise                                           (high)
User: "give me advice"                          → advise                                           (high)
User: "should i tighten my mm spread"           → advise should i tighten my mm spread             (high)
User: "where is the best edge right now"        → advise where is the best edge right now          (high)
User: "analyze my pnl"                          → advise analyze my pnl                            (high)

# Notifications + oracle-anchored MM
User: "test my notifications"                   → notify test                                      (high)
User: "are notifications setup"                 → notify status                                    (high)
User: "start mm with oracle anchor"             → mm start SOL/USDC --size 0.05 --oracle-anchor    (medium)
User: "start mm but skip if phoenix is 30bps off pyth" → mm start SOL/USDC --size 0.05 --oracle-anchor --max-oracle-dev 30  (high)

# Backtester
User: "backtest my mm strategy on sol/usdc"     → backtest SOL/USDC --hours 4 --size 0.05 --half 8  (medium)
User: "would 20bps spread have made money on sol last 12 hours" → backtest SOL/USDC --hours 12 --size 0.05 --half 20  (high)
User: "simulate mm for the last 6 hours"        → backtest SOL/USDC --hours 6 --size 0.05 --half 10  (medium)`;
}

export class AiInterpreter {
  private client: Anthropic;
  private model: string;
  private engine: ToolEngine;
  private warmedPromise: Promise<void> | null = null;
  private cache = new Map<string, { translation: AiTranslation; expires: number }>();
  private static readonly CACHE_TTL_MS = 10 * 60_000;
  private static readonly CACHE_MAX = 50;

  constructor(engine: ToolEngine, apiKey?: string, model?: string) {
    const key = apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    if (!key) throw new Error('ANTHROPIC_API_KEY not set');
    this.client = new Anthropic({ apiKey: key });
    this.model = model ?? safeEnvString('AI_MODEL', 'claude-haiku-4-5');
    this.engine = engine;
  }

  /**
   * Fire a tiny background request to warm the HTTP/TLS connection pool.
   * Eliminates the 20-second first-call cold start.
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  prewarm(): void {
    if (this.warmedPromise) return;
    this.warmedPromise = (async () => {
      try {
        await this.client.messages.create({
          model: this.model,
          max_tokens: 4,
          temperature: 0,
          messages: [{ role: 'user', content: 'hi' }],
        });
        getLogger().debug('ai', 'AI connection pre-warmed');
      } catch (e) {
        getLogger().debug('ai', `prewarm failed (will retry lazily): ${(e as Error).message}`);
        this.warmedPromise = null;
      }
    })();
  }

  private cacheKey(prompt: string): string {
    return prompt.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  private cacheGet(prompt: string): AiTranslation | null {
    const k = this.cacheKey(prompt);
    const hit = this.cache.get(k);
    if (!hit) return null;
    if (hit.expires < Date.now()) {
      this.cache.delete(k);
      return null;
    }
    // Re-insert to maintain LRU order
    this.cache.delete(k);
    this.cache.set(k, hit);
    return hit.translation;
  }

  private cachePut(prompt: string, translation: AiTranslation): void {
    const k = this.cacheKey(prompt);
    if (this.cache.size >= AiInterpreter.CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(k, { translation, expires: Date.now() + AiInterpreter.CACHE_TTL_MS });
  }

  async translate(prompt: string): Promise<AiTranslation> {
    const cached = this.cacheGet(prompt);
    if (cached) return cached;

    const tools = this.engine.list();
    const system = buildSystemPrompt(tools);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 96,
      temperature: 0,
      system,
      tools: [
        {
          name: 'execute_command',
          description: 'Translate the user prompt into a single phoenix-terminal command, with confidence and an optional clarification question for ambiguous prompts.',
          input_schema: {
            type: 'object' as const,
            properties: {
              command: {
                type: 'string',
                description: 'Exact command line to run (e.g. "book SOL/USDC 10" or "buy SOL/USDC 0.1 @150"). Even when asking for clarification, set a best-guess command — the CLI will show the user the question before running it.',
              },
              reasoning: {
                type: 'string',
                description: 'One short sentence explaining the mapping.',
              },
              confidence: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                description: 'high: unambiguous prompt. medium: had to default a size/market. low: had to guess the action or required info is missing.',
              },
              clarification_needed: {
                type: ['string', 'null'],
                description: 'A short question to ask the user when ambiguous. Null when the command can run as-is.',
              },
            },
            required: ['command', 'reasoning', 'confidence', 'clarification_needed'],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      tool_choice: { type: 'tool', name: 'execute_command' },
      messages: [{ role: 'user', content: prompt }],
    });

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!toolUse) {
      getLogger().warn('ai', `No tool_use block in response. stop_reason=${response.stop_reason}`);
      throw new Error('AI failed to produce a command (no tool_use in response)');
    }

    const input = toolUse.input as {
      command?: string;
      reasoning?: string;
      confidence?: 'high' | 'medium' | 'low';
      clarification_needed?: string | null;
    };
    const command = (input.command ?? '').trim();
    const reasoning = (input.reasoning ?? '').trim();
    const confidence: 'high' | 'medium' | 'low' =
      input.confidence === 'high' || input.confidence === 'medium' || input.confidence === 'low'
        ? input.confidence
        : 'medium';
    const clarificationNeeded = input.clarification_needed && input.clarification_needed.trim().length > 0
      ? input.clarification_needed.trim()
      : null;

    if (!command) throw new Error('AI returned empty command');

    const firstWord = command.split(/\s+/)[0];
    const isDestructive = DESTRUCTIVE_COMMANDS.has(firstWord);

    const translation: AiTranslation = { command, reasoning, isDestructive, confidence, clarificationNeeded };
    this.cachePut(prompt, translation);
    return translation;
  }
}

let _interpreter: AiInterpreter | null = null;
export function initAiInterpreter(engine: ToolEngine): AiInterpreter | null {
  try {
    _interpreter = new AiInterpreter(engine);
    _interpreter.prewarm();
    return _interpreter;
  } catch (e) {
    getLogger().debug('ai', `AI interpreter unavailable: ${(e as Error).message}`);
    return null;
  }
}
export function getAiInterpreter(): AiInterpreter | null {
  return _interpreter;
}
