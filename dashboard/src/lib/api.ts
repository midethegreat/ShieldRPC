import axios from "axios";

export interface DetectionFlag {
  type:
    | "unlimited_approval"
    | "authority_change"
    | "known_malicious_address"
    | "fresh_program";
  detail: string;
  severity: "low" | "medium" | "high" | "critical";
  metadata?: unknown;
}

export interface AnalyzeResponse {
  riskScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  recommendation: "allow" | "warn" | "block";
  explanation: string;
  transactionHash: string;
  signature: string | null;
  network: string;
  flags: DetectionFlag[];
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

export interface StoredTransactionSummary {
  id: number;
  network: string;
  signature: string | null;
  transactionHash: string;
  feePayer: string | null;
  riskScore: number;
  riskLevel: "low" | "medium" | "high" | "critical";
  recommendation: "allow" | "warn" | "block";
  explanation: string;
  flags: DetectionFlag[];
  createdAt: string;
}

export interface StoredTransactionDetail extends StoredTransactionSummary {
  serializedTransaction: string | null;
}

export interface FeedbackResponse {
  id: number;
  scoredTransactionId: number;
  feedbackType: "false_positive" | "false_negative" | "note";
  comment: string | null;
  reporter: string | null;
  createdAt: string;
}

export interface HealthResponse {
  status: string;
  service: string;
  version: string;
  timestamp: string;
  network?: string;
  database?: {
    connected: boolean;
    connectionStringSet: boolean;
    lastError: string | null;
  };
}

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";
const client = axios.create({ baseURL: API_BASE, timeout: 15_000 });

export async function getHealth(): Promise<HealthResponse> {
  const r = await client.get("/health");
  return r.data as HealthResponse;
}

export async function analyzeTransaction(opts: {
  serializedTransaction: string;
  network?: "mainnet-beta" | "devnet" | "testnet";
}): Promise<AnalyzeResponse> {
  const r = await client.post("/analyze-transaction", {
    serializedTransaction: opts.serializedTransaction,
    network: opts.network ?? "mainnet-beta",
  });
  return r.data as AnalyzeResponse;
}

export async function listTransactions(limit = 50): Promise<{
  ok: boolean;
  count: number;
  dbConnected: boolean;
  transactions: StoredTransactionSummary[];
}> {
  const r = await client.get("/transactions", { params: { limit } });
  return r.data;
}

export async function getTransaction(id: number): Promise<{
  ok: boolean;
  dbConnected: boolean;
  transaction: StoredTransactionDetail;
}> {
  const r = await client.get(`/transactions/${id}`);
  return r.data;
}

export async function fetchTransactionByHash(hash: string): Promise<{
  ok: boolean;
  dbConnected: boolean;
  transaction: StoredTransactionDetail;
}> {
  const r = await client.get(`/v1/transactions/${encodeURIComponent(hash)}`);
  return r.data;
}

export async function submitFeedback(opts: {
  scoredTransactionId: number;
  feedbackType: "false_positive" | "false_negative" | "note";
  comment?: string | null;
  reporter?: string | null;
}): Promise<{ ok: boolean; dbConnected: boolean; feedback: FeedbackResponse }> {
  try {
    const r = await client.post("/feedback", opts);
    return r.data;
  } catch (e: unknown) {
    const err = e as {
      response?: { status?: number; data?: { error?: string; ok?: boolean } };
      message?: string;
    };
    const code =
      typeof err.response?.data?.error === "string"
        ? err.response.data.error
        : err.response?.status === 503
          ? "db_unavailable"
          : err.response?.status === 400
            ? "invalid_request"
            : "network_error";
    const friendly: Record<string, string> = {
      db_unavailable:
        "Database not connected — feedback will be resubmitted when persistence is available.",
      insert_failed:
        "Could not save feedback right now. Try again in a moment.",
      invalid_request:
        "Invalid submission. Check the fields and try again.",
      network_error:
        "Could not reach the API. Check your connection and try again.",
    };
    const wrapped = new Error(friendly[code] ?? err.message ?? "Feedback failed");
    (wrapped as Error & { code?: string }).code = code;
    (wrapped as Error & { status?: number }).status = err.response?.status;
    throw wrapped;
  }
}
