/**
 * Detector #4: Fresh / unverified program interaction
 *
 * Flags interactions with programs that look "new and risky":
 *   - Deployed within the last N days (7 by default)
 *   - OR transaction count below a low threshold (10 000 by default), even
 *     if deployment date couldn't be determined
 *   - AND not present in any verified-registry list
 *
 * This is intentionally noisy by design — fresh programs should default
 * to suspicious until proven otherwise. The Phase F blending logic lets
 * the ML model soften it if the rest of the transaction looks benign.
 *
 * Deployment / volume metadata comes from `DetectorContext.getProgramInfo`.
 * In tests we inject a stub. In production it's a combo of DB cache + RPC
 * lookups (getProgramAccounts on the BPFLoaderUpgradeab... program).
 */

import type { ParsedTransaction } from '../lib/types.js';
import type { DetectionResult, DetectorContext, ProgramInfo } from './types.js';

/** If a program was deployed within 7 days, it's "fresh" no matter what. */
export const DEFAULT_FRESHNESS_SECONDS = 7 * 24 * 60 * 60;

/** Below 10k lifetime txs, a program is still unproven volume-wise. */
export const DEFAULT_MIN_TX_COUNT = 10_000;

/**
 * Well-known programs that should never be flagged (System, Token, Token2022,
 * ComputeBudget, AssociatedToken, etc.) even if metadata lookup fails.
 */
const TRUSTED_PROGRAMS = new Set<string>([
  '11111111111111111111111111111111', // System
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token2022
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // AssociatedToken
  'ComputeBudget111111111111111111111111111111', // ComputeBudget
  'SysvarRent111111111111111111111111111111111', // Rent sysvar
  'BPFLoaderUpgradeab1e11111111111111111111111', // BPF loader
]);

export interface FreshProgramHit {
  programId: string;
  reasons: string[];
  info: ProgramInfo | null;
}

export async function detectFreshPrograms(
  tx: ParsedTransaction,
  ctx: DetectorContext = {},
  opts: {
    freshnessSeconds?: number;
    minTxCount?: number;
    nowMs?: number;
  } = {},
): Promise<DetectionResult | null> {
  const freshnessSeconds = opts.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS;
  const minTxCount = opts.minTxCount ?? DEFAULT_MIN_TX_COUNT;
  const nowMs = opts.nowMs ?? Date.now();
  const getInfo = ctx.getProgramInfo;

  const hits: FreshProgramHit[] = [];

  for (const pid of tx.referencedProgramIds) {
    // Skip the obvious system-level programs — they can't be "fresh".
    if (TRUSTED_PROGRAMS.has(pid)) continue;

    const info: ProgramInfo | null = getInfo ? await getInfo(pid) : null;

    const reasons: string[] = [];
    if (!info) {
      reasons.push('no_program_metadata');
    } else {
      if (!info.verified) reasons.push('not_verified');
      if (info.deployedAt != null) {
        const ageSeconds = Math.floor(nowMs / 1000) - info.deployedAt;
        if (ageSeconds < freshnessSeconds) reasons.push(`deployed_${ageSeconds}s_ago`);
      }
      if (info.deployedAt == null) reasons.push('deployment_date_unknown');
      if (info.transactionCount != null && info.transactionCount < minTxCount) {
        reasons.push(`low_volume_${info.transactionCount}_txs`);
      }
      if (info.transactionCount == null) reasons.push('transaction_count_unknown');
    }

    // Flag if ANY suspicious reason attached AND the program is not
    // explicitly verified. (A verified program w/ low volume can still be
    // a newly launched legitimate one — we skip.)
    const looksMalicious =
      reasons.length > 0 && !(info?.verified && reasons.every((r) => r.startsWith('low_volume')));

    if (looksMalicious) {
      hits.push({ programId: pid, reasons, info });
    }
  }

  if (hits.length === 0) return null;

  // Severity ladder:
  //   - no metadata at all → MEDIUM (we simply don't know)
  //   - unverified + low-volume → HIGH
  //   - deployed within 24h + unverified → CRITICAL
  let worst: DetectionResult['severity'] = 'medium';
  for (const h of hits) {
    const recentDeploy = h.reasons.some((r) => r.startsWith('deployed_'));
    const recentlyDeployedSeconds = recentDeploy
      ? Number(h.reasons.find((r) => r.startsWith('deployed_'))!.match(/(\d+)/)![1])
      : Infinity;
    const unverified = h.reasons.includes('not_verified');
    const lowVolume = h.reasons.some((r) => r.startsWith('low_volume'));
    if (recentDeploy && recentlyDeployedSeconds < 24 * 60 * 60 && unverified) {
      worst = 'critical';
    } else if (unverified && (lowVolume || recentDeploy)) {
      worst = 'high';
    } else if (worst === 'medium') {
      worst = 'medium';
    }
  }

  const first = hits[0]!;
  const detail =
    hits.length === 1
      ? `Interacting with potentially fresh/unverified program ${first.programId} (${first.reasons.join(', ')})`
      : `${hits.length} unverified/fresh programs being invoked: ${hits.map((h) => h.programId.slice(0, 8) + '…').join(', ')}`;

  return {
    type: 'fresh_program',
    severity: worst,
    detail,
    metadata: { programs: hits, freshnessSeconds, minTxCount },
  };
}
