# ShieldRPC Submission-Ready — Specification

## Problem & Context

ShieldRPC (AI-powered Solana transaction risk-scoring API + Dashboard + SDK) is
structurally complete but missing the wiring that turns "local scaffold" into
"production-submittable project":

- Dashboard search and table filters are placeholders.
- `DetectorContext.getProgramInfo` returns `null` permanently → Detector #4
  (fresh-program) never deploys real metadata, only fires MEDIUM via the
  `no_program_metadata` path.
- ML service ships a heuristic stub; no trained model, no retraining pipeline,
  no persisted model artifact.
- Feedback write stream has no consumer.
- No rate limiting, no auth, no CI, no SDK mini-dApp demo.
- Deployment Compose stack works but the seed scripts, schema extension, and
  production hardening need to land before real submission.

## Users

1. **Judge / reviewer of the submission** → opens repo, runs `docker compose
   up --build`, sees a feature-complete dashboard with real data, can submit
   transactions for analysis, and reads a coherent README.
2. **End-user (wallet dApp integrator)** → can `npm i @shieldrpc/sdk`, drop it
   into a wallet adapter demo, and see risk scoring work live.
3. **Contributor** → opens a PR, CI runs typecheck + tests automatically, and
   the contributor sees failures before merge.

## Goals

Make the repository submission-ready across three axes by shipping real code:

1. **Coding completeness** — all scaffolded placeholders ship working code.
2. **Deployment readiness** — `docker compose up --build` produces a working,
   seeded, persisted, production-like stack on a bare machine with Docker.
3. **Quality & polish** — dashboard UX, API hardening, CI, and a demo dApp make
   the project feel finished rather than a scaffold.

## Non-Goals

- Writing a blockchain node or custom RPC. Solana metadata lookups use existing
  public RPCs.
- Training a production-grade ML model on millions of labelled samples. A
  deterministic baseline trained on the in-repo fixtures is sufficient.
- Publishing to npm for real — the SDK must be **publishable** (builds, clean
  package.json, correct files entry), but actual `npm publish` is out of scope.
- Full user authentication system. The `/analyze-transaction` endpoint uses a
  single shared token in `API_SHARED_TOKEN`, not multi-tenant auth.

---

## Functional Requirements

### FR1 — Dashboard Search + Table UX
**FR1.1** Top bar search input filters transactions on the Transactions page by
signature, fee_payer, or explanation (case-insensitive substring), with live
results and an empty state.
**FR1.2** Transactions page exposes a risk-level filter dropdown (`All / Low /
Medium / High / Critical`) and a recommendation filter dropdown (`All / Allow /
Warn / Block`), plus per-column clickable sort toggles on the `Created at` and
`Risk score` columns.
**FR1.3** Drawer-level search input ("Paste a signature or transaction hash…")
accepts a signature and fetches the row via `GET /v1/transactions/:hash`.

### FR2 — Program Metadata Lookups
**FR2.1** A new `program_metadata` Postgres table exists with columns for
program_id, deployed_at, transaction_count, verified, display_name, source,
fetched_at.
**FR2.2** `DetectorContext.getProgramInfo` first reads an in-memory LRU cache
(60s TTL), then the `program_metadata` DB table, then a Solana RPC lookup for
`BPFLoaderUpgradeab1e111…` program-data accounts (derive deployedAt from the
slot), writes the result back to the DB, and returns a `ProgramInfo`.
**FR2.3** In fail-soft mode (DB down, RPC unreachable), `getProgramInfo`
returns `null` without throwing, preserving today's behaviour.

### FR3 — Real ML Model + Retraining Pipeline
**FR3.1** `ml-service/` ships a deterministic baseline model (scikit-learn
GradientBoostingClassifier) trained on the `sample-transactions.json` fixtures
+ synthetic negatives, pickled to `ml-service/models/risk_model.pkl`.
**FR3.2** A `train.py` script reproduces the pickle and runs as part of the ML
Docker build.
**FR3.3** `/score-features` uses the trained pickle when present, falls back to
the heuristic when not, and returns `{"model_version": "gb_v1_2026-10-05"}`
metadata.
**FR3.4** A `retrain.py` nightly script consumes `feedback` +
`scored_transactions` rows (with feedback_type='false_positive' /
'false_negative') to relabel a training set and emit a new pickle.
**FR3.5** An authenticated `/admin/reload-model` endpoint hot-reloads the
pickle without a restart.

### FR4 — Feedback Retraining Loop
**FR4.1** `GET /v1/feedback/export` returns a CSV/JSONL stream of feedback +
joined scored_transactions rows, for human review or retraining input.
**FR4.2** A new `feedback.retraining_status` column +
`POST /v1/feedback/:id/retraining-status` endpoint track which feedback rows
have been incorporated into a model version.

### FR5 — SDK Publishable + Mini-dApp Demo
**FR5.1** `@shieldrpc/sdk` package: correct `main`/`types`/`files` in
`package.json`, `build` script produces `dist/index.js` +
`dist/index.d.ts`, `npm pack` completes without errors or unintended files.
**FR5.2** A new top-level `demo-wallet/` folder contains a 1-page Vite + React
wallet-adapter dApp that prompts a "mock approve 1M USDC to drainer" button,
runs the transaction through `shieldSdk.analyze()`, and shows the BLOCK/WARN
overlay as a real integration example.
**FR5.3** SDK exports a `ShieldSdk` class with `constructor({ apiBase,
apiToken })` + `analyze(tx)` + `analyzeSerialized(base64Tx)` + on-the-wire
error handling matching the dashboard's `submitFeedback` friendly-error
pattern.

### FR6 — API Hardening
**FR6.1** `express-rate-limit` middleware is applied globally (windowMs 60s,
max 120) and stricter on `/analyze-transaction` (windowMs 60s, max 30 per IP).
**FR6.2** If `API_SHARED_TOKEN` env var is set, every `/v1/*` endpoint except
`/v1/health` requires an `Authorization: Bearer <token>` header, otherwise
401. Fail-soft: if not set, no auth is required (preserves local dev).
**FR6.3** All 4xx/5xx responses use a consistent envelope `{ error: string,
message: string, request_id?: string }` with a unique `x-request-id` header on
every response.
**FR6.4** Request payload size on `/analyze-transaction` is validated (max
2MB) and a body-schema validator rejects non-object bodies.

### FR7 — Blocklist Automation
**FR7.1** A new `api/scripts/sync-blocklist-sources.ts` script fetches
community lists (Scam Sniffer public drainer JSON, a small curated public
dataset in `data/blocklists/`) and upserts into `known_malicious_addresses`
with `source='scamsniffer'` etc. Idempotent + safe to rerun.
**FR7.2** The docker compose stack adds a `blocklist-sync` one-shot init
container that runs the sync before the API boots.

### FR8 — CI/CD Workflow
**FR8.1** `.github/workflows/ci.yml` runs on PRs and main:
  - `npm install` workspace root
  - `npm run typecheck`
  - `npm run test` (vitest api tests)
  - `npm run build` in api, sdk, dashboard
  - `pip install -r ml-service/requirements.txt` +
    `python -c "import main"` syntax smoke
  - `docker build` for api + ml services (if docker available)
**FR8.2** A `deploy-vercel.md`/`deploy-flyio.md` pair in `docs/` with concrete
copy-paste steps for the submission reviewer.

### FR9 — Deployment Verification
**FR9.1** README top-level shows a one-line startup (`docker compose up
--build`) and documents every endpoint URL inside that compose stack:
Dashboard :8080, API :3001/v1/health, ML :8000/health, Postgres :5432.
**FR9.2** A `verify-deploy.sh` (or Windows `verify-deploy.ps1`) script curls
every endpoint and runs a fixture analyze, prints a green/red summary.
**FR9.3** Schema migration for the new `program_metadata` +
`feedback.retraining_status` columns is baked into `001_schema.sql` with
`CREATE TABLE IF NOT EXISTS` / `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.

---

## Non-Functional Requirements

- **NFR1** — No test regressions: every existing 56 tests still pass after all
  changes.
- **NFR2** — Typecheck 0 errors across api/dashboard/sdk after every task.
- **NFR3** — Fail-soft preserved: if DB, ML, or RPC are unreachable, the API
  still returns a valid risk score (never hard-fails an `/analyze-transaction`
  request on infra).
- **NFR4** — No new AI/PLACEHOLDER comments introduced.
- **NFR5** — Dashboard production bundle size increase < 40KB gzipped vs. today
  (currently 87KB gzipped).
- **NFR6** — All new routes typed via Express `Request<…>` generic handlers,
  all SQL queries go through existing `db/query` wrapper (no raw pg.driver
  usage outside `db/client.ts`).

---

## Constraints, Dependencies, Assumptions

- Docker Compose is the primary deployment target (judge runs locally).
- Scikit-learn is the only new Python dependency beyond FastAPI/Uvicorn/Pydantic.
- No paid third-party APIs are required; fresh-program RPC lookup uses a
  public Solana endpoint and is best-effort with fail-soft.
- Demo wallet dApp uses the public `@solana/wallet-adapter-react` stack with a
  mock wallet (no real private keys needed for the demo).

---

## Acceptance Criteria

### Rule ACs (objectively verifiable)

| ID | Rule |
|---|---|
| AC-R1 | `GET /v1/health` returns `status: ok` inside `docker compose up --build` stack after 60s boot. |
| AC-R2 | POST of an unlimited-approval fixture to `/v1/analyze-transaction` in the compose stack returns `riskScore >= 75`, `riskLevel = 'critical'`, `recommendation = 'block'`, and a non-null `storedTransactionId`. |
| AC-R3 | `npm run typecheck` exits 0 after all tasks. |
| AC-R4 | `npm run test` inside `/api` exits 0 (≥ 56 tests passing). |
| AC-R5 | Dashboard "Top search" filters transactions list live, ignoring case, by signature / fee_payer / explanation substring. |
| AC-R6 | Transactions page "Risk Level" dropdown filters show only matching rows (Critical filter → 0 Low rows). |
| AC-R7 | Transactions page "Risk score" column header click toggles sort asc/desc. |
| AC-R8 | `program_metadata` table exists after applying `001_schema.sql` and columns match FR2.1. |
| AC-R9 | `DetectorContext.getProgramInfo` returns a `ProgramInfo` for
  `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` (with verified=true via
  TRUSTED_PROGRAMS short-circuit OR DB seed) and returns null for a clearly
  bogus program ID without throwing. |
| AC-R10 | `ml-service/models/risk_model.pkl` exists and `/score-features`
  returns `model_version` matching the retrained pickle. |
| AC-R11 | `@shieldrpc/sdk` `npm run build` succeeds and `npm pack`
  produces a tarball containing only `package.json`, `README.md`,
  `dist/index.js`, `dist/index.d.ts`. |
| AC-R12 | Demo wallet dApp `npm run build` succeeds; home page renders a
  "Mock Approve" button and clicking it invokes `shieldSdk.analyze()` (verified
  via `vite dev` network tab in automated smoke or by inspecting the handler
  code). |
| AC-R13 | With `API_SHARED_TOKEN` set, `/v1/analyze-transaction` without
  auth returns 401; with the correct Bearer returns 200. Without the env var
  set, the same endpoint returns 200 with no auth. |
| AC-R14 | 60s, >121 requests → 429 from global rate limiter (can be
  demonstrated by lowering limits in a unit test). |
| AC-R15 | `.github/workflows/ci.yml` exists; `yaml` syntax valid; all 8
  jobs listed in FR8.1 are present as steps. |
| AC-R16 | `sync-blocklist-sources.ts` script exists, runs without error
  against the fixture data, and upserts ≥1 row into `known_malicious_addresses`
  when pointed at a local `data/blocklists/` directory. |
| AC-R17 | README.md contains a single-line quickstart that runs the
  compose stack, plus a table listing all 4 endpoints + ports. |
| AC-R18 | `verify-deploy.ps1` or equivalent script exits 0 if all
  endpoints are healthy and analyze works; non-zero with a clear message on
  any failure. |
| AC-R19 | GET `/v1/feedback/export` returns a valid JSONL array, even
  with 0 feedback rows. |
| AC-R20 | Every new error response in `app.ts` returns a JSON envelope
  with the `error` key. |

### Rubric ACs (evaluative quality dimensions, pass threshold ≥ 3/4)

| ID | Rubric | Threshold |
|---|---|---|
| AC-U1 | Dashboard search UX: results update without reload, empty state is informative, keyboard Enter works. | ≥ 3/4 — smooth, no reload, clear empty state, search-as-you-type with debounce. |
| AC-U2 | SDK API ergonomics: 3 lines of code to get a risk score from a base64 serialized transaction; error messages match the dashboard friendly errors. | ≥ 3/4 — minimal config, typed return values, friendly error unwrapping. |
| AC-U3 | CI file robustness: runs install/build/test on both push/PR; reports build status cleanly; matrix Node version ≥ 2 LTS options. | ≥ 3/4 — runs on push + PR, caches node_modules, explicit fail. |
| AC-U4 | Security hardening completeness: rate limits applied, auth respects env-var gating, response envelope consistent, request-id traceable in logs. | ≥ 3/4 — all 4 items land with working tests for ≥ 2. |
| AC-U5 | Compose-stack reproducibility: documented ports, healthchecks, init containers in right order, reviewer sees seeded dash data on first boot. | ≥ 3/4 — healthchecks present, seeded on first load, documented. |
