// ML integration client.
//
// Responsibilities:
//   1. Convert a parsed transaction + detection flags into a numeric feature
//      vector the FastAPI `/score-features` endpoint can ingest.
//   2. Call the ML service (with a short timeout + fail-soft: if the service
//      is unreachable, scoring falls back to pure rule-based with `null`
//      probability so the API never fails on ML infra downtime).
//   3. Blend the rule-computed risk score with the ML probability.
//      Design:
//        - Rules set a hard FLOOR (see risk-engine.ts). ML cannot lower the
//          score below the rule floor — rules win on safety.
//        - ML acts as an *amplifier* inside the rule floor's ceiling. If
//          `riskFloor <= rawRuleScore <= 99`, ML can push the final score up
//          to `min(99, rawRuleScore + mlAdjustment)`.
//        - 100 is reserved for "definitely malicious" when/if we have a
//          deterministic signal (e.g. blocklist CRITICAL + ML ≥ 0.97).
//
// Feature vector layout (32 floats, zero-padded for forward compatibility):
//   [0]  severity of unlimited_approval flag (0..4 ; 0 = absent)
//   [1]  severity of authority_change flag      (0..4 ; 0 = absent)
//   [2]  severity of known_malicious_address    (0..4 ; 0 = absent)
//   [3]  severity of fresh_program flag         (0..4 ; 0 = absent)
//   [4]  flag count / num instructions (ratio, 0..1)
//   [5]  instruction count (normalized to 0..1 assuming max ~30 ix)
//   [6]  1 if fee payer is also an account target, else 0
//   [7]  count of referenced program ids (norm: 0..1 / 10)
//   [8]  1 if any flag is severity "critical", else 0
//   [9]  1 if any blocklist program-id match, else 0
//   [10] sum of detector base score values weighted by severity (norm 0..1 / 150)
//   [11..31] reserved (zero) for future features

import axios, { type AxiosInstance } from "axios";
import type { ParsedTransaction } from "../lib/types.js";
import type { DetectionResult, Severity } from "../detectors/types.js";

export const FEATURE_VECTOR_LEN = 32;

export interface MlScoreResult {
  probability: number | null;
  version: string | null;
  error: string | null;
  blended: boolean;
}

const SEVERITY_VALUE: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

const DETECTOR_BASE_SCORE: Record<DetectionResult["type"], number> = {
  unlimited_approval: 22,
  authority_change: 24,
  known_malicious_address: 26,
  fresh_program: 14,
};

export function buildFeatureVector(
  tx: ParsedTransaction,
  flags: DetectionResult[],
): number[] {
  const vec = new Array<number>(FEATURE_VECTOR_LEN).fill(0);

  const byType = new Map<DetectionResult["type"], DetectionResult>();
  for (const f of flags) {
    const existing = byType.get(f.type);
    if (
      !existing ||
      SEVERITY_VALUE[f.severity] > SEVERITY_VALUE[existing.severity]
    ) {
      byType.set(f.type, f);
    }
  }

  const sevOf = (t: DetectionResult["type"]) => {
    const f = byType.get(t);
    return f ? SEVERITY_VALUE[f.severity] : 0;
  };

  vec[0] = sevOf("unlimited_approval");
  vec[1] = sevOf("authority_change");
  vec[2] = sevOf("known_malicious_address");
  vec[3] = sevOf("fresh_program");

  const numIx = Math.max(tx.instructions.length, 1);
  vec[4] = Math.min(flags.length / numIx, 1);
  vec[5] = Math.min(numIx / 30, 1);

  const feePayer = tx.feePayer;
  let feePayerInAccounts = 0;
  if (feePayer) {
    for (const ix of tx.instructions) {
      if (ix.accounts.some((a) => a.pubkey === feePayer)) {
        feePayerInAccounts = 1;
        break;
      }
    }
  }
  vec[6] = feePayerInAccounts;

  vec[7] = Math.min(tx.referencedProgramIds.length / 10, 1);

  vec[8] = flags.some((f) => f.severity === "critical") ? 1 : 0;

  let hasProgramBlocklist = 0;
  for (const f of flags) {
    if (f.type !== "known_malicious_address") continue;
    const matches =
      f.metadata && Array.isArray((f.metadata as any).matches)
        ? ((f.metadata as any).matches as Array<{ address_type?: string }>)
        : [];
    if (matches.some((m) => m.address_type === "program_id")) {
      hasProgramBlocklist = 1;
      break;
    }
  }
  vec[9] = hasProgramBlocklist;

  let weighted = 0;
  for (const f of flags) {
    weighted +=
      (DETECTOR_BASE_SCORE[f.type] ?? 10) * SEVERITY_VALUE[f.severity];
  }
  vec[10] = Math.min(weighted / 150, 1);

  return vec;
}

let mlClient: AxiosInstance | null = null;

function getClient() {
  if (mlClient) return mlClient;
  const base = process.env.ML_SERVICE_URL ?? "http://localhost:8000";
  mlClient = axios.create({
    baseURL: base,
    timeout: parseInt(process.env.ML_TIMEOUT_MS ?? "1500", 10),
  });
  return mlClient;
}

export async function scoreMl(
  tx: ParsedTransaction,
  flags: DetectionResult[],
): Promise<MlScoreResult> {
  if (!process.env.ML_ENABLED || process.env.ML_ENABLED === "0") {
    return { probability: null, version: null, error: null, blended: false };
  }
  const features = buildFeatureVector(tx, flags);
  try {
    const r = await getClient().post("/score-features", { features });
    const probability =
      typeof r.data?.probability === "number" ? r.data.probability : null;
    const version = typeof r.data?.version === "string" ? r.data.version : null;
    return {
      probability,
      version,
      error: null,
      blended: probability != null,
    };
  } catch (err) {
    return {
      probability: null,
      version: null,
      error: err instanceof Error ? err.message : String(err),
      blended: false,
    };
  }
}

// Blend a rule-based score with an ML probability of maliciousness.
//
//   - Rule floor is preserved (safety first).
//   - ML adjusts the score UPWARD inside the remaining band [floor, 99].
//   - If ML probability >= 0.97 AND any critical flags exist, score reaches
//     100 — the "definitely drainer" capstone.
export function blendRuleAndMl(
  ruleScore: number,
  ruleFloor: number,
  ml: MlScoreResult,
): number {
  if (ml.probability == null) return ruleScore;
  const base = Math.max(ruleFloor, ruleScore);
  if (base >= 99) {
    if (ml.probability >= 0.97 && ruleFloor >= 75) return 100;
    return base;
  }
  const headroom = 99 - base;
  const adjusted = base + Math.round(headroom * ml.probability);
  if (ml.probability >= 0.97 && ruleFloor >= 75 && adjusted >= 99) return 100;
  return Math.max(base, Math.min(99, adjusted));
}
