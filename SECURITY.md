# Security

Phoenix Terminal handles secret keys and signs Solana transactions that move real funds. This document covers the threat model, the disclosure process, and known issues that aren't covered by upstream fixes.

---

## Reporting a vulnerability

**Do not file public GitHub issues for security bugs.** Instead, open a [private security advisory](https://github.com/Abdr007/phoenix-terminal/security/advisories/new) on the repo.

Include:
1. A minimal reproduction.
2. The commit hash you tested against.
3. Your assessment of impact (key leak / fund loss / DoS / info leak).
4. Suggested fix if you have one.

We aim to triage within 72 hours. If the bug is confirmed, we will:
- Acknowledge within 24h of triage.
- Ship a patch on a private branch.
- Coordinate a disclosure window if the bug affects users in the wild.
- Credit you in the release notes (or keep it anonymous if you prefer).

---

## Threat model

The terminal runs locally as a TTY process holding a Solana keypair. The threats we defend against:

| # | Threat | Mitigation |
|---|---|---|
| 1 | Operator typo flips paper → live mid-session | Startup mode picker (TTY-only), `&&` chain guard refuses destructive segments |
| 2 | AI translator silently fires a signing command from a poisoned NL prompt | `DESTRUCTIVE_COMMANDS` set forces explicit re-run; low-confidence translations also force re-run; test asserts every signing command is gated |
| 3 | Concurrent `disconnect()` corrupts the keypair mid-signature | `withSigning()` drain gate; `disconnect()` awaits up to 5s for in-flight signs before zeroing |
| 4 | Secret-key bytes linger in V8 heap after disconnect | `zeroCurrentSecret()` fills the Uint8Array with 0; wallet-registry zeros its locally-held copy too |
| 5 | Half-corrupted keypair signs garbage that never lands (burns priority fees) | `verifyKeypairIntegrity()` checks BOTH halves are non-zero AND that the pubkey half matches the stored `publicKey` |
| 6 | Wallet file world/group-readable | `wallets list` emits a one-time warn per path when `mode & 0o077 != 0` |
| 7 | Wallet path-traversal via `wallet use /etc/something.json` | Both `walletManager.loadFromFile` and `wallet-registry.resolveWallet` enforce `$HOME` containment |
| 8 | Webhook spam after a busy MM run → channel revocation | Per-channel × per-kind token bucket: min 2s between same-kind messages, max 30/min per channel |
| 9 | Signing rate-limit bypass via vault/deposit-withdraw | `vault.ts` checks `reserveSlot()` return; phase 6 fix |
| 10 | Audit log line injection via newline in `reason` field | `logAudit` strips `\r\n` and caps at 500 chars |
| 11 | Audit log history erased on rapid rotation | Numbered rotation keeps `.old` → `.old.2` → `.old.3` → `.old.4` (4 generations × 10 MB) |
| 12 | Secret leak in log files | 11 secret-pattern families scrubbed: `sk-ant-*`, `sk-proj-*`, generic `sk-*40+`, `gsk_*`, `api_key=`, `Bearer ...`, Helius URL (hostname + path forms), GitHub PAT, AWS access key |
| 13 | RPC failover orphans WebSocket subscriptions | Maker/MultiMaker/Watcher all implement `onConnectionChange` that re-mounts subscriptions with no zero-listener gap |
| 14 | RPC failover leaks the prior connection's WebSocket | `failover()` explicitly calls `prevConn._rpcWebSocket.close()` |
| 15 | Unhandled async rejection in WS log handler crashes the process | `handleProgramLog().catch(...)` wraps every `onLogs` callback |
| 16 | SIGTERM bypasses cleanup → journal mid-write, orders alive on-chain, secret unzeroed | `SIGTERM` + `SIGHUP` handlers run the full `gracefulShutdown` |
| 17 | Typo'd env var silently falls back to dangerous default (`SIMULATION_MODE=truee` → false → live trading) | `safeEnvBool`/`safeEnvNumber` emit one-time WARN on unrecognized input |
| 18 | NaN-producing flag typo silently disables a guard (`--max-slippage --use-jito` → NaN → check skipped) | `flagNum`/`flagInt` throw when next token is a flag or missing |
| 19 | Multi-fill same-tx writes collide in journal | Composite PK `(signature, sub_index)`; auto-migration backfills the old schema |
| 20 | Cross-market PnL sums USDC + SOL into nonsense | `summary.totalsByQuote` segregates by currency; renderer uses native unit format |
| 21 | Jito tip leaks on partial bundle failure | Documented in README; for production, use a paid Jito-proxy provider |
| 22 | Off-by-one / undefined array access at runtime | `tsconfig: noUncheckedIndexedAccess` — caught at compile time |
| 23 | `clientOrderId` collision within the same millisecond | Monotonic 16-bit counter packed with elapsed-since-start seconds |
| 24 | Wallet registry loads every secret into V8 just to extract pubkey | Best-effort `secretBytes.fill(0)` in `finally` after each pubkey extraction |

---

## What we DON'T protect against (operator responsibility)

### RPC endpoint trust
A malicious RPC can serve fake account data: wrong balances, wrong order book, stale prices, fabricated fills. The terminal trusts whatever its RPC returns.

**Mitigation:** Use authenticated paid endpoints (Helius, Triton, QuickNode). Run two endpoints with auto-failover. Set `RPC_URL` to your primary and `BACKUP_RPCS` to a comma-separated list of fallbacks.

### Jito bundle landing reliability
The free `mainnet.block-engine.jito.wtf` endpoint is best-effort: bundles can be silently dropped during congestion, and the polling endpoint rate-limits aggressively.

**Mitigation:** For production MM, set `JITO_BLOCK_ENGINE_URL` to a paid Jito-proxy provider. Bump tip percentile via `--tip` to the 95th–99th. For routine trades, the standard RPC path is faster and more reliable.

### Extreme thin-market slippage
`arb --execute` and `mm start` on a market with <$1k of depth can hit unexpected impact even with `--max-slippage`. The pre-trade router math is accurate, but a market that thins between quote and fill can move past the slippage band before the IOC settles.

**Mitigation:** The `markets` command tags each market with `deep`/`medium`/`thin`. Stick to `deep` for any meaningful size. The `advise` command also warns when oracle deviation > 50bps on a market you're about to trade.

### Anthropic API trust
The AI translator sends your prompt to Anthropic's servers. Don't include secrets in prompts. The translation result also goes through `DESTRUCTIVE_COMMANDS` validation before execution — but if Anthropic returns a non-destructive command that's harmful (e.g., `wallet use attacker_alias`), the gate now catches it (phase 6 widened the set).

### Loss of the local journal
`~/.phoenix/journal.db` is the only persistent state. Back it up if PnL history matters. The terminal can re-index from chain at any time (`pnl --sync`) but re-walking takes several minutes per ~1000 fills.

---

## Known dependency CVEs

| CVE | Package | Severity | Status |
|---|---|---|---|
| [GHSA-3gc7-fjrx-p6mg](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg) | `bigint-buffer` (transitive via `@solana/spl-token` → `@solana/buffer-layout-utils`) | High | **No upstream fix available.** Exploit is a buffer-overflow READ in `toBigIntLE()` when the input buffer length is wrong. Real-world reachability requires a malicious RPC response. **Mitigation:** Use trusted RPC endpoints. |

CI runs `npm audit --omit=dev --audit-level=critical` on every PR; new findings appear in the `npm-audit` job output without blocking merges (since some CVEs may be unfixable transitively).

---

## Audit history

| Phase | Date (UTC) | Focus | Bugs Fixed | Tests Added |
|---|---|---|---|---|
| 6 | 2026-05-17 | AI/REPL/watcher/vault security | 8 CRIT/HIGH | — |
| 7 | 2026-05-17 | Journal multi-fill, MM shutdown, CI | 4 HIGH | 1 |
| 8 | 2026-05-17 | Signing-drain wiring, IOC quote cap, NaN flags, RPC failover rebind, audit gaps | 5 HIGH | 10 |
| 9 | 2026-05-17 | Per-quote notional segregation + tools/ file split | 1 HIGH + refactor | 1 |
| 10 | 2026-05-17 | Indexer side detection, socket cleanup, wallet hygiene, log rotation, env typo warn, half-corruption check | 9 MED | 3 |
| 11 | 2026-05-17 | Severity validation, scrub coverage, slot recording, prompt caching, lint tests/ | 5 MED | 4 |
| 12 | 2026-05-17 | `noUncheckedIndexedAccess` — 78 latent undefined-access gaps | 78 (compile-time guarded) | — |
| 13 | 2026-05-17 | Type-aware async eslint, SIGTERM, engine memo, CI supply-chain | 4 (incl. 2 unhandled-rejection) | 2 |
| 14 | 2026-05-17 | findMarket O(1), DESTRUCTIVE coverage tests, AI cache size cap, notifier map GC | 4 | 6 |

Each phase commit on `main` contains the full reasoning, file list, and verification. Run `git log --oneline --grep="deep audit"` for the history.

---

## Recommended operator setup

```bash
# 1. Restrict wallet file permissions
chmod 600 ~/.config/solana/id.json
chmod 700 ~/.config/solana
chmod 700 ~/.phoenix

# 2. Use a paid RPC endpoint with auth
echo 'RPC_URL=https://your-paid-endpoint' > .env
echo 'BACKUP_RPCS=https://second-paid-endpoint,https://third' >> .env

# 3. Cap order notional explicitly (default is $10k; set to 0 only with reason)
echo 'MAX_NOTIONAL_PER_ORDER=5000' >> .env
echo 'MAX_ORDERS_PER_MINUTE=15' >> .env

# 4. Enable file logging so the audit trail survives REPL exit
echo 'LOG_FILE=~/.phoenix/phoenix.log' >> .env
echo 'LOG_LEVEL=info' >> .env

# 5. Test in paper mode for at least one session
phoenix          # picker: choose paper (default)
                 # exercise: markets, book, watch, mm start, mm stop, mm status
                 # then: mode live

# 6. Wire notifications for unattended runs
echo 'DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...' >> .env
echo 'ALERT_MIN_SEVERITY=warning' >> .env
```

The audit log lives at `~/.phoenix/signing-audit.log`. Inspect it after any unexpected behavior:

```bash
tail -100 ~/.phoenix/signing-audit.log | jq .
```

---

## License

Phoenix Terminal is MIT-licensed. The license disclaims warranty. **You are responsible for understanding the on-chain effects of every command you run.** Test in paper mode first.
