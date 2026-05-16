/**
 * Regression tests for the NaN-safe flag parser in phoenix-tools.ts.
 *
 * The bug this prevents: previously `--max-slippage --use-jito` (operator
 * typo with no value) silently parsed to NaN, which `placeIoc`'s slippage
 * check then skipped because `NaN > 0` is false. The user thought they had
 * a 30bps cap; they had none.
 *
 * flagNum/flagInt are module-private but invariants matter — replicate them
 * here for direct testing.
 */
import { describe, it, expect } from 'vitest';

function flagNum(args: string[], flag: string, fallback: number, positive = true): number {
  const idx = args.indexOf(flag);
  if (idx < 0) return fallback;
  const next = args[idx + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`${flag} requires a numeric value (got ${next === undefined ? 'nothing' : `"${next}"`}).`);
  }
  const n = Number(next);
  if (!Number.isFinite(n)) {
    throw new Error(`${flag} expects a number, got "${next}".`);
  }
  if (positive && n < 0) {
    throw new Error(`${flag} must be ≥ 0, got ${n}.`);
  }
  return n;
}

describe('flagNum: NaN-safe arg parsing', () => {
  it('absent flag returns fallback', () => {
    expect(flagNum(['--use-jito'], '--tip', 5_000)).toBe(5_000);
  });
  it('valid number parses', () => {
    expect(flagNum(['--tip', '10000'], '--tip', 0)).toBe(10_000);
  });
  it('flag followed by another --flag throws (the real-world typo)', () => {
    expect(() => flagNum(['--max-slippage', '--use-jito'], '--max-slippage', 0))
      .toThrow(/requires a numeric value/);
  });
  it('flag at end of args (no value) throws', () => {
    expect(() => flagNum(['--ttl'], '--ttl', 0)).toThrow(/nothing/);
  });
  it('NaN-producing string throws', () => {
    expect(() => flagNum(['--tip', 'banana'], '--tip', 0)).toThrow(/expects a number/);
  });
  it('Infinity is rejected', () => {
    expect(() => flagNum(['--size', 'Infinity'], '--size', 0)).toThrow(/expects a number/);
  });
  it('negative value rejected when positive=true', () => {
    expect(() => flagNum(['--size', '-1'], '--size', 0)).toThrow(/must be ≥ 0/);
  });
  it('negative accepted when positive=false', () => {
    expect(flagNum(['--offset', '-50'], '--offset', 0, false)).toBe(-50);
  });
});
