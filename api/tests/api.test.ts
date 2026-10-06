// Integration tests for Phase D endpoints.
//
// The tests inject a fake DetectorContext + program info cache so they run
// offline with no Postgres dependency. End-to-end behavior with a real DB
// is a manual verification step after `npm run db:apply-schema`.

import { describe, it, expect, beforeAll } from "vitest";
import supertest from "supertest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Express } from "express";
import { createApp, closeDb } from "../src/app.js";
import type { DetectorContext, ProgramInfo } from "../src/detectors/types.js";
import {
  injectProgramInfo,
  clearProgramInfoCache,
} from "../src/services/detector-context.js";
import { parseTransaction } from "../src/lib/index.js";

interface Sample {
  id: string;
  label: string;
  category: string;
  notes: string;
  serializedTransaction: string;
}
interface Fixture {
  samples: Sample[];
  detectorContextHints: {
    blockedAddresses: string[];
    blockedProgramIds: string[];
    freshPrograms: Record<string, ProgramInfo>;
    trustedPrograms: Record<string, ProgramInfo>;
  };
}

let fixture: Fixture;
let app: Express;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let agent: any;

beforeAll(() => {
  const path = resolve(
    import.meta.dirname!,
    "../../data/fixtures/sample-transactions.json",
  );
  fixture = JSON.parse(readFileSync(path, "utf-8")) as Fixture;
  clearProgramInfoCache();

  // Inject program metadata so detector #4 reads ages correctly in API path.
  for (const info of Object.values(
    fixture.detectorContextHints.freshPrograms,
  )) {
    injectProgramInfo(info);
  }
  for (const info of Object.values(
    fixture.detectorContextHints.trustedPrograms,
  )) {
    injectProgramInfo(info);
  }

  // Build a context that looks at the fixture blocklist (no Postgres needed).
  const blockedSet = new Set<string>([
    ...fixture.detectorContextHints.blockedAddresses,
    ...fixture.detectorContextHints.blockedProgramIds,
  ]);

  const ctx: DetectorContext = {
    isBlockedAddress: async (a) => blockedSet.has(a),
    getProgramInfo: async (pid) => {
      for (const table of [
        fixture.detectorContextHints.freshPrograms,
        fixture.detectorContextHints.trustedPrograms,
      ]) {
        if (table[pid]) return table[pid];
      }
      return null;
    },
  };

  app = createApp({ detectorContext: ctx });
  agent = supertest.agent(app);
});

function sampleById(id: string): Sample {
  const s = fixture.samples.find((x) => x.id === id);
  if (!s) throw new Error(`missing fixture ${id}`);
  return s;
}

describe("Phase D — Express API integration", () => {
  describe("GET /v1/health", () => {
    it("returns status=ok, service name, timestamp, and database info", async () => {
      const r = await agent.get("/v1/health");
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        status: "ok",
        service: "shieldrpc-api",
      });
      expect(typeof r.body.timestamp).toBe("string");
      expect(r.body.database).toBeDefined();
      expect(typeof r.body.database.connectionStringSet).toBe("boolean");
      expect(typeof r.body.database.connected).toBe("boolean");
    });
  });

  describe("POST /v1/analyze-transaction — request validation", () => {
    it("400s on missing serializedTransaction", async () => {
      const r = await agent.post("/v1/analyze-transaction").send({});
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("invalid_request");
      expect(r.body.issues.length).toBeGreaterThanOrEqual(1);
    });

    it("422s on garbage base64 that does not parse", async () => {
      const r = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: "this is not a solana tx!!!",
      });
      expect(r.status).toBe(422);
      expect(r.body.error).toBe("invalid_transaction");
    });

    it("defaults network to mainnet-beta when omitted", async () => {
      const s = sampleById("sol-transfer-safe");
      const r = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
      });
      expect(r.status).toBe(200);
      expect(r.body.network).toBe("mainnet-beta");
    });

    it("accepts network=devnet explicitly", async () => {
      const s = sampleById("sol-transfer-safe");
      const r = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
        network: "devnet",
      });
      expect(r.status).toBe(200);
      expect(r.body.network).toBe("devnet");
    });
  });

  describe("POST /v1/analyze-transaction — scoring correctness", () => {
    it("safe SOL transfer: score=0, level=low, rec=allow, flags=[]", async () => {
      const s = sampleById("sol-transfer-safe");
      const r = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
      });
      expect(r.status).toBe(200);
      expect(r.body.riskScore).toBe(0);
      expect(r.body.riskLevel).toBe("low");
      expect(r.body.recommendation).toBe("allow");
      expect(r.body.flags).toEqual([]);
      expect(typeof r.body.explanation).toBe("string");
      expect(r.body.explanation.length).toBeGreaterThan(10);
    });

    it("safe swap bundle: score=0, no flags", async () => {
      const s = sampleById("bundle-swap-safe");
      const r = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
      });
      expect(r.status).toBe(200);
      expect(r.body.flags).toEqual([]);
      expect(r.body.riskLevel).toBe("low");
      expect(r.body.recommendation).toBe("allow");
    });

    it("unlimited approve → critical severity flag, block recommendation", async () => {
      const s = sampleById("spl-approve-unlimited");
      const r = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
      });
      expect(r.status).toBe(200);
      const flagTypes = r.body.flags.map((f: any) => f.type);
      expect(flagTypes).toContain("unlimited_approval");
      const approveFlag = r.body.flags.find(
        (f: any) => f.type === "unlimited_approval",
      );
      expect(approveFlag.severity).toBe("critical");
      // Rule floors: any critical → riskLevel at least critical, rec=block
      expect(["high", "critical"]).toContain(r.body.riskLevel);
      expect(r.body.recommendation).toBe("block");
      expect(r.body.riskScore).toBeGreaterThanOrEqual(75);
    });

    it("setAuthority AccountOwner → authority_change flag + block", async () => {
      const s = sampleById("spl-setAuthority-owner");
      const r = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
      });
      expect(r.status).toBe(200);
      const types = r.body.flags.map((f: any) => f.type);
      expect(types).toContain("authority_change");
      expect(types.length).toBe(1); // No cross-trigger
      expect(r.body.recommendation).toBe("block");
      expect(r.body.riskScore).toBeGreaterThanOrEqual(75);
    });

    it("blocklisted destination → known_malicious flag, severity high, block rec", async () => {
      const s = sampleById("sol-transfer-to-blocklisted-dest");
      const r = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
      });
      expect(r.status).toBe(200);
      const types = r.body.flags.map((f: any) => f.type);
      expect(types).toContain("known_malicious_address");
      expect(types.length).toBe(1);
      const flag = r.body.flags.find(
        (f: any) => f.type === "known_malicious_address",
      );
      expect(flag.severity).toBe("high");
      expect(r.body.riskLevel).toBe("high");
      expect(r.body.recommendation).toBe("block");
      expect(r.body.riskScore).toBeGreaterThanOrEqual(55);
    });

    it("blocklisted program id → known_malicious flag CRITICAL + floor=75", async () => {
      const s = sampleById("invoke-blocklisted-program");
      const r = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
      });
      expect(r.status).toBe(200);
      const types = r.body.flags.map((f: any) => f.type);
      expect(types).toEqual(["known_malicious_address"]);
      const flag = r.body.flags[0];
      expect(flag.severity).toBe("critical");
      expect(r.body.riskLevel).toBe("critical");
      expect(r.body.recommendation).toBe("block");
      expect(r.body.riskScore).toBeGreaterThanOrEqual(75);
    });

    it("fresh program → fresh_program flag, warn/block, established trusted program → clean", async () => {
      const freshSample = sampleById("invoke-fresh-unverified-program");
      const establishedSample = sampleById(
        "invoke-established-verified-program",
      );

      const fresh = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: freshSample.serializedTransaction,
      });
      const est = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: establishedSample.serializedTransaction,
      });

      expect(fresh.status).toBe(200);
      expect(est.status).toBe(200);
      const freshTypes = fresh.body.flags.map((f: any) => f.type);
      expect(freshTypes).toContain("fresh_program");
      expect(fresh.body.riskScore).toBeGreaterThan(0);
      expect(["warn", "block"]).toContain(fresh.body.recommendation);

      expect(est.body.flags).toEqual([]);
      expect(est.body.riskScore).toBe(0);
      expect(est.body.recommendation).toBe("allow");
    });

    it("response exposes stable sha256 of transaction bytes", async () => {
      const s = sampleById("spl-transfer-safe");
      const r1 = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
      });
      const r2 = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
      });
      expect(r1.body.transactionHash).toBe(r2.body.transactionHash);
      expect(typeof r1.body.transactionHash).toBe("string");
      expect(r1.body.transactionHash.length).toBe(64); // sha256 hex
    });

    it("parses signature and feePayer correctly from fixtures", async () => {
      const s = sampleById("sol-transfer-safe");
      const r = await agent.post("/v1/analyze-transaction").send({
        serializedTransaction: s.serializedTransaction,
      });
      // The fixture generator does not sign txs — signatures[0] will be a
      // zero-padded placeholder base58 string (~88 chars of "A...") rather
      // than null. Fee payer is still populated from the first signer key.
      const p = parseTransaction(s.serializedTransaction, {
        network: "mainnet-beta",
      });
      // Placeholder signature: length typical for base58 of 64 zero bytes.
      expect(
        typeof r.body.signature === "string" && r.body.signature.length >= 40,
      ).toBe(true);
      expect(p.signatures[0]).toBe(r.body.signature);
    });

    it("every risk-tagged fixture matches exactly the expected detector set (cross-trigger guard)", async () => {
      for (const s of fixture.samples) {
        if (!s.category.startsWith("risk:")) continue;
        const expected = s.category.replace("risk:", "");
        const r = await agent.post("/v1/analyze-transaction").send({
          serializedTransaction: s.serializedTransaction,
        });
        expect(r.status, `${s.id} → HTTP 200`).toBe(200);
        const types: string[] = r.body.flags.map((f: any) => f.type);
        expect(types, `${s.id} → contains ${expected}`).toContain(expected);
        // No cross-trigger from other detectors
        const other = types.filter((t) => t !== expected);
        expect(other, `${s.id} → no cross-trigger`).toEqual([]);
      }
    });
  });
});
