/**
 * Canonical Phoenix market registry.
 *
 * Source: Ellipsis-Labs/phoenix-sdk master_config.json + DefiLlama liveness check.
 * Only the markets that have observable volume (24h > $1k typical) are marked LIQUID.
 * The full list is preserved so you can opt into the deep tail explicitly.
 */

export interface MarketDef {
  symbol: string;         // e.g. "SOL/USDC"
  address: string;        // market account address
  baseSymbol: string;
  quoteSymbol: string;
  baseMint: string;
  quoteMint: string;
  liquidity: 'deep' | 'medium' | 'thin';
}

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export const MARKETS: MarketDef[] = [
  {
    symbol: 'SOL/USDC',
    address: '4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg',
    baseSymbol: 'SOL', quoteSymbol: 'USDC',
    baseMint: WSOL_MINT, quoteMint: USDC_MINT,
    liquidity: 'deep',
  },
  {
    symbol: 'SOL/USDT',
    address: '3J9LfemPBLowAJgpG3YdYPB9n6pUk7HEjwgS6Y5ToSFg',
    baseSymbol: 'SOL', quoteSymbol: 'USDT',
    baseMint: WSOL_MINT, quoteMint: USDT_MINT,
    liquidity: 'deep',
  },
  {
    symbol: 'JitoSOL/USDC',
    address: '5LQLfGtqcC5rm2WuGxJf4tjqYmDjsQAbKo2AMLQ8KB7p',
    baseSymbol: 'JitoSOL', quoteSymbol: 'USDC',
    baseMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', quoteMint: USDC_MINT,
    liquidity: 'medium',
  },
  {
    symbol: 'JitoSOL/SOL',
    address: '2t9TBYyUyovhHQq434uAiBxW6DmJCg7w4xdDoSK6LRjP',
    baseSymbol: 'JitoSOL', quoteSymbol: 'SOL',
    baseMint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', quoteMint: WSOL_MINT,
    liquidity: 'medium',
  },
  {
    symbol: 'mSOL/SOL',
    address: 'FZRgpfpvicJ3p23DfmZuvUgcQZBHJsWScTf2N2jK8dy6',
    baseSymbol: 'mSOL', quoteSymbol: 'SOL',
    baseMint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', quoteMint: WSOL_MINT,
    liquidity: 'medium',
  },
  {
    symbol: 'JTO/USDC',
    address: 'BRLLmdtPGuuFn3BU6orYw4KHaohAEptBToi3dwRUnHQZ',
    baseSymbol: 'JTO', quoteSymbol: 'USDC',
    baseMint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', quoteMint: USDC_MINT,
    liquidity: 'thin',
  },
  {
    symbol: 'JUP/USDC',
    address: '2pspvjWWaf3dNgt3jsgSzFCNvMGPb7t8FrEYvLGjvcCe',
    baseSymbol: 'JUP', quoteSymbol: 'USDC',
    baseMint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', quoteMint: USDC_MINT,
    liquidity: 'thin',
  },
  {
    symbol: 'BONK/USDC',
    address: 'GBMoNx84HsFdVK63t8BZuDgyZhSBaeKWB4pHHpoeRM9z',
    baseSymbol: 'BONK', quoteSymbol: 'USDC',
    baseMint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', quoteMint: USDC_MINT,
    liquidity: 'thin',
  },
  {
    symbol: 'WIF/USDC',
    address: '6ojSigXF7nDPyhFRgmn3V9ywhYseKF9J32ZrranMGVSX',
    baseSymbol: 'WIF', quoteSymbol: 'USDC',
    baseMint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', quoteMint: USDC_MINT,
    liquidity: 'thin',
  },
  {
    symbol: 'PYTH/USDC',
    address: '2sTMN9A1D1qeZLF95XQgJCUPiKe5DiV52jLfZGqMP46m',
    baseSymbol: 'PYTH', quoteSymbol: 'USDC',
    baseMint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', quoteMint: USDC_MINT,
    liquidity: 'thin',
  },
];

export const DEEP_MARKETS = MARKETS.filter((m) => m.liquidity === 'deep').map((m) => m.address);
export const DEFAULT_WATCH_MARKETS = MARKETS.filter((m) => m.liquidity !== 'thin').map((m) => m.address);

export function findMarket(symbolOrAddress: string): MarketDef | undefined {
  const s = symbolOrAddress.toUpperCase().trim();
  return (
    MARKETS.find((m) => m.symbol.toUpperCase() === s) ||
    MARKETS.find((m) => m.address === symbolOrAddress) ||
    MARKETS.find((m) => m.symbol.replace('/', '-').toUpperCase() === s)
  );
}

export function listSymbols(): string[] {
  return MARKETS.map((m) => m.symbol);
}
