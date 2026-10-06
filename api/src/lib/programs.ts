/**
 * Well-known Solana program IDs that we want to detect by name rather than
 * just a raw base58 string. Using the canonical constants from
 * @solana/spl-token and @solana/web3.js where possible.
 */

import { PublicKey } from '@solana/web3.js';

export const SYSTEM_PROGRAM_ID = new PublicKey(
  '11111111111111111111111111111111'
);

export const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
);

export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
);

export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);

export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  'ComputeBudget111111111111111111111111111111'
);

export const RENT_PROGRAM_ID = new PublicKey(
  'SysvarRent111111111111111111111111111111111'
);

/**
 * Returns a human-readable program name if the pubkey matches a known program,
 * otherwise returns the base58 string.
 */
export function programName(pubkey: PublicKey): string {
  const s = pubkey.toBase58();
  switch (s) {
    case SYSTEM_PROGRAM_ID.toBase58():
      return 'System';
    case TOKEN_PROGRAM_ID.toBase58():
      return 'Token';
    case TOKEN_2022_PROGRAM_ID.toBase58():
      return 'Token2022';
    case ASSOCIATED_TOKEN_PROGRAM_ID.toBase58():
      return 'AssociatedToken';
    case COMPUTE_BUDGET_PROGRAM_ID.toBase58():
      return 'ComputeBudget';
    default:
      return s;
  }
}
