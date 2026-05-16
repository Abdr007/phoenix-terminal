/**
 * Seat eviction helpers.
 *
 * Phoenix markets cap the number of traders that can hold a seat. When the
 * registry is full, you cannot claim a seat without first evicting an
 * inactive trader (one with no resting orders and no locked funds).
 *
 * `confirmOrCreateClaimSeatIxs()` handles the lookup-and-evict path automatically.
 * `findTraderToEvict()` + `getEvictSeatIx()` give you manual control.
 */

import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getPhoenixClient } from './client.js';
import { getLogger } from '../utils/logger.js';

export async function safeClaimSeatIxs(
  connection: Connection,
  symbol: string,
  trader: PublicKey,
): Promise<TransactionInstruction[]> {
  const phoenix = getPhoenixClient();
  const { def, state } = await phoenix.getMarket(symbol);
  // confirmOrCreateClaimSeatIxs handles the "seat-table full → find evictable trader → emit eviction ix" flow
  const ixs = await Phoenix.confirmOrCreateClaimSeatIxs(connection, state, trader);
  if (ixs.length > 0) getLogger().info('seats', `claim/eviction needed for ${def.symbol}: ${ixs.length} ix(s)`);
  return ixs;
}

export async function findEvictionCandidate(symbol: string): Promise<PublicKey | null> {
  const phoenix = getPhoenixClient();
  const { state } = await phoenix.getMarket(symbol);
  const phoenixClient = await phoenix.raw();
  const result = await Phoenix.findTraderToEvict(phoenixClient.connection, state);
  return result instanceof PublicKey ? result : null;
}

export async function evictSeatIx(
  symbol: string,
  signer: PublicKey,
  evictTarget: PublicKey,
): Promise<TransactionInstruction> {
  const phoenix = getPhoenixClient();
  const { state } = await phoenix.getMarket(symbol);
  return Phoenix.getEvictSeatIx(state, evictTarget, signer);
}
