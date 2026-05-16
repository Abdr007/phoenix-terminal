/**
 * Phoenix routing & quoting math.
 *
 * Wrappers around the SDK's pure-function pricing helpers — used to predict
 * fill amounts and price impact BEFORE submitting an IOC. Useful for the
 * `quote` command and as a pre-flight check in placeIoc.
 */

import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getPhoenixClient } from './client.js';

export interface QuoteResult {
  market: string;
  side: 'bid' | 'ask';
  inAmount: number;
  expectedOut: number;
  priceImpactBps: number;     // (worst_fill - mid) / mid × 10_000
  effectivePrice: number;     // out/in (or 1/(out/in) depending on side)
  midPrice: number | null;
}

const TAKER_FEE_BPS_DEFAULT = 2; // Phoenix typical taker fee; per-market in practice

export async function quote(
  symbolOrAddress: string,
  side: 'bid' | 'ask',
  inAmount: number,
  takerFeeBps = TAKER_FEE_BPS_DEFAULT,
): Promise<QuoteResult> {
  const phoenix = getPhoenixClient();
  const { def, state } = await phoenix.getMarket(symbolOrAddress);
  await phoenix.refresh(def.address);

  const ladder = state.getUiLadder(20);
  const sideEnum = side === 'bid' ? Phoenix.Side.Bid : Phoenix.Side.Ask;

  const expectedOut = Phoenix.getExpectedOutAmountRouter({
    uiLadder: ladder,
    side: sideEnum,
    takerFeeBps,
    inAmount,
  });

  const bestBid = ladder.bids[0]?.price ?? null;
  const bestAsk = ladder.asks[0]?.price ?? null;
  const mid = bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0
    ? (bestBid + bestAsk) / 2
    : null;

  // Effective price: when bidding (buying base), expectedOut is base; effective = inAmount / expectedOut.
  // When asking (selling base), inAmount is base, expectedOut is quote; effective = expectedOut / inAmount.
  let effectivePrice = 0;
  if (expectedOut > 0) {
    effectivePrice = side === 'bid' ? inAmount / expectedOut : expectedOut / inAmount;
  }

  let priceImpactBps = 0;
  if (mid !== null && effectivePrice > 0) {
    priceImpactBps = Math.abs(effectivePrice - mid) / mid * 10_000;
  }

  return {
    market: def.symbol,
    side,
    inAmount,
    expectedOut,
    priceImpactBps,
    effectivePrice,
    midPrice: mid,
  };
}

/**
 * Reverse quote: how much input do I need to receive `outAmount` units of output?
 */
export async function quoteRequired(
  symbolOrAddress: string,
  side: 'bid' | 'ask',
  outAmount: number,
  takerFeeBps = TAKER_FEE_BPS_DEFAULT,
): Promise<{ market: string; side: 'bid' | 'ask'; outAmount: number; requiredIn: number }> {
  const phoenix = getPhoenixClient();
  const { def, state } = await phoenix.getMarket(symbolOrAddress);
  await phoenix.refresh(def.address);
  const ladder = state.getUiLadder(20);

  const requiredIn = Phoenix.getRequiredInAmountRouter({
    uiLadder: ladder,
    side: side === 'bid' ? Phoenix.Side.Bid : Phoenix.Side.Ask,
    takerFeeBps,
    outAmount,
  });

  return { market: def.symbol, side, outAmount, requiredIn };
}
