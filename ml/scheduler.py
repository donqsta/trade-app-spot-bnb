"""
AI-QuantBot ML Trainer — Daemon Scheduler
==========================================
Runs `train_all.sh` on a configurable interval and then sleeps until the next
cycle. Designed for deployment as a long-running container on Coolify (or any
PaaS) where there is no external cron trigger.

Environment variables:
  TRAIN_INTERVAL_HOURS  - hours between training runs  (default: 6)
  RUN_ON_STARTUP        - run immediately at container start before first sleep
                          (default: "true")
  PAIRS                 - comma-separated pairs passed to train_all.sh
  INTERVAL              - kline interval, e.g. "15m"
  CANDLES               - number of candles to fetch
  MODEL_KIND            - "xgboost" or "lightgbm"
  OUT_DIR               - where finished .onnx files are written

Exit behavior:
  The process exits non-zero if the training script fails more than
  MAX_CONSECUTIVE_FAILURES times in a row (default: 3). This tells Coolify
  something is wrong so it can alert you rather than silently looping forever.
"""

import os
import subprocess
import sys
import time
from pathlib import Path
from datetime import datetime, timezone

SCRIPT_DIR = Path(__file__).parent.resolve()
TRAIN_SCRIPT = SCRIPT_DIR / "train_all.sh"


def log(msg: str) -> None:
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    print(f"[{ts}] [scheduler] {msg}", flush=True)


def run_training() -> bool:
    """Run train_all.sh. Returns True on success."""
    log("Starting training cycle...")
    start = time.monotonic()
    try:
        result = subprocess.run(
            ["bash", str(TRAIN_SCRIPT)],
            check=False,
            env={**os.environ}  # inherit all env vars (PAIRS, MODEL_KIND, OUT_DIR, …)
        )
        elapsed = time.monotonic() - start
        if result.returncode == 0:
            log(f"Training cycle completed successfully in {elapsed:.0f}s.")
            return True
        else:
            log(f"Training cycle finished with errors (exit code {result.returncode}) after {elapsed:.0f}s.")
            return False
    except Exception as exc:
        elapsed = time.monotonic() - start
        log(f"Training cycle raised an exception after {elapsed:.0f}s: {exc}")
        return False


def main() -> int:
    interval_h = float(os.getenv("TRAIN_INTERVAL_HOURS", "6"))
    run_on_startup = os.getenv("RUN_ON_STARTUP", "true").lower() not in ("0", "false", "no")
    max_failures = int(os.getenv("MAX_CONSECUTIVE_FAILURES", "3"))

    log(f"Daemon started. interval={interval_h}h  run_on_startup={run_on_startup}")

    if not TRAIN_SCRIPT.exists():
        log(f"ERROR: {TRAIN_SCRIPT} not found — check container build.")
        return 1

    consecutive_failures = 0

    if run_on_startup:
        ok = run_training()
        if ok:
            consecutive_failures = 0
        else:
            consecutive_failures += 1

    while True:
        sleep_s = interval_h * 3600
        next_run = datetime.now(timezone.utc).timestamp() + sleep_s
        log(f"Next run at {datetime.fromtimestamp(next_run, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')} "
            f"(sleeping {sleep_s:.0f}s).")

        time.sleep(sleep_s)

        ok = run_training()
        if ok:
            consecutive_failures = 0
        else:
            consecutive_failures += 1
            log(f"Consecutive failures: {consecutive_failures}/{max_failures}")
            if consecutive_failures >= max_failures:
                log(f"FATAL: reached {max_failures} consecutive failures. Exiting so the orchestrator can alert.")
                return 1


if __name__ == "__main__":
    sys.exit(main())
