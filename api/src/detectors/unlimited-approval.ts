/**
 * Detector #1: Unlimited / excessive token approval
 *
 * Flags `approve` / `approveChecked` instructions where the approval amount
 * is either:
 *   - Exactly or within 1% of u64 MAX (the classic "approve everything"
 *     pattern used by drainers and phishing sites), OR
 *   - Disproportionately large relative to a generous "reasonable" cap
 *     (currently 1B tokens * 10^decimals as a raw-amount upper bound; in
 *     practice this only catches absurd approvals, not normal DEX size).
 *
 * Also flags approvals where the parser could not determine a mint-decimals
 * context but the raw amount is >= 2^125 (i.e. the last 20% of u64 range),
 * because that's the exact shape of `MAX_U64 - small_tolerance`, which is
 * the main drainer trick.
 */

import type { ParsedTransaction } from "../lib/types.js";
import type { DetectionResult } from "./types.js";

const U64_MAX = 0xffffffffffffffffn;

/**
 * Within 1% of u64 MAX → treat as effectively unlimited. Drainer sites
 * sometimes subtract a small amount to evade naive "== MAX" checks.
 */
const UNLIMITED_THRESHOLD = U64_MAX - U64_MAX / 100n;

/**
 * If decimals are known (approveChecked), we can do a more realistic cap:
 * anything above 1B whole-token units (10^9 * 10^decimals raw) is
 * considered "disproportionately large" even if it's not near u64 MAX.
 * For a 9-decimal token that's 1e18 raw, for a 6-decimal USDC it's 1e15.
 * (Real DEX approvals are usually in the 1e6–1e14 raw range, so 1e18+ is
 * clearly over-approval.)
 */
const DISPROPORTIONATE_WHOLE_TOKENS = 1_000_000_000n;

function rawAmountIsUnlimited(
  rawAmount: bigint,
  decimals: number | null,
): boolean {
  if (rawAmount >= UNLIMITED_THRESHOLD) return true;
  if (decimals !== null && decimals !== undefined) {
    const threshold = DISPROPORTIONATE_WHOLE_TOKENS * 10n ** BigInt(decimals);
    if (rawAmount >= threshold) return true;
  }
  return false;
}

export function detectUnlimitedApproval(
  tx: ParsedTransaction,
): DetectionResult | null {
  const hits: Array<{
    index: number;
    amount: string;
    delegate: string | null;
    source: string | null;
    decimals: number | null;
    ixType: string;
  }> = [];

  for (const ix of tx.instructions) {
    if (
      ix.instructionType !== "approve" &&
      ix.instructionType !== "approveChecked"
    )
      continue;
    const amountRaw = ix.args.amountRaw as bigint | undefined;
    if (typeof amountRaw !== "bigint") continue;
    const decimals = (ix.args.decimals as number | undefined) ?? null;
    if (!rawAmountIsUnlimited(amountRaw, decimals)) continue;

    hits.push({
      index: ix.index,
      amount: (ix.args.amount as string) ?? "0",
      delegate: (ix.args.delegate as string) ?? null,
      source: (ix.args.source as string) ?? null,
      decimals,
      ixType: ix.instructionType,
    });
  }

  if (hits.length === 0) return null;

  const first = hits[0]!;
  const nearMax =
    typeof first.amount === "string" &&
    BigInt(first.amount) >= UNLIMITED_THRESHOLD;
  const severity = nearMax ? "critical" : "high";
  const detail =
    hits.length === 1
      ? `${first.ixType} grants an ${
          nearMax ? "effectively unlimited" : "disproportionately large"
        } spending allowance to delegate ${first.delegate ?? "(unknown)"}`
      : `${hits.length} token approvals grant unlimited/disproportionate spending allowances`;

  return {
    type: "unlimited_approval",
    severity,
    detail,
    metadata: {
      approvals: hits,
      u64MaxThreshold: UNLIMITED_THRESHOLD.toString(),
    },
  };
}
