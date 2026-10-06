/**
 * api/scripts/fetch-real-txs.ts
 *
 * Pulls a handful of recent confirmed mainnet transactions via a public RPC,
 * deserializes each with our parser, and pretty-prints the decoded
 * instructions. Goal: eyeball real transfers / approvals / swaps so we
 * know what detectors are up against.
 *
 * Run from the `api/` directory (which has all deps installed):
 *   cd api
 *   npx tsx scripts/fetch-real-txs.ts [RPC_URL]
 *
 * If RPC_URL is omitted, uses SOLANA_RPC_URL env var, else falls back to the
 * public mainnet-beta endpoint (rate-limited, fine for ~10 txs).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { parseTransaction } from "../src/lib/index.js";
import type { DecodedInstruction } from "../src/lib/types.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

/**
 * A curated list of well-known mainnet programs we can sample activity from.
 * The Jupiter router + Raydium AMM are particularly likely to contain
 * approve / approveChecked / swap instructions.
 */
const WATCH_ADDRESSES: PublicKey[] = [
  // Jupiter Aggregator v6 (largest DEX aggregator — almost every tx has approvals)
  new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),
  // Raydium Liquidity Pool v4
  new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"),
  // wSOL mint (massive transfer volume)
  new PublicKey("So11111111111111111111111111111111111111112"),
];

function rpcFromArgs(): string {
  const argvRpc = process.argv[2];
  if (argvRpc) return argvRpc;
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  return DEFAULT_RPC;
}

function amountToken(ix: DecodedInstruction): string | null {
  const a = ix.args.amount as string | undefined;
  if (!a) return null;
  const decimals = ix.args.decimals as number | undefined;
  if (typeof decimals === "number") {
    const v = Number(BigInt(a)) / Math.pow(10, decimals);
    return `${v.toFixed(Math.min(decimals, 6))} tokens`;
  }
  return `${a} raw units`;
}

function prettyPrint(sig: string, tx: ReturnType<typeof parseTransaction>) {
  console.log("=".repeat(90));
  console.log("Signature :", sig);
  console.log("Fee payer :", tx.feePayer ?? "(unsigned)");
  console.log(
    "Format    :",
    tx.isVersioned ? "VersionedTransaction (v0)" : "Legacy",
  );
  console.log("Programs  :", tx.referencedProgramIds.join(", "));
  if (tx.destinationAddresses.length) {
    console.log("Dests     :", tx.destinationAddresses.join(", "));
  }
  console.log("Instructions:");
  for (const ix of tx.instructions) {
    const header = `  [${ix.index.toString().padStart(2, "0")}] ${ix.programName.padEnd(14)} ${ix.instructionType}`;
    console.log(header);
    // Special-case a few human-readable extras
    switch (ix.instructionType) {
      case "approve":
      case "approveChecked": {
        const amt = amountToken(ix);
        console.log(`             amount=${amt ?? ix.args.amount}`);
        console.log(`             delegate=${ix.args.delegate}`);
        break;
      }
      case "transfer":
      case "transferChecked": {
        const amt =
          amountToken(ix) ??
          (ix.args.lamports ? `${ix.args.lamports} lamports` : null);
        if (amt) console.log(`             amount=${amt}`);
        if (ix.args.destination)
          console.log(`             to=${ix.args.destination}`);
        break;
      }
      case "setAuthority": {
        console.log(`             type=${ix.args.authorityType}`);
        console.log(
          `             newAuthority=${ix.args.newAuthority ?? "(none / revoked)"}`,
        );
        break;
      }
    }
  }
  console.log("");
}

async function pickInterestingTxs(
  conn: Connection,
  limit = 8,
): Promise<Array<{ sig: string; serializedBase64: string }>> {
  // Strategy: pull recent confirmed signatures for a few high-volume
  // addresses (Jupiter, Raydium, wSOL), then fetch each transaction with
  // `getTransaction` in base64-encoded wire format. Skip vote txs,
  // failed txs, and anything that doesn't deserialize.
  const allSigs: string[] = [];
  for (const addr of WATCH_ADDRESSES.slice(0, 2)) {
    console.log(`Fetching recent sigs for ${addr.toBase58().slice(0, 12)}...`);
    const sigs = await conn.getSignaturesForAddress(addr, { limit: 20 });
    for (const s of sigs) if (!s.err) allSigs.push(s.signature);
  }

  const results: Array<{ sig: string; serializedBase64: string }> = [];
  console.log(`Fetching up to ${limit} transaction bodies...`);
  for (const sig of allSigs) {
    try {
      const raw = await conn.getTransaction(sig, {
        encoding: "base64",
        maxSupportedTransactionVersion: 0,
        commitment: "confirmed",
      });
      if (!raw?.transaction) continue;
      const serializedBase64 = raw.transaction as unknown as string;
      if (typeof serializedBase64 !== "string") continue;
      try {
        const parsed = parseTransaction(serializedBase64);
        const hasTokenIx = parsed.instructions.some(
          (ix) =>
            ix.programName === "Token" ||
            ix.programName === "Token2022" ||
            ix.programName === "System",
        );
        // Favour non-trivial txs but allow token txs even with 1 ix
        const isTrivial =
          parsed.instructions.length <= 1 &&
          !parsed.instructions.some(
            (ix) =>
              ix.instructionType === "approve" ||
              ix.instructionType === "approveChecked" ||
              ix.instructionType === "setAuthority",
          );
        if (isTrivial && !hasTokenIx) continue;
        results.push({ sig, serializedBase64 });
      } catch {
        // skip unparseable
      }
      if (results.length >= limit) break;
    } catch {
      // transient RPC errors, skip
    }
  }
  return results;
}

async function main() {
  const rpc = rpcFromArgs();
  console.log(`Using RPC: ${rpc}\n`);
  const conn = new Connection(rpc, "confirmed");

  const picks = await pickInterestingTxs(conn, 8);
  if (picks.length === 0) {
    console.log("No parseable txs returned by RPC (429s / empty block).");
    console.log(
      "→ Falling back to local fixture: data/fixtures/sample-transactions.json",
    );
    console.log(
      "→ Run: `npx tsx scripts/generate-sample-fixtures.ts` to regenerate.\n",
    );

    const fixturePath = resolve(
      import.meta.dirname!,
      "../../data/fixtures/sample-transactions.json",
    );
    if (!existsSync(fixturePath)) {
      console.error(`Fixture not found at ${fixturePath}. Nothing to show.`);
      return;
    }
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      samples: Array<{
        id: string;
        label: string;
        category: string;
        notes: string;
        serializedTransaction: string;
      }>;
    };

    for (const s of fixture.samples) {
      console.log("~".repeat(90));
      console.log(`Fixture ID : ${s.id}`);
      console.log(`Label      : ${s.label}`);
      console.log(`Category   : ${s.category}`);
      console.log(`Notes      : ${s.notes}`);
      const parsed = parseTransaction(s.serializedTransaction);
      prettyPrint("(fixture — not a real on-chain sig)", parsed);
    }
    console.log("=".repeat(90));
    console.log("\nDone. To see live on-chain txs, pass a premium RPC URL:");
    console.log(
      "  npx tsx scripts/fetch-real-txs.ts https://mainnet.helius-rpc.com/?api-key=...",
    );
    return;
  }

  console.log(`\nParsed ${picks.length} interesting transactions.\n`);
  for (const { sig, serializedBase64 } of picks) {
    const parsed = parseTransaction(serializedBase64);
    prettyPrint(sig, parsed);
  }

  console.log("=".repeat(90));
  console.log(
    "\nTip: if you mostly see SOL transfers, rerun with a premium RPC",
  );
  console.log(
    "     (Helius / Triton / RPC Pool) for more approvals and swaps.",
  );
}

main().catch((e: unknown) => {
  console.error("fatal:", e);
  process.exit(1);
});
