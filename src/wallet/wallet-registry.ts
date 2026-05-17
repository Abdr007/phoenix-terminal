/**
 * Wallet registry — discovers Solana CLI keypair files in standard locations
 * so the user can switch between them by short name at runtime.
 *
 * Locations scanned (in this order, higher priority first):
 *   1. $WALLETS_DIR (if set)
 *   2. ~/.flash/wallets/
 *   3. ~/.config/solana/
 *
 * A "wallet" is any *.json file that successfully decodes as a 64-byte
 * Solana secret-key array. The short name is the filename without extension.
 */

import { Keypair } from '@solana/web3.js';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { homedir, platform } from 'os';
import { join, resolve as resolvePath } from 'path';
import { getLogger } from '../utils/logger.js';

export interface WalletEntry {
  name: string;       // short alias (filename without .json)
  path: string;       // absolute path
  address: string;    // pubkey
}

const SCAN_DIRS = [
  process.env.WALLETS_DIR,
  join(homedir(), '.flash', 'wallets'),
  join(homedir(), '.config', 'solana'),
].filter((d): d is string => Boolean(d));

/**
 * Warn (once per path) when a wallet file is world-readable or group-readable.
 * On Unix the secret-key file should be 0600 (owner-only). Posix-only — Windows
 * has different semantics, so we skip the check there.
 */
const _warnedPaths = new Set<string>();
function warnIfWorldReadable(path: string): void {
  if (platform() === 'win32') return;
  if (_warnedPaths.has(path)) return;
  try {
    const mode = statSync(path).mode & 0o777;
    // Bits 0o077 = group + other. Any non-zero bit there means readable beyond owner.
    if ((mode & 0o077) !== 0) {
      getLogger().warn('wallet-registry',
        `${path} permissions are ${mode.toString(8)} — wallet file readable by group/other. ` +
        `Run: chmod 600 "${path}" to restrict to owner only.`);
      _warnedPaths.add(path);
    }
  } catch { /* stat failed, skip */ }
}

function tryLoadPubkey(path: string): string | null {
  let secretBytes: Uint8Array | null = null;
  try {
    warnIfWorldReadable(path);
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(raw) || raw.length !== 64) return null;
    secretBytes = Uint8Array.from(raw);
    const kp = Keypair.fromSecretKey(secretBytes);
    return kp.publicKey.toBase58();
  } catch {
    return null;
  } finally {
    // Best-effort zero of the locally-held secret bytes so they don't linger
    // on the heap after we've extracted the pubkey. Keypair.fromSecretKey
    // holds its own reference; we can't reach that, but we can at least
    // clear our copy.
    try { secretBytes?.fill(0); } catch { /* */ }
  }
}

export function discoverWallets(): WalletEntry[] {
  const seen = new Set<string>();
  const out: WalletEntry[] = [];
  for (const dir of SCAN_DIRS) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const path = resolvePath(dir, f);
      if (seen.has(path)) continue;
      seen.add(path);
      const address = tryLoadPubkey(path);
      if (!address) continue;
      out.push({ name: f.replace(/\.json$/, ''), path, address });
    }
  }
  return out;
}

/**
 * Resolve a user-supplied identifier to a wallet path.
 * Matches by (in order): exact path, short name, address prefix.
 */
export function resolveWallet(identifier: string): WalletEntry | null {
  const id = identifier.trim();
  // Direct path?
  if (id.includes('/') || id.startsWith('~')) {
    const path = id.startsWith('~') ? id.replace(/^~/, homedir()) : resolvePath(id);
    // Path traversal restriction — match walletManager.loadFromFile policy:
    // user-supplied paths must resolve under $HOME.
    const home = homedir();
    const homePrefix = home.endsWith('/') ? home : home + '/';
    if (path !== home && !path.startsWith(homePrefix)) {
      getLogger().debug('wallet-registry', `refused out-of-home path: ${path}`);
      return null;
    }
    if (existsSync(path)) {
      const address = tryLoadPubkey(path);
      if (address) return { name: id.split('/').pop()?.replace(/\.json$/, '') ?? 'custom', path, address };
    }
    return null;
  }
  const wallets = discoverWallets();
  // Exact short name match (case-insensitive)
  const lower = id.toLowerCase();
  const byName = wallets.find((w) => w.name.toLowerCase() === lower);
  if (byName) return byName;
  // Address-prefix match (case-insensitive) — require at least 4 chars to avoid
  // accidental matches like `a` matching half the wallets.
  if (lower.length >= 4) {
    const byAddr = wallets.find((w) => w.address.toLowerCase().startsWith(lower));
    if (byAddr) return byAddr;
  }
  getLogger().debug('wallet-registry', `no wallet matches "${identifier}"`);
  return null;
}
