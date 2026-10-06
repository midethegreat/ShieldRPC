// Risk derivation: convert rule flags → riskScore (0-100), riskLevel,
// recommendation, and a plain-English explanation.
//
// Design notes for Phase D:
//   * Score is purely rule-derived today. Phase F will blend in the ML
//     probability as a per-level *adjustment* inside the rule-set floor.
//   * Each detector contributes a fixed-point bump (see SCORE_TABLE) and
//     severity multiplies the contribution:
//         low ×1, medium ×2, high ×3, critical ×4
//   * A hard-rule floor kicks in: ANY `critical`-severity flag → floor=75;
//     ANY `high` → floor=55; any flag at all → floor=10.
//   * Explanation is deterministic from the flags so the same inputs always
//     produce the same sentence (useful for tests + UX).

import type { DetectionResult, Severity } from "../detectors/types.js";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type Recommendation = "allow" | "warn" | "block";

export interface RiskOutput {
  riskScore: number; // 0-100 integer
  riskLevel: RiskLevel;
  recommendation: Recommendation;
  explanation: string;
}

export interface RiskIntermediate {
  rawScore: number;
  floor: number;
  maxSeverity: Severity;
  flags: DetectionResult[];
}

// ---------------------------------------------------------------------------
// Scoring table
// ---------------------------------------------------------------------------
const SCORE_TABLE: Record<DetectionResult["type"], number> = {
  unlimited_approval: 22,
  authority_change: 24,
  known_malicious_address: 26,
  fresh_program: 14,
};

const SEVERITY_MULTIPLIER: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const HUMAN_NAMES: Record<DetectionResult["type"], string> = {
  unlimited_approval: "an unlimited or disproportionate token approval",
  authority_change: "an authority-change transferring control of an account",
  known_malicious_address: "interaction with a known-malicious address",
  fresh_program: "interaction with a recently deployed, unverified program",
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function computeRisk(flags: DetectionResult[]): RiskOutput {
  const inter = computeRiskIntermediate(flags);
  return finalizeRisk(inter, inter.rawScore);
}

export function computeRiskIntermediate(
  flags: DetectionResult[],
): RiskIntermediate {
  if (flags.length === 0) {
    return {
      rawScore: 0,
      floor: 0,
      maxSeverity: "low",
      flags,
    };
  }

  let raw = 0;
  for (const f of flags) {
    raw += (SCORE_TABLE[f.type] ?? 10) * (SEVERITY_MULTIPLIER[f.severity] ?? 1);
  }
  const maxSeverity = pickMaxSeverity(flags.map((f) => f.severity));

  let floor = 10;
  if (maxSeverity === "high") floor = 55;
  if (maxSeverity === "critical") floor = 75;

  const rawScore = Math.min(99, Math.max(floor, Math.round(raw)));
  return { rawScore, floor, maxSeverity, flags };
}

export function finalizeRisk(
  inter: RiskIntermediate,
  finalScore: number,
): RiskOutput {
  const { maxSeverity, flags } = inter;
  const riskScore = Math.max(0, Math.min(100, Math.round(finalScore)));
  const riskLevel = scoreToLevel(riskScore, maxSeverity);
  const recommendation = levelToRecommendation(riskLevel, flags);
  const explanation = buildExplanation(flags, riskLevel, recommendation);
  return { riskScore, riskLevel, recommendation, explanation };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function scoreToLevel(score: number, maxSeverity: Severity): RiskLevel {
  // Severity can "upgrade" the level even if the numeric score is low:
  // e.g. a single critical detector always means at least 'critical' level.
  if (score >= 85 || maxSeverity === "critical") return "critical";
  if (score >= 60 || maxSeverity === "high") return "high";
  if (score >= 30 || maxSeverity === "medium") return "medium";
  return "low";
}

function levelToRecommendation(
  level: RiskLevel,
  flags: DetectionResult[],
): Recommendation {
  if (level === "critical") return "block";
  if (level === "high") return "block";
  if (level === "medium") return "warn";
  // low
  const hasAny = flags.length > 0;
  return hasAny ? "warn" : "allow";
}

function pickMaxSeverity(items: Severity[]): Severity {
  const order: Severity[] = ["low", "medium", "high", "critical"];
  let best: Severity = "low";
  for (const s of items) {
    if (order.indexOf(s) > order.indexOf(best)) best = s;
  }
  return best;
}

function buildExplanation(
  flags: DetectionResult[],
  level: RiskLevel,
  recommendation: Recommendation,
): string {
  const uniqueTypes = Array.from(new Set(flags.map((f) => f.type)));
  const parts = uniqueTypes.map((t) => HUMAN_NAMES[t] ?? t);
  const patternPhrase =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? `${parts[0]} and ${parts[1]}`
        : `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;

  const severityPhrase =
    level === "critical"
      ? "This is a strong indicator of a drainer or theft attempt"
      : level === "high"
        ? "This combination is frequently seen in drainer transactions"
        : level === "medium"
          ? "This pattern raises suspicion and is worth verifying"
          : "This pattern is unusual";

  const advice =
    recommendation === "block"
      ? "We recommend rejecting this transaction and verifying the site/app that requested it."
      : recommendation === "warn"
        ? "Review the accounts and amounts carefully before signing."
        : "Looks standard; proceed if you initiated this action.";

  return `${severityPhrase}: we detected ${patternPhrase}. ${advice}`;
}
