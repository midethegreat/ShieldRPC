/**
 * Convenience barrel + aggregate runner: runs all 4 MVP detectors on a
 * single parsed transaction and returns the array of detection results
 * (order-independent, no deduplication — the same address can show up in
 * both the blocklist detector and the approval detector if it's a known
 * scammer delegate; that's a feature, not a bug).
 */

import type { ParsedTransaction } from '../lib/types.js';
import type { DetectionResult, DetectorContext } from './types.js';
import { detectUnlimitedApproval } from './unlimited-approval.js';
import { detectAuthorityChange } from './authority-change.js';
import { detectKnownMaliciousAddresses } from './known-malicious.js';
import { detectFreshPrograms } from './fresh-program.js';

export * from './types.js';
export { detectUnlimitedApproval } from './unlimited-approval.js';
export { detectAuthorityChange } from './authority-change.js';
export { detectKnownMaliciousAddresses } from './known-malicious.js';
export { detectFreshPrograms } from './fresh-program.js';

export async function runAllDetectors(
  tx: ParsedTransaction,
  ctx: DetectorContext = {},
): Promise<DetectionResult[]> {
  const results: DetectionResult[] = [];

  // Sync detectors first (cheap)
  const approval = detectUnlimitedApproval(tx);
  if (approval) results.push(approval);
  const auth = detectAuthorityChange(tx);
  if (auth) results.push(auth);

  // Async detectors (DB / RPC lookups) in parallel
  const [malicious, fresh] = await Promise.all([
    detectKnownMaliciousAddresses(tx, ctx),
    detectFreshPrograms(tx, ctx),
  ]);
  if (malicious) results.push(malicious);
  if (fresh) results.push(fresh);

  return results;
}
