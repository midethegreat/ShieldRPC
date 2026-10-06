import os
import sys
import json
import argparse
import hashlib
from datetime import datetime, timezone

import numpy as np
import joblib
from sklearn.ensemble import GradientBoostingClassifier

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FIXTURES_PATH = os.path.join(BASE_DIR, "..", "data", "fixtures", "sample-transactions.json")
MODELS_DIR = os.path.join(BASE_DIR, "models")
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


def load_base_training_set():
    with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    samples = data.get("samples", [])
    X_raw = []
    y_raw = []
    for s in samples:
        X_raw.append(build_feature_vector(s))
        y_raw.append(label_to_float(s.get("category", "safe")))

    return X_raw, y_raw


def parse_feedback_jsonl(path: str):
    X_new = []
    y_new = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            fb = row.get("feedback", {})
            tx = row.get("tx", {})
            fb_type = fb.get("feedback_type", "")

            if fb_type == "false_positive":
                label = 0.0
            elif fb_type == "false_negative":
                label = 1.0
            else:
                continue

            vec = build_feature_vector(tx)
            X_new.append(vec)
            y_new.append(label)

    return X_new, y_new


def main():
    parser = argparse.ArgumentParser(description="Retrain risk model with feedback data")
    parser.add_argument(
        "--feedback-jsonl",
        default=os.path.join(BASE_DIR, "tests", "fixtures", "feedback-sample.jsonl"),
        help="Path to feedback JSONL file",
    )
    parser.add_argument(
        "--output",
        default=os.path.join(MODELS_DIR, "risk_model_v2.pkl"),
        help="Output path for retrained model pickle",
    )
    args = parser.parse_args()

    if not os.path.exists(args.feedback_jsonl):
        print(f"Error: Feedback file not found: {args.feedback_jsonl}", file=sys.stderr)
        sys.exit(1)

    X_base, y_base = load_base_training_set()
    X_fb, y_fb = parse_feedback_jsonl(args.feedback_jsonl)

    print(f"Base samples: {len(X_base)}")
    print(f"Feedback samples: {len(X_fb)}")

    X_combined = X_base + X_fb
    y_combined = y_base + y_fb

    X = np.array(X_combined, dtype=np.float32)
    y = np.array(y_combined, dtype=np.float32)
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
    print(f"Retrained model train accuracy: {train_acc:.4f}")

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    joblib.dump(model, args.output)

    version_path = args.output.replace(".pkl", "") + "_version.json"
    version_info = {
        "model_type": "gb",
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "version": f"gb_v2_{datetime.now(timezone.utc).strftime('%Y-%m-%d')}",
        "n_features": N_FEATURES,
        "feedback_count": len(X_fb),
    }
    with open(version_path, "w", encoding="utf-8") as f:
        json.dump(version_info, f, indent=2)

    print(f"Model saved to: {args.output}")
    print(f"Version saved to: {version_path}")
    print(f"Version: {version_info['version']}")


if __name__ == "__main__":
    main()
