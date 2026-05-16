import { describe, it, expect, beforeEach } from 'vitest';
import { SigningGuard } from '../src/security/signing-guard.js';
import { tmpdir } from 'os';
import { join } from 'path';

function freshGuard(overrides = {}) {
  return new SigningGuard({
    auditLogPath: join(tmpdir(), `phoenix-test-audit-${Date.now()}-${Math.random()}.log`),
    maxNotionalPerOrder: 0,
    maxOrdersPerMinute: 5,
    minDelayBetweenOrdersMs: 100,
    ...overrides,
  });
}

describe('SigningGuard.checkOrderLimits', () => {
  it('allows when no cap set', () => {
    const g = freshGuard({ maxNotionalPerOrder: 0 });
    expect(g.checkOrderLimits({ notionalUsd: 1_000_000, market: 'SOL/USDC' }).allowed).toBe(true);
  });

  it('blocks when notional exceeds cap', () => {
    const g = freshGuard({ maxNotionalPerOrder: 100 });
    const r = g.checkOrderLimits({ notionalUsd: 200, market: 'SOL/USDC' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('exceeds MAX_NOTIONAL_PER_ORDER');
  });

  it('allows under cap', () => {
    const g = freshGuard({ maxNotionalPerOrder: 100 });
    expect(g.checkOrderLimits({ notionalUsd: 50, market: 'SOL/USDC' }).allowed).toBe(true);
  });
});

describe('SigningGuard.reserveSlot — rate limiter', () => {
  it('first call always allowed', () => {
    const g = freshGuard();
    expect(g.reserveSlot().allowed).toBe(true);
  });

  it('blocks second call within min-delay window', () => {
    const g = freshGuard({ minDelayBetweenOrdersMs: 1000, maxOrdersPerMinute: 100 });
    g.reserveSlot();
    const r = g.reserveSlot();
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('Rate limited');
  });

  it('blocks once max-per-minute reached', () => {
    const g = freshGuard({ minDelayBetweenOrdersMs: 0, maxOrdersPerMinute: 3 });
    expect(g.reserveSlot().allowed).toBe(true);
    expect(g.reserveSlot().allowed).toBe(true);
    expect(g.reserveSlot().allowed).toBe(true);
    expect(g.reserveSlot().allowed).toBe(false);
  });

  it('limits getter returns config', () => {
    const g = freshGuard({ maxNotionalPerOrder: 500, maxOrdersPerMinute: 7, minDelayBetweenOrdersMs: 250 });
    expect(g.limits).toEqual({ maxNotionalPerOrder: 500, maxOrdersPerMinute: 7, minDelayBetweenOrdersMs: 250 });
  });
});
