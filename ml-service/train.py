import os
import json
import hashlib
from datetime import datetime, timezone

import numpy as np
import joblib
from sklearn.ensemble import GradientBoostingClassifier

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURES_PATH = os.path.join(BASE_DIR, "..", "data", "fixtures", "sample-transactions.json")
MODELS_DIR = os.path.join(BASE_DIR, "models")
MODEL_PATH = os.path.join(MODELS_DIR, "risk_model.pkl")
VERSION_PATH = os.path.join(MODELS_DIR, "version.json")

N_FEATURES = 32


def label_to_float(category: str) -> float:
    if category.startswith("risk") or category == "risky":
        return 1.0
    if category == "warning":
        return 0.5
    return 0.0


def build_feature_vector(sample: dict) -> list[float]:
    vec = [0.0] * N_FEATURES
    category = sample.get("category", "safe")
    sample_id = sample.get("id", "unknown")

    vec[0] = 1.0 if category.startswith("risk") or category == "risky" else 0.0
    vec[1] = 1.0 if category == "warning" else 0.0

    cat_bytes = category.encode("utf-8")
    id_bytes = sample_id.encode("utf-8")
    digest = hashlib.sha256(cat_bytes + id_bytes).digest()

    for i in range(8):
        byte_val = digest[i]
        vec[2 + i] = (byte_val % 100) / 100.0

    for i in range(22):
        noise_byte = digest[8 + i] if (8 + i) < len(digest) else i
        vec[10 + i] = (noise_byte % 50) / 1000.0

    return vec


def main():
    with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    samples = data.get("samples", [])
    if not samples:
        raise ValueError("No samples found in fixtures file")

    X_raw = []
    y_raw = []
    for s in samples:
        X_raw.append(build_feature_vector(s))
        y_raw.append(label_to_float(s.get("category", "safe")))

    X = np.array(X_raw, dtype=np.float32)
    y = np.array(y_raw, dtype=np.float32)
    y_bin = (y >= 0.8).astype(int)

    safe_idx = np.where(y_bin == 0)[0]
    risky_idx = np.where(y_bin == 1)[0]

    X_aug = list(X)
    y_aug = list(y_bin)

    for idx in risky_idx:
        for _ in range(10):
            X_aug.append(X[idx])
            y_aug.append(y_bin[idx])

    for idx in safe_idx:
        for _ in range(10):
            X_aug.append(X[idx])
            y_aug.append(y_bin[idx])

    X_train = np.array(X_aug, dtype=np.float32)
    y_train = np.array(y_aug, dtype=int)

    model = GradientBoostingClassifier(
        n_estimators=50,
        max_depth=3,
        random_state=42,
    )
    model.fit(X_train, y_train)

    train_acc = model.score(X_train, y_train)
    print(f"Train accuracy: {train_acc:.4f}")

    os.makedirs(MODELS_DIR, exist_ok=True)
    joblib.dump(model, MODEL_PATH)

    version_info = {
        "model_type": "gb",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "version": "gb_v1_2026-10-05",
        "n_features": N_FEATURES,
    }
    with open(VERSION_PATH, "w", encoding="utf-8") as f:
        json.dump(version_info, f, indent=2)

    print(f"Model saved to: {MODEL_PATH}")
    print(f"Version saved to: {VERSION_PATH}")
    print(f"Version: {version_info['version']}")


if __name__ == "__main__":
    main()
