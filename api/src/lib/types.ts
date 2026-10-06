import { PublicKey, TransactionInstruction } from '@solana/web3.js';

/**
 * Output of the transaction parser: a normalized, readable representation of
 * a Solana transaction that downstream detectors can consume without having
 * to re-implement SPL-token / system-program decoding themselves.
 */

export type Network = 'mainnet-beta' | 'devnet' | 'testnet';

export interface ParsedAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface DecodedInstruction {
  /** Index of this instruction inside the transaction's instructions array. */
  index: number;

  /** Base58 program ID. */
  programId: string;

  /** Human-readable program name, if known (e.g. "Token", "System"). */
  programName: string;

  /** Raw account keys in order (as base58). */
  accounts: ParsedAccountMeta[];

  /**
   * Decoded instruction type, e.g. "approve", "transfer", "setAuthority",
   * "createAccount", "unknown". If we don't recognise the discriminator this
   * will be "unknown".
   */
  instructionType: string;

  /**
   * Human-readable decoded arguments. Shape varies by instruction type.
   * Examples:
   *   approve:       { owner, delegate, amount, decimals? }
   *   transfer:      { source, destination, amount, decimals? }
   *   setAuthority:  { account, authorityType, newAuthority, currentAuthority }
   *   createAccount: { lamports, space, owner }
   */
  args: Record<string, unknown>;

  /** Raw instruction data bytes as hex, for debugging / unknown discriminators. */
  rawDataHex: string;
}

export interface ParsedTransaction {
  /** Signatures (base58). Empty for unsigned pre-sign transactions. */
  signatures: string[];

  /** Feepayer pubkey if available, else null. */
  feePayer: string | null;

  /** true if the transaction is a VersionedTransaction (v0), false for legacy. */
  isVersioned: boolean;

  /** All instructions (including those from loaded address lookup tables for v0). */
  instructions: DecodedInstruction[];

  /** Network the transaction was created for. */
  network: Network;

  /**
   * All unique program IDs touched by the transaction. Useful for the
   * "known malicious program ID" and "fresh program" detectors.
   */
  referencedProgramIds: string[];

  /**
   * All unique destination / recipient / target addresses that appear as the
   * final beneficiary of transfer/approve/setAuthority-style instructions.
   * Used by the blocklist detector.
   */
  destinationAddresses: string[];
}
