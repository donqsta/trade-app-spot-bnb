/**
 * Disk persistence for the BotEngine singleton.
 *
 * Why: the bot lives in Node memory. Every redeploy / container restart wipes
 * everything — tradeHistory, dailyPnL, cooldowns, user-tuned params, LLM keys.
 * Open positions are safe because Binance is the source of truth and we
 * re-sync on boot, but the surrounding context is lost without this module.
 *
 * Design:
 *  - Atomic write: serialize -> write tmp -> rename. Power-cut safe.
 *  - JSON only. No native deps. Works on any container filesystem.
 *  - Schema is versioned so we can evolve the snapshot without crashing
 *    older deployments.
 *
 * Path:
 *  - `BOT_DATA_DIR` env var, default `/data` (Coolify volume convention).
 *  - Falls back to `./data` for local dev.
 */

import fs from 'fs';
import path from 'path';

const SCHEMA_VERSION = 2;
const FILENAME = 'bot-state.json';

function dataDir(): string {
    const envDir = (typeof process !== 'undefined' && process.env?.BOT_DATA_DIR) || '';
    if (envDir) return envDir;
    // Prefer /data when it exists (Coolify mounted volume); else ./data locally.
    // turbopackIgnore: these fs/path calls are runtime-only and must not pull
    // the whole project into the Next.js standalone bundle via NFT tracing.
    try {
        if (process.platform !== 'win32' && fs.existsSync(/*turbopackIgnore: true*/ '/data') && fs.statSync('/data').isDirectory()) return '/data';
    } catch { /* not on a unix-y host; ignore */ }
    return path.join(/*turbopackIgnore: true*/ process.cwd(), 'data');
}

function snapshotPath(): string {
    return path.join(/*turbopackIgnore: true*/ dataDir(), FILENAME);
}

/**
 * Subset of BotEngine state we keep across restarts.
 * Anything that can be recomputed from Binance (prices, candles) or that
 * is large/transient (websocket handles, model weights) is intentionally
 * omitted. Re-trained on boot in O(seconds).
 */
export interface PersistedBotState {
    schemaVersion: number;
    savedAt: number;
    // User-tunable parameters
    confidenceThreshold: number;
    riskRatio: number;
    orderSizeMultiplier?: number;
    tpAtrMultiplier: number;
    slAtrMultiplier: number;
    smartOrderAdjustment: boolean;
    riskReduction30ToEntry?: boolean;
    gridModeEnabled: boolean;
    dcaEnabled?: boolean;
    dcaMaxSteps?: number;
    dcaPriceDropPct?: number;
    dcaCapitalAllocation?: number[];
    quantOperatorEnabled: boolean;
    modelType: 'knn' | 'logistic' | 'momentum' | 'ensemble';
    currentTimeframe: string;
    liveTradingMode: 'simulated' | 'testnet' | 'mainnet' | 'bsc_twak';

    // Simulated ledger (sim mode only; live mode resyncs from Binance)
    balance: number;
    marginUsed: number;
    marginFree: number;
    initialCapital: number;

    // Open positions — restored on boot so they survive deploys
    openPositions: any[];

    // Trading transcripts (capped sizes to keep snapshot small)
    tradeHistory: any[];
    orderHistory: any[];
    logs: any[];

    // Daily risk controls
    dailyPnL: number;
    dailyPnLResetDate: string;
    maxDailyDrawdown?: number;
    lastClosedTime: { [symbol: string]: number };
    totalFeesPaid: number;

    // Quant Operator + LLM state
    quantOperatorThoughts: any[];
    quantOperatorLastSwapTime: number;
    quantOperatorMetrics: any;
    llmProvider: string;
    llmModel: string;
    llmApiKey: string;
    llmRiskMultiplier: number;
    llmLastDecision: any;

    binanceApiKey?: string;
    binanceApiSecret?: string;
    tokenEntryPrices?: { [symbol: string]: { entryPrice: number; openTime: number } };
    activePairs?: string[];
}

/** Cap an array to its last N elements (mutates returns a fresh array). */
function tailCap<T>(arr: T[] | undefined, n: number): T[] {
    if (!Array.isArray(arr)) return [];
    return arr.length > n ? arr.slice(-n) : arr.slice();
}

/**
 * Build the snapshot from a BotEngine-like instance. We pluck fields by name
 * rather than importing the class — avoids a circular dep and keeps this
 * module testable in isolation.
 */
export function buildSnapshot(engine: any): PersistedBotState {
    return {
        schemaVersion: SCHEMA_VERSION,
        savedAt: Date.now(),

        confidenceThreshold: engine.confidenceThreshold,
        riskRatio: engine.riskRatio,
        orderSizeMultiplier: engine.orderSizeMultiplier,
        tpAtrMultiplier: engine.tpAtrMultiplier,
        slAtrMultiplier: engine.slAtrMultiplier,
        smartOrderAdjustment: !!engine.smartOrderAdjustment,
        riskReduction30ToEntry: !!engine.riskReduction30ToEntry,
        gridModeEnabled: !!engine.gridModeEnabled,
        dcaEnabled: !!engine.dcaEnabled,
        dcaMaxSteps: engine.dcaMaxSteps,
        dcaPriceDropPct: engine.dcaPriceDropPct,
        dcaCapitalAllocation: engine.dcaCapitalAllocation,
        quantOperatorEnabled: !!engine.quantOperatorEnabled,
        modelType: engine.modelType,
        currentTimeframe: engine.currentTimeframe,
        liveTradingMode: engine.liveTradingMode,

        balance: engine.balance,
        marginUsed: engine.marginUsed,
        marginFree: engine.marginFree,
        initialCapital: engine.initialCapital,

        // Persist open positions (cap at 50 — safety guard for snapshot size)
        openPositions: tailCap(engine.openPositions, 50),

        tradeHistory: tailCap(engine.tradeHistory, 200),
        orderHistory: tailCap(engine.orderHistory, 200),
        logs: tailCap(engine.logs, 100),

        dailyPnL: engine.dailyPnL ?? 0,
        dailyPnLResetDate: engine.dailyPnLResetDate ?? '',
        maxDailyDrawdown: typeof engine.maxDailyDrawdown === 'number' ? engine.maxDailyDrawdown : 0.05,
        lastClosedTime: engine.lastClosedTime || {},
        totalFeesPaid: engine.totalFeesPaid || 0,

        quantOperatorThoughts: tailCap(engine.quantOperatorThoughts, 30),
        quantOperatorLastSwapTime: engine.quantOperatorLastSwapTime || 0,
        quantOperatorMetrics: engine.quantOperatorMetrics || null,
        llmProvider: engine.llmProvider || 'off',
        llmModel: engine.llmModel || '',
        llmApiKey: engine.llmApiKey || '',
        llmRiskMultiplier: typeof engine.llmRiskMultiplier === 'number' ? engine.llmRiskMultiplier : 1.0,
        llmLastDecision: engine.llmLastDecision || null,
        tokenEntryPrices: engine.tokenEntryPrices || {},
        activePairs: engine.activePairs || []
    };
}

/**
 * Apply a snapshot back to a BotEngine instance. ENV vars take precedence
 * for the security-sensitive keys — if the operator set BINANCE_API_KEY at
 * deploy time, the disk value won't silently override the env.
 */
export function applySnapshot(engine: any, snap: PersistedBotState): void {
    if (!snap || snap.schemaVersion !== SCHEMA_VERSION) return;

    engine.confidenceThreshold = snap.confidenceThreshold ?? engine.confidenceThreshold;
    engine.riskRatio = snap.riskRatio ?? engine.riskRatio;
    engine.orderSizeMultiplier = snap.orderSizeMultiplier ?? engine.orderSizeMultiplier;
    engine.tpAtrMultiplier = snap.tpAtrMultiplier ?? engine.tpAtrMultiplier;
    engine.slAtrMultiplier = snap.slAtrMultiplier ?? engine.slAtrMultiplier;
    engine.smartOrderAdjustment = !!snap.smartOrderAdjustment;
    engine.riskReduction30ToEntry = !!snap.riskReduction30ToEntry;
    engine.gridModeEnabled = !!snap.gridModeEnabled;
    engine.dcaEnabled = !!snap.dcaEnabled;
    engine.dcaMaxSteps = snap.dcaMaxSteps ?? engine.dcaMaxSteps;
    engine.dcaPriceDropPct = snap.dcaPriceDropPct ?? engine.dcaPriceDropPct;
    engine.dcaCapitalAllocation = snap.dcaCapitalAllocation ?? engine.dcaCapitalAllocation;
    engine.quantOperatorEnabled = !!snap.quantOperatorEnabled;
    if (snap.modelType) engine.modelType = snap.modelType;
    if (snap.currentTimeframe) engine.currentTimeframe = snap.currentTimeframe;
    if (snap.liveTradingMode) {
        if (snap.liveTradingMode === 'testnet' || snap.liveTradingMode === 'mainnet') {
            engine.liveTradingMode = 'simulated';
        } else {
            engine.liveTradingMode = snap.liveTradingMode;
        }
    }

    engine.balance = snap.balance ?? engine.balance;
    engine.marginUsed = snap.marginUsed ?? engine.marginUsed;
    engine.marginFree = snap.marginFree ?? engine.marginFree;
    engine.initialCapital = snap.initialCapital ?? engine.initialCapital;

    // Restore open positions — price/pnl will be refreshed on next monitoring tick
    if (Array.isArray(snap.openPositions) && snap.openPositions.length > 0) {
        engine.openPositions = snap.openPositions;
    }

    engine.tradeHistory = snap.tradeHistory || [];
    engine.orderHistory = snap.orderHistory || [];
    engine.logs = snap.logs || [];

    engine.dailyPnL = snap.dailyPnL || 0;
    engine.dailyPnLResetDate = snap.dailyPnLResetDate || '';
    if (typeof snap.maxDailyDrawdown === 'number') engine.maxDailyDrawdown = snap.maxDailyDrawdown;
    engine.lastClosedTime = snap.lastClosedTime || {};
    engine.totalFeesPaid = snap.totalFeesPaid || 0;

    engine.quantOperatorThoughts = snap.quantOperatorThoughts || [];
    engine.quantOperatorLastSwapTime = snap.quantOperatorLastSwapTime || 0;
    if (snap.quantOperatorMetrics) engine.quantOperatorMetrics = snap.quantOperatorMetrics;
    engine.llmProvider = snap.llmProvider || engine.llmProvider;
    engine.llmModel = snap.llmModel || engine.llmModel;
    // Don't clobber env-supplied keys — env is the canonical source at deploy time.
    if (!engine.llmApiKey && snap.llmApiKey) engine.llmApiKey = snap.llmApiKey;
    engine.llmRiskMultiplier = typeof snap.llmRiskMultiplier === 'number' ? snap.llmRiskMultiplier : 1.0;
    engine.llmLastDecision = snap.llmLastDecision || null;
    engine.tokenEntryPrices = snap.tokenEntryPrices || {};
    if (Array.isArray(snap.activePairs) && snap.activePairs.length > 0) {
        engine.activePairs = snap.activePairs;
    }
}

export function loadSnapshot(): PersistedBotState | null {
    try {
        const p = snapshotPath();
        if (!fs.existsSync(p)) return null;
        const txt = fs.readFileSync(p, 'utf8');
        const obj = JSON.parse(txt);
        if (!obj || obj.schemaVersion !== SCHEMA_VERSION) return null;
        return obj as PersistedBotState;
    } catch {
        return null;
    }
}

/**
 * Write snapshot atomically: write to a sibling temp file, then rename over
 * the real one. Rename is atomic on POSIX filesystems and on NTFS — so a
 * crash mid-write cannot corrupt the existing snapshot.
 */
export function saveSnapshot(snap: PersistedBotState): boolean {
    try {
        const dir = dataDir();
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const finalPath = path.join(dir, FILENAME);
        const tmpPath = finalPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(snap), 'utf8');
        fs.renameSync(tmpPath, finalPath);
        return true;
    } catch {
        return false;
    }
}

/** For ops/debug: human-readable info about where state lives. */
export function getPersistenceInfo() {
    const p = snapshotPath();
    let exists = false;
    let size = 0;
    let mtime: number | null = null;
    try {
        if (fs.existsSync(p)) {
            const st = fs.statSync(p);
            exists = true;
            size = st.size;
            mtime = st.mtimeMs;
        }
    } catch { /* ignore */ }
    return { path: p, exists, size, mtime };
}
