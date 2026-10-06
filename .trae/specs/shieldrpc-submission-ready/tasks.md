# ShieldRPC Submission-Ready — Implementation Tasks

Mapped to the Acceptance Criteria in `spec.md`.

Priority key: `high` → blocks submission review; `medium` → reviewer-visible polish;
`low` → nice-to-have but skippable if time is tight.

Task headings are stable identifiers (never embed status in heading). Use the
`Status:` field below each heading for lifecycle state.

---

## Task 1: DB schema extensions (program_metadata + feedback columns)

- **Priority**: high
- **Status**: pending
- **Depends on**: none
- **Covers**: AC-R8, AC-U5
- **Files**: `api/sql/001_schema.sql`, `api/src/db/repos.ts`
- **Description**: Add `program_metadata` table per FR2.1 and
  `feedback.retraining_status` + `feedback.model_version` columns per FR4.2.
  Add repo helpers `insertProgramMetadata()`, `getProgramMetadata(pid)`,
  `upsertProgramMetadata()`, plus `setFeedbackRetrainingStatus()`. All SQL in
  schema file uses `IF NOT EXISTS` so the migration is idempotent; test via
  `apply-schema.ts` on a blank DB.

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 1-TR1 | rule | `npx tsx api/scripts/apply-schema.ts` runs 0 exit code on fresh DB and on rerun (idempotent). |
| 1-TR2 | rule | Querying `information_schema.columns` confirms `program_metadata` has 7 columns per FR2.1. |
| 1-TR3 | rule | `feedback` table has `retraining_status` + `model_version` after apply-schema. |
| 1-TR4 | rule | Existing tests still pass (`npm run test` in api) without DB (repos use `query()` wrapper that fail-softs). |

---

## Task 2: DetectorContext — real getProgramInfo (cache → DB → RPC)

- **Priority**: high
- **Status**: pending
- **Depends on**: Task 1
- **Covers**: AC-R9, NFR3
- **Files**: `api/src/services/detector-context.ts`, `api/src/lib/programs.ts`
- **Description**: Replace the `getProgramInfo` stub with a 3-tier lookup.
  Add a simple `Map`-based LRU cache (pid → ProgramInfo, 60s TTL). On cache
  miss, try the DB `program_metadata` table. On DB miss, try a Solana RPC
  `getAccountInfo` call against `BPFLoaderUpgradeab1e111…` deriving
  `deployedAt` from the slot (map slot → unix seconds via `getSlotLeaders` or
  a cached slot-time estimate). Fail-soft: any level of the chain throws → log
  once, return `null` (never throw upward to detector). Add a short-circuit
  for TRUSTED_PROGRAMS (return verified=true immediately, no DB/RPC hit).

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 2-TR1 | rule | Unit test for TRUSTED_PROGRAMS short-circuit → `verified=true` in < 1ms (no network). |
| 2-TR2 | rule | Unit test with injected stub context → known pid returns stubbed ProgramInfo. |
| 2-TR3 | rule | Unit test with DB disconnected, RPC mocked to throw → returns `null` without throwing. |
| 2-TR4 | rubric | Fail-soft robustness → 2/2: no detector throws when all tiers fail; 1/2: some errors leak; 0/2: breaks detection. Threshold ≥ 2/2. |

---

## Task 3: Blocklist sources sync script + init container

- **Priority**: medium
- **Status**: pending
- **Depends on**: Task 1
- **Covers**: AC-R16, AC-U5
- **Files**: `api/scripts/sync-blocklist-sources.ts`, `data/blocklists/scamsniffer-public.json`, `docker-compose.yml`
- **Description**: Write `sync-blocklist-sources.ts` that reads JSON file(s)
  from `data/blocklists/` (add a sample Scam Sniffer-format public list with
  ~10-20 fixture drainer addresses) and upserts via
  `upsertKnownMalicious()`. Call external URLs only if an env var
  `BLOCKLIST_REMOTE_SYNC=1` is set (avoid network in sealed submission
  environments). Add a `blocklist-sync` docker compose service that runs
  once, depends_on `postgres:healthy`, then exits 0.

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 3-TR1 | rule | Running `BLOCKLIST_REMOTE_SYNC=0 npx tsx api/scripts/sync-blocklist-sources.ts` upserts ≥10 rows, exits 0, rerun is a no-op (count identical). |
| 3-TR2 | rule | `docker compose config blocklist-sync` shows `depends_on: postgres: condition: service_healthy`. |
| 3-TR3 | rule | Seeded rows appear in API: a fixture tx hitting a seeded address → Detector 3 known_malicious flag fires. |

---

## Task 4: Rate limiting + shared-token auth + error envelope

- **Priority**: high
- **Status**: pending
- **Depends on**: none (orthogonal)
- **Covers**: AC-R13, AC-R14, AC-R20, AC-U4, NFR3
- **Files**: `api/src/app.ts`, `api/src/middleware/` (new folder), `api/tests/api.test.ts`
- **Description**: Add three middlewares. (1) RequestId: `x-request-id`
  header + attaches `req.requestId` for logs, response envelope includes
  `request_id`. (2) Rate-limit: global 120/60s via `express-rate-limit`,
  stricter 30/60s on POST `/v1/analyze-transaction`; unit-testable by lowering
  limits per-request via header override in test-only mode. (3) Shared-token
  auth: if `API_SHARED_TOKEN` is set, every route except `/v1/health` requires
  `Authorization: Bearer <token>`; if missing → 401 envelope. Normalize all
  error routes (`404`, body parser errors, `413` payload too large, 5xx) to
  the `{ error, message, request_id }` envelope.

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 4-TR1 | rule | Test: set API_SHARED_TOKEN=test, POST analyze without header → 401 + envelope; with correct header → 200. |
| 4-TR2 | rule | Test: unset API_SHARED_TOKEN, same POST → 200 (no auth). |
| 4-TR3 | rule | Rate-limit unit test (limit lowered): 5 rapid posts → 5th hit (or 6th) is 429 + envelope. |
| 4-TR4 | rule | Every test response with status >= 400 has `body.error` string key (envelope). |
| 4-TR5 | rule | 2MB+ payload → 413 envelope (tested by lowering limit in test config). |

---

## Task 5: ML — real baseline model pickle + train script + reload endpoint

- **Priority**: high
- **Status**: pending
- **Depends on**: none (orthogonal to Node tasks)
- **Covers**: AC-R10, FR3
- **Files**: `ml-service/main.py`, `ml-service/train.py`, `ml-service/retrain.py`, `ml-service/models/.gitkeep`, `ml-service/requirements.txt`
- **Description**: Write `train.py` that parses fixture samples →
  feature-vector matches the 32-float layout in api `ml-client.ts`. Labels are
  derived from fixture `category`: safe → 0, warning → 0.4, risky → 1.0.
  Train a scikit-learn `GradientBoostingClassifier(n_estimators=50)`, pickle to
  `models/risk_model.pkl`, also write `models/version.json` =
  `{"model_type":"gb","trained_at":"...","version":"gb_v1_2026-10-05"}`.
  Update `/score-features` to load the pickle once at startup (or lazy-first
  call) and return its `predict_proba`; fallback to heuristic if pickle
  missing; include `model_version` in response. Add an `API_ADMIN_TOKEN`-gated
  `/admin/reload-model` POST that re-reads the pickle. `retrain.py` is a
  standalone script that takes a `--feedback-jsonl` arg (default path to a
  fixtures file) and emits a new pickle (FR3.4).

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 5-TR1 | rule | `python ml-service/train.py` runs with 0 exit code; creates `models/risk_model.pkl` (>5KB) and `models/version.json`. |
| 5-TR2 | rule | POST `/score-features` with feature vector of 32 floats → returns `probability` float + `model_version` key. |
| 5-TR3 | rule | Move pickle aside, restart → `/score-features` still returns 200 (heuristic fallback). |
| 5-TR4 | rule | `/admin/reload-model` returns 401 without token, 200 with correct token and reloads pickle. |
| 5-TR5 | rule | `python ml-service/retrain.py --help` prints usage; `python ml-service/retrain.py --feedback-jsonl ml-service/tests/fixtures/feedback-sample.jsonl` (created in task) emits new pickle successfully. |

---

## Task 6: Feedback export + retraining status endpoints + schema columns

- **Priority**: medium
- **Status**: pending
- **Depends on**: Task 1 (schema), Task 4 (envelope)
- **Covers**: AC-R19, FR4.1, FR4.2
- **Files**: `api/src/app.ts`, `api/src/db/repos.ts`, `api/tests/api.test.ts`
- **Description**: `GET /v1/feedback/export` joins feedback +
  scored_transactions, streams back JSONL `{"feedback":..., "tx":{...}}\n` per
  row; query params `?type=false_positive` (optional). `POST
  /v1/feedback/:id/retraining-status` body
  `{status: 'pending'|'incorporated'|'rejected', model_version?: string}`;
  uses repo helper from Task 1. Wire DB disconnected → 503 envelope.

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 6-TR1 | rule | `GET /v1/feedback/export` → 200, content-type application/x-ndjson, valid JSON even with 0 rows (empty array or empty body with header is fine as long as parsed). |
| 6-TR2 | rule | `POST /v1/feedback/:id/retraining-status` with valid body → 200 envelope. |
| 6-TR3 | rule | DB disconnected → 503 envelope (not thrown exception). |

---

## Task 7: Dashboard search + filters + sort

- **Priority**: high
- **Status**: pending
- **Depends on**: none
- **Covers**: AC-R5, AC-R6, AC-R7, AC-U1, FR1.1/1.2/1.3
- **Files**: `dashboard/src/App.tsx`, `dashboard/src/lib/api.ts`
- **Description**: (1) Top search input wires client-side filter to the
  in-memory recent rows on Transactions page (for fixture/DB-less mode) and
  also calls `GET /v1/transactions?q=` when API is reachable (union +
  dedupe). Debounce 250ms, clear on Esc, empty "No matching transactions"
  banner. (2) Transactions header: add Risk-level dropdown (All/L/M/H/C) and
  Recommendation dropdown (All/Allow/Warn/Block) — filter the list client-side
  (works in fixture mode). (3) Column headers for Risk score / Created at —
  click toggles asc/desc sort arrow. (4) Drawer "Paste signature or hash"
  input → on Enter, call `GET /v1/transactions/:hash`; show matching row in
  drawer or "Not found" banner.

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 7-TR1 | rule | Transactions page rendering ≥ 1 fixture row: typing a substring that matches one fee_payer → list narrows to 1 row (or fewer). Erasing → full list back. |
| 7-TR2 | rule | Risk-level "Critical" filter → only rows with level critical visible (0 low/medium rows). |
| 7-TR3 | rule | Risk-score column click → first click asc (lowest first), second click desc (highest first). Visual toggle indicators present. |
| 7-TR4 | rule | `tsc --noEmit` in dashboard exits 0 after changes. |
| 7-TR5 | rubric | UX smoothness: 4/4 — debounce, Enter works, Esc clears, empty state informative, sort arrows match direction. Threshold ≥ 3/4. |

---

## Task 8: SDK publishable — build + package files + error unwrap + ShieldSdk class

- **Priority**: high
- **Status**: pending
- **Depends on**: Task 4 (envelope so errors are predictable)
- **Covers**: AC-R11, AC-U2, FR5.1, FR5.3
- **Files**: `sdk/package.json`, `sdk/tsconfig.json`, `sdk/src/index.ts`
- **Description**: Refactor SDK into a `ShieldSdk` class (`new ShieldSdk({
  apiBase, apiToken? })`) with `async analyze(tx: Transaction)` and `async
  analyzeSerialized(base64Tx: string, network?)`. Wrap axios errors in
  friendly messages (mirror the dashboard's `submitFeedback` error unwrapping)
  with codes `db_unavailable | rate_limited | unauthorized |
  invalid_transaction | network_error`. Fix `package.json`: set `main` →
  `dist/index.js`, `types` → `dist/index.d.ts`, add `files: ["dist",
  "README.md", "package.json"]`, correct `license`, author, repository. Build
  script via `tsup` or plain tsc (tsc preferred if no ESM/CJS split is
  required; add tsconfig with `declaration: true, outDir: dist`).

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 8-TR1 | rule | `npm run build` in sdk/ exits 0; `ls sdk/dist` shows `index.js` + `index.d.ts`. |
| 8-TR2 | rule | `npm pack` in sdk/ exits 0; `tar -tzf shieldrpc-sdk-*.tgz` contains exactly `package/{package.json, README.md, dist/index.js, dist/index.d.ts}` (and no src/ or .ts). |
| 8-TR3 | rule | Unit snippet: `new ShieldSdk({apiBase:'http://localhost:3001/v1'}).analyzeSerialized(fixture)` returns typed `AnalyzeResponse` (or throws with code) when tested against live API. |
| 8-TR4 | rubric | API ergonomics: 4/4 — new class in 1 line, analyze in 1 line, typed returns, friendly error codes via catch. Threshold ≥ 3/4. |

---

## Task 9: Demo wallet mini-dApp (shield SDK integration)

- **Priority**: medium
- **Status**: pending
- **Depends on**: Task 8 (SDK build)
- **Covers**: AC-R12, FR5.2, AC-U2
- **Files**: new `demo-wallet/` with `package.json`, vite/ts/tailwind config, `src/App.tsx`, `index.html`
- **Description**: 1-page Vite React mini-dApp styled like a toy wallet. Show
  a "USDC balance" card, a "Sign & Send" button mock, and a prominent
  "Approve 1,000,000 USDC to Drainer Address (unsafe for demo)" button.
  On click, build a base64 fixture unlimited-approval tx programmatically
  (reuse fixture from `sample-transactions.json`) → call `shieldSdk.analyzeSerialized()`
  → show a full-screen BLOCK / WARN overlay with the risk score, matching the
  SDK recommendation. Include `mock wallet` adapter (no real keypair needed)
  but keep the wallet-adapter-react imports commented out for a real wallet
  swap-in.

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 9-TR1 | rule | `npm run build` in demo-wallet/ → exits 0. |
| 9-TR2 | rule | Code inspection: button handler calls `shieldSdk.analyzeSerialized()` with a fixture tx, renders overlay when recommendation is 'block'/'warn'. |
| 9-TR3 | rule | Dashboard typecheck `tsc --noEmit` still passes (demo-wallet is standalone workspace package). |

---

## Task 10: CI workflow + deployment docs

- **Priority**: high
- **Status**: pending
- **Depends on**: all (validates all of them end-to-end)
- **Covers**: AC-R15, FR8, AC-U3
- **Files**: `.github/workflows/ci.yml`, `docs/deploy-vercel.md`, `docs/deploy-flyio.md`
- **Description**: CI workflow as per FR8.1. Use `actions/setup-node@v4` with
  Node 20.x, `actions/setup-python@v5` with Python 3.11, `actions/cache@v4` for
  node_modules and pip. Add `if: ${{ !cancelled() }}` for reporting.
  `deploy-vercel.md`: step-by-step for deploying dashboard to Vercel (set
  `VITE_API_BASE`), deploy api + ml to two Fly apps via `fly launch`, use
  Supabase/Neon Postgres, run `api:apply-schema`, `api:seed-known-malicious`,
  `sync-blocklist-sources` once. `deploy-flyio.md`: docker-based, 3 Fly apps,
  env vars, volumes for ml `models/` and postgres.

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 10-TR1 | rule | `yamllint` or manual syntax check: `.github/workflows/ci.yml` parses, 8 required steps present per FR8.1. |
| 10-TR2 | rule | Both docs files exist, each contains 5+ concrete shell commands (copy-pasteable). |
| 10-TR3 | rubric | CI robustness: 4/4 — push+PR triggers, node LTS matrix, cache, explicit fail on any step exit != 0. Threshold ≥ 3/4. |

---

## Task 11: README one-line quickstart + endpoint table + verify-deploy script

- **Priority**: high
- **Status**: pending
- **Depends on**: Tasks 1–10 for accuracy (but can be drafted in parallel with
  stubs)
- **Covers**: AC-R17, AC-R18, AC-U5
- **Files**: `README.md`, `verify-deploy.ps1`, `verify-deploy.sh`
- **Description**: Top of README: copy-pasteable single line `docker compose
  up --build` + 1 paragraph "what ShieldRPC does". Then, endpoint URLs table
  (Dashboard, API, ML, Postgres). Add `verify-deploy.ps1` (Windows) and
  `verify-deploy.sh` (Mac/Linux): loops through health URLs, runs a fixture
  analyze-transaction, asserts score ≥ 75 on the risky fixture, and prints
  green "✔ ShieldRPC deployment verified" or red "✗ FAILED: <step>".
  Exit code 0/non-zero accordingly.

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 11-TR1 | rule | README endpoint table lists 4 services with host:port and path. |
| 11-TR2 | rule | Running verify-deploy.{ps1,sh} against a running compose stack → exit 0. |
| 11-TR3 | rule | Stop API → same script → exit non-zero with named step failing. |

---

## Task 12: Cross-cutting: run typecheck+tests+builds+rubric scoring

- **Priority**: high
- **Status**: pending
- **Depends on**: Tasks 1–11
- **Covers**: AC-R3, AC-R4, NFR1, NFR2, NFR5, all rubric evidence recording
- **Files**: all, plus evidence in tasks.md (this file) via completion
  evidence section
- **Description**: Performs a full clean build + test sweep after all tasks
  land. Records every rubric's score (1–4) with rationale inside each task's
  "Completion Evidence" block. Checks dashboard gzipped bundle size against
  NFR5 (<= 127KB gzipped). If any TR/AC fails, adds a new remediation sub-task
  at the end of the queue (return to Implement phase).

### Test Requirements (TR)

| ID | Type | Pass condition / Evidence |
|---|---|---|
| 12-TR1 | rule | `npm run typecheck` → 0 errors. |
| 12-TR2 | rule | `npm run test` in api/ → all tests pass, count ≥ 56. |
| 12-TR3 | rule | Clean docker build → `docker compose build` completes. |
| 12-TR4 | rule | Dashboard vite build → gzipped JS ≤ 127KB (NFR5). |
