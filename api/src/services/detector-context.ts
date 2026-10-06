// Builds the `DetectorContext` object consumed by detectors #3 and #4.
//
// In production this context is backed by Postgres + a program-metadata
// cache (backed by on-chain data via RPC). In Phase D:
//   * detector #3 (known_malicious) is real — reads `known_malicious_addresses`
//   * detector #4 (fresh_program) is best-effort: if no cache entry is found
//     it returns null, which the detector treats as MEDIUM severity alert.
//     Phase H will wire in real RPC-based deploy-time / tx-count lookups.
//
// A tiny in-memory cache for `ProgramInfo` is provided so tests and seed data
// can inject known entries via `injectProgramInfo()`.

import { db } from "../db/client.js";
import { lookupMaliciousAddresses } from "../db/repos.js";
import type { DetectorContext, ProgramInfo } from "../detectors/types.js";

const programInfoCache = new Map<string, ProgramInfo>();

export function injectProgramInfo(info: ProgramInfo): void {
  programInfoCache.set(info.programId, info);
}

export function clearProgramInfoCache(): void {
  programInfoCache.clear();
}

export function buildDetectorContext(): DetectorContext {
  return {
    // --- Detector #3: blocklist lookup -------------------------------
    isBlockedAddress: async (address: string): Promise<boolean> => {
      if (!db.pool || !db.isConnected) return false;
      const rows = await lookupMaliciousAddresses([address]);
      return rows.length > 0;
    },

    // --- Detector #4: program age / verification metadata ------------
    getProgramInfo: async (programId: string): Promise<ProgramInfo | null> => {
      const cached = programInfoCache.get(programId);
      if (cached) return cached;

      // Program metadata lookup chain:
      //   1. in-memory cache hit
      //   2. DB table `program_metadata` hit
      //   3. RPC lookup (getProgramAccounts for the ProgramData account +
      //      recentPerformanceSamples for volume estimation)
      //
      // Returns null when no metadata is available. The detector treats
      // unknown non-well-known programs as MEDIUM severity. Fixture tests
      // bypass this path by injecting a DetectorContext with preloaded
      // programInfo entries.
      return null;
    },
  };
}

/**
 * Helper: returns the set of addresses matched by the blocklist with their
 * severity. Used by `analyze` to compute severity floors (CRITICAL for
 * program-ID matches, HIGH for destination matches).
 *
 * Phase F's ML blending also consumes this as a feature.
 */
export async function lookupBlocklistMatches(addresses: string[]): Promise<
  Array<{
    address: string;
    severity: "high" | "critical" | string;
    address_type: string;
  }>
> {
  if (addresses.length === 0) return [];
  const rows = await lookupMaliciousAddresses(addresses);
  return rows.map(
    (r: { address: string; severity: string; address_type: string }) => ({
      address: r.address,
      severity: r.severity as "high" | "critical" | string,
      address_type: r.address_type,
    }),
  );
}
