import { PublicKey } from '@solana/web3.js';

export type Side = 'bid' | 'ask';

export interface MarketDescriptor {
  address: string;
  base: string;
  quote: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: number;       // quote units per base unit
  baseLotSize: number;    // base units per lot
}

export interface OrderbookLevel {
  priceUsd: number;
  sizeBase: number;
  cumulativeBase: number;
}

export interface Orderbook {
  market: string;
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  midUsd: number | null;
  spreadBps: number | null;
  timestamp: number;
}

export interface OpenOrder {
  orderId: string;
  market: string;
  side: Side;
  priceUsd: number;
  sizeBase: number;
  sizeRemainingBase: number;
}

export interface Fill {
  signature: string;
  market: string;
  side: Side;
  priceUsd: number;
  sizeBase: number;
  notionalUsd: number;
  isMaker: boolean;
  timestamp: number;
}

export interface PlaceOrderRequest {
  market: string;
  side: Side;
  priceUsd: number;
  sizeBase: number;
  clientOrderId?: number;
  postOnly?: boolean;
}

export interface PlaceMarketOrderRequest {
  market: string;
  side: Side;
  sizeBase: number;
  slippageBps?: number;
}

export interface OrderResult {
  signature: string;
  orderId?: string;
  filledBase: number;
  filledNotionalUsd: number;
  feesPaidUsd: number;
}

export interface SeatInfo {
  market: string;
  trader: PublicKey;
  approved: boolean;
}
