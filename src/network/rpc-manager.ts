import { Connection, ConnectionConfig } from '@solana/web3.js';
import { getLogger } from '../utils/logger.js';

export interface RpcEndpoint {
  url: string;
  label: string;
}

export interface RpcHealth {
  url: string;
  label: string;
  healthy: boolean;
  latencyMs: number;
  slot?: number;
  slotLag?: number;
  error?: string;
}

const HEALTH_TIMEOUT_MS = 5_000;
const LATENCY_THRESHOLD_MS = 3_000;
const SLOT_LAG_THRESHOLD = 50;
const FAILOVER_COOLDOWN_MS = 60_000;
const HEALTH_INTERVAL_MS = 30_000;

const CONNECTION_CONFIG: ConnectionConfig = {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 90_000,
};

function labelFromUrl(url: string): string {
  try {
    const h = new URL(url).hostname;
    return h.replace('api.', '').replace('.solana.com', '').replace('.helius-rpc.com', '-helius');
  } catch {
    return url.slice(0, 30);
  }
}

export function createConnection(url: string): Connection {
  return new Connection(url, CONNECTION_CONFIG);
}

export class RpcManager {
  private endpoints: RpcEndpoint[];
  private activeIndex = 0;
  private _connection: Connection;
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private lastFailoverAt = 0;
  private onChange: ((c: Connection, ep: RpcEndpoint) => void) | null = null;
  private slotHistory = new Map<string, number>();

  constructor(endpoints: RpcEndpoint[]) {
    if (endpoints.length === 0) throw new Error('At least one RPC endpoint is required');
    this.endpoints = endpoints;
    this._connection = createConnection(endpoints[0].url);
  }

  get connection(): Connection { return this._connection; }
  get active(): RpcEndpoint { return this.endpoints[this.activeIndex]; }
  get all(): readonly RpcEndpoint[] { return this.endpoints; }

  onConnectionChange(cb: (c: Connection, ep: RpcEndpoint) => void): void {
    this.onChange = cb;
  }

  async checkOne(ep: RpcEndpoint): Promise<RpcHealth> {
    const start = Date.now();
    const conn = createConnection(ep.url);
    try {
      const slot = await Promise.race([
        conn.getSlot('confirmed'),
        new Promise<number>((_, rej) => setTimeout(() => rej(new Error('timeout')), HEALTH_TIMEOUT_MS)),
      ]);
      const latency = Date.now() - start;
      this.slotHistory.set(ep.url, slot);
      const maxSlot = Math.max(...Array.from(this.slotHistory.values()));
      const slotLag = maxSlot - slot;
      const healthy = latency < LATENCY_THRESHOLD_MS && slotLag <= SLOT_LAG_THRESHOLD;
      return { url: ep.url, label: ep.label, healthy, latencyMs: latency, slot, slotLag };
    } catch (e) {
      return { url: ep.url, label: ep.label, healthy: false, latencyMs: Date.now() - start, error: (e as Error).message };
    }
  }

  async checkAll(): Promise<RpcHealth[]> {
    return Promise.all(this.endpoints.map((ep) => this.checkOne(ep)));
  }

  /** Switch to the first healthy endpoint other than the current one. */
  async failover(reason: string): Promise<boolean> {
    const now = Date.now();
    if (now - this.lastFailoverAt < FAILOVER_COOLDOWN_MS) return false;
    if (this.endpoints.length < 2) return false;
    const logger = getLogger();
    // Demoted to debug to reduce REPL noise; the actual switch still logs at info below.
    logger.debug('rpc', `Failover triggered: ${reason}. Probing alternatives...`);
    const results = await this.checkAll();
    const candidate = results.findIndex((r, i) => r.healthy && i !== this.activeIndex);
    if (candidate < 0) {
      logger.error('rpc', 'No healthy alternative endpoint found');
      return false;
    }
    const prev = this.endpoints[this.activeIndex];
    this.activeIndex = candidate;
    this._connection = createConnection(this.endpoints[candidate].url);
    this.lastFailoverAt = now;
    logger.info('rpc', `Failover: ${prev.label} → ${this.endpoints[candidate].label}`);
    if (this.onChange) this.onChange(this._connection, this.endpoints[candidate]);
    return true;
  }

  startMonitor(): void {
    if (this.monitorTimer) return;
    this.monitorTimer = setInterval(async () => {
      try {
        const active = await this.checkOne(this.active);
        if (!active.healthy) {
          await this.failover(active.error ?? `unhealthy (lag=${active.slotLag}, lat=${active.latencyMs}ms)`);
        }
      } catch (e) {
        getLogger().debug('rpc', `Monitor cycle error: ${(e as Error).message}`);
      }
    }, HEALTH_INTERVAL_MS);
    this.monitorTimer.unref?.();
  }

  stopMonitor(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }
}

let _rpc: RpcManager | null = null;
export function initRpcManager(endpoints: Array<{ url: string; label?: string }>): RpcManager {
  const eps: RpcEndpoint[] = endpoints.map((e) => ({ url: e.url, label: e.label ?? labelFromUrl(e.url) }));
  _rpc = new RpcManager(eps);
  return _rpc;
}
export function getRpcManager(): RpcManager {
  if (!_rpc) throw new Error('RPC manager not initialized');
  return _rpc;
}
