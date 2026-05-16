/**
 * Multi-level laddered post-only quote.
 *
 * Uses Phoenix.createPlaceMultiplePostOnlyOrdersInstruction (and the
 * WithFreeFunds variant when the trader has deposited funds) to quote a full
 * ladder of N bids + N asks in a single instruction. This is THE pro-MM
 * placement method on Phoenix:
 *   - One tx instead of 2N
 *   - Atomic — either all levels post or none
 *   - Cheaper compute per level
 *
 * Requires the trader to already have a seat. Caller is responsible for
 * cancelling stale orders first (separate tx, per SDK example).
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import BN from 'bn.js';
import { getPhoenixClient } from './client.js';
import { makerSetupIxs } from './seats.js';
import { loadConfig } from '../config/index.js';
import { getSigningGuard } from '../security/signing-guard.js';
import { withSigning } from '../wallet/walletManager.js';

export interface LadderLevel {
  side: 'bid' | 'ask';
  priceUsd: number;
  sizeBase: number;
  clientOrderId?: number;
}

export interface LadderArgs {
  symbol: string;
  levels: LadderLevel[];
  ttlSec?: number;
  useFreeFunds?: boolean; // if true, uses the WithFreeFunds variant
}

export async function placeLadder(connection: Connection, signer: Keypair, args: LadderArgs): Promise<string> {
  if (args.levels.length === 0) throw new Error('placeLadder: no levels');
  const guard = getSigningGuard();
  const rate = guard.reserveSlot();
  if (!rate.allowed) throw new Error(rate.reason);

  const phoenix = getPhoenixClient();
  const { def, state } = await phoenix.getMarket(args.symbol);
  const client = await phoenix.raw();
  const trader = signer.publicKey;
  await phoenix.refresh(def.address);

  const bids: Phoenix.CondensedOrder[] = [];
  const asks: Phoenix.CondensedOrder[] = [];
  const ttl = Math.max(5, args.ttlSec ?? 30);
  const expiry = Math.floor(Date.now() / 1000) + ttl;

  for (const lvl of args.levels) {
    const priceInTicks = new BN(client.floatPriceToTicks(lvl.priceUsd, def.address));
    const numBaseLots = new BN(
      client.rawBaseUnitsToBaseLotsRoundedDown(lvl.sizeBase, def.address),
    );
    if (numBaseLots.isZero()) continue;
    const order: Phoenix.CondensedOrder = {
      priceInTicks,
      sizeInBaseLots: numBaseLots,
      lastValidSlot: null,
      lastValidUnixTimestampInSeconds: new BN(expiry),
    };
    if (lvl.side === 'bid') bids.push(order);
    else asks.push(order);
  }

  if (bids.length === 0 && asks.length === 0) throw new Error('placeLadder: every level rounded to zero size');

  const multiplePacket: Phoenix.MultipleOrderPacket = {
    bids,
    asks,
    clientOrderId: null,
    failedMultipleLimitOrderBehavior: Phoenix.FailedMultipleLimitOrderBehavior.SkipOnInsufficientFundsAndAmendOnCross,
  };

  const setupIxs = args.useFreeFunds ? [] : await makerSetupIxs(connection, state, trader);

  const placeIx = args.useFreeFunds
    ? client.createPlaceMultiplePostOnlyOrdersInstructionWithFreeFunds(
        { multipleOrderPacket: multiplePacket },
        def.address,
        trader,
      )
    : client.createPlaceMultiplePostOnlyOrdersInstruction(
        { multipleOrderPacket: multiplePacket },
        def.address,
        trader,
      );

  const cfg = loadConfig();
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: Math.max(cfg.computeUnitLimit, 600_000) }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.computeUnitPrice }),
    ...setupIxs,
    placeIx,
  ];

  const sig = await withSigning(async () => {
    const tx = new Transaction().add(...ixs);
    return sendAndConfirmTransaction(connection, tx, [signer], {
      skipPreflight: true, commitment: 'confirmed', maxRetries: 3,
    });
  });
  // Audit-log every ladder send (previously missing per phase-6 audit findings)
  guard.logAudit({
    ts: new Date().toISOString(),
    type: 'place_ladder', market: def.symbol,
    notionalUsd: args.levels.reduce((s, l) => s + l.priceUsd * l.sizeBase, 0),
    wallet: trader.toBase58(), result: 'confirmed', signature: sig,
    reason: `ladder × ${args.levels.length} levels`,
  });
  return sig;
}
