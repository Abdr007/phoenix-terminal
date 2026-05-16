import { config as loadEnv } from 'dotenv';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, resolve as resolvePath } from 'path';
import { fileURLToPath } from 'url';
import { safeEnvBool, safeEnvNumber, safeEnvString } from '../utils/safe-env.js';

/**
 * Resolve config from (in priority order):
 *   1. $PHOENIX_ENV (explicit override)
 *   2. ./.env in current working directory
 *   3. ~/.phoenix/.env (per-user global config)
 *   4. .env next to the installed binary (handles `phoenix` invoked from anywhere)
 *
 * Later files only fill in keys missing from earlier ones (dotenv default: first-loaded wins).
 */
function loadEnvFromAllLocations(): void {
  const candidates: string[] = [];
  if (process.env.PHOENIX_ENV) candidates.push(process.env.PHOENIX_ENV);
  candidates.push(resolvePath(process.cwd(), '.env'));
  candidates.push(resolvePath(homedir(), '.phoenix', '.env'));
  try {
    const here = dirname(fileURLToPath(import.meta.url));        // dist/config
    candidates.push(resolvePath(here, '..', '..', '.env'));      // project root next to dist/
  } catch {
    /* not running as ESM file URL (e.g. bundled) — skip */
  }
  for (const path of candidates) {
    if (existsSync(path)) loadEnv({ path });
  }
}
loadEnvFromAllLocations();

export interface PhoenixConfig {
  rpcUrl: string;
  backupRpcs: string[];
  network: 'mainnet-beta' | 'devnet';
  walletPath: string;
  simulationMode: boolean;
  tradingEnabled: boolean;
  computeUnitLimit: number;
  computeUnitPrice: number;
  maxNotionalPerOrder: number;
  maxOrdersPerMinute: number;
  minDelayBetweenOrdersMs: number;
}

function expandHome(p: string): string {
  if (p.startsWith('~')) return p.replace('~', homedir());
  return p;
}

function validateRpcUrl(url: string): string {
  if (!url) throw new Error('RPC_URL is required');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid RPC_URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`RPC_URL must be http(s): ${url}`);
  }
  if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(`RPC_URL must use https for non-local endpoints: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('RPC_URL must not contain credentials. Use API key as query parameter.');
  }
  return url;
}

export function loadConfig(): PhoenixConfig {
  const rpcUrl = validateRpcUrl(safeEnvString('RPC_URL', 'https://api.mainnet-beta.solana.com'));
  const backupRpcs: string[] = [];
  for (const k of ['BACKUP_RPC_1', 'BACKUP_RPC_2', 'BACKUP_RPC_3']) {
    const v = process.env[k];
    if (v) backupRpcs.push(validateRpcUrl(v));
  }
  const network = safeEnvString('NETWORK', 'mainnet-beta') as 'mainnet-beta' | 'devnet';
  if (network !== 'mainnet-beta' && network !== 'devnet') {
    throw new Error(`NETWORK must be mainnet-beta or devnet, got: ${network}`);
  }

  return {
    rpcUrl,
    backupRpcs,
    network,
    walletPath: expandHome(safeEnvString('WALLET_PATH', '~/.config/solana/id.json')),
    simulationMode: safeEnvBool('SIMULATION_MODE', true),
    tradingEnabled: safeEnvBool('TRADING_ENABLED', true),
    computeUnitLimit: safeEnvNumber('COMPUTE_UNIT_LIMIT', 400_000),
    computeUnitPrice: safeEnvNumber('COMPUTE_UNIT_PRICE', 100_000),
    maxNotionalPerOrder: safeEnvNumber('MAX_NOTIONAL_PER_ORDER', 0),
    maxOrdersPerMinute: safeEnvNumber('MAX_ORDERS_PER_MINUTE', 20),
    minDelayBetweenOrdersMs: safeEnvNumber('MIN_DELAY_BETWEEN_ORDERS_MS', 500),
  };
}
