/**
 * data/scripts/fetch-real-txs.ts
 *
 * Pulls a handful of recent confirmed mainnet transactions via a public RPC,
 * deserializes each with our parser, and pretty-prints the decoded
 * instructions. Goal: eyeball real transfers / approvals / swaps so we
 * know what detectors are up against.
 *
 * Run from the `api/` directory (which has all deps installed):
 *   cd api
 *   npx tsx ../data/scripts/fetch-real-txs.ts [RPC_URL]
 *
 * If RPC_URL is omitted, uses SOLANA_RPC_URL env var, else falls back to the
 * public mainnet-beta endpoint (rate-limited, fine for ~10 txs).
 */

import {
  ConfirmedTransactionMeta,
  Connection,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { parseTransaction } from "../../api/src/lib/index.js";
import type { DecodedInstruction } from "../../api/src/lib/types.js";

const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

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
  // Strategy: get a recent slot, ask for its block with full encoding, grab
  // the first batch of non-vote, non-failed, non-trivial transactions. Vote
  // and simple-SOL-transfer spam dominate blocks, so we skip ixs < 2 and
  // favour anything touching the Token program (that's where approvals live).
  const slot = await conn.getSlot("confirmed");
  console.log(`Fetching block @ slot ${slot} ...`);
  const block = await conn.getBlock(slot, {
    encoding: "base64",
    maxSupportedTransactionVersion: 0,
    transactionDetails: "full",
    rewards: false,
  });

  if (!block || !block.transactions.length) {
    throw new Error(
      `Block ${slot} had no transactions; try a different RPC URL.`,
    );
  }

  const results: Array<{ sig: string; serializedBase64: string }> = [];
  for (const tx of block.transactions as VersionedTransactionResponse[]) {
    if (tx.meta && (tx.meta as ConfirmedTransactionMeta).err) continue;
    const [serializedBase64] = tx.transaction as unknown as [string];
    if (!serializedBase64) continue;
    const sig = (tx.transaction as any).signatures?.[0] ?? "(no sig)";
    try {
      const parsed = parseTransaction(serializedBase64);
      const hasTokenIx = parsed.instructions.some(
        (ix) => ix.programName === "Token" || ix.programName === "Token2022",
      );
      const isTrivial = parsed.instructions.length <= 1;
      if (isTrivial && !hasTokenIx) continue;
      results.push({ sig, serializedBase64 });
      if (results.length >= limit) break;
    } catch {
      // skip unparseable
    }
  }
  return results;
}

async function main() {
  const rpc = rpcFromArgs();
  console.log(`Using RPC: ${rpc}\n`);
  const conn = new Connection(rpc, "confirmed");

  const picks = await pickInterestingTxs(conn, 8);
  console.log(`\nParsed ${picks.length} interesting transactions.\n`);
  for (const { sig, serializedBase64 } of picks) {
    const parsed = parseTransaction(serializedBase64);
    prettyPrint(sig, parsed);
  }

  console.log("=".repeat(90));
  console.log(
    "\nTip: if you mostly see SOL transfers, rerun with a higher-tx RPC",
  );
  console.log(
    "     (e.g. Helius / Triton / your own) and this script will surface",
  );
  console.log("     more approvals / swaps / setAuthority ixs.");
}

main().catch((e: unknown) => {
  console.error("fatal:", e);
  process.exit(1);
});
