/**
 * Wallet fill history — fetched by paginating signatures for the wallet,
 * then decoding each Phoenix transaction via the SDK's event parser.
 *
 * This is necessarily slow (one tx fetch per signature). We cap at N recent
 * signatures and stop when we hit a non-Phoenix tx batch.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { Fill } from '../types/index.js';
import { findMarket } from './markets.js';
import { getPhoenixClient } from './client.js';
import { getLogger } from '../utils/logger.js';

export interface WalletFillsOpts {
  /** Max signatures to scan back from latest. Default 50. */
  scanLimit?: number;
  /** Max fills to return. Default 30. */
  resultLimit?: number;
}

export async function fetchWalletFills(
  connection: Connection,
  wallet: PublicKey,
  opts: WalletFillsOpts = {},
): Promise<Fill[]> {
  const scanLimit = Math.min(opts.scanLimit ?? 50, 200);
  const resultLimit = opts.resultLimit ?? 30;

  const sigs = await connection.getSignaturesForAddress(wallet, { limit: scanLimit });
  if (sigs.length === 0) return [];

  const phoenix = getPhoenixClient();
  const client = await phoenix.raw();
  const walletStr = wallet.toBase58();

  const fills: Fill[] = [];

  for (const sigInfo of sigs) {
    if (sigInfo.err) continue;
    if (fills.length >= resultLimit) break;
    try {
      const ptx = await Phoenix.getPhoenixEventsFromTransactionSignature(connection, sigInfo.signature);
      for (const ix of ptx.instructions) {
        const marketAddr = ix.header?.market?.toBase58();
        if (!marketAddr) continue;
        const def = findMarket(marketAddr);
        if (!def) continue;

        // Ensure this market is loaded so we can convert ticks/lots → human units
        if (!client.marketStates.has(marketAddr)) {
          try { await phoenix.addMarket(def.symbol); } catch { continue; }
        }

        for (const evt of ix.events) {
          if (!Phoenix.isPhoenixMarketEventFill(evt)) continue;
          const f = evt.fields[0];
          const isMaker = f.makerId.toBase58() === walletStr;
          // If we weren't the maker we might have been the taker — accept either way
          if (!isMaker && ptx.signature !== sigInfo.signature) continue;

          const priceTicks = Phoenix.toNum(f.priceInTicks);
          const baseLots = Phoenix.toNum(f.baseLotsFilled);
          if (baseLots === 0) continue;

          const priceUsd = client.ticksToFloatPrice(priceTicks, marketAddr);
          const sizeBase = client.baseAtomsToRawBaseUnits(
            client.baseLotsToBaseAtoms(baseLots, marketAddr),
            marketAddr,
          );
          fills.push({
            signature: sigInfo.signature,
            market: def.symbol,
            side: isMaker ? 'ask' : 'bid', // approximate — needs PlaceEvent cross-ref for exact
            priceUsd,
            sizeBase,
            notionalUsd: priceUsd * sizeBase,
            isMaker,
            timestamp: (sigInfo.blockTime ?? 0) * 1000,
          });
        }
      }
    } catch (e) {
      getLogger().debug('fills', `decode failed ${sigInfo.signature.slice(0, 12)}: ${(e as Error).message}`);
    }
  }

  return fills.slice(0, resultLimit);
}
