-- ShieldRPC schema — Phase D: Postgres tables for transaction logging,
-- malicious-address blocklist, and human-in-the-loop feedback.
--
-- Load with:
--   psql $DATABASE_URL -f api/sql/001_schema.sql
-- or via `npm run db:migrate` (see package.json).

-- ---------------------------------------------------------------------------
-- Postgres best-practice baseline
-- ---------------------------------------------------------------------------
SET client_min_messages TO warning;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- uuid-ossp fallback
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ---------------------------------------------------------------------------
-- known_malicious_addresses — maintained blocklist.
-- Detector #3 scans every instruction's program id + every destination/
-- account against this table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS known_malicious_addresses (
    id              BIGSERIAL PRIMARY KEY,
    address         TEXT NOT NULL UNIQUE,
    -- "program_id" | "wallet" | "token_mint" | "other"
    address_type    TEXT NOT NULL DEFAULT 'wallet',
    tag             TEXT,            -- e.g. "phantom-drainer-v17", "rug-mint-2024"
    severity        TEXT NOT NULL DEFAULT 'high',  -- "high" | "critical"
    source          TEXT,            -- e.g. "scamsniffer", "manual", "community"
    first_reported_at TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kma_address ON known_malicious_addresses(address);
CREATE INDEX IF NOT EXISTS idx_kma_severity ON known_malicious_addresses(severity);

-- ---------------------------------------------------------------------------
-- scored_transactions — every response from POST /v1/analyze-transaction.
-- The dashboard live feed reads this table; Phase F ML blending logs here too.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scored_transactions (
    id              BIGSERIAL PRIMARY KEY,
    -- User-provided network ("mainnet-beta" | "devnet" | ...)
    network         TEXT NOT NULL,

    -- Transaction fingerprint — first signature of the serialized tx, if any.
    -- May be null for unsigned txs.
    signature       TEXT,

    -- Stable hash of the serialized tx bytes so we can dedupe if needed.
    transaction_hash TEXT NOT NULL,

    -- Fee payer / signer of the transaction, if extractable
    fee_payer       TEXT,

    -- Risk outputs from the API
    risk_score      SMALLINT NOT NULL,   -- 0-100
    risk_level      TEXT NOT NULL,       -- 'low' | 'medium' | 'high' | 'critical'
    recommendation  TEXT NOT NULL,       -- 'allow' | 'warn' | 'block'
    explanation     TEXT NOT NULL,

    -- Array of detection-flag objects, stored as JSONB so we can query inside
    -- them for stats later (e.g. "how many drainer approvals this week").
    flags           JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- Full serialized base64 transaction — useful for replaying / training.
    -- Can be large, so it's nullable and truncated at the 10mb Express limit.
    serialized_transaction TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_st_created_at ON scored_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_st_risk_level ON scored_transactions(risk_level);
CREATE INDEX IF NOT EXISTS idx_st_network ON scored_transactions(network);
CREATE INDEX IF NOT EXISTS idx_st_signature ON scored_transactions(signature);
CREATE INDEX IF NOT EXISTS idx_st_hash ON scored_transactions(transaction_hash);

-- ---------------------------------------------------------------------------
-- feedback — human-in-the-loop corrections from the dashboard "mark false
-- positive" button. Phase F ML retraining pipeline can consume this stream.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feedback (
    id              BIGSERIAL PRIMARY KEY,
    scored_transaction_id BIGINT NOT NULL REFERENCES scored_transactions(id) ON DELETE CASCADE,
    -- 'false_positive' | 'false_negative' | 'note'
    feedback_type   TEXT NOT NULL,
    comment         TEXT,
    reporter        TEXT,            -- freeform: email, pubkey, session id
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fb_tx_id ON feedback(scored_transaction_id);
CREATE INDEX IF NOT EXISTS idx_fb_type ON feedback(feedback_type);

ALTER TABLE feedback ADD COLUMN IF NOT EXISTS retraining_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE feedback ADD COLUMN IF NOT EXISTS model_version TEXT NULL;

-- ---------------------------------------------------------------------------
-- program_metadata — on-chain program deployment info and verification state.
-- Populated by the background program-indexer job; consumed by dashboards.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS program_metadata (
    id                  BIGSERIAL PRIMARY KEY,
    program_id          TEXT UNIQUE NOT NULL,
    deployed_at         BIGINT NULL,
    transaction_count   BIGINT NULL,
    verified            BOOLEAN NOT NULL DEFAULT FALSE,
    display_name        TEXT NULL,
    source              TEXT NULL,
    fetched_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pm_program_id ON program_metadata(program_id);
CREATE INDEX IF NOT EXISTS idx_pm_verified ON program_metadata(verified);
CREATE INDEX IF NOT EXISTS idx_pm_fetched_at ON program_metadata(fetched_at);
