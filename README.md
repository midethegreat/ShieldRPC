# ShieldRPC

AI-powered transaction risk-scoring API + SDK for Solana.

Analyzes a proposed Solana transaction *before* a user signs it, returning a risk score, plain-English explanation, and recommendation (allow/warn/block).

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌────────────────┐
│   SDK /      │────▶│   Node API       │────▶│   Postgres DB  │
│   Dashboard  │     │   (Express)      │     │                │
└──────────────┘     └────────┬─────────┘     └────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   ML Service     │
                    │   (FastAPI)      │
                    └──────────────────┘
```

## Components

- **api/** - Node/Express backend API: transaction parsing, rule-based detection, scoring
- **ml-service/** - Python FastAPI microservice: ML classifier for risk scoring
- **sdk/** - TypeScript npm package for integrating ShieldRPC into wallets/dApps
- **dashboard/** - React dashboard: live transaction feed, detail views, stats
- **data/** - Fixtures, datasets, labeling scripts
- **docs/** - Architecture notes and documentation

## Quick Start

See individual service READMEs for detailed setup:

- [API README](api/README.md)
- [ML Service README](ml-service/README.md)
- [SDK README](sdk/README.md)
- [Dashboard README](dashboard/README.md)

## Detection Methods (MVP)

1. **Unlimited token approval** - `approve`/`approveChecked` with near-max allowances
2. **Authority change** - `setAuthority` transferring to unfamiliar addresses
3. **Known malicious address match** - Blocklist lookup for destinations/program IDs
4. **Fresh/unverified program interaction** - Recently deployed, low-volume programs
5. **ML blended score** (Phase F) - FastAPI classifier probability adjusts the rule ceiling upward (rule floors are preserved for safety; critical + ML≥97% = score 100)

## Deployment (Phase G)

### One-command local preview with Docker Compose

Runs Postgres + ML service + API + dashboard (nginx on :8080) — auto-applies the schema on first boot.

```bash
docker compose up --build
# Dashboard: http://localhost:8080
# API:       http://localhost:3001/v1/health
# ML:        http://localhost:8000/health
# Postgres:  localhost:5432  user=shieldrpc  pass=shieldrpc  db=shieldrpc
```

To stop and wipe all volumes:

```bash
docker compose down -v
```

### Running the dev stack locally (no Docker)

The root `package.json` exposes workspace-managed convenience scripts:

```bash
npm install                 # installs workspaces: api, dashboard, sdk + concurrently
npm run dev                 # runs all 3 services together (api + ml + dashboard)
npm run test                # API vitest suite
npm run typecheck           # TS strict check across api / dashboard / sdk
npm run api:apply-schema    # apply 001_schema.sql against $DATABASE_URL
npm run api:seed-malicious  # seed the known_malicious_addresses blocklist
```

### Environment

Copy each service's `.env.example` → `.env` and fill in:

| Service | Vars |
|---|---|
| **api** | `PORT` (3001), `NETWORK`, `DATABASE_URL`, `ML_ENABLED=1`, `ML_SERVICE_URL=http://localhost:8000`, `ML_TIMEOUT_MS=1500` |
| **ml-service** | `PORT` (8000) |
| **dashboard** | `VITE_API_BASE` (optional, baked at build time for static hosting; default: `/api`) |

## License

MIT
