import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getLogger } from '../utils/logger.js';

/**
 * Phoenix seat management.
 *
 * Takers (IOC / swap) DO NOT need a seat. Makers (resting limit orders) DO.
 * The seat is a PDA per (market, trader). Cost ~0.0018 SOL per market.
 *
 * `getMakerSetupInstructionsForMarket()` returns the ATA-create + claim-seat
 * instructions, or [] if everything's already set up.
 */

const SETUP_CACHE_TTL_MS = 60_000;
const setupCache = new Map<string, number>();

function cacheKey(market: string, trader: string): string {
  return `${trader}@${market}`;
}

/**
 * Get the maker-setup ixs for (market, trader). Returns [] if already set up,
 * and remembers that for 60s so a hot MM loop doesn't hammer the RPC.
 */
export async function makerSetupIxs(
  connection: Connection,
  marketState: Phoenix.MarketState,
  trader: PublicKey,
): Promise<TransactionInstruction[]> {
  const key = cacheKey(marketState.address.toBase58(), trader.toBase58());
  const cached = setupCache.get(key);
  if (cached && Date.now() - cached < SETUP_CACHE_TTL_MS) return [];

  const ixs = await Phoenix.getMakerSetupInstructionsForMarket(connection, marketState, trader);
  if (ixs.length === 0) setupCache.set(key, Date.now());
  else getLogger().debug('phoenix', `Seat/ATA setup needed for ${marketState.address.toBase58().slice(0, 8)}: ${ixs.length} ix(s)`);
  return ixs;
}

/** Invalidate the setup cache for a (market, trader) pair (call after eviction or seat loss). */
export function invalidateSetupCache(market: string, trader: string): void {
  setupCache.delete(cacheKey(market, trader));
}

/**
 * Just the claim-seat ix (no ATA setup). Use this when you've already verified
 * ATAs exist via `makerSetupIxs` returning [].
 */
export function claimSeatIx(marketAddress: PublicKey, trader: PublicKey): TransactionInstruction {
  return Phoenix.getClaimSeatIx(marketAddress, trader);
}

/** Whether a trader already has a registered seat on this market. */
export function hasSeat(marketState: Phoenix.MarketState, trader: PublicKey): boolean {
  const idx = marketState.data.traderPubkeyToTraderIndex.get(trader.toBase58());
  return idx !== undefined;
}
