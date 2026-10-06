// Thin data-access layer for the three Phase-D tables.
//
// All functions are non-throwing: if the DB is unavailable they resolve to
// `null` instead of rejecting. This keeps the API online even when Postgres
// is still warming up locally / on Render free tier.

import crypto from "node:crypto";
import { db } from "./client.js";
import type { DetectionResult } from "../detectors/types.js";
import type { RiskOutput } from "../services/risk-engine.js";

export interface StoredScoredTransaction {
  id: number;
  network: string;
  signature: string | null;
  transaction_hash: string;
  fee_payer: string | null;
  risk_score: number;
  risk_level: string;
  recommendation: string;
  explanation: string;
  flags: unknown;
  serialized_transaction: string | null;
  created_at: Date;
}

export interface KnownMaliciousAddressRecord {
  id: number;
  address: string;
  address_type: string;
  tag: string | null;
  severity: string;
  source: string | null;
}

export interface FeedbackRecord {
  id: number;
  scored_transaction_id: number;
  feedback_type: string;
  comment: string | null;
  reporter: string | null;
  created_at: Date;
  retraining_status?: string;
  model_version?: string | null;
}

export interface ProgramMetadataRecord {
  id: number;
  program_id: string;
  deployed_at: number | null;
  transaction_count: number | null;
  verified: boolean;
  display_name: string | null;
  source: string | null;
  fetched_at: Date;
}

// ---------------------------------------------------------------------------
// scored_transactions
// ---------------------------------------------------------------------------

/** Stable sha256 of serialized transaction bytes (base64 input → raw bytes → hash). */
export function hashTransaction(serializedB64: string): string {
  const bytes = Buffer.from(serializedB64, "base64");
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function insertScoredTransaction(args: {
  network: string;
  signature: string | null;
  feePayer: string | null;
  serializedTransaction: string;
  flags: DetectionResult[];
  risk: RiskOutput;
}): Promise<StoredScoredTransaction | null> {
  if (!db.pool || !db.isConnected) return null;
  const transaction_hash = hashTransaction(args.serializedTransaction);
  try {
    const res = await db.pool.query<StoredScoredTransaction>(
      `
      INSERT INTO scored_transactions
        (network, signature, transaction_hash, fee_payer, risk_score, risk_level,
         recommendation, explanation, flags, serialized_transaction)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
      RETURNING *
      `,
      [
        args.network,
        args.signature,
        transaction_hash,
        args.feePayer,
        args.risk.riskScore,
        args.risk.riskLevel,
        args.risk.recommendation,
        args.risk.explanation,
        JSON.stringify(args.flags),
        args.serializedTransaction,
      ],
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function listRecentScoredTransactions(
  limit = 50,
): Promise<StoredScoredTransaction[]> {
  if (!db.pool || !db.isConnected) return [];
  try {
    const res = await db.pool.query<StoredScoredTransaction>(
      `SELECT * FROM scored_transactions ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return res.rows;
  } catch {
    return [];
  }
}

export async function getScoredTransactionById(
  id: number,
): Promise<StoredScoredTransaction | null> {
  if (!db.pool || !db.isConnected) return null;
  try {
    const res = await db.pool.query<StoredScoredTransaction>(
      `SELECT * FROM scored_transactions WHERE id = $1 LIMIT 1`,
      [id],
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function getScoredTransactionByHash(
  hash: string,
): Promise<StoredScoredTransaction | null> {
  if (!db.pool || !db.isConnected) return null;
  try {
    const res = await db.pool.query<StoredScoredTransaction>(
      `SELECT * FROM scored_transactions WHERE transaction_hash = $1 OR signature = $1 LIMIT 1`,
      [hash],
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// known_malicious_addresses
// ---------------------------------------------------------------------------

/** Returns matching records for `address` — case-sensitive exact match on base58. */
export async function lookupMaliciousAddresses(
  addresses: string[],
): Promise<KnownMaliciousAddressRecord[]> {
  if (!db.pool || !db.isConnected || addresses.length === 0) return [];
  try {
    const placeholders = addresses.map((_, i) => `$${i + 1}`).join(",");
    const res = await db.pool.query<KnownMaliciousAddressRecord>(
      `SELECT * FROM known_malicious_addresses WHERE address IN (${placeholders})`,
      addresses,
    );
    return res.rows;
  } catch {
    return [];
  }
}

export async function upsertKnownMalicious(
  rows: Array<{
    address: string;
    address_type?: "program_id" | "wallet" | "token_mint" | "other";
    tag?: string | null;
    severity?: "high" | "critical";
    source?: string | null;
  }>,
): Promise<number> {
  if (!db.pool || !db.isConnected || rows.length === 0) return 0;
  try {
    let affected = 0;
    for (const r of rows) {
      const res = await db.pool.query<KnownMaliciousAddressRecord>(
        `
        INSERT INTO known_malicious_addresses
          (address, address_type, tag, severity, source)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (address) DO UPDATE SET
          address_type = EXCLUDED.address_type,
          tag          = COALESCE(EXCLUDED.tag, known_malicious_addresses.tag),
          severity     = EXCLUDED.severity,
          source       = COALESCE(EXCLUDED.source, known_malicious_addresses.source)
        RETURNING id
        `,
        [
          r.address,
          r.address_type ?? "wallet",
          r.tag ?? null,
          r.severity ?? "high",
          r.source ?? null,
        ],
      );
      if (res.rowCount && res.rowCount > 0) affected += res.rowCount;
    }
    return affected;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// program_metadata
// ---------------------------------------------------------------------------

export async function insertProgramMetadata(args: {
  program_id: string;
  deployed_at?: number | null;
  transaction_count?: number | null;
  verified?: boolean;
  display_name?: string | null;
  source?: string | null;
}): Promise<ProgramMetadataRecord | null> {
  if (!db.pool || !db.isConnected) return null;
  try {
    const res = await db.pool.query<ProgramMetadataRecord>(
      `
      INSERT INTO program_metadata
        (program_id, deployed_at, transaction_count, verified, display_name, source)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [
        args.program_id,
        args.deployed_at ?? null,
        args.transaction_count ?? null,
        args.verified ?? false,
        args.display_name ?? null,
        args.source ?? null,
      ],
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function getProgramMetadata(
  programId: string,
): Promise<ProgramMetadataRecord | null> {
  if (!db.pool || !db.isConnected) return null;
  try {
    const res = await db.pool.query<ProgramMetadataRecord>(
      `SELECT * FROM program_metadata WHERE program_id = $1 LIMIT 1`,
      [programId],
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function upsertProgramMetadata(row: {
  program_id: string;
  deployed_at?: number | null;
  transaction_count?: number | null;
  verified?: boolean;
  display_name?: string | null;
  source?: string | null;
}): Promise<number> {
  if (!db.pool || !db.isConnected) return 0;
  try {
    const res = await db.pool.query<ProgramMetadataRecord>(
      `
      INSERT INTO program_metadata
        (program_id, deployed_at, transaction_count, verified, display_name, source, fetched_at)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (program_id) DO UPDATE SET
        deployed_at       = EXCLUDED.deployed_at,
        transaction_count = CASE
          WHEN EXCLUDED.transaction_count IS NOT NULL
            AND (program_metadata.transaction_count IS NULL
                 OR EXCLUDED.transaction_count > program_metadata.transaction_count)
          THEN EXCLUDED.transaction_count
          ELSE program_metadata.transaction_count
        END,
        verified          = (EXCLUDED.verified OR program_metadata.verified),
        display_name      = COALESCE(EXCLUDED.display_name, program_metadata.display_name),
        source            = COALESCE(EXCLUDED.source, program_metadata.source),
        fetched_at        = NOW()
      RETURNING id
      `,
      [
        row.program_id,
        row.deployed_at ?? null,
        row.transaction_count ?? null,
        row.verified ?? false,
        row.display_name ?? null,
        row.source ?? null,
      ],
    );
    return res.rowCount ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------

export async function insertFeedback(args: {
  scoredTransactionId: number;
  feedbackType: "false_positive" | "false_negative" | "note";
  comment?: string | null;
  reporter?: string | null;
}): Promise<FeedbackRecord | null> {
  if (!db.pool || !db.isConnected) return null;
  try {
    const res = await db.pool.query<FeedbackRecord>(
      `
      INSERT INTO feedback (scored_transaction_id, feedback_type, comment, reporter)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [
        args.scoredTransactionId,
        args.feedbackType,
        args.comment ?? null,
        args.reporter ?? null,
      ],
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function setFeedbackRetrainingStatus(
  id: number,
  status: string,
  modelVersion?: string | null,
): Promise<FeedbackRecord | null> {
  if (!db.pool || !db.isConnected) return null;
  try {
    const res = await db.pool.query<FeedbackRecord>(
      `
      UPDATE feedback
      SET retraining_status = $1,
          model_version     = $2
      WHERE id = $3
      RETURNING *
      `,
      [status, modelVersion ?? null, id],
    );
    return res.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function exportFeedback(
  feedbackType?: string,
): Promise<Array<{ feedback: FeedbackRecord; tx: StoredScoredTransaction }>> {
  if (!db.pool || !db.isConnected) return [];
  try {
    const whereClause = feedbackType ? `WHERE feedback.feedback_type = $1` : ``;
    const params = feedbackType ? [feedbackType] : [];
    const res = await db.pool.query<{ feedback: FeedbackRecord; tx: StoredScoredTransaction }>(
      `
      SELECT
        json_build_object(
          'id', feedback.id,
          'scored_transaction_id', feedback.scored_transaction_id,
          'feedback_type', feedback.feedback_type,
          'comment', feedback.comment,
          'reporter', feedback.reporter,
          'created_at', feedback.created_at,
          'retraining_status', feedback.retraining_status,
          'model_version', feedback.model_version
        ) AS feedback,
        json_build_object(
          'id', scored_transactions.id,
          'network', scored_transactions.network,
          'signature', scored_transactions.signature,
          'transaction_hash', scored_transactions.transaction_hash,
          'fee_payer', scored_transactions.fee_payer,
          'risk_score', scored_transactions.risk_score,
          'risk_level', scored_transactions.risk_level,
          'recommendation', scored_transactions.recommendation,
          'explanation', scored_transactions.explanation,
          'flags', scored_transactions.flags,
          'serialized_transaction', scored_transactions.serialized_transaction,
          'created_at', scored_transactions.created_at
        ) AS tx
      FROM feedback
      LEFT JOIN scored_transactions ON feedback.scored_transaction_id = scored_transactions.id
      ${whereClause}
      ORDER BY feedback.created_at DESC
      `,
      params,
    );
    return res.rows;
  } catch {
    return [];
  }
}
