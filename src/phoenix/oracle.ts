/**
 * Pyth Hermes oracle reference pricing.
 *
 * Hermes is Pyth's HTTP+SSE service for the latest verified price updates
 * (https://hermes.pyth.network). We poll the REST endpoint with a small TTL
 * cache — sub-second freshness is unnecessary here (only used for sanity
 * checks vs Phoenix mid).
 */

import { getLogger } from '../utils/logger.js';

const HERMES_BASE = 'https://hermes.pyth.network/v2';
const CACHE_TTL_MS = 4_000;

// Pyth price feed IDs for the assets we trade on Phoenix.
// Source: https://pyth.network/developers/price-feed-ids
const FEED_IDS: Record<string, string> = {
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  USDC: 'eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a',
  USDT: '2b89b9dc8fdf9f34709a5b106b472f0f39bb6ca9ce04b0fd7f2e971688e2e53b',
  JitoSOL: '67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb',
  mSOL: 'c2289a6a43d2ce91c6f55caec370f4acc38a2ed477f58813334c6d03749ff2a4',
  JTO: 'b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2',
  JUP: '0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996',
  BONK: '72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419',
  WIF: '4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54cd4cc61fc',
  PYTH: '0bbf28e9a841a1cc788f6a361b17ca072d0ea3098a1e5df1c3922d06719579ff',
};

interface CachedPrice { price: number; expoNorm: number; ts: number; }
const cache = new Map<string, CachedPrice>();

interface HermesPriceUpdate {
  parsed?: Array<{
    id: string;
    price: { price: string; conf: string; expo: number; publish_time: number };
  }>;
}

export async function fetchPythPrice(symbol: string): Promise<number | null> {
  const id = FEED_IDS[symbol];
  if (!id) return null;
  const cached = cache.get(symbol);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.price;

  try {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 4_000);
    const res = await fetch(`${HERMES_BASE}/updates/price/latest?ids[]=${id}`, { signal: ctrl.signal });
    clearTimeout(to);
    if (!res.ok) return null;
    const json = (await res.json()) as HermesPriceUpdate;
    const parsed = json.parsed?.[0];
    if (!parsed) return null;
    const raw = Number(parsed.price.price);
    const expo = parsed.price.expo;
    if (!Number.isFinite(raw) || !Number.isFinite(expo)) return null;
    const price = raw * Math.pow(10, expo);
    cache.set(symbol, { price, expoNorm: expo, ts: Date.now() });
    return price;
  } catch (e) {
    getLogger().debug('oracle', `pyth fetch failed for ${symbol}: ${(e as Error).message}`);
    return null;
  }
}

export async function fetchPythPrices(symbols: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  await Promise.all(symbols.map(async (s) => out.set(s, await fetchPythPrice(s))));
  return out;
}

export function supportedSymbols(): string[] {
  return Object.keys(FEED_IDS);
}
