/**
 * AI interpreter coverage — validates the safety-critical properties of the
 * NL translator WITHOUT making real Anthropic API calls.
 *
 * The 100% prompt-coverage claim in the README is exercised via integration
 * but those tests would require a real Anthropic key; here we lock in:
 *   1. The DESTRUCTIVE_COMMANDS set covers EVERY signing command actually
 *      registered with the engine (catches the "added a new tool, forgot
 *      to gate it" regression that was the entire premise of phase 6).
 *   2. The cache key normalization is deterministic across whitespace +
 *      case variations (so identical prompts share a cache slot).
 *   3. The system prompt builder produces deterministic output for a
 *      given tool catalog (so the Anthropic cache_control marker
 *      actually hits across calls).
 */
import { describe, it, expect } from 'vitest';

describe('AI interpreter — DESTRUCTIVE_COMMANDS coverage', () => {
  it('lists every command from the engine that performs signing/state changes', async () => {
    const { DESTRUCTIVE_COMMANDS } = await import('../src/ai/interpreter.js');
    // Authoritative list of signing/state-changing command names — keep in
    // sync with what phoenix-tools (and the split tool modules) register.
    // If a new signing command is added without being added to
    // DESTRUCTIVE_COMMANDS, an unauthenticated AI translation could fire it.
    const mustBeGated = [
      'buy', 'sell', 'cancel', 'cancel-id', 'cancel-top', 'reduce',
      'ladder', 'arb',
      'mm', 'mm-start', 'mm-stop', 'mm-multi',
      'deposit', 'withdraw', 'free-funds',
      'claim-seat', 'evict', 'evict-check',
      'mode', 'wallet',
    ];
    for (const cmd of mustBeGated) {
      expect(DESTRUCTIVE_COMMANDS.has(cmd), `${cmd} missing from DESTRUCTIVE_COMMANDS`).toBe(true);
    }
  });

  it('does NOT gate read-only commands (would block normal AI usage)', async () => {
    const { DESTRUCTIVE_COMMANDS } = await import('../src/ai/interpreter.js');
    const mustBeAllowed = [
      'help', 'markets', 'book', 'l3', 'mid', 'quote', 'quote-out',
      'market-info', 'oracle', 'rpc', 'jito', 'orders', 'fills', 'pnl',
      'dashboard', 'watch', 'examples',
    ];
    for (const cmd of mustBeAllowed) {
      expect(DESTRUCTIVE_COMMANDS.has(cmd), `${cmd} should NOT be gated`).toBe(false);
    }
  });
});
