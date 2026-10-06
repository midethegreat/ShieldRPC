import "dotenv/config";
import {
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createApproveInstruction,
  createApproveCheckedInstruction,
  createSetAuthorityInstruction,
  createTransferInstruction,
  createTransferCheckedInstruction,
  AuthorityType,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTransaction } from "../src/lib/index.js";
import type { ProgramInfo } from "../src/detectors/types.js";

/**
 * Builds a small fixture bank of real-wire-format transactions covering:
 *   - simple SOL transfer (safe)
 *   - simple SPL token transfer (safe)
 *   - small SPL approve (safe-ish)
 *   - unlimited SPL approve (detector #1 trigger)
 *   - approveChecked max (detector #1 trigger)
 *   - setAuthority to a new address (detector #2 trigger)
 *   - multi-ix Jupiter-style swap-ish bundle with approve + transfer + unknown program
 *   - Transfer to a KNOWN-BLOCKLISTED destination address  (detector #3 trigger)
 *   - Interaction with a KNOWN-BLOCKLISTED program ID     (detector #3 trigger)
 *   - Interaction with a FRESH / unverified / low-volume program (detector #4 trigger)
 *
 * The fixture is saved to ../../data/fixtures/sample-transactions.json so the
 * fetch-real-txs script can always show decoded layouts even without an RPC,
 * and the detector test suite uses the serialized transactions for E2E runs.
 *
 * Detectors #3 and #4 rely on context (blocklist lookups, program metadata)
 * — the fixture JSON also ships a `detectorContextHints` field that the test
 * suite uses to build matching stub callbacks.
 */

const BLOCKHASH = new PublicKey(Buffer.alloc(32, 0xab)).toBase58();

// Use a deterministically-generated fake mint pubkey (Keypair -> publicKey) so
// it's a valid ed25519 pubkey rather than a vanity string that fails validation.
function deterministicKeypair(seed: string): Keypair {
  const buf = Buffer.alloc(32);
  for (let i = 0; i < seed.length && i < 32; i++) buf[i] = seed.charCodeAt(i);
  return Keypair.fromSeed(buf);
}
const FAKE_MINT = deterministicKeypair(
  "deadbeef-deadbeef-deadbeef-mint!!",
).publicKey;

function base64Serialize(tx: Transaction): string {
  return Buffer.from(
    tx.serialize({ requireAllSignatures: false, verifySignatures: false }),
  ).toString("base64");
}

function attachMeta(tx: Transaction, feePayer: PublicKey) {
  tx.feePayer = feePayer;
  tx.recentBlockhash = BLOCKHASH;
}

interface Sample {
  id: string;
  label: string;
  category: string;
  notes: string;
  serializedTransaction: string;
}

interface DetectorContextHints {
  blockedAddresses: string[];
  blockedProgramIds: string[];
  freshPrograms: Record<string, ProgramInfo>;
  trustedPrograms: Record<string, ProgramInfo>;
}

function buildSamples(): { samples: Sample[]; hints: DetectorContextHints } {
  const user = Keypair.generate();
  const friend = Keypair.generate().publicKey;
  const delegateSafe = Keypair.generate().publicKey;
  const delegateScammer = Keypair.generate().publicKey;
  const newAuthorityScammer = Keypair.generate().publicKey;
  const userAta = getAssociatedTokenAddressSync(FAKE_MINT, user.publicKey);
  const friendAta = getAssociatedTokenAddressSync(FAKE_MINT, friend);

  // === Addresses used for detector #3 (known malicious) ===
  // Deterministic "blocklisted" destination — test suite puts this in the mock blocklist
  const BLOCKLISTED_DESTINATION = deterministicKeypair(
    "blocklisted-dest-000000000000000000001",
  ).publicKey;
  // A fake program ID we will mark as blocklisted (drainer program)
  const BLOCKLISTED_PROGRAM = deterministicKeypair(
    "blocklisted-program-00000000000000001",
  ).publicKey;

  // === Program IDs used for detector #4 (fresh/unverified) ===
  // A fresh program — deployed 1 hour ago, 3 txs, unverified
  const FRESH_PROGRAM = deterministicKeypair(
    "fresh-scam-program-000000000000000001",
  ).publicKey;
  // An established, verified program (e.g. Jupiter V6 stand-in) — never flagged
  const TRUSTED_ESTABLISHED_PROGRAM = deterministicKeypair(
    "trusted-established-0000000000000001",
  ).publicKey;

  const samples: Sample[] = [];

  // 1. Pure SOL transfer (safe)
  {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: user.publicKey,
        toPubkey: friend,
        lamports: (500n * BigInt(LAMPORTS_PER_SOL)) / 100n, // 5 SOL
      }),
    );
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "sol-transfer-safe",
      label: "Safe: 5 SOL transfer to a friend",
      category: "safe",
      notes: "Plain System Program transfer. No SPL, no approvals.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // 2. Small SPL token transfer (safe)
  {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      createTransferInstruction(
        userAta,
        friendAta,
        user.publicKey,
        42_000_000n,
      ),
    );
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "spl-transfer-safe",
      label: "Safe: 42 SPL tokens transferred",
      category: "safe",
      notes:
        "SPL Token transfer + compute-unit tip. No approvals or authority changes.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // 3. Small approve (safe-ish — typical for a DEX)
  {
    const tx = new Transaction().add(
      createApproveInstruction(
        userAta,
        delegateSafe,
        user.publicKey,
        1_000_000n,
      ),
    );
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "spl-approve-small",
      label: "Safe-ish: small approve for 1M units",
      category: "safe",
      notes: "Below-at-risk threshold. Typical Jupiter/DEX pre-swap approve.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // 4. Unlimited approve — detector #1 trigger
  {
    const tx = new Transaction().add(
      createApproveInstruction(
        userAta,
        delegateScammer,
        user.publicKey,
        // u64 max = classic "approve unlimited" drainer pattern
        0xffffffffffffffffffffffffffffffffn,
      ),
    );
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "spl-approve-unlimited",
      label: "RISKY: unlimited approve to unknown delegate",
      category: "risk:unlimited_approval",
      notes:
        "Amount == u64 max. Classic drainer pattern. Detector #1 should flag.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // 5. approveChecked unlimited — detector #1 trigger
  {
    const tx = new Transaction().add(
      createApproveCheckedInstruction(
        userAta,
        FAKE_MINT,
        delegateScammer,
        user.publicKey,
        0xffffffffffffffffffffffffffffffffn,
        9, // decimals
      ),
    );
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "spl-approveChecked-unlimited",
      label: "RISKY: approveChecked (mint-aware) unlimited",
      category: "risk:unlimited_approval",
      notes: "approveChecked variant with decimals field + max u64.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // 6. setAuthority AccountOwner — detector #2 trigger
  {
    const tx = new Transaction().add(
      createSetAuthorityInstruction(
        userAta,
        user.publicKey,
        AuthorityType.AccountOwner,
        newAuthorityScammer,
      ),
    );
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "spl-setAuthority-owner",
      label: "RISKY: setAuthority AccountOwner -> unknown address",
      category: "risk:authority_change",
      notes:
        "Transfers ATA ownership to a scammer pubkey. Detector #2 should flag.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // 7. Bundle: compute tip + approvals + transferChecked (swap-ish, safe)
  {
    const pool = Keypair.generate().publicKey;
    const poolAta = getAssociatedTokenAddressSync(FAKE_MINT, pool);
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 }),
      createApproveInstruction(userAta, delegateSafe, user.publicKey, 500_000n),
      createTransferCheckedInstruction(
        userAta,
        FAKE_MINT,
        poolAta,
        user.publicKey,
        500_000n,
        9,
      ),
    );
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "bundle-swap-safe",
      label: "Safe: Jupiter-style swap bundle (approve + transferChecked)",
      category: "safe",
      notes:
        "Multi-ix DEX interaction. Small bounded approve, no authority changes.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // === NEW: Detector #3 fixtures (known malicious) ===

  // 8. SOL transfer to a BLOCKLISTED destination — detector #3 trigger (destination)
  {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: user.publicKey,
        toPubkey: BLOCKLISTED_DESTINATION,
        lamports: 1n * BigInt(LAMPORTS_PER_SOL),
      }),
    );
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "sol-transfer-to-blocklisted-dest",
      label: "RISKY: SOL transfer to a known blocklisted destination wallet",
      category: "risk:known_malicious_address",
      notes:
        "Sends SOL to a destination that is in the maintained blocklist. Detector #3 should flag.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // 9. Invoke a BLOCKLISTED program ID directly — detector #3 trigger (program_id)
  {
    // Build a minimal no-op instruction targeting the blocklisted program.
    // Accounts: user as writable signer + one scratch account.
    const scratchAccount = Keypair.generate().publicKey;
    const ix = new TransactionInstruction({
      programId: BLOCKLISTED_PROGRAM,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: scratchAccount, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([0x00, 0x01, 0x02, 0x03]),
    });
    const tx = new Transaction().add(ix);
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "invoke-blocklisted-program",
      label: "RISKY: Direct invocation of a known blocklisted program ID",
      category: "risk:known_malicious_address",
      notes:
        "Calls a program ID that is in the blocklist (e.g. known drainer). Detector #3 should flag as critical.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // === NEW: Detector #4 fixtures (fresh/unverified program) ===

  // 10. Invoke a FRESH / unverified / low-volume program — detector #4 trigger
  {
    const scratchAccount = Keypair.generate().publicKey;
    const ix = new TransactionInstruction({
      programId: FRESH_PROGRAM,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: scratchAccount, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([0x00]),
    });
    const tx = new Transaction().add(ix);
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "invoke-fresh-unverified-program",
      label:
        "RISKY: Interacting with a freshly deployed, unverified low-volume program",
      category: "risk:fresh_program",
      notes:
        "Program was deployed 1h ago, only 3 lifetime txs, not verified. Detector #4 should flag.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // 11. (CONTROL) Invoke an ESTABLISHED, verified program — detector #4 must NOT flag
  {
    const scratchAccount = Keypair.generate().publicKey;
    const ix = new TransactionInstruction({
      programId: TRUSTED_ESTABLISHED_PROGRAM,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: scratchAccount, isSigner: false, isWritable: true },
      ],
      data: Buffer.from([0x00]),
    });
    const tx = new Transaction().add(ix);
    attachMeta(tx, user.publicKey);
    samples.push({
      id: "invoke-established-verified-program",
      label:
        "Safe: Invoking an established, verified high-volume program (Jupiter-like)",
      category: "safe",
      notes:
        "Program is 180 days old, verified, 10M+ txs. Fresh-program detector must NOT flag.",
      serializedTransaction: base64Serialize(tx),
    });
  }

  // === Context hints for the test suite ===
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Blocklisted programs also have established metadata — they're well-known
  // drainers with lots of on-chain history, not "fresh". This keeps the
  // detector #3 fixture from double-triggering detector #4 in tests.
  const blockedProgramInfos: Record<string, ProgramInfo> = {};
  for (const base58 of [BLOCKLISTED_PROGRAM.toBase58()]) {
    blockedProgramInfos[base58] = {
      programId: base58,
      deployedAt: nowSeconds - 120 * 24 * 60 * 60, // 120 days old
      transactionCount: 543_210,
      verified: true, // verifiably deployed, even though it's malicious
      displayName: "KnownDrainerProtocol_v2",
    };
  }

  const hints: DetectorContextHints = {
    blockedAddresses: [BLOCKLISTED_DESTINATION.toBase58()],
    blockedProgramIds: [BLOCKLISTED_PROGRAM.toBase58()],
    freshPrograms: {
      [FRESH_PROGRAM.toBase58()]: {
        programId: FRESH_PROGRAM.toBase58(),
        deployedAt: nowSeconds - 60 * 60, // deployed 1 hour ago
        transactionCount: 3,
        verified: false,
        displayName: "SuspiciousNewProtocol",
      },
    },
    trustedPrograms: {
      [TRUSTED_ESTABLISHED_PROGRAM.toBase58()]: {
        programId: TRUSTED_ESTABLISHED_PROGRAM.toBase58(),
        deployedAt: nowSeconds - 180 * 24 * 60 * 60, // 180 days old
        transactionCount: 12_345_678,
        verified: true,
        displayName: "Jupiter Aggregator (mock)",
      },
      ...blockedProgramInfos,
    },
  };

  return { samples, hints };
}

function main() {
  const { samples, hints } = buildSamples();
  const fixture = {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    tokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
    fakeMint: FAKE_MINT.toBase58(),
    blockhashNote:
      "All samples use a synthetic blockhash. They parse correctly but are not signed.",
    samples,
    detectorContextHints: hints,
  };

  const outPath = resolve(
    import.meta.dirname!,
    "../../data/fixtures/sample-transactions.json",
  );
  writeFileSync(outPath, JSON.stringify(fixture, null, 2));
  console.log(`Wrote ${samples.length} sample txs -> ${outPath}`);

  // Print decoded summary so you can eyeball them
  for (const s of samples) {
    const p = parseTransaction(s.serializedTransaction, {
      network: "mainnet-beta",
    });
    const ixs = p.instructions
      .map((i) => `${i.programName}:${i.instructionType}`)
      .join(", ");
    console.log(`  [${s.category.padEnd(28)}] ${s.id.padEnd(44)} => ${ixs}`);
  }
}

main();
