/**
 * Surgical cancels and reduces.
 *
 * - cancelById: cancel one or many specific orders (no churn on other resting orders)
 * - cancelUpTo: bulk-cancel up to N orders per side, optionally above/below a price
 * - reduceOrder: shrink an existing resting order without canceling it
 *
 * Each operation has a *WithFreeFunds variant that skips the ATA-transfer
 * settlement step. Use it after `deposit` so MM ticks stay cheap.
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
import { getSigningGuard } from '../security/signing-guard.js';
import { withSigning } from '../wallet/walletManager.js';
import { loadConfig } from '../config/index.js';
import { getLogger } from '../utils/logger.js';

function withBudget(ixs: TransactionInstruction[]): TransactionInstruction[] {
  const cfg = loadConfig();
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.computeUnitPrice }),
    ...ixs,
  ];
}

async function send(connection: Connection, signer: Keypair, ixs: TransactionInstruction[], label: string): Promise<string> {
  return withSigning(async () => {
    const tx = new Transaction().add(...withBudget(ixs));
    const sig = await sendAndConfirmTransaction(connection, tx, [signer], {
      skipPreflight: true, commitment: 'confirmed', maxRetries: 3,
    });
    getLogger().debug('cancel-adv', `[${label}] confirmed ${sig}`);
    return sig;
  });
}

// ─── Cancel specific orders by ID ──────────────────────────────────────────────

export interface CancelByIdArgs {
  symbol: string;
  orders: Array<{
    side: 'bid' | 'ask';
    priceInTicks: number;
    orderSequenceNumber: string; // BN-compatible string
  }>;
  useFreeFunds?: boolean;
}

export async function cancelById(connection: Connection, signer: Keypair, args: CancelByIdArgs): Promise<string> {
  if (args.orders.length === 0) throw new Error('cancelById: no orders provided');
  const guard = getSigningGuard();
  const rate = guard.reserveSlot();
  if (!rate.allowed) throw new Error(rate.reason);

  const phoenix = getPhoenixClient();
  const { def } = await phoenix.getMarket(args.symbol);
  const client = await phoenix.raw();

  const params: Phoenix.CancelMultipleOrdersByIdParams = {
    orders: args.orders.map((o) => ({
      side: o.side === 'bid' ? Phoenix.Side.Bid : Phoenix.Side.Ask,
      priceInTicks: new BN(o.priceInTicks),
      orderSequenceNumber: new BN(o.orderSequenceNumber),
    })),
  };

  const ix = args.useFreeFunds
    ? client.createCancelMultipleOrdersByIdWithFreeFundsInstruction(
        { params },
        def.address,
        signer.publicKey,
      )
    : client.createCancelMultipleOrdersByIdInstruction(
        { params },
        def.address,
        signer.publicKey,
      );

  const sig = await send(connection, signer, [ix], `cancel-by-id ${def.symbol} x${args.orders.length}`);
  guard.logAudit({
    ts: new Date().toISOString(), type: 'cancel_by_id', market: def.symbol,
    wallet: signer.publicKey.toBase58(), result: 'confirmed', signature: sig,
    reason: `surgical: ${args.orders.length} orders`,
  });
  return sig;
}

// ─── Cancel up to N orders per side ────────────────────────────────────────────

export interface CancelUpToArgs {
  symbol: string;
  side?: 'bid' | 'ask' | 'both'; // default 'both' (uses two separate ixs would exceed limits — see note)
  numOrders: number;
  /** Optional price filter — cancel only orders worse than this tick price */
  tickLimit?: number;
  useFreeFunds?: boolean;
}

export async function cancelUpTo(connection: Connection, signer: Keypair, args: CancelUpToArgs): Promise<string> {
  const guard = getSigningGuard();
  const rate = guard.reserveSlot();
  if (!rate.allowed) throw new Error(rate.reason);

  const phoenix = getPhoenixClient();
  const { def } = await phoenix.getMarket(args.symbol);
  const client = await phoenix.raw();

  // CancelUpTo applies per side; default to bid if unspecified (caller can issue twice)
  const sideEnum = args.side === 'ask' ? Phoenix.Side.Ask : Phoenix.Side.Bid;

  const params: Phoenix.CancelUpToParams = {
    side: sideEnum,
    tickLimit: args.tickLimit !== undefined ? new BN(args.tickLimit) : null,
    numOrdersToSearch: args.numOrders,
    numOrdersToCancel: args.numOrders,
  };

  const ix = args.useFreeFunds
    ? client.createCancelUpToWithFreeFundsInstruction(
        { params },
        def.address,
        signer.publicKey,
      )
    : client.createCancelUpToInstruction(
        { params },
        def.address,
        signer.publicKey,
      );

  const sig = await send(connection, signer, [ix], `cancel-up-to ${def.symbol} side=${args.side ?? 'bid'} n=${args.numOrders}`);
  guard.logAudit({
    ts: new Date().toISOString(), type: 'cancel_up_to', market: def.symbol,
    side: args.side === 'ask' ? 'ask' : 'bid',
    wallet: signer.publicKey.toBase58(), result: 'confirmed', signature: sig,
    reason: `cancelUpTo n=${args.numOrders}`,
  });
  return sig;
}

// ─── Reduce existing order ─────────────────────────────────────────────────────

export interface ReduceArgs {
  symbol: string;
  side: 'bid' | 'ask';
  priceInTicks: number;
  orderSequenceNumber: string;
  newSizeBaseLots: number;
  useFreeFunds?: boolean;
}

export async function reduceOrder(connection: Connection, signer: Keypair, args: ReduceArgs): Promise<string> {
  const guard = getSigningGuard();
  const rate = guard.reserveSlot();
  if (!rate.allowed) throw new Error(rate.reason);

  const phoenix = getPhoenixClient();
  const { def } = await phoenix.getMarket(args.symbol);
  const client = await phoenix.raw();

  const params: Phoenix.ReduceOrderParams = {
    baseParams: {
      side: args.side === 'bid' ? Phoenix.Side.Bid : Phoenix.Side.Ask,
      priceInTicks: new BN(args.priceInTicks),
      orderSequenceNumber: new BN(args.orderSequenceNumber),
    },
    size: new BN(args.newSizeBaseLots),
  };

  const ix = args.useFreeFunds
    ? client.createReduceOrderWithFreeFundsInstruction(
        { params },
        def.address,
        signer.publicKey,
      )
    : client.createReduceOrderInstruction(
        { params },
        def.address,
        signer.publicKey,
      );

  const sig = await send(connection, signer, [ix], `reduce ${def.symbol} ${args.side}`);
  // Audit log (previously missing per phase-6 audit findings)
  guard.logAudit({
    ts: new Date().toISOString(), type: 'reduce_order', market: def.symbol,
    side: args.side,
    wallet: signer.publicKey.toBase58(), result: 'confirmed', signature: sig,
    reason: `priceTick=${args.priceInTicks} seq=${args.orderSequenceNumber} newSizeLots=${args.newSizeBaseLots}`,
  });
  return sig;
}
