#!/usr/bin/env bash
# =============================================================================
# Train an ONNX model for every pair in $PAIRS, then publish to $OUT_DIR.
#
# Designed to run inside Dockerfile.trainer as a one-shot cron job. Exits 0
# only if EVERY pair trained + exported successfully; otherwise exits with the
# number of failures so Coolify Scheduled Tasks marks the run as failed and
# you get an alert.
#
# Env vars (with defaults from the Dockerfile):
#   PAIRS       - comma-separated symbols, e.g. "BTCUSDT,ETHUSDT,SOLUSDT"
#   INTERVAL    - kline interval, default "15m"
#   CANDLES     - candles to pull, default 2000 (~3 weeks of 15m data)
#   MODEL_KIND  - "xgboost" or "lightgbm"
#   OUT_DIR     - where to drop the finished .onnx files (mounted volume)
# =============================================================================

set -uo pipefail

PAIRS="${PAIRS:-BTCUSDT,ETHUSDT,SOLUSDT}"
INTERVAL="${INTERVAL:-15m}"
CANDLES="${CANDLES:-2000}"
MODEL_KIND="${MODEL_KIND:-xgboost}"
OUT_DIR="${OUT_DIR:-/models}"
# T3.5 — triple-barrier ATR multipliers. Use symmetric values (e.g. 1.5)
# to prevent severe label imbalance during training.
HORIZON="${HORIZON:-10}"
TP_ATR="${TP_ATR:-1.5}"
SL_ATR="${SL_ATR:-1.5}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# All work happens in a scratch dir so we can have side-by-side data/ + models/
# without polluting the image. tmpfs would be even faster but /tmp is fine.
WORK="$(mktemp -d -t aiquantbot-train-XXXX)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/data" "$WORK/models"
cd "$WORK"

mkdir -p "$OUT_DIR"

echo "============================================================"
echo "AI-QuantBot trainer  $(date -u +%FT%TZ)"
echo "  pairs    = $PAIRS"
echo "  interval = $INTERVAL"
echo "  candles  = $CANDLES"
echo "  model    = $MODEL_KIND"
echo "  out_dir  = $OUT_DIR"
echo "  workdir  = $WORK"
echo "  horizon  = $HORIZON  (tp=${TP_ATR}*ATR sl=${SL_ATR}*ATR)"
echo "============================================================"

failures=0
IFS=',' read -ra PAIRS_ARR <<< "$PAIRS"

for raw in "${PAIRS_ARR[@]}"; do
    pair="$(echo "$raw" | xargs)"           # trim whitespace
    [ -z "$pair" ] && continue
    echo ""
    echo "--- [$pair] export ---"
    if ! python "$SCRIPT_DIR/export_data.py" \
        --pair "$pair" --interval "$INTERVAL" --limit "$CANDLES" \
        --horizon "$HORIZON" --tp-atr "$TP_ATR" --sl-atr "$SL_ATR"; then
        echo "[$pair] export FAILED"
        failures=$((failures + 1))
        continue
    fi

    echo "--- [$pair] train ($MODEL_KIND) ---"
    if ! python "$SCRIPT_DIR/train.py" \
        --pair "$pair" --interval "$INTERVAL" --model "$MODEL_KIND"; then
        echo "[$pair] train FAILED"
        failures=$((failures + 1))
        continue
    fi

    src="models/${pair}_${MODEL_KIND}.onnx"
    if [ ! -f "$src" ]; then
        echo "[$pair] expected ONNX output $src not found"
        failures=$((failures + 1))
        continue
    fi

    # Atomic publish: write to .tmp then mv. The bot's onnx-runner picks up
    # the new file on the very next inference tick via its mtime check.
    dst="$OUT_DIR/${pair}_${MODEL_KIND}.onnx"
    cp "$src" "$dst.tmp"
    mv -f "$dst.tmp" "$dst"
    bytes=$(stat -c%s "$dst" 2>/dev/null || wc -c < "$dst")
    echo "[$pair] published -> $dst ($bytes bytes)"
done

echo ""
echo "============================================================"
if [ "$failures" -eq 0 ]; then
    echo "DONE: all ${#PAIRS_ARR[@]} pair(s) trained successfully."
    exit 0
else
    echo "DONE WITH ERRORS: $failures pair(s) failed."
    exit "$failures"
fi
