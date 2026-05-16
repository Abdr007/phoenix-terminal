import { Orderbook, OrderbookLevel } from '../types/index.js';
import { getPhoenixClient } from './client.js';
import { safeNumber } from '../utils/safe-number.js';

const DEFAULT_DEPTH = 10;

export async function fetchOrderbook(symbolOrAddress: string, depth = DEFAULT_DEPTH, refresh = true): Promise<Orderbook> {
  const client = getPhoenixClient();
  const { def, state } = await client.getMarket(symbolOrAddress);
  if (refresh) await client.refresh(def.address);

  const ladder = state.getUiLadder(depth);

  const bids = toLevels(ladder.bids);
  const asks = toLevels(ladder.asks);

  const bestBid = bids[0]?.priceUsd ?? null;
  const bestAsk = asks[0]?.priceUsd ?? null;
  let midUsd: number | null = null;
  let spreadBps: number | null = null;
  if (bestBid !== null && bestAsk !== null && bestBid > 0 && bestAsk > 0) {
    midUsd = (bestBid + bestAsk) / 2;
    spreadBps = ((bestAsk - bestBid) / midUsd) * 10_000;
  }

  return { market: def.symbol, bids, asks, midUsd, spreadBps, timestamp: Date.now() };
}

function toLevels(side: Array<{ price: number; quantity: number }>): OrderbookLevel[] {
  let cum = 0;
  return side
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.quantity) && l.quantity > 0)
    .map((l) => {
      cum += l.quantity;
      return { priceUsd: safeNumber(l.price), sizeBase: safeNumber(l.quantity), cumulativeBase: cum };
    });
}

/** Quick mid-price helper that loads + refreshes a single market. */
export async function fetchMid(symbolOrAddress: string): Promise<number | null> {
  const book = await fetchOrderbook(symbolOrAddress, 1, true);
  return book.midUsd;
}
