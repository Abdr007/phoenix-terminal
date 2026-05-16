import { Connection, PublicKey } from '@solana/web3.js';
import * as Phoenix from '@ellipsis-labs/phoenix-sdk';
import { getLogger } from '../utils/logger.js';
import { MarketDef, MARKETS, findMarket } from './markets.js';

/**
 * Thin wrapper around `Phoenix.Client` that lazy-loads markets, debounces
 * refreshes, and exposes a stable getMarket(symbol) accessor.
 *
 * Cold-start strategy:
 *   - DO NOT call Phoenix.Client.create() — it loads all configured markets and
 *     burns several seconds + RPC bandwidth.
 *   - Use createWithMarketAddresses() with the ones we actually need.
 *   - Add more on demand.
 */
export class PhoenixClient {
  private client: Phoenix.Client | null = null;
  private connection: Connection;
  private lastRefreshByMarket = new Map<string, number>();
  private static readonly REFRESH_DEBOUNCE_MS = 400;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  setConnection(connection: Connection): void {
    this.connection = connection;
    this.client = null; // force re-init on next use
    this.lastRefreshByMarket.clear();
  }

  /** Initialize with a specific set of markets (lazy). */
  async init(addresses: string[] = []): Promise<void> {
    const targets = addresses.length > 0 ? addresses : MARKETS.slice(0, 4).map((m) => m.address);
    const pubkeys = targets.map((a) => new PublicKey(a));
    getLogger().debug('phoenix', `Initializing client with ${pubkeys.length} markets`);
    this.client = await Phoenix.Client.createWithMarketAddresses(this.connection, pubkeys);
  }

  /** Idempotently add a market to the client. */
  async addMarket(symbolOrAddress: string): Promise<MarketDef> {
    if (!this.client) await this.init([]);
    const def = findMarket(symbolOrAddress);
    if (!def) throw new Error(`Unknown market: ${symbolOrAddress}. Use one from MARKETS.`);
    if (!this.client!.marketStates.has(def.address)) {
      await this.client!.addMarket(def.address);
      getLogger().debug('phoenix', `Loaded market ${def.symbol}`);
    }
    return def;
  }

  /** Get the underlying SDK Client. Initializes if needed. */
  async raw(): Promise<Phoenix.Client> {
    if (!this.client) await this.init([]);
    return this.client!;
  }

  /** Refresh a market's data with debounce to avoid hammering the RPC. */
  async refresh(address: string, force = false): Promise<void> {
    const now = Date.now();
    const last = this.lastRefreshByMarket.get(address) ?? 0;
    if (!force && now - last < PhoenixClient.REFRESH_DEBOUNCE_MS) return;
    const client = await this.raw();
    await client.refreshMarket(address);
    this.lastRefreshByMarket.set(address, now);
  }

  async refreshAll(): Promise<void> {
    const client = await this.raw();
    await client.refreshAllMarkets();
    const now = Date.now();
    for (const addr of client.marketStates.keys()) this.lastRefreshByMarket.set(addr, now);
  }

  /** Get a MarketState by symbol or address. Loads if missing. */
  async getMarket(symbolOrAddress: string): Promise<{ def: MarketDef; state: Phoenix.MarketState }> {
    const def = await this.addMarket(symbolOrAddress);
    const client = await this.raw();
    const state = client.marketStates.get(def.address);
    if (!state) throw new Error(`Market state missing after load: ${def.symbol}`);
    return { def, state };
  }

  getLoadedAddresses(): string[] {
    return this.client ? Array.from(this.client.marketStates.keys()) : [];
  }
}

let _client: PhoenixClient | null = null;
export function initPhoenixClient(connection: Connection): PhoenixClient {
  _client = new PhoenixClient(connection);
  return _client;
}
export function getPhoenixClient(): PhoenixClient {
  if (!_client) throw new Error('Phoenix client not initialized');
  return _client;
}
