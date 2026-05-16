import { describe, it, expect, afterEach } from 'vitest';
import { safeEnvBool, safeEnvNumber, safeEnvString } from '../src/utils/safe-env.js';
import { safeNumber, clamp } from '../src/utils/safe-number.js';
import { fmtUsd, fmtNum, fmtPct, shortAddr, pad } from '../src/utils/format.js';

const ENV_KEY = '__PHOENIX_TEST_ENV__';
afterEach(() => { delete process.env[ENV_KEY]; });

describe('safeEnvNumber', () => {
  it('returns fallback when unset', () => {
    expect(safeEnvNumber(ENV_KEY, 42)).toBe(42);
  });
  it('parses a valid number', () => {
    process.env[ENV_KEY] = '123';
    expect(safeEnvNumber(ENV_KEY, 0)).toBe(123);
  });
  it('returns fallback on invalid', () => {
    process.env[ENV_KEY] = 'abc';
    expect(safeEnvNumber(ENV_KEY, 9)).toBe(9);
  });
});

describe('safeEnvBool', () => {
  it.each([['true', true], ['1', true], ['yes', true], ['on', true], ['false', false], ['0', false], ['no', false], ['off', false]])(
    'parses %s correctly', (val, expected) => {
      process.env[ENV_KEY] = val;
      expect(safeEnvBool(ENV_KEY, !expected)).toBe(expected);
    },
  );
  it('fallback on invalid value', () => {
    process.env[ENV_KEY] = 'maybe';
    expect(safeEnvBool(ENV_KEY, true)).toBe(true);
  });
});

describe('safeEnvString', () => {
  it('returns fallback when unset', () => {
    expect(safeEnvString(ENV_KEY, 'default')).toBe('default');
  });
  it('returns value when set', () => {
    process.env[ENV_KEY] = 'hello';
    expect(safeEnvString(ENV_KEY, 'default')).toBe('hello');
  });
  it('returns fallback on empty string', () => {
    process.env[ENV_KEY] = '';
    expect(safeEnvString(ENV_KEY, 'default')).toBe('default');
  });
});

describe('safeNumber', () => {
  it('returns numbers unchanged', () => { expect(safeNumber(3.14, 0)).toBe(3.14); });
  it('fallback on NaN', () => { expect(safeNumber(NaN, 7)).toBe(7); });
  it('fallback on Infinity', () => { expect(safeNumber(Infinity, 5)).toBe(5); });
  it('fallback on non-number', () => { expect(safeNumber('abc' as unknown as number, 1)).toBe(1); });
});

describe('clamp', () => {
  it('passes through when in range', () => { expect(clamp(5, 0, 10)).toBe(5); });
  it('clamps to min', () => { expect(clamp(-1, 0, 10)).toBe(0); });
  it('clamps to max', () => { expect(clamp(20, 0, 10)).toBe(10); });
  it('handles NaN by returning min', () => { expect(clamp(NaN, 0, 10)).toBe(0); });
});

describe('formatters', () => {
  it('fmtUsd formats with $ and commas', () => {
    expect(fmtUsd(1234.5, 2)).toBe('$1,234.50');
  });
  it('fmtUsd handles NaN', () => {
    expect(fmtUsd(NaN)).toBe('—');
  });
  it('fmtNum respects decimals', () => {
    expect(fmtNum(3.14159, 2)).toBe('3.14');
  });
  it('fmtPct adds %', () => {
    expect(fmtPct(12.34, 1)).toBe('12.3%');
  });
  it('shortAddr truncates long', () => {
    // Synthetic test fixture — not a real wallet
    const addr = 'So11111111111111111111111111111111111111112';
    expect(shortAddr(addr)).toBe('So11…1112');
  });
  it('shortAddr passes through short', () => {
    expect(shortAddr('abc')).toBe('abc');
  });
  it('pad left-aligns by default', () => {
    expect(pad('hi', 5)).toBe('hi   ');
  });
  it('pad right-aligns when requested', () => {
    expect(pad('hi', 5, 'right')).toBe('   hi');
  });
});
