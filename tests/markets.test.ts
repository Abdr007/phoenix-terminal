import { describe, it, expect } from 'vitest';
import { findMarket, listSymbols, MARKETS } from '../src/phoenix/markets.js';

describe('markets registry', () => {
  it('listSymbols returns at least the deep markets', () => {
    const symbols = listSymbols();
    expect(symbols).toContain('SOL/USDC');
    expect(symbols).toContain('SOL/USDT');
  });

  it('findMarket by exact symbol', () => {
    const m = findMarket('SOL/USDC');
    expect(m).toBeDefined();
    expect(m?.baseSymbol).toBe('SOL');
    expect(m?.quoteSymbol).toBe('USDC');
  });

  it('findMarket is case-insensitive', () => {
    expect(findMarket('sol/usdc')).toBe(findMarket('SOL/USDC'));
    expect(findMarket('SOL/usdc')).toBe(findMarket('SOL/USDC'));
  });

  it('findMarket by address', () => {
    const def = findMarket('SOL/USDC')!;
    expect(findMarket(def.address)).toBe(def);
  });

  it('findMarket accepts dash separator', () => {
    expect(findMarket('SOL-USDC')).toBe(findMarket('SOL/USDC'));
  });

  it('returns undefined for unknown', () => {
    expect(findMarket('DOES/NOT/EXIST')).toBeUndefined();
  });

  it('every market has the required fields', () => {
    for (const m of MARKETS) {
      expect(m.symbol).toMatch(/^\w+\/\w+$/);
      expect(m.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58
      expect(m.baseMint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(m.quoteMint).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(['deep', 'medium', 'thin']).toContain(m.liquidity);
    }
  });
});
