"""
Train XGBoost or LightGBM on the features produced by export_data.py and
export the trained model to ONNX for the Node bot to load.

Validation is WALK-FORWARD, not a random split. We carve the dataset into
N=5 sequential folds and train each fold on the past, evaluate on the
strictly-future next fold. This is the only honest validation for
time-series models.
"""

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score, classification_report

FEATURE_COLS = [
    "f_rsi", "f_macd", "f_ema20Dist", "f_emaCross", "f_momentum",
    "f_volatility", "f_ema200Dist", "f_mfi", "f_obvChange", "f_bbSpread",
    "f_adx", "f_volChange"
]


def walk_forward_splits(n_rows: int, n_folds: int = 5):
    """Yield (train_idx, test_idx) tuples. Each successive fold trains on
    everything seen so far and tests on the next chunk."""
    fold_size = n_rows // (n_folds + 1)
    if fold_size <= 0:
        raise ValueError("Not enough rows for the requested fold count")
    for i in range(1, n_folds + 1):
        train_end = fold_size * i
        test_end = min(n_rows, train_end + fold_size)
        yield np.arange(0, train_end), np.arange(train_end, test_end)


def remap_label(y: np.ndarray) -> np.ndarray:
    """ONNX converters prefer 0..K-1 integer classes.
    If -1 is present, remap -1,0,1 -> 0,1,2 (multiclass).
    If -1 is not present, keep as 0 and 1 (binary).
    """
    has_minus_one = np.any(y == -1)
    if has_minus_one:
        out = y.copy().astype(np.int64)
        out[y == -1] = 0
        out[y == 0] = 1
        out[y == 1] = 2
        return out
    else:
        return y.copy().astype(np.int64)


def train_xgboost(X_train, y_train, X_test, y_test, num_class: int):
    from xgboost import XGBClassifier
    if num_class == 2:
        model = XGBClassifier(
            n_estimators=300,
            max_depth=5,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            objective="binary:logistic",
            eval_metric="logloss",
            tree_method="hist",
            n_jobs=2
        )
    else:
        model = XGBClassifier(
            n_estimators=300,
            max_depth=5,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            objective="multi:softprob",
            num_class=num_class,
            eval_metric="mlogloss",
            tree_method="hist",
            n_jobs=2
        )
    model.fit(X_train, y_train)
    preds = model.predict(X_test)
    acc = accuracy_score(y_test, preds)
    return model, acc


def train_lightgbm(X_train, y_train, X_test, y_test, num_class: int):
    from lightgbm import LGBMClassifier
    if num_class == 2:
        model = LGBMClassifier(
            n_estimators=400,
            max_depth=-1,
            num_leaves=31,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            objective="binary",
            n_jobs=2
        )
    else:
        model = LGBMClassifier(
            n_estimators=400,
            max_depth=-1,
            num_leaves=31,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            objective="multiclass",
            num_class=num_class,
            n_jobs=2
        )
    model.fit(X_train, y_train)
    preds = model.predict(X_test)
    acc = accuracy_score(y_test, preds)
    return model, acc


def export_onnx(model, kind: str, out_path: Path, n_features: int):
    """Use onnxmltools for XGBoost/LightGBM (skl2onnx alone cannot do them)."""
    from onnxmltools.convert.common.data_types import FloatTensorType
    initial_types = [("input", FloatTensorType([None, n_features]))]

    if kind == "xgboost":
        from onnxmltools.convert import convert_xgboost
        onnx_model = convert_xgboost(model, initial_types=initial_types, target_opset=15)
    elif kind == "lightgbm":
        from onnxmltools.convert import convert_lightgbm
        onnx_model = convert_lightgbm(model, initial_types=initial_types, target_opset=15)
    else:
        raise ValueError(f"Unknown kind: {kind}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "wb") as fh:
        fh.write(onnx_model.SerializeToString())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pair", required=True)
    ap.add_argument("--interval", default="15m")
    ap.add_argument("--model", choices=["xgboost", "lightgbm"], default="xgboost")
    ap.add_argument("--folds", type=int, default=5)
    args = ap.parse_args()

    data_path = Path("data") / f"{args.pair}_{args.interval}.csv"
    if not data_path.exists():
        print(f"Missing dataset: {data_path}. Run export_data.py first.", file=sys.stderr)
        sys.exit(1)

    df = pd.read_csv(data_path)
    X = df[FEATURE_COLS].values.astype(np.float32)
    y_raw = df["label"].values.astype(np.int64)
    y = remap_label(y_raw)

    print(f"Loaded {len(df)} rows for {args.pair} ({args.interval})")
    print(f"Label distribution: {dict(zip(*np.unique(y_raw, return_counts=True)))}")

    accs = []
    trained = None
    num_classes = 3 if np.any(y_raw == -1) else 2
    for fold_i, (tr, te) in enumerate(walk_forward_splits(len(df), args.folds), start=1):
        if args.model == "xgboost":
            model, acc = train_xgboost(X[tr], y[tr], X[te], y[te], num_class=num_classes)
        else:
            model, acc = train_lightgbm(X[tr], y[tr], X[te], y[te], num_class=num_classes)
        print(f"Fold {fold_i}: train={len(tr)} test={len(te)} acc={acc:.3f}")
        accs.append(acc)
        trained = model  # Keep the most recent fold; it sees the most data.

    print(f"Walk-forward mean acc = {np.mean(accs):.3f} +/- {np.std(accs):.3f}")

    # Sanity-check: refit on FULL data so the exported model has seen everything.
    if args.model == "xgboost":
        final, _ = train_xgboost(X, y, X[-50:], y[-50:], num_class=num_classes)
    else:
        final, _ = train_lightgbm(X, y, X[-50:], y[-50:], num_class=num_classes)

    # Timeframe-aware filename: BTCUSDT_15m_xgboost.onnx
    # The Node.js onnx-runner looks for this first, then falls back to the
    # legacy BTCUSDT_xgboost.onnx for backward compatibility.
    out = Path("models") / f"{args.pair}_{args.interval}_{args.model}.onnx"
    export_onnx(final, args.model, out, n_features=X.shape[1])
    print(f"Exported -> {out}")


if __name__ == "__main__":
    sys.exit(main())
