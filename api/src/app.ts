import express from "express";
import cors from "cors";
import { z } from "zod";
import { parseTransaction, Network } from "./lib/index.js";
import { runAllDetectors } from "./detectors/index.js";
import type { DetectionResult, DetectorContext } from "./detectors/types.js";
import {
  computeRisk,
  computeRiskIntermediate,
  finalizeRisk,
  RiskOutput,
} from "./services/risk-engine.js";
import { insertScoredTransaction, hashTransaction } from "./db/repos.js";
import {
  buildDetectorContext,
  lookupBlocklistMatches,
} from "./services/detector-context.js";
import { initDb, closeDb, db as dbState, loadSchemaSql } from "./db/client.js";
import {
  upsertKnownMalicious,
  listRecentScoredTransactions,
  getScoredTransactionById,
  insertFeedback,
} from "./db/repos.js";
import {
  scoreMl,
  blendRuleAndMl,
  type MlScoreResult,
} from "./services/ml-client.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import {
  sendError,
  notFoundHandler,
  globalErrorHandler,
} from "./middleware/error-envelope.js";
import { authMiddleware } from "./middleware/auth.js";
import { globalRateLimit, analyzeRateLimit } from "./middleware/rate-limit.js";

export interface AppOptions {
  detectorContext?: DetectorContext;
}

const analyzeBody = z.object({
  serializedTransaction: z.string({
    required_error: "serializedTransaction (base64) is required",
  }),
  network: z
    .enum(["mainnet-beta", "devnet", "testnet"])
    .default("mainnet-beta"),
});

const listTxsQuery = z.object({
  limit: z
    .string()
    .optional()
    .transform((v) => (v ? Math.min(Math.max(parseInt(v, 10), 1), 500) : 50)),
});

const feedbackBody = z.object({
  scoredTransactionId: z.number().int().positive(),
  feedbackType: z.enum(["false_positive", "false_negative", "note"]),
  comment: z.string().max(2000).optional().nullable(),
  reporter: z.string().max(255).optional().nullable(),
});

export interface AnalyzeResponse extends RiskOutput {
  transactionHash: string;
  signature: string | null;
  network: Network;
  flags: DetectionResult[];
  storedTransactionId: number | null;
  dbConnected: boolean;
  ml: {
    enabled: boolean;
    blended: boolean;
    probability: number | null;
    version: string | null;
    error: string | null;
  };
}

export type App = express.Express;

export function createApp(opts: AppOptions = {}): express.Express {
  const app = express();

  app.use(requestIdMiddleware);
  app.use(globalRateLimit);
  app.use(cors());
  app.use((req, res, next) => {
    express.json({ limit: "2mb" })(req, res, (err) => {
      if (err) return next(err);
      next();
    });
  });
  app.use(authMiddleware);

  app.get("/v1/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "shieldrpc-api",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
      network: process.env.NETWORK || "mainnet-beta",
      database: {
        connected: dbState.isConnected,
        connectionStringSet: !!process.env.DATABASE_URL,
        lastError: dbState.initializationError,
      },
    });
  });

  app.post("/v1/db/apply-schema", async (req, res): Promise<void> => {
    if (!dbState.pool || !dbState.isConnected) {
      sendError(res, 503, "db_unavailable", "database not connected", req.requestId);
      return;
    }
    try {
      await dbState.pool.query(loadSchemaSql());
      res.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 500, "internal_error", message, req.requestId);
    }
  });

  app.post("/v1/analyze-transaction", analyzeRateLimit, async (req, res): Promise<void> => {
    const body = analyzeBody.safeParse(req.body ?? {});
    if (!body.success) {
      sendError(res, 400, "invalid_request", "Invalid request body", req.requestId, {
        issues: body.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const { serializedTransaction, network } = body.data;

    let parsed;
    try {
      parsed = parseTransaction(serializedTransaction, { network });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendError(res, 422, "invalid_transaction", message, req.requestId);
      return;
    }

    const ctx = opts.detectorContext ?? buildDetectorContext();

    const flags = await runAllDetectors(parsed, ctx);

    {
      const matched = await lookupBlocklistMatches(
        parsed.referencedProgramIds.concat(parsed.destinationAddresses),
      );
      for (const m of matched) {
        if (m.address_type === "program_id" && m.severity === "critical") {
          const flag = flags.find(
            (f: DetectionResult) =>
              f.type === "known_malicious_address" &&
              (
                f.metadata?.matches as Array<{ address: string }> | undefined
              )?.some((x) => x.address === m.address),
          );
          if (flag) flag.severity = "critical";
        }
      }
    }

    const ruleInter = computeRiskIntermediate(flags);
    const mlResult: MlScoreResult = await scoreMl(parsed, flags);
    const blendedScore = blendRuleAndMl(
      ruleInter.rawScore,
      ruleInter.floor,
      mlResult,
    );
    const risk = finalizeRisk(ruleInter, blendedScore);

    const signature = parsed.signatures[0] ?? null;
    const stored = await insertScoredTransaction({
      network,
      signature,
      feePayer: parsed.feePayer,
      serializedTransaction,
      flags,
      risk,
    });

    const response: AnalyzeResponse = {
      transactionHash: hashTransaction(serializedTransaction),
      signature,
      network,
      riskScore: risk.riskScore,
      riskLevel: risk.riskLevel,
      recommendation: risk.recommendation,
      explanation: risk.explanation,
      flags,
      storedTransactionId: stored?.id ?? null,
      dbConnected: dbState.isConnected,
      ml: {
        enabled: process.env.ML_ENABLED !== "0" && !!process.env.ML_ENABLED,
        blended: mlResult.blended,
        probability: mlResult.probability,
        version: mlResult.version,
        error: mlResult.error,
      },
    };
    res.json(response);
  });

  app.get("/v1/transactions", async (req, res): Promise<void> => {
    const q = listTxsQuery.safeParse(req.query ?? {});
    const limit = q.success ? q.data.limit : 50;
    const rows = await listRecentScoredTransactions(limit);
    res.json({
      ok: true,
      count: rows.length,
      dbConnected: dbState.isConnected,
      transactions: rows.map((r) => ({
        id: r.id,
        network: r.network,
        signature: r.signature,
        transactionHash: r.transaction_hash,
        feePayer: r.fee_payer,
        riskScore: r.risk_score,
        riskLevel: r.risk_level,
        recommendation: r.recommendation,
        explanation: r.explanation,
        flags: r.flags as DetectionResult[],
        createdAt: r.created_at.toISOString(),
      })),
    });
  });

  app.get("/v1/transactions/:id", async (req, res): Promise<void> => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      sendError(res, 400, "invalid_request", "invalid id", req.requestId);
      return;
    }
    const r = await getScoredTransactionById(id);
    if (!r) {
      sendError(res, 404, "not_found", "Transaction not found", req.requestId);
      return;
    }
    res.json({
      ok: true,
      dbConnected: dbState.isConnected,
      transaction: {
        id: r.id,
        network: r.network,
        signature: r.signature,
        transactionHash: r.transaction_hash,
        feePayer: r.fee_payer,
        riskScore: r.risk_score,
        riskLevel: r.risk_level,
        recommendation: r.recommendation,
        explanation: r.explanation,
        flags: r.flags as DetectionResult[],
        serializedTransaction: r.serialized_transaction,
        createdAt: r.created_at.toISOString(),
      },
    });
  });

  app.post("/v1/feedback", async (req, res): Promise<void> => {
    const body = feedbackBody.safeParse(req.body ?? {});
    if (!body.success) {
      sendError(res, 400, "invalid_request", "Invalid request body", req.requestId, {
        issues: body.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const row = await insertFeedback({
      scoredTransactionId: body.data.scoredTransactionId,
      feedbackType: body.data.feedbackType,
      comment: body.data.comment ?? null,
      reporter: body.data.reporter ?? null,
    });
    if (!row) {
      const err = dbState.isConnected ? "insert_failed" : "db_unavailable";
      sendError(res, 503, err, dbState.isConnected ? "Feedback insert failed" : "database not connected", req.requestId);
      return;
    }
    res.json({
      ok: true,
      dbConnected: dbState.isConnected,
      feedback: {
        id: row.id,
        scoredTransactionId: row.scored_transaction_id,
        feedbackType: row.feedback_type,
        comment: row.comment,
        reporter: row.reporter,
        createdAt: row.created_at.toISOString(),
      },
    });
  });

  app.use(notFoundHandler);
  app.use(globalErrorHandler);

  return app;
}

export { initDb, closeDb, upsertKnownMalicious };
