import { describe, it, expect } from 'vitest';
import { computeMarketPnl, JournalFill } from '../src/phoenix/journal.js';

function fill(side: 'bid' | 'ask', price: number, size: number, ts = 0): JournalFill {
  return {
    signature: `sig-${ts}-${side}-${price}-${size}`,
    wallet: 'test',
    market: 'SOL/USDC',
    side,
    priceUsd: price,
    sizeBase: size,
    notionalUsd: price * size,
    isMaker: 0,
    feeUsd: 0,
    blockTime: ts,
    slot: 0,
  };
}

describe('computeMarketPnl (WAC)', () => {
  it('returns zeros for empty fills', () => {
    const r = computeMarketPnl('SOL/USDC', []);
    expect(r.fills).toBe(0);
    expect(r.inventoryBase).toBe(0);
    expect(r.avgCostUsd).toBe(0);
    expect(r.realizedPnlUsd).toBe(0);
  });

  it('single buy: inventory increases, avgCost = price', () => {
    const r = computeMarketPnl('SOL/USDC', [fill('bid', 100, 1)]);
    expect(r.inventoryBase).toBe(1);
    expect(r.avgCostUsd).toBe(100);
    expect(r.realizedPnlUsd).toBe(0);
    expect(r.buyVolumeBase).toBe(1);
  });

  it('buy then sell at same price: realized PnL = 0', () => {
    const r = computeMarketPnl('SOL/USDC', [fill('bid', 100, 1), fill('ask', 100, 1)]);
    expect(r.inventoryBase).toBe(0);
    expect(r.realizedPnlUsd).toBeCloseTo(0, 6);
  });

  it('buy at 100 then sell at 110: realized = 10', () => {
    const r = computeMarketPnl('SOL/USDC', [fill('bid', 100, 1), fill('ask', 110, 1)]);
    expect(r.inventoryBase).toBe(0);
    expect(r.realizedPnlUsd).toBeCloseTo(10, 6);
  });

  it('two buys at different prices: WAC blends correctly', () => {
    // Buy 1 @ 100, buy 1 @ 200 → avgCost = 150, inv = 2
    const r = computeMarketPnl('SOL/USDC', [fill('bid', 100, 1), fill('bid', 200, 1)]);
    expect(r.inventoryBase).toBe(2);
    expect(r.avgCostUsd).toBeCloseTo(150, 6);
  });

  it('partial sell against WAC: realized matches', () => {
    // Buy 1 @ 100, buy 1 @ 200, sell 1 @ 180 → avgCost 150, realized = (180-150)*1 = 30
    const r = computeMarketPnl('SOL/USDC', [
      fill('bid', 100, 1),
      fill('bid', 200, 1),
      fill('ask', 180, 1),
    ]);
    expect(r.inventoryBase).toBe(1);
    expect(r.realizedPnlUsd).toBeCloseTo(30, 6);
  });

  it('going short: avgCost resets to short basis', () => {
    // Buy 1 @ 100, sell 2 @ 110 → realized = (110-100)*1 = 10 on long leg, inv = -1, avg = 110
    const r = computeMarketPnl('SOL/USDC', [fill('bid', 100, 1), fill('ask', 110, 2)]);
    expect(r.inventoryBase).toBe(-1);
    expect(r.realizedPnlUsd).toBeCloseTo(10, 6);
    expect(r.avgCostUsd).toBeCloseTo(110, 6);
  });

  it('round-trip with profit + maker volume tracking', () => {
    const fills: JournalFill[] = [
      { ...fill('bid', 100, 1), isMaker: 1 },
      { ...fill('ask', 110, 1), isMaker: 0 },
    ];
    const r = computeMarketPnl('SOL/USDC', fills);
    expect(r.realizedPnlUsd).toBeCloseTo(10, 6);
    expect(r.makerVolumeUsd).toBe(100);
    expect(r.takerVolumeUsd).toBe(110);
  });

  it('accumulates fees', () => {
    const fills: JournalFill[] = [
      { ...fill('bid', 100, 1), feeUsd: 0.01 },
      { ...fill('ask', 110, 1), feeUsd: 0.01 },
    ];
    const r = computeMarketPnl('SOL/USDC', fills);
    expect(r.feesUsd).toBeCloseTo(0.02, 6);
  });

  it('records first and last timestamps', () => {
    const r = computeMarketPnl('SOL/USDC', [fill('bid', 100, 1, 1000), fill('ask', 110, 1, 2000)]);
    expect(r.firstFillAt).toBe(1000);
    expect(r.lastFillAt).toBe(2000);
  });
});
