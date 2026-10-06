#!/usr/bin/env node
/**
 * Seeds the `known_malicious_addresses` table using the fixture hints from
 * `data/fixtures/sample-transactions.json`.
 *
 * This is idempotent (upserts), so you can run it repeatedly.
 *
 * Usage:
 *   cd api
 *   npx tsx scripts/seed-known-malicious.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initDb, closeDb } from '../src/db/client.js';
import { upsertKnownMalicious } from '../src/db/repos.js';

interface Hints {
  blockedAddresses: string[];
  blockedProgramIds: string[];
}

interface Fixture {
  detectorContextHints?: Hints;
}

async function main() {
  const state = await initDb();
  if (!state.isConnected) {
    console.error('FATAL: postgres unavailable:', state.initializationError);
    process.exit(1);
  }

  const path = resolve(
    import.meta.dirname!,
    '../../data/fixtures/sample-transactions.json',
  );
  const fixture: Fixture = JSON.parse(readFileSync(path, 'utf-8'));
  const hints = fixture.detectorContextHints;
  if (!hints) {
    console.error('No detectorContextHints found in fixture. Regenerate fixtures?');
    process.exit(2);
  }

  const rows = [
    ...hints.blockedAddresses.map((a) => ({
      address: a,
      address_type: 'wallet' as const,
      tag: 'fixture-blocked-destination',
      severity: 'high' as const,
      source: 'fixture:seed-script',
    })),
    ...hints.blockedProgramIds.map((a) => ({
      address: a,
      address_type: 'program_id' as const,
      tag: 'fixture-blocked-program',
      severity: 'critical' as const,
      source: 'fixture:seed-script',
    })),
  ];

  const count = await upsertKnownMalicious(rows);
  console.log(`✓ Upserted ${count} rows into known_malicious_addresses`);
  for (const r of rows) {
    console.log(`    ${r.address_type.padEnd(10)} ${r.address}  (${r.severity})`);
  }
  await closeDb();
}

main();
