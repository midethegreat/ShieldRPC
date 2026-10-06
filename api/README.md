# ShieldRPC API

Node/Express backend for transaction risk analysis.

## Setup

```bash
cd api
npm install
cp .env.example .env
npm run dev
```

## Endpoints

- `GET /v1/health` - Health check
- `POST /v1/analyze-transaction` - Analyze a serialized Solana transaction
- `GET /v1/transactions` - List recently scored transactions
