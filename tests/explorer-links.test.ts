import { describe, it, expect } from 'vitest';
import { txLink, addrLink } from '../src/utils/explorer.js';

// Synthetic test fixtures — not associated with any real wallet/tx.
const SIG = '5HfwbthMxnFW4cV3X9ahcGTAEh4wpFa1KQYn9P9bgsfBQEjwwk8d52pCkPDV3vYrvDoz6Yyhi66NZbeyEY6jSEFn';
const ADDR = '11111111111111111111111111111111';

describe('explorer URL builders', () => {
  it('Solscan tx mainnet: no cluster suffix', () => {
    expect(txLink(SIG)).toBe(`https://solscan.io/tx/${SIG}`);
  });
  it('Solscan tx devnet: cluster=devnet', () => {
    expect(txLink(SIG, 'devnet')).toBe(`https://solscan.io/tx/${SIG}?cluster=devnet`);
  });
  it('Solscan address mainnet', () => {
    expect(addrLink(ADDR)).toBe(`https://solscan.io/account/${ADDR}`);
  });
  it('Solana Explorer tx mainnet: no cluster', () => {
    expect(txLink(SIG, 'mainnet-beta', 'solana')).toBe(`https://explorer.solana.com/tx/${SIG}`);
  });
  it('Solana Explorer tx devnet', () => {
    expect(txLink(SIG, 'devnet', 'solana')).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=devnet`);
  });
  it('SolanaFM provider', () => {
    expect(txLink(SIG, 'mainnet-beta', 'solanafm')).toBe(`https://solana.fm/tx/${SIG}`);
  });
});
