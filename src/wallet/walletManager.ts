import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { readFileSync, realpathSync, statSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { getLogger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { safeEnvNumber } from '../utils/safe-env.js';

const RPC_RETRY = { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 3000 };
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const KNOWN_MINTS: Record<string, string> = {
  [USDC_MINT]: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  So11111111111111111111111111111111111111112: 'WSOL',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 'PYTH',
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 'JTO',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 'WIF',
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'mSOL',
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JitoSOL',
  bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1: 'bSOL',
};

export class WalletManager {
  private connection: Connection;
  private keypair: Keypair | null = null;
  private publicKey: PublicKey | null = null;
  private balancesCache: { data: { sol: number; tokens: Array<{ symbol: string; mint: string; amount: number }> }; expiry: number } | null = null;
  private static readonly CACHE_TTL = 30_000;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  // Session idle timer — 0 = DISABLED (default). Set SESSION_TIMEOUT_MS=900000 in .env to re-enable.
  private static readonly SESSION_TIMEOUT_MS = safeEnvNumber('SESSION_TIMEOUT_MS', 0);
  /** Subscribers fired when the wallet is disconnected (manually or via timeout). */
  private disconnectCallbacks: Array<() => void | Promise<void>> = [];
  private _disconnecting = false;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  setConnection(connection: Connection): void {
    this.connection = connection;
    this.balancesCache = null;
  }

  clearBalanceCache(): void {
    this.balancesCache = null;
  }

  get isConnected(): boolean { return this.keypair !== null; }
  get hasAddress(): boolean { return this.publicKey !== null; }
  get isReadOnly(): boolean { return this.publicKey !== null && this.keypair === null; }
  get address(): string | null { return this.publicKey?.toBase58() ?? null; }

  getKeypair(): Keypair | null {
    if (this._disconnecting) return null;
    return this.keypair;
  }

  getPublicKey(): PublicKey | null { return this.publicKey; }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.keypair) return;
    // 0 = disabled
    if (WalletManager.SESSION_TIMEOUT_MS <= 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.keypair) {
        getLogger().warn('wallet', 'Session timed out — wallet disconnected for security');
        this.disconnect();
      }
    }, WalletManager.SESSION_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  /** Subscribe to wallet disconnection events. Used by the REPL to halt makers/etc. */
  onDisconnect(cb: () => void | Promise<void>): void {
    this.disconnectCallbacks.push(cb);
  }

  resetIdle(): void { this.resetIdleTimer(); }

  /**
   * Disconnect: zero the keypair's internal secret-key buffer, then drop references.
   * Keypair.fromSecretKey holds a REFERENCE to its input — we mutate the property directly.
   */
  disconnect(): void {
    this._disconnecting = true;
    if (this.keypair) {
      try {
        const sk = this.keypair.secretKey;
        if (sk && sk instanceof Uint8Array) sk.fill(0);
      } catch {
        /* best effort */
      }
    }
    this.keypair = null;
    this.publicKey = null;
    this._disconnecting = false;
    this.balancesCache = null;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    // Fire subscribers (e.g. stop active makers). Best-effort; errors are swallowed.
    for (const cb of this.disconnectCallbacks) {
      try { void cb(); } catch { /* ignore */ }
    }
  }

  /** Load a Solana CLI keypair JSON. Path must resolve inside $HOME. */
  loadFromFile(path: string): { address: string; keypair: Keypair } {
    const resolved = resolve(path);
    const home = homedir();
    const homePrefix = home.endsWith('/') ? home : home + '/';
    if (resolved !== home && !resolved.startsWith(homePrefix)) {
      throw new Error(`Wallet path must be within home directory (${home}). Got: ${resolved}`);
    }
    let realPath: string;
    try { realPath = realpathSync(resolved); } catch { throw new Error(`Wallet file not found: ${resolved}`); }
    if (realPath !== home && !realPath.startsWith(homePrefix)) {
      throw new Error(`Wallet path resolves outside home directory. Real path: ${realPath}`);
    }
    const fileSize = statSync(realPath).size;
    if (fileSize > 1024) throw new Error(`Wallet file too large (${fileSize} bytes). Expected 64-byte JSON.`);

    let raw: string;
    try { raw = readFileSync(realPath, 'utf-8'); } catch { throw new Error(`Wallet file not found: ${realPath}`); }

    let secretKey: number[];
    try { secretKey = JSON.parse(raw); } catch { throw new Error('Invalid wallet file format'); }
    if (!Array.isArray(secretKey) || secretKey.length !== 64) {
      throw new Error(`Invalid keypair: expected 64-byte array`);
    }
    for (let i = 0; i < 64; i++) {
      const v = secretKey[i];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
        throw new Error(`Invalid keypair byte at index ${i}`);
      }
    }

    const keyBytes = Uint8Array.from(secretKey);
    secretKey.fill(0);
    // Keypair.fromSecretKey holds a REFERENCE — do NOT zero keyBytes after this call.
    this.keypair = Keypair.fromSecretKey(keyBytes);
    this.publicKey = this.keypair.publicKey;
    getLogger().debug('wallet', `Loaded wallet: ${this.publicKey.toBase58()}`);
    this.resetIdleTimer();
    return { address: this.publicKey.toBase58(), keypair: this.keypair };
  }

  connectAddress(address: string): { address: string } {
    let pubkey: PublicKey;
    try { pubkey = new PublicKey(address); } catch { throw new Error(`Invalid Solana address: ${address}`); }
    if (!PublicKey.isOnCurve(pubkey.toBytes())) {
      throw new Error(`Address is not a valid wallet (off-curve): ${address}`);
    }
    this.publicKey = pubkey;
    this.keypair = null;
    getLogger().debug('wallet', `Connected address (read-only): ${pubkey.toBase58()}`);
    return { address: pubkey.toBase58() };
  }

  verifyKeypairIntegrity(): boolean {
    if (!this.keypair) return false;
    try {
      const sk = this.keypair.secretKey;
      let nonZero = 0;
      for (let i = 0; i < 32; i++) if (sk[i] !== 0) nonZero++;
      return nonZero > 0;
    } catch { return false; }
  }

  async getBalance(): Promise<number> {
    if (!this.publicKey) throw new Error('No wallet connected');
    const lamports = await withRetry(() => this.connection.getBalance(this.publicKey!), 'wallet-balance', RPC_RETRY);
    return lamports / LAMPORTS_PER_SOL;
  }

  async getTokenBalances(): Promise<{ sol: number; tokens: Array<{ symbol: string; mint: string; amount: number }> }> {
    if (!this.publicKey) throw new Error('No wallet connected');
    const now = Date.now();
    if (this.balancesCache && this.balancesCache.expiry > now) return this.balancesCache.data;

    const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

    const [solBal, splAcc, t22Acc] = await withRetry(
      () => Promise.all([
        this.connection.getBalance(this.publicKey!),
        this.connection.getParsedTokenAccountsByOwner(this.publicKey!, { programId: TOKEN_PROGRAM }),
        this.connection.getParsedTokenAccountsByOwner(this.publicKey!, { programId: TOKEN_2022 }),
      ]),
      'wallet-tokens',
      RPC_RETRY,
    );

    const tokens: Array<{ symbol: string; mint: string; amount: number }> = [];
    for (const acc of [...splAcc.value, ...t22Acc.value]) {
      const info = acc.account.data.parsed?.info;
      if (!info) continue;
      const mint: string = info.mint;
      const amount: number = info.tokenAmount?.uiAmount ?? 0;
      if (amount === 0) continue;
      tokens.push({ symbol: KNOWN_MINTS[mint] ?? 'UNKNOWN', mint, amount });
    }

    const result = { sol: solBal / LAMPORTS_PER_SOL, tokens };
    this.balancesCache = { data: result, expiry: Date.now() + WalletManager.CACHE_TTL };
    return result;
  }
}
