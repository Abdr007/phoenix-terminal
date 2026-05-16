/**
 * Phoenix seat-deposited funds management.
 *
 * Phoenix lets you deposit base + quote into your seat ("free funds"). Subsequent
 * orders can be placed via the *WithFreeFunds* variants which skip ATA transfers
 * entirely — every MM tick becomes significantly cheaper + faster.
 *
 * Lifecycle:
 *   1. Claim seat (handled by orders.placeLimit's makerSetupIxs)
 *   2. Deposit funds (this module — `deposit`)
 *   3. Run MM with --use-deposited (uses PlaceLimitOrderWithFreeFunds)
 *   4. Withdraw at end of session (`withdraw`)
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
import { getPhoenixClient } from './client.js';
import { makerSetupIxs } from './seats.js';
import { loadConfig } from '../config/index.js';
import { getSigningGuard } from '../security/signing-guard.js';
import { getLogger } from '../utils/logger.js';
import BN from 'bn.js';

function withBudget(ixs: TransactionInstruction[]): TransactionInstruction[] {
  const cfg = loadConfig();
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cfg.computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.computeUnitPrice }),
    ...ixs,
  ];
}

async function send(connection: Connection, signer: Keypair, ixs: TransactionInstruction[], label: string): Promise<string> {
  const tx = new Transaction().add(...withBudget(ixs));
  const sig = await sendAndConfirmTransaction(connection, tx, [signer], {
    skipPreflight: true, commitment: 'confirmed', maxRetries: 3,
  });
  getLogger().debug('vault', `[${label}] confirmed ${sig}`);
  return sig;
}

export interface DepositArgs {
  symbol: string;
  baseUnits?: number;     // in raw base units (e.g. SOL)
  quoteUnits?: number;    // in raw quote units (e.g. USDC)
}

export async function deposit(connection: Connection, signer: Keypair, args: DepositArgs): Promise<string> {
  if ((args.baseUnits ?? 0) <= 0 && (args.quoteUnits ?? 0) <= 0) {
    throw new Error('deposit: must specify baseUnits and/or quoteUnits > 0');
  }
  getSigningGuard().reserveSlot();

  const phoenix = getPhoenixClient();
  const { def, state } = await phoenix.getMarket(args.symbol);
  const client = await phoenix.raw();
  const trader = signer.publicKey;

  await phoenix.refresh(def.address);
  const setup = await makerSetupIxs(connection, state, trader);

  const ixs: TransactionInstruction[] = [...setup];
  const params = {
    quoteLotsToDeposit: new BN(args.quoteUnits ? client.quoteUnitsToQuoteLots(args.quoteUnits, def.address) : 0),
    baseLotsToDeposit: new BN(args.baseUnits ? client.rawBaseUnitsToBaseLotsRoundedDown(args.baseUnits, def.address) : 0),
  };
  ixs.push(client.createDepositFundsInstruction({ depositFundsParams: params }, def.address, trader));

  const sig = await send(connection, signer, ixs, `deposit ${def.symbol}`);
  getSigningGuard().logAudit({
    ts: new Date().toISOString(), type: 'deposit', market: def.symbol,
    wallet: trader.toBase58(), result: 'confirmed', signature: sig,
  });
  return sig;
}

export interface WithdrawArgs {
  symbol: string;
  /** If unspecified, withdraws ALL deposited funds. */
  baseUnits?: number;
  quoteUnits?: number;
}

export async function withdraw(connection: Connection, signer: Keypair, args: WithdrawArgs): Promise<string> {
  getSigningGuard().reserveSlot();

  const phoenix = getPhoenixClient();
  const { def, state } = await phoenix.getMarket(args.symbol);
  const client = await phoenix.raw();
  const trader = signer.publicKey;
  await phoenix.refresh(def.address);

  const setup = await makerSetupIxs(connection, state, trader);
  const ixs: TransactionInstruction[] = [...setup];

  const withdrawAll = args.baseUnits === undefined && args.quoteUnits === undefined;
  const params = withdrawAll
    ? { quoteLotsToWithdraw: null, baseLotsToWithdraw: null }
    : {
        quoteLotsToWithdraw: args.quoteUnits ? new BN(client.quoteUnitsToQuoteLots(args.quoteUnits, def.address)) : null,
        baseLotsToWithdraw: args.baseUnits ? new BN(client.rawBaseUnitsToBaseLotsRoundedDown(args.baseUnits, def.address)) : null,
      };
  ixs.push(client.createWithdrawFundsInstruction({ withdrawFundsParams: params }, def.address, trader));

  const sig = await send(connection, signer, ixs, `withdraw ${def.symbol}`);
  getSigningGuard().logAudit({
    ts: new Date().toISOString(), type: 'withdraw', market: def.symbol,
    wallet: trader.toBase58(), result: 'confirmed', signature: sig,
  });
  return sig;
}

/** Look up the deposited (free) balances for a trader on a market. */
export async function getFreeFunds(symbol: string, trader: import('@solana/web3.js').PublicKey): Promise<{ baseLots: number; quoteLots: number } | null> {
  const phoenix = getPhoenixClient();
  const { state } = await phoenix.getMarket(symbol);
  await phoenix.refresh(state.address.toBase58(), true);
  const idx = state.data.traderPubkeyToTraderIndex.get(trader.toBase58());
  if (idx === undefined) return null;
  const traderState = state.data.traders.get(trader.toBase58());
  if (!traderState) return null;
  return {
    baseLots: Phoenix.toNum(traderState.baseLotsFree),
    quoteLots: Phoenix.toNum(traderState.quoteLotsFree),
  };
}
