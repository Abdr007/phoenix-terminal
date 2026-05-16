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
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
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

function tryLoadPubkey(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'));
    if (!Array.isArray(raw) || raw.length !== 64) return null;
    const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
    return kp.publicKey.toBase58();
  } catch {
    return null;
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
