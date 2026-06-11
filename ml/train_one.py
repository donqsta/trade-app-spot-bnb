#!/usr/bin/env python
"""
Orchestrates ONNX model training for a single pair.
Runs export_data.py then train.py with cwd=script_dir so all relative paths
(data/, models/) resolve to ml/data/ and ml/models/ consistently.
Works cross-platform on Windows, Linux, and macOS without bash.
"""

import argparse
import shutil
import sys
import subprocess
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Train ONNX model for a single pair")
    parser.add_argument("--pair", required=True, help="Trading pair, e.g., BTCUSDT")
    parser.add_argument("--interval", default="15m", help="Kline interval")
    parser.add_argument("--limit", default="5000", help="Number of candles to fetch")
    parser.add_argument("--model", choices=["xgboost", "lightgbm"], default="xgboost", help="Model type")
    parser.add_argument("--out-dir", default=None, help="Final output directory for ONNX model (default: ml/models)")
    parser.add_argument("--horizon", default="10", help="Triple-barrier horizon")
    parser.add_argument("--tp-atr", default="1.5", help="Take profit ATR multiplier")
    parser.add_argument("--sl-atr", default="1.5", help="Stop loss ATR multiplier")
    args = parser.parse_args()

    # All paths are relative to the ml/ directory so data/ and models/ live there
    script_dir = Path(__file__).parent.resolve()
    python_exe = sys.executable

    print(f"=== Starting training pipeline for {args.pair} ===")
    print(f"  Python   : {python_exe}")
    print(f"  ml dir   : {script_dir}")
    print(f"  model    : {args.model}")

    # 1. Export data — runs with cwd=script_dir so data/ is created inside ml/data/
    export_script = script_dir / "export_data.py"
    export_cmd = [
        python_exe, str(export_script),
        "--pair", args.pair,
        "--interval", args.interval,
        "--limit", args.limit,
        "--horizon", args.horizon,
        "--tp-atr", args.tp_atr,
        "--sl-atr", args.sl_atr,
    ]
    print(f"Running: {' '.join(export_cmd)}")
    res = subprocess.run(export_cmd, capture_output=True, text=True, cwd=str(script_dir))
    print(res.stdout, end="")
    if res.returncode != 0:
        print("Export data FAILED!", file=sys.stderr)
        print(res.stderr, file=sys.stderr)
        sys.exit(1)

    # 2. Train and export to ONNX — runs with cwd=script_dir so it finds data/ and writes to models/
    train_script = script_dir / "train.py"
    train_cmd = [
        python_exe, str(train_script),
        "--pair", args.pair,
        "--interval", args.interval,
        "--model", args.model,
    ]
    print(f"Running: {' '.join(train_cmd)}")
    res = subprocess.run(train_cmd, capture_output=True, text=True, cwd=str(script_dir))
    print(res.stdout, end="")
    if res.returncode != 0:
        print("Training FAILED!", file=sys.stderr)
        print(res.stderr, file=sys.stderr)
        sys.exit(1)

    # 3. Publish to final out-dir (atomic copy)
    # train.py writes: models/{PAIR}_{interval}_{model}.onnx
    src_file = script_dir / "models" / f"{args.pair}_{args.interval}_{args.model}.onnx"
    if not src_file.exists():
        print(f"Error: Expected ONNX model at {src_file} not found!", file=sys.stderr)
        sys.exit(1)

    out_dir = Path(args.out_dir) if args.out_dir else script_dir / "models"
    out_dir.mkdir(parents=True, exist_ok=True)
    # Publish with timeframe in filename so the bot can pick the correct TF model.
    dst_file = out_dir / f"{args.pair}_{args.interval}_{args.model}.onnx"

    # Atomic publish: write to .tmp then rename so the bot never reads a partial file
    tmp_file = dst_file.with_suffix(".onnx.tmp")
    try:
        shutil.copy2(src_file, tmp_file)
        tmp_file.replace(dst_file)
        print(f"[OK] Published ONNX model to {dst_file} ({dst_file.stat().st_size} bytes)")
    except Exception as e:
        print(f"Failed to publish model: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    sys.exit(main())
