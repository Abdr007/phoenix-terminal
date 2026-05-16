import { describe, it, expect } from 'vitest';
import { findTriangles } from '../src/phoenix/arb.js';
import { MarketDef } from '../src/phoenix/markets.js';

function mk(symbol: string, baseMint: string, quoteMint: string): MarketDef {
  const [base, quote] = symbol.split('/');
  return {
    symbol, address: `addr-${symbol}`,
    baseSymbol: base, quoteSymbol: quote,
    baseMint, quoteMint,
    liquidity: 'medium',
  };
}

describe('findTriangles', () => {
  it('returns empty for no markets', () => {
    expect(findTriangles([])).toEqual([]);
  });

  it('returns empty for two markets sharing one mint (no cycle)', () => {
    const markets = [mk('A/B', 'AAA', 'BBB'), mk('A/C', 'AAA', 'CCC')];
    expect(findTriangles(markets)).toEqual([]);
  });

  it('finds the SOL/USDC ↔ SOL/USDT ↔ USDT/USDC cycle', () => {
    const markets = [
      mk('SOL/USDC', 'SOL', 'USDC'),
      mk('SOL/USDT', 'SOL', 'USDT'),
      mk('USDT/USDC', 'USDT', 'USDC'),
    ];
    const tris = findTriangles(markets);
    expect(tris.length).toBe(1);
    const sorted = [...tris[0]].sort();
    expect(sorted).toEqual(['SOL', 'USDC', 'USDT']);
  });

  it('dedups cycles regardless of permutation', () => {
    const markets = [
      mk('A/B', 'AAA', 'BBB'),
      mk('B/C', 'BBB', 'CCC'),
      mk('A/C', 'AAA', 'CCC'),
    ];
    const tris = findTriangles(markets);
    expect(tris.length).toBe(1);
  });

  it('finds multiple disjoint triangles', () => {
    const markets = [
      // Triangle 1: A-B-C
      mk('A/B', 'AAA', 'BBB'),
      mk('B/C', 'BBB', 'CCC'),
      mk('A/C', 'AAA', 'CCC'),
      // Triangle 2: X-Y-Z
      mk('X/Y', 'XXX', 'YYY'),
      mk('Y/Z', 'YYY', 'ZZZ'),
      mk('X/Z', 'XXX', 'ZZZ'),
    ];
    const tris = findTriangles(markets);
    expect(tris.length).toBe(2);
  });

  it('finds overlapping triangles', () => {
    // A-B-C and A-B-D both exist via shared A-B edge
    const markets = [
      mk('A/B', 'AAA', 'BBB'),
      mk('B/C', 'BBB', 'CCC'),
      mk('A/C', 'AAA', 'CCC'),
      mk('B/D', 'BBB', 'DDD'),
      mk('A/D', 'AAA', 'DDD'),
    ];
    const tris = findTriangles(markets);
    expect(tris.length).toBeGreaterThanOrEqual(2);
  });
});
