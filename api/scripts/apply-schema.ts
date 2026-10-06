#!/usr/bin/env node
/**
 * Applies the schema in `sql/001_schema.sql` to $DATABASE_URL.
 *
 * Usage (from api/):
 *   npx tsx scripts/apply-schema.ts
 */
import 'dotenv/config';
import { initDb, loadSchemaSql, closeDb, db } from '../src/db/client.js';

async function main() {
  const state = await initDb();
  if (!state.isConnected || !db.pool) {
    console.error('FATAL: could not connect to Postgres:', state.initializationError);
    console.error('  Check DATABASE_URL in .env. For local dev, start Postgres first:');
    console.error('    docker run --name shieldrpc-pg -e POSTGRES_PASSWORD=postgres \\\n' +
                  '       -e POSTGRES_DB=shieldrpc -p 5432:5432 -d postgres:16-alpine');
    process.exit(1);
  }
  const sql = loadSchemaSql();
  try {
    await db.pool.query(sql);
    console.log('✓ Applied schema (001_schema.sql)');
  } catch (err) {
    console.error('Schema apply FAILED:', err instanceof Error ? err.message : err);
    process.exit(2);
  } finally {
    await closeDb();
  }
}

main();
