# ML Pipeline (Phase 3)

Serious-ML companion to the Node-based AI-QuantBot. We train tree models
(XGBoost / LightGBM) in Python on Binance candles, export them to ONNX,
and the Node runtime loads them via `onnxruntime-node` for live inference.

## Why this split?

- TypeScript is bad at training; Python is bad at running 24/7 in Node memory.
- ONNX is the glue — it preserves the model graph and runs anywhere.
- The bot keeps working without ONNX (rule-based + KNN/Logistic fallback).

## Quick start

```bash
cd ml
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt

# 1. Dump candles + features for the active pairs into ./data
python export_data.py --pair BTCUSDT --interval 15m --limit 1500
python export_data.py --pair ETHUSDT --interval 15m --limit 1500
python export_data.py --pair SOLUSDT --interval 15m --limit 1500

# 2. Train + walk-forward validate + export ONNX
python train.py --pair BTCUSDT --model xgboost
python train.py --pair ETHUSDT --model lightgbm
python train.py --pair SOLUSDT --model xgboost
```

ONNX files land in `models/<pair>_<model>.onnx` and are picked up by the
Node engine when `modelType = 'onnx'`.

## Walk-forward validation

`train.py` does NOT use a single train/test split. It walks forward in
N=5 folds, training on past windows and evaluating on the next unseen
window. This is the only honest way to validate a time-series model —
random shuffles leak information from the future.

## What the model predicts

Three-class label per candle:
- `+1`  = forward return over next 5 candles ≥ threshold  →  LONG
- `-1`  = forward return ≤ -threshold                     →  SHORT
- ` 0`  = no clear direction                              →  HOLD

The Node engine reads the LONG/SHORT class probabilities and converts
them to `{signal, confidence}` exactly the way Logistic Regression does.
