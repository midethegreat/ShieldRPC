import { describe, it, expect } from 'vitest';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  createApproveInstruction,
  createSetAuthorityInstruction,
  AuthorityType,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createTransferInstruction,
} from '@solana/spl-token';
import { parseTransaction } from '../src/lib/index.js';

function serialize(tx: Transaction): string {
  // Legacy: caller is responsible for partial signing when needed. For parser tests we
  // just need wire-format-compatible bytes; signatures can be empty for legacy.
  return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
}

describe('parser', () => {
  const owner = Keypair.generate();
  const mint = new PublicKey('So11111111111111111111111111111111111111112');

  it('parses a legacy system transfer', () => {
    const dest = Keypair.generate().publicKey;
    const tx = new Transaction().add(
      SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: dest,
      lamports: 1n * BigInt(LAMPORTS_PER_SOL),
    })
    );
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = new PublicKey(Buffer.alloc(32, 1)).toBase58();
    const b64 = serialize(tx);
    const parsed = parseTransaction(b64, { network: 'devnet' });

    expect(parsed.network).toBe('devnet');
    expect(parsed.isVersioned).toBe(false);
    expect(parsed.feePayer).toBe(owner.publicKey.toBase58());
    expect(parsed.instructions).toHaveLength(1);
    const ix = parsed.instructions[0]!;
    expect(ix.programName).toBe('System');
    expect(ix.instructionType).toBe('transfer');
    expect(ix.args.destination).toBe(dest.toBase58());
    expect(ix.args.lamports).toBe((1n * BigInt(LAMPORTS_PER_SOL)).toString());
    expect(parsed.destinationAddresses).toContain(dest.toBase58());
  });

  it('parses a Token approve instruction (unlimited amount)', () => {
    const delegate = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(mint, owner.publicKey);
    const tx = new Transaction().add(
      createApproveInstruction(
        ata,
        delegate,
        owner.publicKey,
        // BigInt as uint64 max = unlimited
        0xffffffffffffffffffffffffffffffffn
      )
    );
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = new PublicKey(Buffer.alloc(32, 2)).toBase58();

    const parsed = parseTransaction(serialize(tx));
    const ix = parsed.instructions.find((i) => i.instructionType === 'approve');
    expect(ix).toBeDefined();
    expect(ix!.args.delegate).toBe(delegate.toBase58());
    expect(ix!.args.source).toBe(ata.toBase58());
    // Should be near-max uint64
    const amt = BigInt(ix!.args.amount as string);
    expect(amt).toBeGreaterThan(1n << 60n);
    expect(parsed.destinationAddresses).toContain(delegate.toBase58());
  });

  it('parses a Token setAuthority instruction', () => {
    const ata = getAssociatedTokenAddressSync(mint, owner.publicKey);
    const newAuth = Keypair.generate().publicKey;
    const tx = new Transaction().add(
      createSetAuthorityInstruction(
        ata,
        owner.publicKey,
        AuthorityType.AccountOwner,
        newAuth
      )
    );
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = new PublicKey(Buffer.alloc(32, 3)).toBase58();

    const parsed = parseTransaction(serialize(tx));
    const ix = parsed.instructions.find((i) => i.instructionType === 'setAuthority');
    expect(ix).toBeDefined();
    expect(ix!.args.authorityType).toBe('AccountOwner');
    expect(ix!.args.newAuthority).toBe(newAuth.toBase58());
    expect(parsed.destinationAddresses).toContain(newAuth.toBase58());
    expect(parsed.referencedProgramIds).toContain(TOKEN_PROGRAM_ID.toBase58());
  });

  it('parses a Token transfer instruction', () => {
    const src = getAssociatedTokenAddressSync(mint, owner.publicKey);
    const dstOwner = Keypair.generate().publicKey;
    const dst = getAssociatedTokenAddressSync(mint, dstOwner);
    const tx = new Transaction().add(
      createTransferInstruction(src, dst, owner.publicKey, 1000n)
    );
    tx.feePayer = owner.publicKey;
    tx.recentBlockhash = new PublicKey(Buffer.alloc(32, 4)).toBase58();
    const parsed = parseTransaction(serialize(tx));
    const ix = parsed.instructions.find((i) => i.instructionType === 'transfer');
    expect(ix).toBeDefined();
    expect(ix!.args.destination).toBe(dst.toBase58());
    expect(ix!.args.amount).toBe('1000');
    expect(parsed.destinationAddresses).toContain(dst.toBase58());
  });
});
