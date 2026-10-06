/**
 * Detector #3: Known malicious address match
 *
 * Cross-checks every suspicious destination-like address in the parsed
 * transaction against a blocklist. Blocklist membership is provided by the
 * `DetectorContext.isBlockedAddress` callback (which, in production, reads
 * from `known_malicious_addresses` table in Postgres). For tests/fixtures
 * the caller injects a simple Set-based stub.
 *
 * The lookup runs against BOTH:
 *   - all referenced program IDs (so we catch "interacts with known
 *     drainer program")
 *   - all "destination addresses" emitted by the parser (delegates,
 *     transfer recipients, newAuthorities)
 */

import type { ParsedTransaction } from '../lib/types.js';
import type { DetectionResult, DetectorContext } from './types.js';

export interface MaliciousMatch {
  address: string;
  /** Where in the transaction this address appeared. */
  role: 'program_id' | 'destination';
}

export async function detectKnownMaliciousAddresses(
  tx: ParsedTransaction,
  ctx: DetectorContext = {},
): Promise<DetectionResult | null> {
  const isBlocked = ctx.isBlockedAddress;
  if (!isBlocked) return null; // no blocklist available → skip

  const candidates: MaliciousMatch[] = [
    ...tx.referencedProgramIds.map((pid) => ({ address: pid, role: 'program_id' as const })),
    ...tx.destinationAddresses.map((a) => ({ address: a, role: 'destination' as const })),
  ];

  const matches: MaliciousMatch[] = [];
  for (const c of candidates) {
    // Support both sync and async callbacks (DB queries are async).
    // eslint-disable-next-line no-await-in-loop
    const blocked = await isBlocked(c.address);
    if (blocked) matches.push(c);
  }
  if (matches.length === 0) return null;

  // Severity: known malicious program ID is CRITICAL (user is about to
  // run known-bad code). A known destination is HIGH (known drainer wallet).
  const hasProgramHit = matches.some((m) => m.role === 'program_id');
  const severity: DetectionResult['severity'] = hasProgramHit ? 'critical' : 'high';

  const first = matches[0]!;
  const detail =
    matches.length === 1
      ? `Known malicious ${first.role} detected: ${first.address}`
      : `${matches.length} known malicious addresses detected (${matches.filter((m) => m.role === 'program_id').length} programs, ${matches.filter((m) => m.role === 'destination').length} destinations)`;

  return {
    type: 'known_malicious_address',
    severity,
    detail,
    metadata: { matches },
  };
}
