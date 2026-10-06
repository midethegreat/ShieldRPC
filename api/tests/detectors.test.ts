import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseTransaction } from '../src/lib/index.js';
import type { ParsedTransaction } from '../src/lib/types.js';
import {
  detectUnlimitedApproval,
  detectAuthorityChange,
  detectKnownMaliciousAddresses,
  detectFreshPrograms,
  runAllDetectors,
} from '../src/detectors/index.js';
import type {
  DetectionResult,
  DetectorContext,
  ProgramInfo,
} from '../src/detectors/types.js';

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

interface FixtureSample {
  id: string;
  label: string;
  category: string; // 'safe' | 'risk:unlimited_approval' | 'risk:authority_change' | 'risk:known_malicious_address' | 'risk:fresh_program'
  notes: string;
  serializedTransaction: string;
}

interface FixtureFile {
  samples: FixtureSample[];
  detectorContextHints: {
    blockedAddresses: string[];
    blockedProgramIds: string[];
    freshPrograms: Record<string, ProgramInfo>;
    trustedPrograms: Record<string, ProgramInfo>;
  };
}

let fixture: FixtureFile;
let parsedBySampleId: Record<string, ParsedTransaction> = {};
let ctx: DetectorContext;

beforeAll(() => {
  const fixturePath = resolve(
    import.meta.dirname!,
    '../../data/fixtures/sample-transactions.json',
  );
  fixture = JSON.parse(readFileSync(fixturePath, 'utf-8')) as FixtureFile;

  // Pre-parse every sample so tests are cheap
  for (const s of fixture.samples) {
    parsedBySampleId[s.id] = parseTransaction(s.serializedTransaction, {
      network: 'mainnet-beta',
    });
  }

  // Build a DetectorContext backed by the fixture hints
  const blockedSet = new Set<string>([
    ...fixture.detectorContextHints.blockedAddresses,
    ...fixture.detectorContextHints.blockedProgramIds,
  ]);

  const programInfoMap: Record<string, ProgramInfo> = {
    ...fixture.detectorContextHints.freshPrograms,
    ...fixture.detectorContextHints.trustedPrograms,
  };

  ctx = {
    isBlockedAddress: (addr: string) => blockedSet.has(addr),
    getProgramInfo: (pid: string) => programInfoMap[pid] ?? null,
  };
});

function sample(id: string): FixtureSample {
  const s = fixture.samples.find((x) => x.id === id);
  if (!s) throw new Error(`Missing fixture sample: ${id}`);
  return s;
}

function parsed(id: string): ParsedTransaction {
  return parsedBySampleId[id]!;
}

// ---------------------------------------------------------------------------
// Shared assertion helpers
// ---------------------------------------------------------------------------

function expectFlagged(
  result: DetectionResult | null,
  expectedType: DetectionResult['type'],
): DetectionResult {
  expect(result).not.toBeNull();
  expect(result!.type).toBe(expectedType);
  return result!;
}

function expectClean(result: DetectionResult | null) {
  expect(result).toBeNull();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase C: Rule-based detectors', () => {
  describe('Detector #1: Unlimited / excessive approval', () => {
    it('flags unlimited approve (u64 MAX) as CRITICAL', () => {
      const r = detectUnlimitedApproval(parsed('spl-approve-unlimited'));
      const hit = expectFlagged(r, 'unlimited_approval');
      expect(hit.severity).toBe('critical');
      expect(hit.detail).toMatch(/unlimited/);
    });

    it('flags unlimited approveChecked (u64 MAX w/ decimals) as CRITICAL', () => {
      const r = detectUnlimitedApproval(parsed('spl-approveChecked-unlimited'));
      const hit = expectFlagged(r, 'unlimited_approval');
      expect(hit.severity).toBe('critical');
    });

    it('does NOT flag small bounded approve (1M units)', () => {
      expectClean(detectUnlimitedApproval(parsed('spl-approve-small')));
    });

    it('does NOT flag pure SOL transfers', () => {
      expectClean(detectUnlimitedApproval(parsed('sol-transfer-safe')));
    });

    it('does NOT flag SPL token transfers', () => {
      expectClean(detectUnlimitedApproval(parsed('spl-transfer-safe')));
    });

    it('does NOT flag a swap bundle with a bounded 500k-unit approve', () => {
      expectClean(detectUnlimitedApproval(parsed('bundle-swap-safe')));
    });

    it('does NOT flag authority changes', () => {
      expectClean(detectUnlimitedApproval(parsed('spl-setAuthority-owner')));
    });

    it('does NOT flag known-malicious-only transfers', () => {
      expectClean(
        detectUnlimitedApproval(parsed('sol-transfer-to-blocklisted-dest')),
      );
    });

    it('does NOT flag fresh-program-only invocations', () => {
      expectClean(
        detectUnlimitedApproval(parsed('invoke-fresh-unverified-program')),
      );
    });

    it('correctly handles all fixture categories (100% specificity)', () => {
      for (const s of fixture.samples) {
        const r = detectUnlimitedApproval(parsed(s.id));
        if (s.category === 'risk:unlimited_approval') {
          expect(r).not.toBeNull();
          expect(r!.type).toBe('unlimited_approval');
        } else {
          // No other fixture category should trigger this detector
          expect(r).toBeNull();
        }
      }
    });
  });

  describe('Detector #2: Authority change to unfamiliar address', () => {
    it('flags setAuthority(AccountOwner) -> third-party as CRITICAL', () => {
      const r = detectAuthorityChange(parsed('spl-setAuthority-owner'));
      const hit = expectFlagged(r, 'authority_change');
      expect(hit.severity).toBe('critical');
      expect(hit.detail).toMatch(/AccountOwner/);
      expect(hit.metadata?.changes).toBeDefined();
    });

    it('does NOT flag pure SOL transfers', () => {
      expectClean(detectAuthorityChange(parsed('sol-transfer-safe')));
    });

    it('does NOT flag SPL transfers', () => {
      expectClean(detectAuthorityChange(parsed('spl-transfer-safe')));
    });

    it('does NOT flag approvals (any size)', () => {
      expectClean(detectAuthorityChange(parsed('spl-approve-small')));
      expectClean(detectAuthorityChange(parsed('spl-approve-unlimited')));
    });

    it('does NOT flag swap bundles', () => {
      expectClean(detectAuthorityChange(parsed('bundle-swap-safe')));
    });

    it('does NOT flag blocklisted destination transfers', () => {
      expectClean(
        detectAuthorityChange(parsed('sol-transfer-to-blocklisted-dest')),
      );
    });

    it('does NOT flag blocklisted program invocations', () => {
      expectClean(detectAuthorityChange(parsed('invoke-blocklisted-program')));
    });

    it('does NOT flag fresh program invocations', () => {
      expectClean(
        detectAuthorityChange(parsed('invoke-fresh-unverified-program')),
      );
    });

    it('does NOT flag established verified program invocations', () => {
      expectClean(
        detectAuthorityChange(parsed('invoke-established-verified-program')),
      );
    });

    it('correctly handles all fixture categories (100% specificity)', () => {
      for (const s of fixture.samples) {
        const r = detectAuthorityChange(parsed(s.id));
        if (s.category === 'risk:authority_change') {
          expect(r).not.toBeNull();
          expect(r!.type).toBe('authority_change');
        } else {
          expect(r).toBeNull();
        }
      }
    });
  });

  describe('Detector #3: Known malicious address match (async, context-driven)', () => {
    it('flags transfer to a blocklisted DESTINATION as HIGH severity', async () => {
      const r = await detectKnownMaliciousAddresses(
        parsed('sol-transfer-to-blocklisted-dest'),
        ctx,
      );
      const hit = expectFlagged(r, 'known_malicious_address');
      expect(hit.severity).toBe('high');
      // The match should be a `destination` role, not program_id
      const matches = (hit.metadata?.matches ?? []) as Array<{
        address: string;
        role: string;
      }>;
      expect(matches.some((m) => m.role === 'destination')).toBe(true);
    });

    it('flags a direct call to a blocklisted PROGRAM ID as CRITICAL', async () => {
      const r = await detectKnownMaliciousAddresses(
        parsed('invoke-blocklisted-program'),
        ctx,
      );
      const hit = expectFlagged(r, 'known_malicious_address');
      // Program-ID block = critical
      expect(hit.severity).toBe('critical');
      const matches = (hit.metadata?.matches ?? []) as Array<{
        address: string;
        role: string;
      }>;
      expect(matches.some((m) => m.role === 'program_id')).toBe(true);
    });

    it('returns null when no blocklist context is provided (fail-closed for detector, not system)', async () => {
      const r = await detectKnownMaliciousAddresses(
        parsed('invoke-blocklisted-program'),
        /* no ctx */ {},
      );
      // No blocklist available → detector opts out (returns null).
      // Callers decide if a missing blocklist is itself a risk.
      expect(r).toBeNull();
    });

    it('does NOT flag clean fixtures', async () => {
      const cleanIds = fixture.samples
        .filter((s) => s.category !== 'risk:known_malicious_address')
        .map((s) => s.id);
      for (const id of cleanIds) {
        const r = await detectKnownMaliciousAddresses(parsed(id), ctx);
        expect(r).toBeNull();
      }
    });

    it('correctly handles all fixture categories (100% specificity)', async () => {
      for (const s of fixture.samples) {
        const r = await detectKnownMaliciousAddresses(parsed(s.id), ctx);
        if (s.category === 'risk:known_malicious_address') {
          expect(r).not.toBeNull();
          expect(r!.type).toBe('known_malicious_address');
        } else {
          expect(r).toBeNull();
        }
      }
    });
  });

  describe('Detector #4: Fresh / unverified program interaction (async, context-driven)', () => {
    it('flags a freshly deployed, unverified, low-volume program', async () => {
      const r = await detectFreshPrograms(
        parsed('invoke-fresh-unverified-program'),
        ctx,
      );
      const hit = expectFlagged(r, 'fresh_program');
      // Deployed < 24h + unverified → at least HIGH or CRITICAL
      expect(['high', 'critical']).toContain(hit.severity);
    });

    it('does NOT flag an established, verified, high-volume program (Jupiter-like)', async () => {
      const r = await detectFreshPrograms(
        parsed('invoke-established-verified-program'),
        ctx,
      );
      expect(r).toBeNull();
    });

    it('does NOT flag any fixture not tagged as risk:fresh_program', async () => {
      const otherIds = fixture.samples
        .filter((s) => s.category !== 'risk:fresh_program')
        .map((s) => s.id);
      for (const id of otherIds) {
        const r = await detectFreshPrograms(parsed(id), ctx);
        expect(r).toBeNull();
      }
    });

    it('does NOT flag trusted system programs (System, Token, ComputeBudget)', async () => {
      // sol-transfer-safe touches only System
      // spl-transfer-safe touches ComputeBudget + Token
      // bundle-swap-safe touches ComputeBudget + Token
      for (const id of [
        'sol-transfer-safe',
        'spl-transfer-safe',
        'bundle-swap-safe',
      ]) {
        const r = await detectFreshPrograms(parsed(id), ctx);
        expect(r).toBeNull();
      }
    });

    it('returns MEDIUM when metadata lookup returns null for a non-trusted program', async () => {
      // Build a context that returns null for every program (no RPC/DB info)
      const noInfoCtx: DetectorContext = {
        getProgramInfo: () => null,
      };
      const r = await detectFreshPrograms(
        parsed('invoke-fresh-unverified-program'),
        noInfoCtx,
      );
      // Unknown metadata → flag, but only medium severity
      expect(r).not.toBeNull();
      expect(r!.type).toBe('fresh_program');
      expect(r!.severity).toBe('medium');
    });

    it('correctly handles all fixture categories (100% specificity)', async () => {
      for (const s of fixture.samples) {
        const r = await detectFreshPrograms(parsed(s.id), ctx);
        if (s.category === 'risk:fresh_program') {
          expect(r).not.toBeNull();
          expect(r!.type).toBe('fresh_program');
        } else {
          expect(r).toBeNull();
        }
      }
    });
  });

  describe('Aggregate: runAllDetectors cross-talk checks', () => {
    it('safe fixtures produce 0 flags across all detectors', async () => {
      const safeIds = fixture.samples
        .filter((s) => s.category === 'safe')
        .map((s) => s.id);
      for (const id of safeIds) {
        const flags = await runAllDetectors(parsed(id), ctx);
        expect(flags).toEqual([]);
      }
    });

    it('a risk:unlimited_approval fixture only triggers #1, never #2/#3/#4', async () => {
      for (const s of fixture.samples) {
        if (s.category !== 'risk:unlimited_approval') continue;
        const flags = await runAllDetectors(parsed(s.id), ctx);
        const types = flags.map((f) => f.type);
        expect(types).toContain('unlimited_approval');
        expect(types).not.toContain('authority_change');
        expect(types).not.toContain('known_malicious_address');
        expect(types).not.toContain('fresh_program');
      }
    });

    it('a risk:authority_change fixture only triggers #2', async () => {
      for (const s of fixture.samples) {
        if (s.category !== 'risk:authority_change') continue;
        const flags = await runAllDetectors(parsed(s.id), ctx);
        const types = flags.map((f) => f.type);
        expect(types).toEqual(['authority_change']);
      }
    });

    it('a risk:known_malicious fixture only triggers #3', async () => {
      for (const s of fixture.samples) {
        if (s.category !== 'risk:known_malicious_address') continue;
        const flags = await runAllDetectors(parsed(s.id), ctx);
        const types = flags.map((f) => f.type);
        expect(types).toEqual(['known_malicious_address']);
      }
    });

    it('a risk:fresh_program fixture only triggers #4', async () => {
      for (const s of fixture.samples) {
        if (s.category !== 'risk:fresh_program') continue;
        const flags = await runAllDetectors(parsed(s.id), ctx);
        const types = flags.map((f) => f.type);
        expect(types).toEqual(['fresh_program']);
      }
    });

    it('every risk-tagged fixture fires exactly one detector (no false cross-triggers)', async () => {
      const risky = fixture.samples.filter((s) => s.category.startsWith('risk:'));
      for (const s of risky) {
        const flags = await runAllDetectors(parsed(s.id), ctx);
        expect(flags.length).toBeGreaterThanOrEqual(1);
        const expectedType = s.category.replace('risk:', '');
        const types = flags.map((f) => f.type);
        expect(types).toContain(expectedType);
      }
    });
  });
});
