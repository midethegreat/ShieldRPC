# ShieldRPC Dashboard

React + Tailwind dashboard for viewing scored transactions and flags.

## Setup

```bash
cd dashboard
npm install
cp .env.example .env
npm run dev
```

Open http://localhost:5173

The Vite dev server proxies `/api/*` → `http://localhost:3001/v1/*`, so the
API must be running on port 3001 for the dashboard to talk to it.
