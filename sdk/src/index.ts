import { Transaction, VersionedTransaction } from '@solana/web3.js';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Recommendation = 'allow' | 'warn' | 'block';

export interface RiskFlag {
  type: string;
  detail: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface AnalyzeResult {
  riskScore: number;
  riskLevel: RiskLevel;
  flags: RiskFlag[];
  explanation: string;
  recommendation: Recommendation;
  network?: string;
}

export interface ShieldRPCOptions {
  apiBaseUrl?: string;
  timeoutMs?: number;
  defaultNetwork?: string;
  /**
   * If true, SDK throws on network failure.
   * If false (default), the SDK returns a synthetic `critical` result so callers
   * never silently treat an unreachable API as "safe".
   */
  throwOnFailure?: boolean;
}

const DEFAULT_BASE = 'http://localhost:3001';
const DEFAULT_TIMEOUT = 5000;

export class ShieldRPC {
  private baseUrl: string;
  private timeoutMs: number;
  private defaultNetwork: string;
  private throwOnFailure: boolean;

  constructor(options: ShieldRPCOptions = {}) {
    this.baseUrl = options.apiBaseUrl || DEFAULT_BASE;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT;
    this.defaultNetwork = options.defaultNetwork || 'mainnet-beta';
    this.throwOnFailure = options.throwOnFailure || false;
  }

  /**
   * Analyze a Solana transaction for risk.
   *
   * Accepts either a `Transaction`, `VersionedTransaction`, or a
   * base64-encoded serialized transaction string.
   */
  async analyzeTransaction(
    transaction: Transaction | VersionedTransaction | Uint8Array | string,
    options?: { network?: string }
  ): Promise<AnalyzeResult> {
    const serialized = this.serialize(transaction);
    const network = options?.network || this.defaultNetwork;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const resp = await fetch(`${this.baseUrl}/v1/analyze-transaction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serializedTransaction: serialized, network }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        throw new Error(`ShieldRPC API error: HTTP ${resp.status}`);
      }

      return (await resp.json()) as AnalyzeResult;
    } catch (err) {
      if (this.throwOnFailure) throw err;
      const message = err instanceof Error ? err.message : String(err);
      return {
        riskScore: 99,
        riskLevel: 'critical',
        flags: [
          {
            type: 'api_unreachable',
            detail: `ShieldRPC service unavailable: ${message}. Treating as unsafe.`,
            severity: 'critical',
          },
        ],
        explanation:
          'The ShieldRPC risk-scoring service could not be reached. For safety, this transaction is flagged as critical risk until a real analysis is performed.',
        recommendation: 'warn',
        network,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private serialize(tx: Transaction | VersionedTransaction | Uint8Array | string): string {
    if (typeof tx === 'string') return tx;
    if (tx instanceof Uint8Array) {
      return Buffer.from(tx).toString('base64');
    }
    if ('serialize' in tx && typeof (tx as any).serialize === 'function') {
      const bytes: Uint8Array = (tx as any).serialize();
      return Buffer.from(bytes).toString('base64');
    }
    throw new TypeError('Unsupported transaction type passed to ShieldRPC.analyzeTransaction');
  }
}
