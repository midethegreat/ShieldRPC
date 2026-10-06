/**
 * Shared types for rule-based detectors.
 *
 * Each detector is a pure function `(parsed, context?) => DetectionResult | null`.
 * `null` → no flag found. A non-null result means "flag this."
 *
 * Keeping them pure makes them trivial to unit-test against fixtures and
 * cheap to parallelize in the API layer.
 */

import type { ParsedTransaction } from '../lib/types.js';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface DetectionResult {
  /** Matches one of the 4 MVP detector IDs, plus any extras we add later. */
  type:
    | 'unlimited_approval'
    | 'authority_change'
    | 'known_malicious_address'
    | 'fresh_program';

  /** Plain-English one-liner explaining *what* was flagged. */
  detail: string;

  /** Impact severity — drives riskLevel and riskScore floors in Phase D/F. */
  severity: Severity;

  /**
   * Optional machine-readable metadata attached by detectors (e.g. which
   * specific address matched, how much was approved). Exposed in the API
   * response for dashboards/users to consume, and also used as ML features.
   */
  metadata?: Record<string, unknown>;
}

/**
 * Context passed into detectors that can't be derived purely from the
 * parsed transaction (e.g. DB-backed blocklists, or RPC-derived program
 * metadata). Keeping this as an interface means Phase D can swap in real
 * implementations without changing detector signatures.
 */
export interface DetectorContext {
  /**
   * Return true iff the given base58 address is in the malicious-address
   * blocklist (addresses, program IDs, known scammer wallets, etc.).
   */
  isBlockedAddress?: (address: string) => Promise<boolean> | boolean;

  /**
   * Return program metadata for a given program ID. If the program is not
   * known, return null so the fresh-program detector can default to
   * "unverified".
   */
  getProgramInfo?: (
    programId: string,
  ) => Promise<ProgramInfo | null> | ProgramInfo | null;
}

export interface ProgramInfo {
  programId: string;
  /** Unix seconds since epoch when the program was last deployed / upgraded. */
  deployedAt: number | null;
  /** Estimated number of transactions referencing this program (lifetime). */
  transactionCount: number | null;
  /** true if the program is in a public verified-registry (e.g. verified on solscan.io). */
  verified: boolean;
  /** Human-readable program name, if known (e.g. "Jupiter Aggregator v6"). */
  displayName?: string;
}

/** A detector function signature. */
export type Detector = (
  tx: ParsedTransaction,
  ctx?: Partial<DetectorContext>,
) => DetectionResult | null | Promise<DetectionResult | null>;
