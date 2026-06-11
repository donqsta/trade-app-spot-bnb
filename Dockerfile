# =============================================================================
# AI-QuantBot — production Docker image (Coolify-ready)
#
# Multi-stage build that:
#   1. Installs deps (incl. native onnxruntime-node bindings).
#   2. Builds Next.js with `output: 'standalone'` so the runner stage ships
#      ONLY the .next/standalone bundle + a tiny node_modules. Image stays
#      slim and cold-start is fast.
#   3. Runs as a non-root user.
#
# Why node:20-slim (Debian) instead of node:20-alpine:
#   onnxruntime-node's pre-built native binary is linked against glibc.
#   Alpine uses musl and needs libc6-compat plus occasional manual fixes.
#   Slim "just works" and the image is still small (~150MB layer total).
#
# Volume:
#   Mount your persistent volume at /data (matches BOT_DATA_DIR default).
#   Without it, state survives container *restarts* but is lost on redeploys.
#
# Build:
#   docker build -t ai-quantbot .
# Run:
#   docker run -p 3000:3000 -v ai-quantbot-data:/data \
#     -e BINANCE_API_KEY=... -e BINANCE_API_SECRET=... \
#     -e LLM_PROVIDER=gemini -e LLM_API_KEY=... -e LLM_MODEL=gemini-2.5-flash \
#     ai-quantbot
# =============================================================================

# --- 1. Dependencies stage ---------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app
# Build tools for any node-gyp packages (onnxruntime-node uses pre-built bins,
# but other deps may need them at install time).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
# NOTE: do NOT use --omit=optional here. Tailwind v4 + lightningcss ship their
# native binary (`lightningcss.linux-x64-gnu.node`) as an OPTIONAL dependency
# resolved per-platform. Skipping them breaks `next build`:
#   Error: Cannot find module '../lightningcss.linux-x64-gnu.node'
# The size saving (~5 MB) isn't worth the broken build.
RUN npm ci

# --- 2. Builder stage --------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- 3. Runner stage (final image) ------------------------------------------
FROM node:20-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    BOT_DATA_DIR=/data \
    BOT_MODEL_DIR=/models \
    HOME=/data

# Python 3 + pip for ONNX auto-retrain (bot spawns ml/train_all.sh in background).
# Layer is cached as long as requirements.txt is unchanged — adds ~300 MB once.
# No Coolify addon needed; Python is baked into this image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install Trust Wallet CLI globally
RUN npm install -g @trustwallet/cli@0.18.0

# Non-root user for security
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs nextjs

# Public assets + the standalone server bundle + static assets.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# onnxruntime-node native bindings live in node_modules at runtime.
# `output: standalone` includes the modules it can statically analyze, but
# we ship the whole package to be safe with dynamic require().
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/onnxruntime-node ./node_modules/onnxruntime-node

# ML training scripts — the bot spawns ml/train_all.sh in the background to
# retrain ONNX automatically (same trigger as KNN/Logistic rolling retrain).
# No separate trainer container or Coolify service needed.
COPY --chown=nextjs:nodejs ml/ ./ml/
# Install Python ML packages. requirements.txt is in ml/ so this layer is
# only rebuilt when dependencies change, not on every app code change.
RUN pip3 install --no-cache-dir --break-system-packages -r ml/requirements.txt

# Pre-create mount points so the non-root user can write before the volume
# arrives. Once Coolify mounts the volume, these dirs are masked harmlessly.
RUN mkdir -p /data /models && chown nextjs:nodejs /data /models
VOLUME ["/data", "/models"]

USER nextjs
EXPOSE 3000

# Healthcheck: hit the cheap /api/health route, NOT /api/bot/status (which
# would call Binance every probe and burn rate-limit budget).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

# `server.js` is the standalone entrypoint produced by `output: 'standalone'`.
CMD ["node", "server.js"]
