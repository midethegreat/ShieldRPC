import os
import json
import logging
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from typing import Optional

load_dotenv()

app = FastAPI(title="ShieldRPC ML Service", version="0.1.0")
logger = logging.getLogger("shieldrpc-ml")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(BASE_DIR, "models")
DEFAULT_MODEL_PATH = os.path.join(MODELS_DIR, "risk_model.pkl")
DEFAULT_VERSION_PATH = os.path.join(MODELS_DIR, "version.json")

MODEL = None
MODEL_VERSION = None
MODEL_LOAD_ERROR = None


def load_model(model_path: str = DEFAULT_MODEL_PATH, version_path: str = DEFAULT_VERSION_PATH):
    global MODEL, MODEL_VERSION, MODEL_LOAD_ERROR
    try:
        import joblib
    except ImportError as e:
        MODEL_LOAD_ERROR = f"joblib import failed: {e}"
        logger.warning(MODEL_LOAD_ERROR)
        return False

    try:
        if not os.path.exists(model_path):
            MODEL_LOAD_ERROR = f"Model file not found: {model_path}"
            logger.warning(MODEL_LOAD_ERROR)
            return False

        MODEL = joblib.load(model_path)

        if os.path.exists(version_path):
            with open(version_path, "r", encoding="utf-8") as f:
                vinfo = json.load(f)
            MODEL_VERSION = vinfo.get("version")
        else:
            MODEL_VERSION = None

        MODEL_LOAD_ERROR = None
        logger.info(f"Model loaded. version={MODEL_VERSION}")
        return True
    except Exception as e:
        MODEL_LOAD_ERROR = f"Failed to load model: {e}"
        logger.warning(MODEL_LOAD_ERROR)
        MODEL = None
        MODEL_VERSION = None
        return False


load_model()


class FeatureVector(BaseModel):
    features: list[float]


class ScoreResponse(BaseModel):
    probability: float
    version: str = "0.1.0"
    model_version: Optional[str] = None


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "shieldrpc-ml",
        "version": "0.1.0",
        "model_version": MODEL_VERSION,
        "model_loaded": MODEL is not None,
    }


@app.post("/score-features", response_model=ScoreResponse)
def score_features(payload: FeatureVector):
    if MODEL is not None and len(payload.features) >= 32:
        proba = MODEL.predict_proba([payload.features])[0][1]
        return ScoreResponse(
            probability=round(float(proba), 4),
            version="0.1.0",
            model_version=MODEL_VERSION,
        )

    non_zero = sum(1 for f in payload.features if abs(f) > 1e-6)
    base_prob = 0.05 + min(non_zero / max(len(payload.features), 1), 0.5) * 0.4
    return ScoreResponse(
        probability=round(base_prob, 4),
        version="0.1.0",
        model_version=MODEL_VERSION,
    )


@app.post("/admin/reload-model")
def reload_model(authorization: Optional[str] = Header(default=None)):
    admin_token = os.getenv("API_ADMIN_TOKEN")
    if not admin_token:
        raise HTTPException(status_code=400, detail={
            "status": "error",
            "detail": "admin token not configured",
        })

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail={
            "status": "error",
            "detail": "missing or invalid Authorization header",
        })

    token = authorization[len("Bearer "):]
    if token != admin_token:
        raise HTTPException(status_code=401, detail={
            "status": "error",
            "detail": "invalid admin token",
        })

    ok = load_model()
    if not ok:
        raise HTTPException(status_code=500, detail={
            "status": "error",
            "detail": MODEL_LOAD_ERROR or "model reload failed",
        })

    return {
        "ok": True,
        "loaded_model_version": MODEL_VERSION,
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", "8000"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
