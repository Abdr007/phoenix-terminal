import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from '@solana/spl-token';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getPhoenixClient } from './client.js';
import { makerSetupIxs, hasSeat, invalidateSetupCache } from './seats.js';
import { getSigningGuard } from '../security/signing-guard.js';
import { getLogger } from '../utils/logger.js';
import { loadConfig } from '../config/index.js';
import { Fill, OpenOrder, OrderResult, Side } from '../types/index.js';
import { safeNumber } from '../utils/safe-number.js';

const PHOENIX_SIDE = (s: Side): Phoenix.Side => (s === 'bid' ? Phoenix.Side.Bid : Phoenix.Side.Ask);

function clientOrderId(): number {
  // Use ms-since-epoch lower 31 bits — collision-resistant within session
  return Date.now() & 0x7fffffff;
}

interface SendOpts {
  computeUnitLimit?: number;
  computeUnitPrice?: number;
  skipPreflight?: boolean;
  label: string;
  useJito?: boolean;
  tipLamports?: number;
}

function withComputeBudget(ixs: TransactionInstruction[], opts: SendOpts): TransactionInstruction[] {
  const cfg = loadConfig();
  const out: TransactionInstruction[] = [];
  out.push(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit ?? cfg.computeUnitLimit }));
  out.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.computeUnitPrice ?? cfg.computeUnitPrice }));
  out.push(...ixs);
  return out;
}

async function sendTx(
  connection: Connection,
  signer: Keypair,
  ixs: TransactionInstruction[],
  opts: SendOpts,
): Promise<string> {
  const all = withComputeBudget(ixs, opts);

  if (opts.useJito) {
    const { sendBundleSimple, defaultTipLamports } = await import('../network/jito.js');
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tip = opts.tipLamports ?? defaultTipLamports();
    const { signature, bundleId, slot } = await sendBundleSimple(signer, [all], blockhash, tip);
    getLogger().info('tx', `[${opts.label}] Jito bundle ${bundleId} landed in slot ${slot} — sig ${signature}`);
    return signature;
  }

  const tx = new Transaction().add(...all);
  const sig = await sendAndConfirmTransaction(connection, tx, [signer], {
    skipPreflight: opts.skipPreflight ?? true,
    commitment: 'confirmed',
    maxRetries: 3,
  });
  getLogger().debug('tx', `[${opts.label}] confirmed ${sig}`);
  return sig;
}

/** SOL pair? Caller must wrap SOL into wSOL before bids, and unwrap after sells. */
function isSolPair(baseMint: string, quoteMint: string): { needsWrap: boolean; mintToWrap?: string } {
  const wSol = NATIVE_MINT.toBase58();
  if (baseMint === wSol) return { needsWrap: true, mintToWrap: wSol };
  if (quoteMint === wSol) return { needsWrap: true, mintToWrap: wSol };
  return { needsWrap: false };
}

/** Idempotent ATA + sync-native ixs to wrap a given amount of SOL into wSOL. */
function wrapSolIxs(owner: PublicKey, lamports: number): TransactionInstruction[] {
  if (lamports <= 0) return [];
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  return [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: ata, lamports }),
    createSyncNativeInstruction(ata),
  ];
}

/** Unwrap wSOL back to native SOL (closes the wSOL ATA). */
function unwrapSolIx(owner: PublicKey): TransactionInstruction {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner);
  return createCloseAccountInstruction(ata, owner, owner);
}

// ─── Place limit (maker) ───────────────────────────────────────────────────────

export interface PlaceLimitArgs {
  symbol: string;             // e.g. "SOL/USDC"
  side: Side;
  priceUsd: number;           // human price in quote-per-base
  sizeBase: number;           // human size in base units (e.g. 0.1 SOL)
  ttlSec?: number;            // default 30
  postOnly?: boolean;         // default false (true == reject if it would cross)
  wrapSolLamports?: number;   // for SOL-base bids, lamports to wrap pre-send
  useJito?: boolean;          // send via Jito bundle (atomic, guaranteed inclusion)
  tipLamports?: number;       // Jito tip; defaults to JITO_DEFAULT_TIP_LAMPORTS
}

export async function placeLimit(connection: Connection, signer: Keypair, args: PlaceLimitArgs): Promise<OrderResult> {
  const guard = getSigningGuard();
  const notional = args.priceUsd * args.sizeBase;
  const limitCheck = guard.checkOrderLimits({ notionalUsd: notional, market: args.symbol });
  if (!limitCheck.allowed) throw new Error(limitCheck.reason);
  const rate = guard.reserveSlot();
  if (!rate.allowed) throw new Error(rate.reason);

  const phoenix = getPhoenixClient();
  const { def, state } = await phoenix.getMarket(args.symbol);
  const client = await phoenix.raw();
  const trader = signer.publicKey;

  await phoenix.refresh(def.address);

  const ixs: TransactionInstruction[] = [];

  // 1. SOL wrap (if buying a SOL-base pair with SOL collateral, or selling base SOL)
  if (args.wrapSolLamports && args.wrapSolLamports > 0) {
    ixs.push(...wrapSolIxs(trader, args.wrapSolLamports));
  }

  // 2. Seat + ATA setup (idempotent, cached 60s)
  const setupIxs = await makerSetupIxs(connection, state, trader);
  ixs.push(...setupIxs);

  // 3. Order ix via template (handles unit conversion)
  const ttl = Math.max(5, args.ttlSec ?? 30);
  const orderIx = args.postOnly
    ? client.getPostOnlyOrderInstructionfromTemplate(def.address, trader, {
        side: PHOENIX_SIDE(args.side),
        priceAsFloat: args.priceUsd,
        sizeInBaseUnits: args.sizeBase,
        clientOrderId: clientOrderId(),
        rejectPostOnly: true,
        useOnlyDepositedFunds: false,
        lastValidUnixTimestampInSeconds: Math.floor(Date.now() / 1000) + ttl,
      })
    : client.getLimitOrderInstructionfromTemplate(def.address, trader, {
        side: PHOENIX_SIDE(args.side),
        priceAsFloat: args.priceUsd,
        sizeInBaseUnits: args.sizeBase,
        selfTradeBehavior: Phoenix.SelfTradeBehavior.CancelProvide,
        clientOrderId: clientOrderId(),
        useOnlyDepositedFunds: false,
        lastValidUnixTimestampInSeconds: Math.floor(Date.now() / 1000) + ttl,
      });
  ixs.push(orderIx);

  let sig: string;
  try {
    sig = await sendTx(connection, signer, ixs, {
      label: `limit ${args.side} ${def.symbol}`,
      useJito: args.useJito, tipLamports: args.tipLamports,
    });
  } catch (e) {
    // If we lost our seat between cache and send, retry once with cache invalidated
    const msg = (e as Error).message;
    if (msg.includes('Seat') || msg.includes('Trader')) {
      invalidateSetupCache(def.address, trader.toBase58());
      getLogger().warn('phoenix', `Order failed (${msg}). Retrying with fresh seat setup.`);
      const freshSetup = await makerSetupIxs(connection, state, trader);
      const retryIxs = [...freshSetup, orderIx];
      sig = await sendTx(connection, signer, retryIxs, { label: `limit-retry ${args.side} ${def.symbol}` });
    } else {
      guard.logAudit({
        ts: new Date().toISOString(),
        type: 'place_limit', market: def.symbol, side: args.side,
        priceUsd: args.priceUsd, sizeBase: args.sizeBase, notionalUsd: notional,
        wallet: trader.toBase58(), result: 'failed', reason: msg,
      });
      throw e;
    }
  }

  const fills = await parseFills(connection, sig, trader, def.symbol);
  const filledBase = fills.reduce((s, f) => s + f.sizeBase, 0);
  const filledNotional = fills.reduce((s, f) => s + f.notionalUsd, 0);

  guard.logAudit({
    ts: new Date().toISOString(),
    type: 'place_limit', market: def.symbol, side: args.side,
    priceUsd: args.priceUsd, sizeBase: args.sizeBase, notionalUsd: notional,
    wallet: trader.toBase58(), result: 'confirmed', signature: sig,
  });

  return { signature: sig, filledBase, filledNotionalUsd: filledNotional, feesPaidUsd: 0 };
}

// ─── Place IOC / market (taker) ────────────────────────────────────────────────

export interface PlaceIocArgs {
  symbol: string;
  side: Side;
  sizeBase: number;
  slippageBps?: number;          // worst-price tolerance (default 50)
  maxSlippageBps?: number;       // pre-trade REJECT threshold — predicts impact via router; throws if exceeded
  wrapSolLamports?: number;
  useJito?: boolean;
  tipLamports?: number;
}

export async function placeIoc(connection: Connection, signer: Keypair, args: PlaceIocArgs): Promise<OrderResult> {
  const guard = getSigningGuard();
  const phoenix = getPhoenixClient();
  const { def, state } = await phoenix.getMarket(args.symbol);
  const client = await phoenix.raw();
  const trader = signer.publicKey;

  await phoenix.refresh(def.address);

  // ─── Pre-trade slippage guard (uses SDK's router math) ──────────────────
  if (args.maxSlippageBps !== undefined && args.maxSlippageBps > 0) {
    const ladder = state.getUiLadder(20);
    const sideEnum = args.side === 'bid' ? Phoenix.Side.Bid : Phoenix.Side.Ask;
    const expectedOut = Phoenix.getExpectedOutAmountRouter({
      uiLadder: ladder, side: sideEnum, takerFeeBps: 2, inAmount: args.sizeBase,
    });
    const bestBid = ladder.bids[0]?.price ?? 0;
    const bestAsk = ladder.asks[0]?.price ?? 0;
    if (bestBid > 0 && bestAsk > 0 && expectedOut > 0) {
      const mid = (bestBid + bestAsk) / 2;
      // For asks (selling base), effective price = expectedOut / sizeBase (quote per base)
      // For bids (buying base), inAmount is base, expectedOut is base too if Phoenix routes that way
      // Phoenix's router for Bid takes quote in → returns base out. For Ask: base in → quote out.
      // sizeBase here is always base, but for Bid you'd want sizeQuote — caller normalizes.
      // Simplest universal: compute expected_price = how much quote per base actually moved
      const effectivePrice = args.side === 'bid' ? args.sizeBase / expectedOut : expectedOut / args.sizeBase;
      const impactBps = Math.abs(effectivePrice - mid) / mid * 10_000;
      if (impactBps > args.maxSlippageBps) {
        throw new Error(
          `Pre-trade impact ${impactBps.toFixed(1)}bps exceeds --max-slippage ${args.maxSlippageBps}bps. ` +
          `Expected fill ${effectivePrice.toFixed(4)} vs mid ${mid.toFixed(4)}. ` +
          `Increase --max-slippage or use a smaller size.`,
        );
      }
    }
  }

  // Estimate notional for guard check using top-of-book
  const ladder = state.getUiLadder(1);
  const topPrice = args.side === 'bid' ? ladder.asks[0]?.price : ladder.bids[0]?.price;
  if (!topPrice || !Number.isFinite(topPrice)) throw new Error(`No liquidity on ${def.symbol} for ${args.side}`);
  const notional = topPrice * args.sizeBase;

  const limitCheck = guard.checkOrderLimits({ notionalUsd: notional, market: def.symbol });
  if (!limitCheck.allowed) throw new Error(limitCheck.reason);
  const rate = guard.reserveSlot();
  if (!rate.allowed) throw new Error(rate.reason);

  const slippage = (args.slippageBps ?? 50) / 10_000;
  const worstPrice = args.side === 'bid' ? topPrice * (1 + slippage) : topPrice * (1 - slippage);

  const ixs: TransactionInstruction[] = [];

  if (args.wrapSolLamports && args.wrapSolLamports > 0) {
    ixs.push(...wrapSolIxs(trader, args.wrapSolLamports));
  }

  // ATAs (no seat required for IOC, but ATAs must exist)
  ixs.push(
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      getAssociatedTokenAddressSync(new PublicKey(def.baseMint), trader),
      trader,
      new PublicKey(def.baseMint),
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      trader,
      getAssociatedTokenAddressSync(new PublicKey(def.quoteMint), trader),
      trader,
      new PublicKey(def.quoteMint),
    ),
  );

  const swapIx = client.getImmediateOrCancelOrderIxfromTemplate(def.address, trader, {
    side: PHOENIX_SIDE(args.side),
    priceAsFloat: worstPrice,
    sizeInBaseUnits: args.sizeBase,
    sizeInQuoteUnits: 0,
    minBaseUnitsToFill: 0,
    minQuoteUnitsToFill: 0,
    selfTradeBehavior: Phoenix.SelfTradeBehavior.CancelProvide,
    clientOrderId: clientOrderId(),
    useOnlyDepositedFunds: false,
  });
  ixs.push(swapIx);

  const sig = await sendTx(connection, signer, ixs, {
    label: `ioc ${args.side} ${def.symbol}`,
    useJito: args.useJito, tipLamports: args.tipLamports,
  });
  const fills = await parseFills(connection, sig, trader, def.symbol);
  const filledBase = fills.reduce((s, f) => s + f.sizeBase, 0);
  const filledNotional = fills.reduce((s, f) => s + f.notionalUsd, 0);

  guard.logAudit({
    ts: new Date().toISOString(),
    type: 'place_ioc', market: def.symbol, side: args.side,
    sizeBase: args.sizeBase, notionalUsd: filledNotional || notional,
    wallet: trader.toBase58(), result: 'confirmed', signature: sig,
  });

  return { signature: sig, filledBase, filledNotionalUsd: filledNotional, feesPaidUsd: 0 };
}

// ─── Cancel ─────────────────────────────────────────────────────────────────────

export async function cancelAll(connection: Connection, signer: Keypair, symbol: string, opts: { useJito?: boolean; tipLamports?: number } = {}): Promise<string> {
  const guard = getSigningGuard();
  const rate = guard.reserveSlot();
  if (!rate.allowed) throw new Error(rate.reason);

  const phoenix = getPhoenixClient();
  const { def } = await phoenix.getMarket(symbol);
  const client = await phoenix.raw();
  const ix = client.createCancelAllOrdersInstruction(def.address, signer.publicKey);
  const sig = await sendTx(connection, signer, [ix], {
    label: `cancel-all ${def.symbol}`,
    useJito: opts.useJito, tipLamports: opts.tipLamports,
  });
  guard.logAudit({
    ts: new Date().toISOString(),
    type: 'cancel_all', market: def.symbol,
    wallet: signer.publicKey.toBase58(), result: 'confirmed', signature: sig,
  });
  return sig;
}

// ─── Open orders ────────────────────────────────────────────────────────────────

export async function getOpenOrders(symbol: string, trader: PublicKey): Promise<OpenOrder[]> {
  const phoenix = getPhoenixClient();
  const { def, state } = await phoenix.getMarket(symbol);
  await phoenix.refresh(def.address, true);
  const client = await phoenix.raw();

  const traderIndex = state.data.traderPubkeyToTraderIndex.get(trader.toBase58());
  if (traderIndex === undefined) return [];

  const out: OpenOrder[] = [];

  for (const [orderId, restingOrder] of state.data.bids) {
    if (Phoenix.toNum(restingOrder.traderIndex) !== traderIndex) continue;
    const numBaseLots = Phoenix.toNum(restingOrder.numBaseLots);
    const priceInTicks = Phoenix.toNum(orderId.priceInTicks);
    out.push({
      orderId: `bid-${Phoenix.toNum(orderId.orderSequenceNumber)}`,
      market: def.symbol,
      side: 'bid',
      priceUsd: client.ticksToFloatPrice(priceInTicks, def.address),
      sizeBase: client.baseAtomsToRawBaseUnits(client.baseLotsToBaseAtoms(numBaseLots, def.address), def.address),
      sizeRemainingBase: client.baseAtomsToRawBaseUnits(client.baseLotsToBaseAtoms(numBaseLots, def.address), def.address),
    });
  }
  for (const [orderId, restingOrder] of state.data.asks) {
    if (Phoenix.toNum(restingOrder.traderIndex) !== traderIndex) continue;
    const numBaseLots = Phoenix.toNum(restingOrder.numBaseLots);
    const priceInTicks = Phoenix.toNum(orderId.priceInTicks);
    out.push({
      orderId: `ask-${Phoenix.toNum(orderId.orderSequenceNumber)}`,
      market: def.symbol,
      side: 'ask',
      priceUsd: client.ticksToFloatPrice(priceInTicks, def.address),
      sizeBase: client.baseAtomsToRawBaseUnits(client.baseLotsToBaseAtoms(numBaseLots, def.address), def.address),
      sizeRemainingBase: client.baseAtomsToRawBaseUnits(client.baseLotsToBaseAtoms(numBaseLots, def.address), def.address),
    });
  }
  return out.sort((a, b) => b.priceUsd - a.priceUsd);
}

// ─── Fill parsing ───────────────────────────────────────────────────────────────

async function parseFills(connection: Connection, signature: string, trader: PublicKey, symbol: string): Promise<Fill[]> {
  try {
    const ptx = await Phoenix.getPhoenixEventsFromTransactionSignature(connection, signature);
    const fills: Fill[] = [];
    const traderStr = trader.toBase58();
    for (const ix of ptx.instructions) {
      for (const evt of ix.events) {
        if (!Phoenix.isPhoenixMarketEventFill(evt)) continue;
        const fillEvent = evt.fields[0];
        const isMaker = fillEvent.makerId.toBase58() === traderStr;
        // priceInTicks and baseLotsFilled require market context for conversion;
        // we don't have it cheaply here, so we record raw fields and resolve later.
        const priceTicks = safeNumber(Phoenix.toNum(fillEvent.priceInTicks));
        const baseLots = safeNumber(Phoenix.toNum(fillEvent.baseLotsFilled));
        // Resolve via the loaded market in our client (best effort)
        const client = await getPhoenixClient().raw();
        const def = (await getPhoenixClient().getMarket(symbol)).def;
        const priceUsd = client.ticksToFloatPrice(priceTicks, def.address);
        const sizeBase = client.baseAtomsToRawBaseUnits(
          client.baseLotsToBaseAtoms(baseLots, def.address),
          def.address,
        );
        fills.push({
          signature,
          market: symbol,
          side: isMaker ? 'bid' : 'ask', // approximate; full side detection needs PlaceEvent matching
          priceUsd,
          sizeBase,
          notionalUsd: priceUsd * sizeBase,
          isMaker,
          timestamp: Date.now(),
        });
      }
    }
    return fills;
  } catch (e) {
    getLogger().debug('phoenix', `parseFills failed for ${signature}: ${(e as Error).message}`);
    return [];
  }
}

export async function fetchFillsForTx(connection: Connection, signature: string): Promise<Phoenix.PhoenixTransaction> {
  return Phoenix.getPhoenixEventsFromTransactionSignature(connection, signature);
}
