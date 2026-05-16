/**
 * Signing Guard — central gate for all on-chain order signing.
 *
 * - Per-order notional ceiling (USD)
 * - Rate limiting (max orders/minute, min delay between orders)
 * - Append-only signing audit log (no secrets, rotated at 10MB)
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

export interface SigningGuardConfig {
  maxNotionalPerOrder: number;     // USD, 0 = unlimited
  maxOrdersPerMinute: number;      // count, 0 = unlimited
  minDelayBetweenOrdersMs: number; // ms, 0 = no delay
  auditLogPath: string;
}

export const DEFAULT_GUARD: SigningGuardConfig = {
  maxNotionalPerOrder: 0,
  maxOrdersPerMinute: 20,
  minDelayBetweenOrdersMs: 500,
  auditLogPath: join(homedir(), '.phoenix', 'signing-audit.log'),
};

export interface GuardCheck { allowed: boolean; reason?: string; }

export type AuditEventType =
  | 'place_limit'
  | 'place_ioc'
  | 'place_ladder'
  | 'cancel_order'
  | 'cancel_all'
  | 'cancel_by_id'
  | 'cancel_up_to'
  | 'reduce_order'
  | 'claim_seat'
  | 'deposit'
  | 'withdraw';

export interface AuditEntry {
  ts: string;
  type: AuditEventType;
  market: string;
  side?: 'bid' | 'ask';
  priceUsd?: number;
  sizeBase?: number;
  notionalUsd?: number;
  wallet: string;
  result: 'submitted' | 'confirmed' | 'rejected' | 'failed' | 'rate_limited';
  signature?: string;
  reason?: string;
}

const MAX_LOG_BYTES = 10 * 1024 * 1024;
const MAX_HISTORY = 200;

export class SigningGuard {
  private cfg: SigningGuardConfig;
  private timestamps: number[] = [];
  private lastSigningAt = 0;

  constructor(cfg?: Partial<SigningGuardConfig>) {
    this.cfg = { ...DEFAULT_GUARD, ...cfg };
    this.initLog();
  }

  checkOrderLimits(params: { notionalUsd: number; market: string }): GuardCheck {
    if (this.cfg.maxNotionalPerOrder > 0 && params.notionalUsd > this.cfg.maxNotionalPerOrder) {
      return {
        allowed: false,
        reason: `Order notional $${params.notionalUsd.toFixed(2)} exceeds MAX_NOTIONAL_PER_ORDER $${this.cfg.maxNotionalPerOrder.toFixed(2)}`,
      };
    }
    return { allowed: true };
  }

  /** Atomically check and reserve a rate-limit slot. */
  reserveSlot(): GuardCheck {
    const now = Date.now();
    if (this.cfg.minDelayBetweenOrdersMs > 0) {
      const elapsed = now - this.lastSigningAt;
      if (this.lastSigningAt > 0 && elapsed < this.cfg.minDelayBetweenOrdersMs) {
        const waitMs = this.cfg.minDelayBetweenOrdersMs - elapsed;
        return { allowed: false, reason: `Rate limited: wait ${(waitMs / 1000).toFixed(1)}s before next order` };
      }
    }
    if (this.cfg.maxOrdersPerMinute > 0) {
      const oneMinAgo = now - 60_000;
      this.timestamps = this.timestamps.filter((t) => t > oneMinAgo);
      if (this.timestamps.length >= this.cfg.maxOrdersPerMinute) {
        return { allowed: false, reason: `Rate limited: ${this.cfg.maxOrdersPerMinute} orders/minute cap reached` };
      }
    }
    this.lastSigningAt = now;
    this.timestamps.push(now);
    if (this.timestamps.length > MAX_HISTORY) this.timestamps = this.timestamps.slice(-MAX_HISTORY);
    return { allowed: true };
  }

  logAudit(entry: AuditEntry): void {
    const line = JSON.stringify(entry) + '\n';
    try {
      if (existsSync(this.cfg.auditLogPath)) {
        const size = statSync(this.cfg.auditLogPath).size;
        if (size > MAX_LOG_BYTES) {
          renameSync(this.cfg.auditLogPath, this.cfg.auditLogPath + '.old');
          writeFileSync(this.cfg.auditLogPath, '', { mode: 0o600 });
        }
      }
      appendFileSync(this.cfg.auditLogPath, line);
    } catch {
      /* best effort */
    }
  }

  private initLog(): void {
    try {
      const dir = dirname(this.cfg.auditLogPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (!existsSync(this.cfg.auditLogPath)) writeFileSync(this.cfg.auditLogPath, '', { mode: 0o600 });
    } catch {
      /* best effort */
    }
  }

  get limits() {
    return {
      maxNotionalPerOrder: this.cfg.maxNotionalPerOrder,
      maxOrdersPerMinute: this.cfg.maxOrdersPerMinute,
      minDelayBetweenOrdersMs: this.cfg.minDelayBetweenOrdersMs,
    };
  }
}

let _guard: SigningGuard | null = null;
export function initSigningGuard(cfg?: Partial<SigningGuardConfig>): SigningGuard {
  _guard = new SigningGuard(cfg);
  return _guard;
}
export function getSigningGuard(): SigningGuard {
  if (!_guard) _guard = new SigningGuard();
  return _guard;
}
