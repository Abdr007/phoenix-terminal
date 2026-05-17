<div align="center">

<img src="./assets/hero.svg" alt="phoenix-terminal — interactive trading terminal for the Phoenix CLOB on Solana" width="100%"/>

**The first interactive trading terminal for the [Phoenix CLOB](https://github.com/Ellipsis-Labs/phoenix-v1) on Solana.**

[![CI](https://github.com/Abdr007/phoenix-terminal/actions/workflows/ci.yml/badge.svg)](https://github.com/Abdr007/phoenix-terminal/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node 20+](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](https://nodejs.org)
[![Phoenix SDK](https://img.shields.io/badge/phoenix--sdk-2.0.3-orange)](https://github.com/Ellipsis-Labs/phoenix-sdk)
[![Powered by Claude](https://img.shields.io/badge/AI-Claude%20Haiku%204.5-7b68ee)](https://www.anthropic.com)
[![Tests](https://img.shields.io/badge/tests-105%20passing-brightgreen)](./tests)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict%20%2B%20noUncheckedIndexedAccess-3178c6)](./tsconfig.json)
[![Audited](https://img.shields.io/badge/audit-14%20phases-blue)](./SECURITY.md)

</div>

---

Phoenix has no first-party TUI. **This is one.** Type plain English (`whats my pnl`, `buy 1 sol via jito`, `start mm on sol/usdc with 5bps spread`) — Claude translates it to a typed command and runs it. Or skip the AI and use the 40 commands directly.

```
phoenix › what should i do
› AI → advise  [high]  (User asked for general analysis)

  AI ADVISOR
  ──────────────────────────────────────────────────
  ## Read
  You've made 2 micro-fills on SOL/USDC with zero PnL; wallet holds ~$48 USDC
  + 0.11 JitoSOL, but no active MM or positions to defend.

  ## Risks
  - JitoSOL/USDC market is broken — 11,325 bps spread, Phoenix mid massively
    above Pyth. Liquidity desert. Avoid.
  - SOL/USDC spread is wide (369 bps) — suggests thin MM. Your 0.011 SOL
    inventory from earlier fills is unhedged.

  ## Recommended next actions
  1. mm start SOL/USDC --size 0.05 --half 50 --oracle-anchor
  2. Monitor 10 min; if filling too thin, tighten with --half 75
```

---

## Quick start

```bash
git clone https://github.com/Abdr007/phoenix-terminal && cd phoenix-terminal
npm install
cp .env.example .env       # set RPC_URL + ANTHROPIC_API_KEY
npm run build
npm link                   # exposes `phoenix`, `pterm`, `phoenix-terminal` globally
phoenix                    # launches the picker → paper (default) or LIVE
```

On launch, a TTY picker asks: paper (safe simulation, no on-chain action) or LIVE (real funds). Default is paper. Inside the terminal, just type — natural language is auto-translated:

```
phoenix › whats my pnl
phoenix › buy 1 sol but cap slippage at 30bps
phoenix › make markets on sol/usdc with 5bps spread size 0.05
```

---

## Commands (40)

| Group | Commands |
|---|---|
| **Market data** | `markets` · `book` · `l3` · `mid` · `market-info` · `oracle` |
| **Pre-trade math** | `quote` · `quote-out` (uses SDK router for expected fill + price impact) |
| **Live monitoring** | `watch` (full-screen multi-market + fill ticker + armable hotkeys) · `arb` (triangular scanner + executor) · `dashboard` (control room) |
| **Execution** | `buy` · `sell` (with `--ioc --max-slippage BPS --use-jito --tip`) · `orders` · `cancel` |
| **Surgical** | `cancel-id` · `cancel-top` · `reduce` (all support `--use-free`) · `ladder` (multi-level post-only) |
| **Vault / seat** | `deposit` · `withdraw` · `free-funds` · `claim-seat` · `evict-check` |
| **Market making** | `mm start/stop/status` · `mm-multi` (cross-asset inventory) · `backtest` (passive sim) |
| **PnL & history** | `pnl` (realized + per-quote-currency breakdown) · `fills` (instant from SQLite journal) |
| **AI / discovery** | `ai <prompt>` · `advise` (live-state coaching) · `examples` · `help` |
| **System** | `wallet` · `mode` · `rpc` · `config` · `jito` · `notify` · `quit` |

Run `examples` inside the terminal for a curated NL-prompt cheatsheet across 17 categories.

---

## Killer features

### Persistent PnL journal
SQLite at `~/.phoenix/journal.db` (WAL mode). First `pnl --sync` walks chain backwards, indexes every Phoenix fill, attributes maker/taker by `orderSequenceNumber` side encoding (canonical SDK pattern), computes weighted-average-cost realized PnL per market. Composite primary key `(signature, sub_index)` handles multi-fill same-tx writes correctly. Cross-market totals are segregated by quote currency so USDC + SOL aren't summed into nonsense. Subsequent reads are <1ms.

### Live MM telemetry
`mm status` shows real-time:
- Total fills (split bid/ask), fill rate (`fills/places`)
- Dollar volume + per-hour extrapolation
- **Realized edge captured** = Σ |fill_price − mid_at_fill| × size — your actual maker rebate equivalent
- Inventory + mark-to-mid USD value
- Last fill (time, side, price)

Powered by `connection.onLogs(PROGRAM_ID)` subscription; every fill streams as `[mm fill] ● BUY 0.05 inv $0.0023 edge 12 fills`. RPC failovers automatically re-mount the subscription on the new connection.

### Inventory-aware MM (Avellaneda-Stoikov-lite)
- Reservation price r = mid × (1 − γσ²q̂) where q̂ is normalized inventory
- Asymmetric half-spread that widens on the side that would worsen inventory
- Hard inventory cap, mid-jump sanity check, TTL-bounded post-only orders
- Tick mutex prevents overlap if a prior tick is still running
- Cancel + bid + ask sequenced with delay to respect signing-guard rate limits
- Oracle anchor (`--oracle-anchor`) skips ticks when Phoenix mid > N bps from Pyth

### Cross-asset MM (`mm-multi`)
Quotes N markets simultaneously with ASSET-level inventory aggregation. Trading both SOL/USDC and SOL/USDT? Your SOL inventory is one shared bucket; quotes on both markets adjust together. Caps per asset via `--max-inv SOL=2,USDC=500`.

### Triangular arb scanner + executor
Across the SOL ↔ USDC ↔ USDT ↔ JitoSOL graph: builds every 3-cycle, computes round-trip return from top-of-book, sorts by profit bps. `arb --execute --min-bps 15 --size 0.05 --max-slippage 30` fires the top cycle as 3 sequential IOCs with per-leg slippage rejection. `--dry-run` simulates without signing.

### Optional Jito bundles
Add `--use-jito` to any execution command for atomic, block-engine inclusion. Tip is auto-added (default 10,000 lamports or 50th-percentile floor via `recommendTipLamports`). `jito` command shows current tip floor by percentile.

> **Caveat — free public endpoint is best-effort.** The default `mainnet.block-engine.jito.wtf` accepts bundles (you'll get a bundle ID), but landing is **not guaranteed**: bundles can be silently dropped during congestion, and the rate limiter on the polling endpoint is aggressive (HTTP 429 on rapid retries).
>
> **For production MM**, use one of:
> - A paid Jito-proxy provider (Helius, QuickNode, Triton all offer this) — set `JITO_BLOCK_ENGINE_URL=https://<your-endpoint>` in `.env`
> - Higher tips at the 95th–99th percentile (run `jito` to see current floor)
> - The non-Jito path (the default) — much more reliable on the free tier

### Natural-language translator (Claude Haiku 4.5)
- Cold start: ~1.8s (one prewarm fires on init)
- Cache hit: 0ms (LRU, 50 entries, 10min TTL, per-entry 16KB cap)
- Steady state: 1.4–2s per translation
- Cost: ~$0.003 per call (prompt-cached for ~90% input discount on warm cache)
- 20 destructive commands gated — AI translation NEVER auto-fires `buy`/`sell`/`cancel`/`mm`/`arb`/`deposit`/`withdraw`/`mode`/`wallet` etc.; user must explicitly re-run

### AI advisor
`advise` ships the live wallet state, open positions, MM stats, recent fills, and oracle deviations to Claude Opus for prioritized coaching. Use `advise <specific question>` for targeted analysis.

### Webhook notifications
Discord, Slack, Telegram, generic webhook — set the URL in `.env`, MM fills + start/stop + oracle divergence stream out. Token-bucket rate limiter (2s between same-kind messages, 30/min cap per channel) prevents webhook revocation from busy MM runs.

---

## Configuration

All via `.env` (see `.env.example`). Highlights:

| Key | Default | Notes |
|---|---|---|
| `SIMULATION_MODE` | `true` | Also runtime-togglable via `mode` command |
| `RPC_URL` | mainnet-beta | Use a paid endpoint for production |
| `BACKUP_RPCS` | — | Comma-separated; auto-failover on lag/timeout |
| `ANTHROPIC_API_KEY` | — | Enables AI translator + advisor |
| `MAX_NOTIONAL_PER_ORDER` | `10000` | $ cap per order; `0` = unlimited (opt-in) |
| `MAX_ORDERS_PER_MINUTE` | `20` | Rate limit across ALL signing |
| `MIN_DELAY_BETWEEN_ORDERS_MS` | `150` | Matches MM cancel+bid+ask cadence |
| `JITO_BLOCK_ENGINE_URL` | jito.wtf public | Set to a paid Jito-proxy for production MM |
| `JITO_DEFAULT_TIP_LAMPORTS` | `10000` | Bundle tip floor |
| `DISCORD_WEBHOOK_URL` etc. | — | One or more channels — see SECURITY.md for full list |
| `ALERT_MIN_SEVERITY` | `info` | `info` · `success` · `warning` · `error` |
| `LOG_FILE` | — | Set to enable structured file logging (auto-rotates at 10MB) |
| `SESSION_TIMEOUT_MS` | `0` (disabled) | Set to N>0 to auto-disconnect on idle |

Config is loaded from: `$PHOENIX_ENV` → `./.env` → `~/.phoenix/.env` → `.env` next to the binary. Works from any directory.

---

## Architecture

A condensed view (full version in [ARCHITECTURE.md](./ARCHITECTURE.md)):

```
                    user keystroke
                          │
                          ▼
   ┌──────────────────────────────────────────────┐
   │  REPL  ·  &&-guard  ·  mode picker  ·  hist  │
   └──────────────────────────────────────────────┘
                          │
                          ▼
   ┌──────────────────────────────────────────────┐
   │  ToolEngine (40 cmds) ←→ AiInterpreter       │
   │           (destructive gate + cache)         │
   └──────────────────────────────────────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
   ┌────────┐       ┌─────────┐        ┌─────────┐
   │ Trade  │       │ Maker / │        │ Journal │
   │ Cancel │──┐    │ Multi   │───┐    │ + WAC   │
   │ Ladder │  │    │ Maker   │   │    │ PnL     │
   └────────┘  │    └─────────┘   │    └─────────┘
               │         │        │
               ▼         ▼        ▼
   ┌──────────────────────────────────────────────┐
   │  Phoenix domain  (client · orders · seats)   │
   │  every signer wrapped in withSigning()       │
   │  →  guard.reserveSlot · checkOrderLimits     │
   │  →  wallet.beginSigning / endSigning DRAIN   │
   └──────────────────────────────────────────────┘
                          │
       ┌──────────────────┼──────────────────┐
       ▼                  ▼                  ▼
   ┌────────┐      ┌────────────┐      ┌────────┐
   │  RPC   │      │   Jito     │      │ Notif  │
   │ failo- │      │  bundles   │      │ 4 ch.  │
   │ ver    │      │ tip floor  │      │ rate-l │
   └────────┘      └────────────┘      └────────┘
```

40 command handlers across 5 tool modules. 99% type-safe (`strict + noUncheckedIndexedAccess + noImplicitOverride`). 105 unit tests. Lint covers `src/` and `tests/` with type-aware async-bug rules.

---

## Safety

- **Paper mode is default.** The startup picker requires explicit consent to go LIVE.
- **Every signing path** passes through `SigningGuard` (per-order notional cap, rate limit, JSONL audit log with numbered rotation).
- **`withSigning()` drain gate** — `disconnect()` waits up to 5s for in-flight signs before zeroing the secret key bytes.
- **Wallet path traversal blocked** — both the registry resolver and `loadFromFile` enforce `$HOME` containment.
- **Group/world-readable wallet files** trigger a startup warning.
- **AI translator can't silently fire destructive commands.** 20 signing commands are gated; user must explicitly re-run.
- **Watcher hotkeys** ignore paper mode — pressing `b` in paper does nothing on-chain.
- **REPL `&&` chains** refuse destructive segments — `mode live && buy ...` rejected.
- **11 secret pattern families** scrubbed from logs (Anthropic, OpenAI, Helius URLs, GitHub PATs, AWS keys, etc.).
- **SIGTERM / SIGHUP** run the full graceful shutdown (orders cancelled, journal closed, secret zeroed).
- **TypeScript `noUncheckedIndexedAccess`** blocks unchecked array access at compile time.

Full threat model + disclosure process in [SECURITY.md](./SECURITY.md).

---

## Status

Phoenix Legacy spot only. Phoenix Perpetuals (private beta) is a separate SDK — not wired here. 14 audit phases complete, 48 real bugs fixed, 105 regression tests. Production-ready for spot MM on the listed markets.

## License

MIT — see [LICENSE](./LICENSE). The license disclaims warranty. **You are responsible for understanding the on-chain effects of every command you run.** Test in paper mode first.
