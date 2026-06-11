# AI-QuantBot — Coolify deployment guide

VPS spec assumed: 32 GB RAM, NVMe SSD, Docker + Coolify installed.

## Architecture in one picture

```
                   ┌───────────────────────────────┐
                   │  Coolify Resource: stack       │
                   │  docker-compose.yml            │
                   └──────────────┬────────────────┘
                                  │
        ┌─────────────────────────┴────────────────────────┐
        ▼                                                  ▼
  ┌──────────────┐                                ┌──────────────────┐
  │  bot service │                                │  trainer service │
  │  Next.js     │                                │  Python 3.12     │
  │  always-on   │                                │  one-shot / cron │
  └──────┬───────┘                                └────────┬─────────┘
         │                                                 │
         │  read /models/*.onnx                            │ write /models/*.onnx
         │  read+write /data/bot-state.json                │
         ▼                                                 ▼
   ┌─────────────────┐                              ┌───────────────┐
   │ Volume: botdata │                              │ Volume: models│
   │  /data          │                              │  /models      │
   └─────────────────┘                              └───────────────┘
```

Two volumes, two images, one VPS. ~650 MB total disk, idle CPU near 0.

## First deploy

### 1. Create the Coolify resource

- **New Resource** → **Docker Compose** → connect this git repo.
- Coolify reads `docker-compose.yml` and builds **only** the `bot` service on first deploy. The `trainer` service has `profiles: [cron]`, so it won't auto-start — it only runs when called explicitly.

### 2. Environment variables

In the Coolify UI for this resource, paste:

```env
BINANCE_API_KEY=<your testnet or mainnet key>
BINANCE_API_SECRET=<your secret>

LLM_PROVIDER=gemini              # or openai / anthropic / off
LLM_API_KEY=<your LLM key>
LLM_MODEL=gemini-2.5-flash

PAIRS=BTCUSDT,ETHUSDT,SOLUSDT
INTERVAL=15m
CANDLES=2000
MODEL_KIND=xgboost
```

`BOT_DATA_DIR=/data` and `BOT_MODEL_DIR=/models` are baked into the image — don't override unless you're remapping volumes.

### 3. First run

Deploy. Coolify will:
1. Build `ai-quantbot:latest` from `Dockerfile`.
2. Mount the two volumes (empty on first deploy).
3. Start the bot service on port 3000.

The bot launches with `modelType=knn` by default and **doesn't need any `.onnx` files**. Phase 3 fallback kicks in: if `BOT_MODEL_DIR` is empty, the bot uses momentum strategy as a placeholder.

### 4. Train your first models

Two ways:

#### A. Manual one-shot (recommended first time)

SSH into the VPS, find the stack directory (Coolify usually puts it under `/data/coolify/applications/<uuid>/`), and run:

```bash
cd /data/coolify/applications/<uuid>
docker compose run --rm trainer
```

You'll see output like:
```
--- [BTCUSDT] export ---
Fetched 2000 candles for BTCUSDT 15m
Saved -> data/BTCUSDT_15m.csv  (1850 labeled rows)
--- [BTCUSDT] train (xgboost) ---
Fold 1: train=370 test=370 acc=0.512
Fold 2: train=740 test=370 acc=0.534
...
Walk-forward mean acc = 0.523 +/- 0.018
Exported -> models/BTCUSDT_xgboost.onnx
[BTCUSDT] published -> /models/BTCUSDT_xgboost.onnx (482310 bytes)
```

The bot picks up the new model on the very next inference tick (mtime check, no restart).

To verify the bot is using it:
- Open the UI → switch **Model type** to `ONNX`.
- Watch the logs panel: `predictONNX hit` instead of `KNN predict`.

#### B. Schedule automated retraining

In Coolify: **Resource → Scheduled Tasks → New Task**.

| Field   | Value                                          |
|---------|------------------------------------------------|
| Command | `docker compose run --rm trainer`              |
| Cron    | `0 3 * * *`     (= 03:00 UTC daily)            |
| Container | leave empty (Coolify runs it on the host)    |

Coolify will execute the command at the scheduled time. The trainer container spins up, runs `ml/train_all.sh`, writes fresh `.onnx` files to `/models`, then exits. Total runtime ~5 minutes for 3 pairs on a modern VPS.

Failures (any pair failing to train) will exit non-zero — Coolify marks the task as failed and you get a notification.

## Operational checks

### Is persistence working?

```bash
docker compose exec bot ls -la /data
```
Expect `bot-state.json` (a few KB, mtime within the last minute).

### Is the model volume populated?

```bash
docker compose exec bot ls -la /models
```
Expect one `.onnx` per pair after the first trainer run.

### Health probe

```bash
curl http://localhost:3000/api/health
```
Returns:
```json
{
  "ok": true,
  "uptime": 1234,
  "activePairs": 3,
  "openPositions": 0,
  "modelType": "knn",
  "persistenceSavedAt": 1780299940271
}
```

Coolify's built-in healthcheck uses this endpoint automatically (it's in the Dockerfile's `HEALTHCHECK` instruction).

## Updating the bot

```bash
git push  # to whatever branch Coolify watches
```

Coolify rebuilds `bot`, restarts the container. State and models survive because they live on volumes.

The `trainer` image only rebuilds when files under `ml/`, `Dockerfile.trainer`, or `requirements.txt` change — Coolify is smart about layer caching.

## Resource budget

| Service  | Idle RAM | Peak RAM (during use) | CPU       | Disk           |
|----------|----------|------------------------|-----------|----------------|
| bot      | ~120 MB  | ~250 MB (active trading) | 1-5%      | ~150 MB image  |
| trainer  | 0 (off)  | ~800 MB (during train) | 1 vCPU × 5 min/day | ~500 MB image |
| Volumes  | —        | —                      | —         | < 50 MB total  |
| **Total**| **~120 MB** | **~1 GB peak**       | **~5%**   | **~700 MB**    |

Plenty of headroom on a 32 GB VPS. You could run 10 of these bots side-by-side and still have RAM to spare.

## Common issues

| Symptom | Cause | Fix |
|---|---|---|
| `predictONNX returns null, falling back to momentum` in logs | No `.onnx` files in `/models` yet | Run trainer once (Section 4A) |
| Bot doesn't pick up newly trained model | Inference session cached against OLD mtime | Should auto-reload; if not, restart bot container |
| Trainer exits with non-zero code | Binance API rate limited the bulk fetch | Reduce `CANDLES` to 1000 or stagger pairs |
| 429 from Binance after redeploy | Bot polling too aggressively before WS catches up | Already handled — `BinanceClient` has a global cooldown + retry-after respect |
| State lost after redeploy | `botdata` volume not mounted | Check `docker volume ls`; volumes survive container deletion |

## Rolling back a bad model

If a freshly trained model makes the bot trade worse than the previous one:

```bash
# Roll model file back to a known-good copy from the host
docker compose exec bot cp /models/BTCUSDT_xgboost.onnx.bak /models/BTCUSDT_xgboost.onnx
```

The bot picks up the rollback on the next tick. (Take backups before each retrain if this is critical — easy to add to `train_all.sh` if you want.)
