import {
  Message,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  programName,
} from "./programs.js";
import type {
  DecodedInstruction,
  Network,
  ParsedAccountMeta,
  ParsedTransaction,
} from "./types.js";

// ---------------------------------------------------------------------------
// Discriminators (instruction opcodes)
//
// Both the System program and SPL Token program prefix instruction data with
// a little-endian u32 discriminator telling you *which* instruction it is.
// We only decode the ones ShieldRPC detectors actually need.
// ---------------------------------------------------------------------------

/** SPL Token Program discriminators (from solana-program-library/token/program/src/instruction.rs). */
const TOKEN_IX_TYPES: Record<number, string> = {
  0: "initializeMint",
  1: "initializeAccount",
  2: "initializeMultisig",
  3: "transfer",
  4: "approve",
  5: "revoke",
  6: "setAuthority",
  7: "mintTo",
  8: "burn",
  9: "closeAccount",
  10: "freezeAccount",
  11: "thawAccount",
  12: "transferChecked",
  13: "approveChecked",
  14: "mintToChecked",
  15: "burnChecked",
  16: "initializeAccount2",
  17: "syncNative",
  18: "initializeAccount3",
  19: "initializeMultisig2",
  20: "initializeMint2",
};

/** System Program discriminators (from solana-program/system_program/src/instruction.rs). */
const SYSTEM_IX_TYPES: Record<number, string> = {
  0: "createAccount",
  1: "assign",
  2: "transfer",
  3: "createAccountWithSeed",
  4: "advanceNonceAccount",
  5: "withdrawNonceAccount",
  6: "initializeNonceAccount",
  7: "authorizeNonceAccount",
  8: "allocate",
  9: "allocateWithSeed",
  10: "assignWithSeed",
  11: "transferWithSeed",
};

/** SPL Token `AuthorityType` enum (setAuthority ix). */
const AUTHORITY_TYPES: Record<number, string> = {
  0: "MintTokens",
  1: "FreezeAccount",
  2: "AccountOwner",
  3: "CloseAccount",
};

// ---------------------------------------------------------------------------
// Low-level deserialization helpers
// ---------------------------------------------------------------------------

function base64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

/**
 * A Solana wire transaction can be either:
 *   - legacy (old `Message` layout)
 *   - v0 (VersionedMessage with address lookup tables)
 *
 * We try legacy first, then fall back to v0. In practice v0 is ~10x more
 * common in modern wallets, but the fallback is cheap and keeps us robust.
 */
function deserializeAny(bytes: Buffer): {
  isVersioned: boolean;
  message: Message | VersionedMessage;
  signatures: Uint8Array[];
  instructions: TransactionInstruction[];
} {
  // Try legacy first
  try {
    const tx = Transaction.from(bytes);
    return {
      isVersioned: false,
      message: tx.compileMessage(),
      signatures: tx.signatures.map((s) => s.signature ?? new Uint8Array(64)),
      instructions: tx.instructions,
    };
  } catch {
    // fall through to v0
  }

  const vtx = VersionedTransaction.deserialize(bytes);
  const msg = vtx.message;
  const staticKeys = msg.staticAccountKeys;
  const instructions: TransactionInstruction[] = [];
  for (const ix of msg.compiledInstructions) {
    const programId = staticKeys[ix.programIdIndex] ?? PublicKey.default;
    const keys: Array<{
      pubkey: PublicKey;
      isSigner: boolean;
      isWritable: boolean;
    }> = [];
    for (const idx of ix.accountKeyIndexes) {
      // accountKeyIndexes points into either staticAccountKeys OR an
      // address-lookup-table loaded key. On a raw message without loaded
      // tables we only have static keys; for pre-sign txs this is fine
      // because the instructions we care about (approve / setAuthority /
      // transfers) always place their program + relevant accounts in the
      // static section. Lookup-table keys fall back to PublicKey.default
      // and downstream detectors treat unknowns as "no flag".
      const pubkey =
        idx < staticKeys.length ? staticKeys[idx]! : PublicKey.default;
      const isWritable = msg.isAccountWritable(idx);
      const isSigner = msg.isAccountSigner(idx);
      keys.push({ pubkey, isSigner, isWritable });
    }
    instructions.push(
      new TransactionInstruction({
        programId,
        keys,
        data: Buffer.from(ix.data),
      }),
    );
  }
  return {
    isVersioned: true,
    message: msg,
    signatures: [vtx.signatures[0] ?? new Uint8Array(64)],
    instructions,
  };
}

// ---------------------------------------------------------------------------
// Single-instruction decoding
// ---------------------------------------------------------------------------

function readU32Le(buf: Buffer, offset = 0): number {
  return buf.readUInt32LE(offset);
}

function readU64Le(buf: Buffer, offset = 0): bigint {
  return buf.readBigUInt64LE(offset);
}

function toMeta(
  pubkey: PublicKey,
  isSigner = false,
  isWritable = false,
): ParsedAccountMeta {
  return {
    pubkey: pubkey.toBase58(),
    isSigner,
    isWritable,
  };
}

function ixAccountsFromLegacy(ix: TransactionInstruction): ParsedAccountMeta[] {
  return ix.keys.map((k) => toMeta(k.pubkey, k.isSigner, k.isWritable));
}

function decodeTokenInstruction(
  ix: TransactionInstruction,
  _index: number,
): { instructionType: string; args: Record<string, unknown> } {
  if (ix.data.length < 1) {
    return { instructionType: "unknown", args: {} };
  }
  // SPL Token uses a u8 discriminator in byte 0 for all instructions up to
  // 254; all TOKEN_IX_TYPES values are in the range [0, 20] so u8 is
  // sufficient. We then shift every subsequent offset by -3 bytes relative
  // to the System-program u32 layout.
  const disc = ix.data.readUInt8(0);
  const typeName = TOKEN_IX_TYPES[disc] ?? `unknown_${disc}`;
  const keys = ix.keys.map((k) => k.pubkey.toBase58());

  switch (typeName) {
    case "approve": {
      // Accounts: [source, delegate, owner/authority (signer)]
      // Layout: u8 discriminant (1) | u64 amount (8)  => amount starts at 1
      const amount = readU64Le(ix.data, 1);
      return {
        instructionType: "approve",
        args: {
          source: keys[0] ?? null,
          delegate: keys[1] ?? null,
          owner: keys[2] ?? null,
          amount: amount.toString(),
          amountRaw: amount,
        },
      };
    }
    case "approveChecked": {
      // Accounts: [source, mint, delegate, owner/authority (signer)]
      // Layout: u8 (1) | u64 amount (8) | u8 decimals (1)
      const amount = readU64Le(ix.data, 1);
      const decimals = ix.data.length > 9 ? ix.data.readUInt8(9) : null;
      return {
        instructionType: "approveChecked",
        args: {
          source: keys[0] ?? null,
          mint: keys[1] ?? null,
          delegate: keys[2] ?? null,
          owner: keys[3] ?? null,
          amount: amount.toString(),
          amountRaw: amount,
          decimals,
        },
      };
    }
    case "transfer": {
      // Layout: u8 (1) | u64 amount (8)
      const amount = readU64Le(ix.data, 1);
      return {
        instructionType: "transfer",
        args: {
          source: keys[0] ?? null,
          destination: keys[1] ?? null,
          authority: keys[2] ?? null,
          amount: amount.toString(),
          amountRaw: amount,
        },
      };
    }
    case "transferChecked": {
      // Layout: u8 (1) | u64 amount (8) | u8 decimals (1)
      const amount = readU64Le(ix.data, 1);
      const decimals = ix.data.length > 9 ? ix.data.readUInt8(9) : null;
      return {
        instructionType: "transferChecked",
        args: {
          source: keys[0] ?? null,
          mint: keys[1] ?? null,
          destination: keys[2] ?? null,
          authority: keys[3] ?? null,
          amount: amount.toString(),
          amountRaw: amount,
          decimals,
        },
      };
    }
    case "setAuthority": {
      // Accounts: [account, currentAuthority (signer)]
      // Layout: u8 disc (1) | u8 authorityType (1) | Option<Pubkey> (1+32)
      const authorityType = ix.data.length > 1 ? ix.data.readUInt8(1) : 0xff;
      let newAuthority: string | null = null;
      if (
        ix.data.length > 2 &&
        ix.data.readUInt8(2) === 1 &&
        ix.data.length >= 2 + 1 + 32
      ) {
        newAuthority = new PublicKey(ix.data.subarray(3, 3 + 32)).toBase58();
      }
      return {
        instructionType: "setAuthority",
        args: {
          account: keys[0] ?? null,
          currentAuthority: keys[1] ?? null,
          authorityType:
            AUTHORITY_TYPES[authorityType] ?? `unknown_${authorityType}`,
          authorityTypeRaw: authorityType,
          newAuthority,
        },
      };
    }
    case "revoke":
    case "closeAccount":
    case "mintTo":
    case "burn":
    case "initializeAccount":
    case "initializeMint":
    default:
      // For detectors we don't need the full decoded shape; keep the raw
      // args minimal so this function stays maintainable.
      return {
        instructionType: typeName,
        args: { _keys: keys },
      };
  }
}

function decodeSystemInstruction(
  ix: TransactionInstruction,
  _index: number,
): { instructionType: string; args: Record<string, unknown> } {
  if (ix.data.length < 4) {
    return { instructionType: "unknown", args: {} };
  }
  const disc = readU32Le(ix.data, 0);
  const typeName = SYSTEM_IX_TYPES[disc] ?? `unknown_${disc}`;
  const keys = ix.keys.map((k) => k.pubkey.toBase58());
  switch (typeName) {
    case "transfer": {
      const lamports = readU64Le(ix.data, 4);
      return {
        instructionType: "transfer",
        args: {
          source: keys[0] ?? null,
          destination: keys[1] ?? null,
          lamports: lamports.toString(),
          lamportsRaw: lamports,
        },
      };
    }
    case "createAccount": {
      const lamports = readU64Le(ix.data, 4);
      const space = readU64Le(ix.data, 12);
      const owner = keys[2] ? keys[2] : null;
      return {
        instructionType: "createAccount",
        args: {
          from: keys[0] ?? null,
          newAccount: keys[1] ?? null,
          lamports: lamports.toString(),
          space: space.toString(),
          owner,
        },
      };
    }
    default:
      return { instructionType: typeName, args: { _keys: keys } };
  }
}

function decodeInstruction(
  ix: TransactionInstruction,
  index: number,
): { instructionType: string; args: Record<string, unknown> } {
  const prog = ix.programId.toBase58();
  if (
    prog === TOKEN_PROGRAM_ID.toBase58() ||
    prog === TOKEN_2022_PROGRAM_ID.toBase58()
  ) {
    return decodeTokenInstruction(ix, index);
  }
  if (prog === SYSTEM_PROGRAM_ID.toBase58()) {
    return decodeSystemInstruction(ix, index);
  }
  return { instructionType: "unknown", args: {} };
}

// ---------------------------------------------------------------------------
// Top-level parser API
// ---------------------------------------------------------------------------

export interface ParseOptions {
  network?: Network;
}

/**
 * Parse a base64-serialized Solana transaction (legacy or v0) into the
 * normalized `ParsedTransaction` shape the rest of ShieldRPC consumes.
 *
 * Usage:
 *   const parsed = parseTransaction(base64String, { network: 'mainnet-beta' });
 *   parsed.instructions.forEach(ix => console.log(ix.instructionType, ix.args));
 */
export function parseTransaction(
  serializedTransaction: string,
  options: ParseOptions = {},
): ParsedTransaction {
  const network: Network = options.network ?? "mainnet-beta";
  const bytes = base64ToBuffer(serializedTransaction);
  const { isVersioned, message, signatures, instructions } =
    deserializeAny(bytes);

  const feePayer =
    message instanceof Message
      ? (message.accountKeys[0]?.toBase58() ?? null)
      : (message.staticAccountKeys[0]?.toBase58() ?? null);

  const decodedIxs: DecodedInstruction[] = instructions.map((ix, i) => {
    const { instructionType, args } = decodeInstruction(ix, i);
    const accounts = ixAccountsFromLegacy(ix);

    return {
      index: i,
      programId: ix.programId.toBase58(),
      programName: programName(ix.programId),
      accounts,
      instructionType,
      args,
      rawDataHex: Buffer.from(ix.data).toString("hex"),
    };
  });

  const referencedProgramIds = Array.from(
    new Set(decodedIxs.map((ix) => ix.programId)),
  );

  const destinationAddresses = collectDestinations(decodedIxs);

  return {
    signatures: signatures.map((s) => Buffer.from(s).toString("base64")),
    feePayer,
    isVersioned,
    instructions: decodedIxs,
    network,
    referencedProgramIds,
    destinationAddresses,
  };
}

/**
 * Pull "interesting" destination addresses that downstream detectors want
 * to check against a blocklist / inspect for freshness. We deliberately
 * exclude obvious signer-owned accounts to keep the signal tight.
 */
function collectDestinations(ixs: DecodedInstruction[]): string[] {
  const out = new Set<string>();
  for (const ix of ixs) {
    const t = ix.instructionType;
    const args = ix.args;
    switch (t) {
      case "transfer":
      case "transferChecked":
        if (typeof args.destination === "string") out.add(args.destination);
        break;
      case "approve":
      case "approveChecked":
        if (typeof args.delegate === "string") out.add(args.delegate);
        break;
      case "setAuthority":
        if (typeof args.newAuthority === "string" && args.newAuthority) {
          out.add(args.newAuthority);
        }
        break;
    }
    // Any unknown program's first writable non-signer account is suspicious
    // enough to include; detectors treat this as "destination-ish".
    if (t === "unknown") {
      for (const a of ix.accounts) {
        if (a.isWritable && !a.isSigner) {
          out.add(a.pubkey);
        }
      }
    }
  }
  return Array.from(out);
}
