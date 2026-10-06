# ShieldRPC ML Service

Python/FastAPI microservice for ML-based transaction risk scoring.

## Setup

```bash
cd ml-service
python -m venv .venv
# Windows:
.venv\Scripts\activate
# macOS/Linux:
# source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python main.py
```

## Endpoints

- `GET /health` - Health check
- `POST /score-features` - Score a feature vector, returns risk probability
