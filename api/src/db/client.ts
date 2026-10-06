// Thin wrapper around node-postgres (`pg`) exposing a single shared Pool.
//
// Fail-soft strategy:
//   - If DATABASE_URL is missing or the initial connect() fails, we expose
//     a pool with an informational `isConnected=false` flag so the HTTP
//     layer can still serve requests (it just won't persist anything).
//   - We never crash the process on DB error — hackathon MVP resilience.

import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:postgres@localhost:5432/shieldrpc';

export interface DbState {
  pool: pg.Pool | null;
  isConnected: boolean;
  initializationError: string | null;
}

export const db: DbState = {
  pool: null,
  isConnected: false,
  initializationError: null,
};

/**
 * (Re-)initializes the global shared pool. Safe to call multiple times.
 * Returns a Promise that resolves after the first ping test — if the ping
 * fails the promise still resolves (with `isConnected=false`) rather than
 * rejecting so startup never blocks on DB availability.
 */
export async function initDb(): Promise<DbState> {
  // Teardown any previous pool (handles re-init in tests)
  if (db.pool) {
    try {
      await db.pool.end();
    } catch {
      /* swallow */
    }
    db.pool = null;
  }

  if (!DATABASE_URL) {
    db.isConnected = false;
    db.initializationError = 'DATABASE_URL not set';
    return Object.freeze({ ...db });
  }

  const pool = new pg.Pool({
    connectionString: DATABASE_URL,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 30_000,
  });
  db.pool = pool;

  try {
    const client = await pool.connect();
    await client.query('SELECT 1 AS ok');
    client.release();
    db.isConnected = true;
    db.initializationError = null;
  } catch (err) {
    db.isConnected = false;
    db.initializationError =
      err instanceof Error ? err.message : String(err);
    // Don't tear down the pool on transient failures; caller can retry via initDb().
  }

  return Object.freeze({
    pool: db.pool,
    isConnected: db.isConnected,
    initializationError: db.initializationError,
  } as DbState);
}

/**
 * Runs `fn(client)` inside a transaction. If the DB is not available the
 * function resolves to `null` instead of rejecting.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T | null> {
  if (!db.pool || !db.isConnected) return null;
  let client: pg.PoolClient | null = null;
  try {
    client = await db.pool.connect();
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* swallow */
      }
    }
    throw err;
  } finally {
    client?.release();
  }
}

/** Loads the schema SQL string from api/sql/001_schema.sql. */
export function loadSchemaSql(): string {
  return readFileSync(
    resolve(import.meta.dirname!, '../../sql/001_schema.sql'),
    'utf-8',
  );
}

export async function closeDb(): Promise<void> {
  if (db.pool) {
    await db.pool.end();
    db.pool = null;
    db.isConnected = false;
  }
}
