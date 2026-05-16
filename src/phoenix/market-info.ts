/**
 * Per-market metadata: status, tick/lot sizes, fees, seat manager, PDA addresses.
 *
 * Exposes the MarketMetadata class + status check so the terminal can refuse
 * trades on uninitialized / paused markets and surface the protocol-level
 * accounts for inspection.
 */

import { PublicKey } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getPhoenixClient } from './client.js';

export interface MarketInfo {
  symbol: string;
  address: string;
  status: 'Uninitialized' | 'Active' | 'PostOnly' | 'Paused' | 'Closed' | 'Tombstoned' | 'Unknown';
  baseSymbol: string;
  quoteSymbol: string;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
  tickSize: number;
  baseLotSize: number;
  priceDecimalPlaces: number;
  totalTraders: number;
  numBids: number;
  numAsks: number;
  seatManagerAddress: string;
  seatDepositCollectorAddress: string;
  logAuthority: string;
  programId: string;
}

function statusName(s: Phoenix.MarketStatus): MarketInfo['status'] {
  switch (s) {
    case Phoenix.MarketStatus.Uninitialized: return 'Uninitialized';
    case Phoenix.MarketStatus.Active: return 'Active';
    case Phoenix.MarketStatus.PostOnly: return 'PostOnly';
    case Phoenix.MarketStatus.Paused: return 'Paused';
    case Phoenix.MarketStatus.Closed: return 'Closed';
    case Phoenix.MarketStatus.Tombstoned: return 'Tombstoned';
    default: return 'Unknown';
  }
}

export async function getMarketInfo(symbol: string): Promise<MarketInfo> {
  const phoenix = getPhoenixClient();
  const { def, state } = await phoenix.getMarket(symbol);
  await phoenix.refresh(def.address);
  const client = await phoenix.raw();

  const header = state.data.header;
  const status = statusName(Phoenix.toNum(header.status) as Phoenix.MarketStatus);

  const seatManager = Phoenix.getSeatManagerAddress(new PublicKey(def.address));
  const seatDeposit = Phoenix.getSeatDepositCollectorAddress(new PublicKey(def.address));
  const logAuth = Phoenix.getLogAuthority();

  return {
    symbol: def.symbol,
    address: def.address,
    status,
    baseSymbol: def.baseSymbol,
    quoteSymbol: def.quoteSymbol,
    baseMint: def.baseMint,
    quoteMint: def.quoteMint,
    baseDecimals: header.baseParams.decimals,
    quoteDecimals: header.quoteParams.decimals,
    tickSize: client.ticksToFloatPrice(1, def.address),
    baseLotSize: client.baseLotsToBaseAtoms(1, def.address),
    priceDecimalPlaces: state.getPriceDecimalPlaces(),
    totalTraders: state.data.traders.size,
    numBids: state.data.bids.length,
    numAsks: state.data.asks.length,
    seatManagerAddress: seatManager.toBase58(),
    seatDepositCollectorAddress: seatDeposit.toBase58(),
    logAuthority: logAuth.toBase58(),
    programId: Phoenix.PROGRAM_ADDRESS,
  };
}

export function isMarketTradable(status: MarketInfo['status']): boolean {
  return status === 'Active' || status === 'PostOnly';
}
