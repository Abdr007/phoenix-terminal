/**
 * Solana Explorer / Solscan link helpers.
 *
 * Returns full clickable URLs (most modern terminals — iTerm2, kitty, Warp,
 * VSCode terminal — auto-link bare URLs). Defaults to Solscan; pass `provider`
 * to override.
 */

export type ExplorerProvider = 'solscan' | 'solana' | 'solanafm';

const BASE: Record<ExplorerProvider, { tx: string; addr: string; cluster?: string }> = {
  solscan: { tx: 'https://solscan.io/tx/', addr: 'https://solscan.io/account/' },
  solana: { tx: 'https://explorer.solana.com/tx/', addr: 'https://explorer.solana.com/address/' },
  solanafm: { tx: 'https://solana.fm/tx/', addr: 'https://solana.fm/address/' },
};

function clusterSuffix(network: string, provider: ExplorerProvider): string {
  if (network === 'mainnet-beta') return '';
  if (provider === 'solscan') return `?cluster=${network}`;
  if (provider === 'solana') return `?cluster=${network === 'devnet' ? 'devnet' : 'testnet'}`;
  return `?cluster=${network}`;
}

export function txLink(signature: string, network = 'mainnet-beta', provider: ExplorerProvider = 'solscan'): string {
  return `${BASE[provider].tx}${signature}${clusterSuffix(network, provider)}`;
}

export function addrLink(address: string, network = 'mainnet-beta', provider: ExplorerProvider = 'solscan'): string {
  return `${BASE[provider].addr}${address}${clusterSuffix(network, provider)}`;
}
