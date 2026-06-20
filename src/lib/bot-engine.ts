/**
 * AI-QuantBot Terminal - Server-Side Bot Daemon Engine (TypeScript Singleton)
 * This maintains persistent state, manages Binance WebSockets, calculations,
 * and handles background trading decisions 24/7 in Node.js memory.
 */

import { AIEngine, LabeledDataPoint, LogisticRegressionModel } from './ai-engine';
import { TWAKBscClient, pairToBscToken } from './twak-bsc-client';
import { getCMCMarketSnapshot, getTokenQuotes } from './cmc-agent-hub';
import { CmcPriceFeed, getCmcPriceFeed, stopCmcPriceFeed, type CmcPriceUpdate } from './cmc-price-feed';
import {
    checkTradeAllowed,
    getCompetitionStats,
    initCompetition,
    isCompetitionActive,
    recordTrade,
    updatePortfolioPeak,
    isEligiblePair,
    ELIGIBLE_BSC_TOKENS,
} from './competition-guard';
import { getXSentiment, refreshSentimentBatch } from './grok-sentiment';
import { callLLM, isLLMConfigured, readLLMConfig, type LLMProvider } from './llm-client';
import {
    buildUserPrompt,
    computeHoursRemainingInDay,
    computeMacroBias,
    QUANT_OPERATOR_SYSTEM_PROMPT,
    summarizePositions,
    summarizeRecentTrades,
    type EnsembleSignalContext,
    type MarketContext,
    type QuantOperatorDecision
} from './market-context';

import { applySnapshot, buildSnapshot, getPersistenceInfo, loadSnapshot, saveSnapshot } from './state-persistence';

export interface Position {
    symbol: string;
    type: 'LONG' | 'SHORT';
    leverage: number;
    size: number;
    entryPrice: number;
    margin: number;
    liqPrice: number;
    sl: number;
    tp: number;
    pnl: number;
    pnlPercent: number;
    partialClosed?: boolean;
    binanceOrderId?: string;
    slOrderId?: string;
    // Timestamp position was opened (ms). Used to apply funding charges
    // proportional to how long the position is held.
    openTime?: number;
    // Cumulative trading fees + funding paid on this position so far (in quote currency).
    // Tracked so that PnL display reflects NET PnL (after costs).
    feesPaid?: number;
    isClosing?: boolean;
    // T3.3 — which model produced the signal that opened this position.
    // Used by the alpha-decay monitor to attribute realized PnL per model.
    modelType?: 'knn' | 'logistic' | 'momentum' | 'ensemble';
    // SMART QUANT trailing tier tracking
    originalSl?: number;        // SL at open — used to compute 50% risk reduction at Tier 0
    trailingTier?: number;      // highest tier activated: 0=none 1=T0(30%) 2=T1(50%) 3=T2(75%) 4=T3(90%) 5=T4(100%)
    // Hybrid backup fields
    binanceSlSynced?: boolean;  // false when latest SL update to Binance failed
    hybridCloseMode?: boolean;  // true when Binance close order failed; bot retries internally
    hybridRetries?: number;     // close retry counter (max 5 before force-close)
    // Adaptive Trailing TP (Chandelier Exit) tracking
    trailingTpActive?: boolean; // true once progress to TP > activation threshold
    trailingTpPrice?: number;   // current trailing TP stop price (follows peak)
    peakPrice?: number;         // best price seen so far (max for LONG, min for SHORT)
    // Tracking properties for real-time LLM adjustments
    lastLlmCheckTime?: number;  // Timestamp of the last LLM operator review
    lastLlmCheckPrice?: number; // Price of the symbol at the last LLM operator review
    // ATR at entry time — used as reference for the minimum SL distance floor
    // so the LLM cannot tighten stop loss below 0.6× initial ATR distance.
    entryAtr?: number;
    // DCA state tracking
    dcaStep?: number;
    dcaMaxSteps?: number;
    dcaTotalMargin?: number;
    dcaPriceDropPct?: number;
    /** Price of the last initial entry or DCA fill — next step requires drop from here. */
    dcaLastFillPrice?: number;
    lastDcaAttemptTime?: number;
}

export interface TradeLog {
    time: string;
    pair: string;
    type: string;
    side: string;
    price: number;
    size: string;
    leverage: string;
    pnl: number;
    status: string;
}

export interface SystemLog {
    time: string;
    source: string;
    message: string;
    styleClass: string;
}

export interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface GridOrder {
    id: string;
    type: 'BUY_LIMIT' | 'SELL_LIMIT';
    price: number;
    size: number;
    margin: number;
    status: 'PENDING' | 'FILLED' | 'CLOSED';
    tpPrice: number;
    pnl: number;
    filledPrice?: number;
}

export interface OrderLog {
    time: string;
    symbol: string;
    type: 'MARKET' | 'LIMIT';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'CLOSED';
    pnl?: number;
    reason?: string;
}

export const FIFTY_POTENTIAL_TOKENS = [
    'BNBUSDT', 'CAKEUSDT', 'LINKUSDT', 'AAVEUSDT', 'FLOKIUSDT', 'TWTUSDT', 'ETHUSDT', 'USDCUSDT', 'XRPUSDT', 'TRXUSDT',
    'DOGEUSDT', 'ADAUSDT', 'BCHUSDT', 'TONUSDT', 'LTCUSDT', 'AVAXUSDT', 'SHIBUSDT', 'DOTUSDT', 'UNIUSDT', 'ATOMUSDT',
    'FILUSDT', 'INJUSDT', 'FETUSDT', 'ZROUSDT', 'LDOUSDT', 'PENDLEUSDT', 'STGUSDT', 'AXSUSDT', 'RAYUSDT', 'COMPUSDT',
    'BATUSDT', 'APEUSDT', 'SFPUSDT', '1INCHUSDT', 'SNXUSDT', 'CHEEMSUSDT', 'LUNCUSDT', 'BONKUSDT', 'ZECUSDT', 'SUSHIUSDT',
    'DEXEUSDT', 'BEAMUSDT', 'YFIUSDT', 'ZILUSDT', 'BTTUSDT', 'NFTUSDT', 'EURIUSDT', 'ACHUSDT', 'AXLUSDT', 'KAVAUSDT'
];

class BotEngine {
    private ai = new AIEngine();

    // Server state
    public activePairs = (process.env.PAIRS || (
        process.env.TWAK_WALLET_PASSWORD || process.env.TWAK_AGENT_WALLET
            ? 'BNBUSDT,CAKEUSDT,LINKUSDT,AAVEUSDT,FLOKIUSDT'
            : 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT'
    )).split(',').map(p => p.trim().toUpperCase());
    public currentPair = '';
    public currentTimeframe = '15m';

    // Dynamic stats maps per pair
    public livePrices: { [symbol: string]: number } = {};
    public priceChanges24h: { [symbol: string]: number } = {};
    public volumes24h: { [symbol: string]: number } = {};
    public tokenEntryPrices: Record<string, { entryPrice: number; openTime: number }> = {};
    private lastDirectCheckTimeMap: Record<string, number> = {};
    private syncFailCounts: Record<string, number> = {};

    // Historical data parsed from Binance per pair
    public historicalCandlesMap: { [symbol: string]: Candle[] } = {};

    // AI brain state maps
    public aiBrainTrainedMap: { [symbol: string]: boolean } = {};
    // T3.6 — 'ensemble' runs all three in-process models in parallel and
    // votes weighted by each model's recent realized winrate.
    public modelType: 'knn' | 'logistic' | 'momentum' | 'ensemble' = 'knn';
    public trainedModelMap: { [symbol: string]: LogisticRegressionModel | null } = {};
    public trainingFeaturesMap: { [symbol: string]: LabeledDataPoint[] } = {};
    // Logistic in-sample accuracy per pair (0.0–1.0). Used by predictEnsemble to
    // down-weight the Logistic vote when it performs below random (< 0.50).
    private logisticAccuracyMap: { [symbol: string]: number } = {};
    // Last ensemble signal per pair — injected into LLM context for smarter SL/TP.
    private lastEnsembleSignalMap: { [symbol: string]: EnsembleSignalContext } = {};

    // Getters and setters for compatibility
    get historicalCandles(): Candle[] {
        return this.historicalCandlesMap[this.currentPair] || [];
    }
    set historicalCandles(candles: Candle[]) {
        this.historicalCandlesMap[this.currentPair] = candles;
    }

    get livePrice(): number {
        return this.livePrices[this.currentPair] || 0;
    }
    set livePrice(val: number) {
        this.livePrices[this.currentPair] = val;
    }

    get priceChange24h(): number {
        return this.priceChanges24h[this.currentPair] || 0;
    }
    set priceChange24h(val: number) {
        this.priceChanges24h[this.currentPair] = val;
    }

    get volume24h(): number {
        return this.volumes24h[this.currentPair] || 0;
    }
    set volume24h(val: number) {
        this.volumes24h[this.currentPair] = val;
    }

    get gridActive(): boolean {
        return this.gridActiveMap[this.currentPair] || false;
    }
    set gridActive(val: boolean) {
        this.gridActiveMap[this.currentPair] = val;
    }

    get gridOrders(): GridOrder[] {
        return this.gridOrdersMap[this.currentPair] || [];
    }
    set gridOrders(val: GridOrder[]) {
        this.gridOrdersMap[this.currentPair] = val;
    }

    get gridCenterPrice(): number {
        return this.gridCenterPrices[this.currentPair] || 0;
    }
    set gridCenterPrice(val: number) {
        this.gridCenterPrices[this.currentPair] = val;
    }

    get gridUpperBoundary(): number {
        return this.gridUpperBoundaries[this.currentPair] || 0;
    }
    set gridUpperBoundary(val: number) {
        this.gridUpperBoundaries[this.currentPair] = val;
    }

    get gridLowerBoundary(): number {
        return this.gridLowerBoundaries[this.currentPair] || 0;
    }
    set gridLowerBoundary(val: number) {
        this.gridLowerBoundaries[this.currentPair] = val;
    }

    get aiBrainTrained(): boolean {
        return this.aiBrainTrainedMap[this.currentPair] || false;
    }
    set aiBrainTrained(val: boolean) {
        this.aiBrainTrainedMap[this.currentPair] = val;
    }

    get trainedModel(): LogisticRegressionModel | null {
        return this.trainedModelMap[this.currentPair] || null;
    }
    set trainedModel(val: LogisticRegressionModel | null) {
        this.trainedModelMap[this.currentPair] = val;
    }

    get trainingFeatures(): LabeledDataPoint[] {
        return this.trainingFeaturesMap[this.currentPair] || [];
    }
    set trainingFeatures(val: LabeledDataPoint[]) {
        this.trainingFeaturesMap[this.currentPair] = val;
    }

    get lastCandleTimeEvaluated(): number | null {
        return this.lastCandleTimesEvaluated[this.currentPair] || null;
    }
    set lastCandleTimeEvaluated(val: number | null) {
        this.lastCandleTimesEvaluated[this.currentPair] = val;
    }

    // Bot parameters
    public botRunning = false;
    public confidenceThreshold = 70;
    public leverage = 1;
    public riskRatio = 0.30; // 30% of per-pair allocation per entry — leaves room for DCA
    public orderSizeMultiplier = 1.0; // No extra multiplier by default. Adjust via UI if needed.
    public minOrderSize = (typeof process !== 'undefined' && process.env.MIN_ORDER_SIZE) ? parseFloat(process.env.MIN_ORDER_SIZE) : 2.0; // Minimum order size in USDT. Defaults to 2.0.
    public tpAtrMultiplier = 3.5;
    public slAtrMultiplier = 2.5;
    public smartOrderAdjustment = true; // Smart Quant dynamic risk and trailing stop
    public riskReduction30ToEntry = false; // Move SL to entry at 30% progress instead of 50% risk
    public initialCapital = 1000.00;

    // Adaptive SL/TP tuning (SMART QUANT v2)
    public trailingTpMultiplier = 1.5;   // ATR multiplier for trailing TP (Chandelier) distance
    public trailingTpActivation = 0.8;   // progress-to-TP ratio that arms trailing TP
    public atrSpikeThreshold = 1.5;      // atr_now > avg_30 * threshold => volatility spike
    public volSpikeThreshold = 3.0;      // current volume > avg_20 * threshold => volume spike
    public momentumExitRsiHigh = 78;     // LONG overbought exit threshold
    public momentumExitRsiLow = 22;      // SHORT oversold exit threshold
    // Last computed ATR per pair (from candle close), used for tick-time trailing TP.
    public liveAtrMap: Record<string, number> = {};
    // Momentum exhaustion signal per pair, refreshed each candle close.
    // Consumed inside updatePositionsLivePnL to close exhausted winners early.
    public momentumExitSignalMap: Record<string, { long: boolean; short: boolean }> = {};

    // Binance API Configuration
    public liveTradingMode: 'simulated' | 'testnet' | 'mainnet' | 'bsc_twak' = 'simulated';
    public binanceApiKey = (process.env.BINANCE_API_KEY || '').trim().replace(/\r/g, '');
    public binanceApiSecret = (process.env.BINANCE_API_SECRET || '').trim().replace(/\r/g, '');

    // TWAK / BSC Configuration
    public twakWalletPassword = (process.env.TWAK_WALLET_PASSWORD || '').trim();
    public twakAgentWallet = (process.env.TWAK_AGENT_WALLET || '').trim();

    // AI Smart Grid Strategy state per pair
    public gridModeEnabled = false;
    // DCA (Dollar-Cost Averaging) configuration
    public dcaEnabled = false;
    public dcaMaxSteps = 3;
    public dcaPriceDropPct = 5.0;
    public dcaCapitalAllocation = [0.2, 0.3, 0.5];
    /** Minimum wait between DCA steps (prevents rapid-fire averaging). */
    public dcaCooldownMs = 300_000;
    public quantOperatorEnabled = false;
    public quantOperatorThoughts: { time: string; message: string; type: 'info' | 'decision' | 'warning' }[] = [];
    // Public so persistence can snapshot/restore the operator cooldown.
    public quantOperatorLastSwapTime = 0;
    private quantOperatorRunningPairs = new Set<string>();
    private lastRegimeCheckTime = 0;
    private lastLlmChop = 0;
    private lastLlmVol = 0;
    private lastLlmTrend = 0;



    // T3.3 — Alpha decay monitor.
    // Last N closed trades per model, used to compute rolling winrate /
    // expectancy. If a model degrades materially (winrate < 40% AND
    // expectancy < 0 over the last 50 trades), we auto-fallback to momentum.
    public modelRecentTrades: { [model: string]: { pnl: number; pct: number; at: number }[] } = {
        knn: [], logistic: [], momentum: []
    };
    private alphaDecayWatchdogActive = false;
    private lastFallbackAt = 0;
    private changingTimeframe = false;
    private pendingRegime: string | null = null; // Hysteresis: must confirm regime 2x before switching
    private pendingRegimeCount = 0;
    public quantOperatorMetrics = { choppiness: 50, volatility: 0.05, trendIntensity: 0, regimeConfidence: 50 };

    // ============================================================
    // LLM "AI Brain" config (Phase 1).
    // Defaults read from env at construct time. Settable at runtime via
    // POST /api/bot/status (so the user can swap providers without restart).
    // When unset/invalid, runQuantOperator falls back to the rule-based logic.
    // ============================================================
    public llmProvider: LLMProvider = ((typeof process !== 'undefined' && process.env?.LLM_PROVIDER) || 'off') as LLMProvider;
    public llmApiKey: string = (typeof process !== 'undefined' && (process.env?.LLM_API_KEY || '').trim()) || '';
    public llmModel: string = (typeof process !== 'undefined' && process.env?.LLM_MODEL) || '';
    // Risk multiplier the LLM (or rule fallback) recommends; applied on
    // top of `riskRatio` when sizing new trades. Bounded in [0.3, 1.5].
    public llmRiskMultiplier = 1.0;
    // LLM-driven adaptive SL/TP knobs (applied only when quantOperatorEnabled).
    // 1.0 = neutral (no change vs the rule-based defaults).
    public llmSlTightness = 1.0;          // scales initial SL distance [0.5, 1.5]
    public llmTpExtension = 1.0;          // scales initial TP distance [0.7, 2.0]
    public llmTrailingAggressiveness = 1.0; // scales trailing TP tightness [0.5, 2.0]
    public llmLastDecision: QuantOperatorDecision | null = null;
    public llmLastLatencyMs = 0;
    public gridActiveMap: { [symbol: string]: boolean } = {};
    public gridOrdersMap: { [symbol: string]: GridOrder[] } = {};
    public gridCenterPrices: { [symbol: string]: number } = {};
    public gridUpperBoundaries: { [symbol: string]: number } = {};
    public gridLowerBoundaries: { [symbol: string]: number } = {};

    // Simulated ledger
    public balance = 1000.00;
    public marginUsed = 0;
    public marginFree = 1000.00;
    public openPositions: Position[] = [];
    public tradeHistory: TradeLog[] = [];
    public orderHistory: OrderLog[] = [];

    // Issue 9, 8, 12 properties
    public gridSpacingAtrMultiplier = 1.0;
    // Made public so the persistence layer (Phase 5) can snapshot/restore them.
    public dailyPnL = 0;
    public dailyPnLResetDate = '';
    public maxDailyDrawdown = 0.05; // 5% max daily loss
    /** Highest equity seen today (for drawdown-from-peak metric). */
    private dailyEquityPeak = 0;
    public lastClosedTime: { [symbol: string]: number } = {};

    // ============================================================
    // TRADING COSTS (Phase 0 — Honest PnL)
    // Backtest and live PnL were previously cost-free, which made every
    // strategy look more profitable than reality. We now charge every fill:
    //   - takerFeeRate: per-side notional fee (Binance Futures = 0.04% default)
    //   - slippageBps: extra adverse price applied to market fills (basis points)
    //   - fundingRateHourly: approximation of average funding cost per hour
    //     of holding (real funding will be fetched per-pair in Phase 2)
    // ============================================================
    public takerFeeRate = 0.0010;        // 0.1% per fill (Spot default)
    public slippageBps = 2;              // 2 bps = 0.02% adverse slippage per market fill
    public totalFeesPaid = 0;

    get effectiveTakerFeeRate(): number {
        return this.liveTradingMode === 'bsc_twak' ? 0.0025 : this.takerFeeRate;
    }

    get effectiveSlippageBps(): number {
        return this.liveTradingMode === 'bsc_twak' ? 150 : this.slippageBps;
    }

    public getBscGasFeeUsdt(): number {
        const bnbPrice = this.livePrices['BNBUSDT'] || this.livePrices['BNB'] || 600;
        const multiplier = process.env.BSC_GAS_MULTIPLIER ? parseFloat(process.env.BSC_GAS_MULTIPLIER) : 0.0008;
        return multiplier * bnbPrice; // ~ 0.0008 BNB by default, or configurable
    }

    public getExpectedRoundtripCost(sizeUsdt: number): number {
        const slip = sizeUsdt * (this.effectiveSlippageBps * 2 / 10000);
        const fee = sizeUsdt * (this.effectiveTakerFeeRate * 2);
        const gas = this.liveTradingMode === 'bsc_twak' ? this.getBscGasFeeUsdt() * 2 : 0;
        return slip + fee + gas;
    }

    public calculateNetPnL(pos: Position, currentPrice: number): { pnl: number; pnlPercent: number } {
        const direction = pos.type === 'LONG' ? 1 : -1;
        const exitSlippage = this.effectiveSlippageBps / 10000;
        const exitFeeRate = this.effectiveTakerFeeRate;
        const exitGas = this.liveTradingMode === 'bsc_twak' ? this.getBscGasFeeUsdt() : 0;
        const entryGas = this.liveTradingMode === 'bsc_twak' ? this.getBscGasFeeUsdt() : 0;

        const slippedExitPrice = direction === 1
            ? currentPrice * (1 - exitSlippage)
            : currentPrice * (1 + exitSlippage);

        const exitFee = slippedExitPrice * pos.size * exitFeeRate + exitGas;

        let netPnL = 0;
        if (this.liveTradingMode === 'bsc_twak') {
            // For BSC: entryPrice already includes entry slippage and entry swap fee (due to onchain fill matching).
            // So we only subtract exit slippage, exit swap fee, exit gas, and entry gas.
            netPnL = pos.size * (slippedExitPrice - pos.entryPrice) - exitFee - entryGas;
        } else {
            // For simulation/Binance: entryPrice is raw. Apply entry slippage/fee and exit slippage/fee.
            const entrySlippage = this.slippageBps / 10000;
            const entryFeeRate = this.takerFeeRate;
            const slippedEntryPrice = direction === 1
                ? pos.entryPrice * (1 + entrySlippage)
                : pos.entryPrice * (1 - entrySlippage);
            const entryFee = slippedEntryPrice * pos.size * entryFeeRate;

            netPnL = direction * pos.size * (slippedExitPrice - slippedEntryPrice) - entryFee - exitFee;
        }

        return {
            pnl: netPnL,
            pnlPercent: (netPnL / pos.margin) * 100
        };
    }

    // Logs capped to 400 lines
    public logs: SystemLog[] = [];

    // WebSocket references per pair (Binance mode)
    private wsMap: { [symbol: string]: WebSocket | null } = {};
    private wsHeartbeatInterval: NodeJS.Timeout | null = null;
    private wsReconnectTimeouts: { [symbol: string]: NodeJS.Timeout | null } = {};
    private lastCandleTimesEvaluated: { [symbol: string]: number | null } = {};
    // CMC price feed (bsc_twak mode — replaces Binance WebSocket)
    private cmcFeed: CmcPriceFeed | null = null;
    private candlesSinceLastOptimization = 0;

    // Binance live-sync rate-limit guards (fixes 429 Too Many Requests).
    // The client polls /api/bot/status every 1s, but we must NOT hit the
    // Binance REST API on every poll. We throttle the real sync to run at
    // most once per `binanceSyncMinIntervalMs` and serve cached state otherwise.
    private lastBinanceSyncTs = 0;
    private binanceSyncInProgress = false;
    private binanceSyncMinIntervalMs = 5000; // hit Binance at most every 5s

    constructor() {
        this.currentPair = this.activePairs[0] || 'BNBUSDT';
        // Initialize dynamic maps for activePairs
        this.activePairs.forEach(pair => {
            this.livePrices[pair] = 0;
            this.priceChanges24h[pair] = 0;
            this.volumes24h[pair] = 0;
            this.historicalCandlesMap[pair] = [];
            this.aiBrainTrainedMap[pair] = false;
            this.trainedModelMap[pair] = null;
            this.trainingFeaturesMap[pair] = [];
            this.gridActiveMap[pair] = false;
            this.gridOrdersMap[pair] = [];
            this.gridCenterPrices[pair] = 0;
            this.gridUpperBoundaries[pair] = 0;
            this.gridLowerBoundaries[pair] = 0;
            this.wsMap[pair] = null;
            this.wsReconnectTimeouts[pair] = null;
            this.lastCandleTimesEvaluated[pair] = null;
        });

        this.addLog('SYSTEM', 'Multi-pair Node.js AI-QuantBot Daemon Trading Engine initialized successfully.', 'system-line');

        // Phase 5: Try to restore user params, transcripts and cooldowns from
        // the persisted snapshot on disk. Open positions are NOT restored
        // here — Binance is the source of truth and `syncLiveBinanceState`
        // will re-populate them within seconds of boot.
        try {
            const snap = loadSnapshot();
            if (snap) {
                applySnapshot(this, snap);
                this.leverage = 1; // Force 1x Spot leverage (no leverage)
                if (this.dcaEnabled && this.openPositions.length > 0) {
                    this.backfillDcaForOpenPositions();
                }
                const info = getPersistenceInfo();
                const ageSec = info.mtime ? Math.round((Date.now() - info.mtime) / 1000) : 0;
                this.addLog('SYSTEM', `💾 Restored state from disk (${info.path}, ${ageSec}s ago). Binance positions will auto-sync via API.`, 'info-line');
            } else {
                this.addLog('SYSTEM', 'Multi-pair background system ready. Please click Train AI to load data.', 'system-line');
            }
        } catch (e: any) {
            this.addLog('SYSTEM', `⚠️ Cannot read state snapshot: ${e?.message || e}`, 'warning-line');
        }

        // Auto-detect BSC mode: if TWAK credentials are set, default to bsc_twak on first boot (no snapshot)
        const hasSnapshot = getPersistenceInfo().exists;
        if (!hasSnapshot && (process.env.TWAK_WALLET_PASSWORD || process.env.TWAK_AGENT_WALLET) && this.liveTradingMode === 'simulated') {
            this.liveTradingMode = 'bsc_twak';
            this.addLog('SYSTEM', '🔗 TWAK credentials detected — defaulting to BSC on-chain trading mode (bsc_twak).', 'info-line');
        }

        // Re-initialize maps for active pairs
        if (!this.activePairs || this.activePairs.length === 0) {
            this.activePairs = (process.env.PAIRS || (
                this.liveTradingMode === 'bsc_twak'
                    ? 'BNBUSDT,CAKEUSDT,LINKUSDT,AAVEUSDT,FLOKIUSDT'
                    : 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT'
            )).split(',').map(p => p.trim().toUpperCase());
        }
        this.activePairs.forEach(pair => {
            if (this.livePrices[pair] === undefined) this.livePrices[pair] = 0;
            if (this.priceChanges24h[pair] === undefined) this.priceChanges24h[pair] = 0;
            if (this.volumes24h[pair] === undefined) this.volumes24h[pair] = 0;
            if (!this.historicalCandlesMap[pair]) this.historicalCandlesMap[pair] = [];
            if (this.aiBrainTrainedMap[pair] === undefined) this.aiBrainTrainedMap[pair] = false;
            if (this.trainedModelMap[pair] === undefined) this.trainedModelMap[pair] = null;
            if (!this.trainingFeaturesMap[pair]) this.trainingFeaturesMap[pair] = [];
            if (this.gridActiveMap[pair] === undefined) this.gridActiveMap[pair] = false;
            if (!this.gridOrdersMap[pair]) this.gridOrdersMap[pair] = [];
            if (this.gridCenterPrices[pair] === undefined) this.gridCenterPrices[pair] = 0;
            if (this.gridUpperBoundaries[pair] === undefined) this.gridUpperBoundaries[pair] = 0;
            if (this.gridLowerBoundaries[pair] === undefined) this.gridLowerBoundaries[pair] = 0;
            if (this.wsMap[pair] === undefined) this.wsMap[pair] = null;
            if (this.wsReconnectTimeouts[pair] === undefined) this.wsReconnectTimeouts[pair] = null;
            if (this.lastCandleTimesEvaluated[pair] === undefined) this.lastCandleTimesEvaluated[pair] = null;
        });

        // Initial pair loads sequentially in background
        this.loadAllActivePairsData(this.currentTimeframe).catch(err => {
            console.error('Error loading initial active pairs data:', err);
        });
        // Initial sentiment fetch
        refreshSentimentBatch(this.activePairs);

        // Initialize competition guard when BSC mode is active
        if (this.liveTradingMode === 'bsc_twak') {
            const twak = this.getTWAKClient();
            if (twak) {
                twak.getTotalPortfolioUsd()
                    .then(total => {
                        if (total > 0) {
                            initCompetition(total);
                            updatePortfolioPeak(total);
                            this.addLog('SYSTEM', `💰 Competition guard init: portfolio $${total.toFixed(2)} USDT on BSC.`, 'info-line');
                        }
                    })
                    .catch(() => { });
            }
        }

        // Setup background AI Quant Operator interval to run every 30 seconds
        setInterval(() => {
            this.runQuantOperator().catch(err => {
                console.error('Error running Quant Operator:', err);
            });
            // Background refresh sentiment for active pairs
            refreshSentimentBatch(this.activePairs);
        }, 30000);

        // Phase 5: Persist state to disk every 30s. Cheap (< 50KB JSON) and
        // means a redeploy / crash loses at most 30s of trade history. The
        // snapshot survives container restarts when a volume is mounted at
        // BOT_DATA_DIR (default /data on Coolify).
        setInterval(() => {
            this.persistState();
        }, 30000);



        // T3.2: rolling retrain every 1h. KNN/Logistic in-process models
        // benefit hugely from this because they otherwise stick to the
        // dataset captured at first load → alpha decays fast in non-
        // stationary markets. Momentum is stateless so we skip.
        setInterval(() => this.rollingRetrainAll(), 60 * 60_000);

        // T3.3: alpha-decay watchdog runs every 2 minutes. Cheap check; only
        // triggers a fallback when ≥ 50 trades have accumulated since the
        // last fallback so we don't bounce models on noise.
        setInterval(() => this.checkAlphaDecay(), 2 * 60_000);

        // Best-effort persist on graceful shutdown so the LAST trades aren't lost.
        if (typeof process !== 'undefined' && process.on) {
            const flush = () => { try { this.persistState(); } catch { /* shutting down */ } };
            process.on('SIGINT', flush);
            process.on('SIGTERM', flush);
            process.on('beforeExit', flush);
        }
    }

    /**
     * Snapshot the relevant subset of state and write it atomically to disk.
     * Safe to call frequently; the cost is dominated by JSON.stringify.
     */
    public persistState(): boolean {
        try {
            const snap = buildSnapshot(this);
            return saveSnapshot(snap);
        } catch {
            return false;
        }
    }

    // ====================================================================


    // ====================================================================
    // T3.4 — News blackout helper
    // ====================================================================
    /**
     * Parse env BOT_NEWS_BLACKOUTS (comma-separated ISO timestamps) and
     * return true if `now` is within [-30m, +60m] of any of them.
     * Cached at boot — bot must be restarted to pick up new dates, which
     * matches how FOMC/CPI calendars are updated (rare, set-and-forget).
     */
    private newsBlackoutsCache: number[] | null = null;
    public isInsideNewsBlackout(now: number = Date.now()): boolean {
        if (this.newsBlackoutsCache === null) {
            const raw = (typeof process !== 'undefined' ? process.env?.BOT_NEWS_BLACKOUTS : '') || '';
            this.newsBlackoutsCache = raw
                .split(',')
                .map(s => s.trim())
                .filter(Boolean)
                .map(s => Date.parse(s))
                .filter(ts => Number.isFinite(ts));
        }
        if (this.newsBlackoutsCache.length === 0) return false;
        const before = 30 * 60_000;       // 30 minutes pre-release
        const after = 60 * 60_000;        // 60 minutes post-release
        for (const ts of this.newsBlackoutsCache) {
            if (now >= ts - before && now <= ts + after) return true;
        }
        return false;
    }

    // ====================================================================
    // T3.3 — Alpha-decay monitor
    // ====================================================================
    /** Record realized PnL of a closed trade attributed to a model. */
    public recordModelTrade(model: 'knn' | 'logistic' | 'momentum' | 'ensemble', pnl: number, pct: number): void {
        if (!this.modelRecentTrades[model]) this.modelRecentTrades[model] = [];
        const arr = this.modelRecentTrades[model];
        arr.push({ pnl, pct, at: Date.now() });
        while (arr.length > 100) arr.shift(); // keep last 100 trades per model
    }

    /** Compute rolling stats over the last N trades for one model. */
    public computeModelHealth(model: 'knn' | 'logistic' | 'momentum' | 'ensemble', windowN = 50) {
        const arr = (this.modelRecentTrades[model] || []).slice(-windowN);
        const n = arr.length;
        if (n === 0) return { n, winrate: 0, avgPnl: 0, expectancy: 0, profitFactor: 1 };
        const wins = arr.filter(t => t.pnl > 0);
        const losses = arr.filter(t => t.pnl <= 0);
        const winrate = wins.length / n;
        const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
        const avgPnl = arr.reduce((s, t) => s + t.pnl, 0) / n;
        const expectancy = winrate * avgWin + (1 - winrate) * avgLoss; // signed
        const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
        const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
        const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 1);
        return { n, winrate, avgPnl, expectancy, profitFactor };
    }

    /**
     * Run the alpha-decay watchdog. If the ACTIVE model has accumulated at
     * least 30 trades and shows winrate < 40% AND expectancy < 0, we
     * auto-fallback to momentum (the most regime-robust of the in-process
     * strategies). Guarded to at most one fallback per 4 hours so we don't
     * thrash on a small unlucky streak right after a true fallback.
     */
    private checkAlphaDecay(): void {
        if (this.alphaDecayWatchdogActive) return;
        const active = this.modelType;
        if (active === 'momentum') return; // momentum IS the fallback
        const health = this.computeModelHealth(active, 50);
        if (health.n < 30) return;

        const isDecayed = health.winrate < 0.40 && health.expectancy < 0;
        if (!isDecayed) return;

        const now = Date.now();
        if (now - this.lastFallbackAt < 4 * 60 * 60_000) return;

        this.alphaDecayWatchdogActive = true;
        try {
            this.addLog('AI',
                `🚨 ALPHA DECAY: Model ${active.toUpperCase()} has decayed (winrate ${(health.winrate * 100).toFixed(1)}%, expectancy ${health.expectancy.toFixed(2)} over last ${health.n} trades). Auto-switched to MOMENTUM to protect capital.`,
                'warning-line');
            this.modelType = 'momentum';
            this.lastFallbackAt = now;
            this.persistState();
        } finally {
            this.alphaDecayWatchdogActive = false;
        }
    }

    /**
     * T3.2 — rolling retrain. Called once per hour by the constructor's
     * setInterval. Handles KNN / Logistic / Ensemble in-process models.
     */
    private rollingRetrainAll(): void {
        if (this.liveTradingMode === 'bsc_twak') {
            return;
        }

        // ── In-process models (KNN / Logistic / Ensemble) ──────────────────
        if (this.modelType === 'knn' || this.modelType === 'logistic' || this.modelType === 'ensemble') {
            for (const pair of this.activePairs) {
                if (!this.aiBrainTrainedMap[pair]) continue;
                const candles = this.historicalCandlesMap[pair];
                if (!candles || candles.length < 250) continue;
                try {
                    const res = this.trainModel(this.modelType, pair);
                    if (res?.success) {
                        this.addLog('AI', `🔁 Rolling retrain [${pair}] model ${this.modelType.toUpperCase()} complete — ${res.accuracy ?? 'N/A'}.`, 'system-line');
                    }
                } catch (e: any) {
                    this.addLog('AI', `⚠️ Rolling retrain [${pair}] error: ${e?.message || e}`, 'warning-line');
                }
            }
        }
    }

    /**
     * Compute Higher Timeframe (HTF) trend bias in-process using public 1H Spot klines.
     * Returns: 1 if close > ema50 > ema200 (bullish), -1 if close < ema50 < ema200 (bearish), 0 otherwise.
     */
    private async getHtfBias(pair: string): Promise<{ bias: -1 | 0 | 1 } | null> {
        try {
            const candles = await this.fetchBinanceSpotKlines(pair, '1h', 250);
            if (!candles || candles.length < 200) return null;
            const closes = candles.map(c => c.close);

            const ema50Series = this.ai.calculateEMA(closes, 50);
            const ema200Series = this.ai.calculateEMA(closes, 200);

            const lastClose = closes[closes.length - 1];
            const ema50 = ema50Series[ema50Series.length - 1];
            const ema200 = ema200Series[ema200Series.length - 1];

            if (ema50 === null || ema200 === null) return null;

            let bias: -1 | 0 | 1 = 0;
            if (lastClose > ema50 && ema50 > ema200) bias = 1;
            else if (lastClose < ema50 && ema50 < ema200) bias = -1;

            return { bias };
        } catch {
            return null;
        }
    }

    private getTWAKClient(): TWAKBscClient | null {
        if (this.liveTradingMode !== 'bsc_twak') return null;
        return new TWAKBscClient(this.twakWalletPassword || undefined);
    }

    /** Strip USDT suffix to get the BSC token symbol for TWAK. */
    private bscToken(pair: string): string {
        return pairToBscToken(pair);
    }

    /**
     * Apply realistic slippage to a market fill price. Market orders never
     * fill exactly at the screen price — there is always adverse slippage
     * proportional to size and liquidity. We approximate it with a flat
     * `slippageBps` (basis points) shift in the unfavourable direction.
     *   side='BUY'  => price is *worse* (higher)
     *   side='SELL' => price is *worse* (lower)
     */
    public applySlippage(price: number, side: 'BUY' | 'SELL'): number {
        const slip = price * (this.slippageBps / 10000);
        return side === 'BUY' ? price + slip : price - slip;
    }

    /**
     * Compute funding cost for holding `notional` over `holdMs` milliseconds.
     * Funding flows from longs to shorts (or vice versa) every 8h; we
     * approximate the *average* cost as a positive charge against PnL.
     * In Phase 2 we will replace `fundingRateHourly` with the actual
     * Binance funding rate per symbol.
     */
    public computeFundingCost(notional: number, holdMs: number): number {
        return 0;
    }

    private getMinLotSize(symbol: string): number {
        const sym = symbol.toUpperCase();
        if (sym.includes('BTC')) return 0.001;
        if (sym.includes('ETH')) return 0.001;
        if (sym.includes('SOL')) return 0.1;
        if (sym.includes('BNB')) return 0.01;
        if (sym.includes('AVAX')) return 0.1;
        if (sym.includes('LINK')) return 0.1;
        if (sym.includes('DOT')) return 0.1;
        if (sym.includes('MATIC') || sym.includes('POL')) return 1;
        if (sym.includes('XRP')) return 1;
        if (sym.includes('DOGE')) return 1;
        if (sym.includes('ADA')) return 1;
        if (sym.includes('TRX')) return 1;
        if (sym.includes('LTC')) return 0.01;
        return 0.001;
    }

    private getPricePrecision(symbol: string): number {
        const sym = symbol.toUpperCase();
        if (sym.includes('BTC')) return 2;
        if (sym.includes('ETH')) return 2;
        if (sym.includes('SOL')) return 3;
        if (sym.includes('BNB')) return 2;
        if (sym.includes('DOGE')) return 4;
        if (sym.includes('XRP')) return 4;
        if (sym.includes('ADA')) return 4;
        if (sym.includes('MATIC') || sym.includes('POL')) return 4;
        return 2;
    }
    /**
     * Calculates the local swing high or swing low over a lookback window of candles.
     * For 'LONG' trades, we look for the lowest low (support).
     * For 'SHORT' trades, we look for the highest high (resistance).
     */
    public calculateSwingPrice(symbol: string, type: 'LONG' | 'SHORT', lookback = 15): number {
        const candles = this.historicalCandlesMap[symbol] || [];
        if (candles.length === 0) return 0;

        const recentCandles = candles.slice(-lookback);
        if (type === 'LONG') {
            return Math.min(...recentCandles.map(c => c.low));
        } else {
            return Math.max(...recentCandles.map(c => c.high));
        }
    }

    private translateLogMessage(msg: string): string {
        return msg;
    }

    public addLog(source: string, message: string, styleClass = '') {
        const translatedMessage = this.translateLogMessage(message);
        const timeStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        const newLog = { time: timeStr, source, message: translatedMessage, styleClass };

        this.logs.push(newLog);

        // Cap logs length to avoid memory leaks
        if (this.logs.length > 400) {
            this.logs.shift();
        }

        console.log(`[${timeStr}] [${source}] ${translatedMessage}`);
    }

    /**
     * Load market data for all active pairs sequentially with a 100ms delay
     * to prevent hitting API rate limits and spawning parallel requests.
     */
    private async loadAllActivePairsData(timeframe: string) {
        this.addLog('SYSTEM', `[SYSTEM] Start loading data for all ${this.activePairs.length} pairs sequentially...`, 'system-line');
        
        if (this.liveTradingMode === 'bsc_twak') {
            try {
                const cmcSymbols = [...new Set(this.activePairs.map(p => p.endsWith('USDT') ? p.slice(0, -4) : p))];
                this.addLog('SYSTEM', `[CMC] Pre-fetching batch quotes for all ${cmcSymbols.length} active symbols...`, 'system-line');
                // Fetch all quotes in batch and cache them in cmc-agent-hub
                await getTokenQuotes(cmcSymbols, true);
            } catch (e: any) {
                this.addLog('SYSTEM', `[CMC] Failed to pre-fetch quotes: ${e.message}`, 'warning-line');
            }
        }

        for (const pair of this.activePairs) {
            await this.loadPairData(pair, timeframe);
            // Wait 100ms between pairs to avoid slamming APIs and rate limits
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        this.addLog('SYSTEM', `[SYSTEM] Completed loading data for all active pairs.`, 'system-line');
    }

    /**
     * Fetch historical candles and hook live stream.
     * In bsc_twak mode: uses CMC price feed instead of Binance WebSocket.
     * In other modes: uses Binance REST + WebSocket as before.
     */
    public async loadPairData(pair: string, timeframe: string) {
        this.currentTimeframe = timeframe;
        this.livePrices[pair] = 0;

        // ── BSC / CMC mode check ──────────────────────────────────────────────
        if (this.liveTradingMode === 'bsc_twak') {
            return this.loadPairDataCMC(pair);
        }

        // ── Binance mode (simulated / testnet / mainnet) ───────────────────────
        this.addLog('SYSTEM', `Connecting to Binance Spot server, downloading candles for ${pair} (${timeframe})...`, 'system-line');

        // Disconnect old WS if running
        const oldWs = this.wsMap[pair];
        if (oldWs) {
            oldWs.onmessage = null;
            oldWs.close();
            this.wsMap[pair] = null;
        }

        const oldTimeout = this.wsReconnectTimeouts[pair];
        if (oldTimeout) {
            clearTimeout(oldTimeout);
            this.wsReconnectTimeouts[pair] = null;
        }

        try {
            // Server-side fetch from Binance
            const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${timeframe}&limit=500`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Failed to call Binance API for ${pair}`);

            const raw = await res.json() as any[];
            this.historicalCandlesMap[pair] = raw.map(c => ({
                time: c[0] / 1000,
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                volume: parseFloat(c[5])
            }));

            // Fetch 24h ticker info
            this.fetch24hTicker(pair);

            // Connect live WebSocket stream
            this.connectBinanceWS(pair, timeframe);

            const lastCandle = this.historicalCandlesMap[pair][this.historicalCandlesMap[pair].length - 1];
            this.livePrices[pair] = lastCandle.close;

            this.addLog('SYSTEM', `Loaded data for ${pair} (${this.historicalCandlesMap[pair].length} candles). Live WS is ready.`, 'system-line');

            // Train AI on the pair in background
            this.trainModel(this.modelType, pair);

            return true;
        } catch (error: any) {
            this.addLog('SYSTEM', `Error loading Binance data for ${pair}: ${error.message}`, 'warning-line');
            return false;
        }
    }

    /**
     * BSC/CMC variant of loadPairData.
     * Seeds price data from CMC and starts the CmcPriceFeed polling loop
     * (which fires callbacks instead of Binance WebSocket messages).
     */
    /**
     * Fetch real Binance Spot klines for display purposes only (public endpoint, no auth).
     * Falls back to null if the symbol is not listed on Binance Spot.
     */
    private async fetchBinanceSpotKlines(pair: string, timeframe: string, limit = 500): Promise<{
        time: number; open: number; high: number; low: number; close: number; volume: number;
    }[] | null> {
        const TF_MAP: Record<string, string> = {
            '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
            '1h': '1h', '2h': '2h', '4h': '4h', '1d': '1d',
        };
        const interval = TF_MAP[timeframe] ?? '5m';
        try {
            const url = `https://api.binance.com/api/v3/klines?symbol=${pair.toUpperCase()}&interval=${interval}&limit=${limit}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) return null;
            const arr: any[][] = await res.json();
            if (!Array.isArray(arr) || arr.length === 0) return null;
            return arr.map((k) => ({
                time: Math.floor(Number(k[0]) / 1000),
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
            }));
        } catch {
            return null;
        }
    }

    private async loadPairDataCMC(pair: string): Promise<boolean> {
        this.addLog('SYSTEM', `[CMC] Loading market data for ${pair} from CoinMarketCap...`, 'system-line');
        try {
            const cmcSym = pair.endsWith('USDT') ? pair.slice(0, -4) : pair;

            // Fetch CMC quote and Binance Spot klines in parallel
            const [quotes, binanceCandles] = await Promise.all([
                getTokenQuotes([cmcSym]),
                this.fetchBinanceSpotKlines(pair, this.currentTimeframe ?? '5m'),
            ]);
            const q = quotes.find(r => r.symbol.toUpperCase() === cmcSym.toUpperCase());

            if (!q) throw new Error(`CMC did not return data for ${cmcSym}`);
            if (!q.price || q.price <= 0) throw new Error(`CMC returned price 0 for ${cmcSym} — could be incorrect symbol or API quota exhausted`);

            // Seed price + 24h stats
            this.livePrices[pair] = q.price;
            this.priceChanges24h[pair] = q.percentChange24h;
            this.volumes24h[pair] = q.volume24h;

            if (binanceCandles && binanceCandles.length >= 10) {
                // Use real Binance Spot OHLCV for display — looks correct and covers all tokens
                this.historicalCandlesMap[pair] = binanceCandles;
                this.addLog('SYSTEM', `[CMC] ${pair}: ${binanceCandles.length} real candles from Binance Spot (display only)`, 'system-line');
            } else {
                // Fallback: generate synthetic candles when Binance Spot doesn't list the pair
                const now = Math.floor(Date.now() / 1000);
                const tfSeconds: Record<string, number> = {
                    '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800,
                    '1h': 3600, '2h': 7200, '4h': 14400, '1d': 86400,
                };
                const INTERVAL = tfSeconds[this.currentTimeframe ?? '5m'] ?? 300;
                const change24h = q.percentChange24h ?? 0;
                // Per-candle drift using 24h change scaled to this interval
                const stepsIn24h = 86400 / INTERVAL;
                const driftPerStep = change24h / stepsIn24h;

                const closePrices: number[] = new Array(500);
                closePrices[499] = q.price;
                for (let i = 498; i >= 0; i--) {
                    closePrices[i] = closePrices[i + 1] / (1 + driftPerStep / 100);
                }

                // Realistic intraday noise: ~0.15% per candle amplitude
                const noiseAmp = q.price * 0.0015;

                this.historicalCandlesMap[pair] = closePrices.map((closePrice, i) => {
                    const openPrice = i > 0 ? closePrices[i - 1] : closePrice;
                    // Deterministic noise via sine waves (avoids Math.random for consistency)
                    const n1 = noiseAmp * Math.sin(i * 2.3999 + 0.7);
                    const n2 = noiseAmp * Math.sin(i * 1.6180 + 1.4);
                    const adjOpen = openPrice + n1;
                    const adjClose = closePrice + n2;
                    const bodyHigh = Math.max(adjOpen, adjClose);
                    const bodyLow = Math.min(adjOpen, adjClose);
                    const bodySize = bodyHigh - bodyLow;
                    // Wick = 40-80% of body to look like real candles
                    const wickFrac = 0.4 + 0.4 * ((i * 7 + 3) % 10) / 10;
                    const wick = bodySize * wickFrac;
                    return {
                        time: now - (499 - i) * INTERVAL,
                        open: adjOpen,
                        high: bodyHigh + wick,
                        low: bodyLow - wick,
                        close: adjClose,
                        volume: (q.volume24h / stepsIn24h) * (0.5 + ((i * 7) % 13) / 13),
                    };
                });
                this.addLog('SYSTEM', `[CMC] ${pair}: synthetic candles (not listed on Binance Spot)`, 'system-line');
            }

            // Mark model as "trained" — CMC mode uses LLM as primary decision maker
            this.aiBrainTrainedMap[pair] = true;

            const priceStr = q.price >= 0.01 ? q.price.toFixed(4) : q.price.toPrecision(4);
            this.addLog('SYSTEM', `[CMC] ${pair} seeded @ $${priceStr} | 24h: ${q.percentChange24h.toFixed(2)}% | 7d: ${(q as any).percentChange7d?.toFixed(2) ?? '?'}%`, 'system-line');

            // Start/update CMC polling feed for all active pairs
            this.startCMCFeed();

            return true;
        } catch (err: any) {
            this.addLog('SYSTEM', `[CMC] Error loading data for ${pair}: ${err.message}`, 'warning-line');
            return false;
        }
    }

    /**
     * Start (or restart) the CmcPriceFeed for all active pairs.
     * Called once after all pairs are loaded in bsc_twak mode.
     */
    private startCMCFeed() {
        // If already running, just update pairs
        if (this.cmcFeed) {
            this.cmcFeed.updatePairs(this.activePairs);
            return;
        }

        this.cmcFeed = getCmcPriceFeed(this.activePairs);

        // On every CMC poll: update live prices and roll the last candle forward.
        // We do NOT replace the seeded history — just update the current candle
        // so the chart always has 500 candles while still reflecting the latest price.
        this.cmcFeed.onPriceUpdate = (upd: CmcPriceUpdate) => {
            const pair = upd.symbol;
            this.livePrices[pair] = upd.price;
            this.priceChanges24h[pair] = upd.change24h;
            this.volumes24h[pair] = upd.volume24h;

            const history = this.historicalCandlesMap[pair];
            if (history && history.length > 0 && upd.price > 0) {
                const now = Math.floor(Date.now() / 1000);
                const last = history[history.length - 1];

                // If ≥ 30s since last candle, append a new one
                if (now - last.time >= 30) {
                    const openP = last.close;
                    const spreadMin = Math.max(upd.price * 0.0005, Number.EPSILON);
                    const bodyHigh = Math.max(openP, upd.price);
                    const bodyLow = Math.min(openP, upd.price);
                    const wick = Math.max(Math.abs(upd.price - openP) * 0.3, spreadMin);
                    history.push({
                        time: now,
                        open: openP,
                        high: bodyHigh + wick,
                        low: bodyLow - wick,
                        close: upd.price,
                        volume: upd.volume24h / (24 * 120),
                    });
                    if (history.length > 500) history.shift();
                } else {
                    // Update current candle in-place
                    history[history.length - 1] = {
                        ...last,
                        high: Math.max(last.high, upd.price),
                        low: Math.min(last.low, upd.price),
                        close: upd.price,
                    };
                }
            }

            // Update open position PnL in real time
            this.updatePositionsLivePnL(pair, upd.price);
        };

        // On eval tick (every 5 min): run signal evaluation + LLM
        this.cmcFeed.onEvalTick = (pair: string, upd: CmcPriceUpdate) => {
            if (!this.botRunning) return;
            this.addLog('SYSTEM', `[CMC] Eval tick ${pair} @ $${upd.price.toFixed(4)} | 1h: ${upd.change1h.toFixed(2)}%`, 'system-line');
            this.runAdaptiveCandleClose(pair);
            this.evaluateLiveSignal(pair, upd.ts / 1000);
            this.runQuantOperator({ isCandleClose: true, targetPair: pair }).catch(err => {
                console.error('[CMC] runQuantOperator error:', err);
            });
        };

        this.cmcFeed.start().catch(e => {
            this.addLog('SYSTEM', `[CMC] Feed start error: ${e?.message}`, 'warning-line');
        });

        this.addLog('SYSTEM', `[CMC] Price feed started for ${this.activePairs.join(', ')} (poll every 30s, eval every 5min)`, 'system-line');
    }

    private async fetch24hTicker(pair: string) {
        try {
            const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
            if (res.ok) {
                const data = await res.json() as any;
                this.priceChanges24h[pair] = parseFloat(data.priceChangePercent);
                this.volumes24h[pair] = parseFloat(parseFloat(data.volume).toFixed(1));
            }
        } catch (e) {
            // silent ignore
        }
    }

    private connectBinanceWS(pair: string, timeframe: string) {
        const wsUrl = `wss://stream.binance.com:9443/ws/${pair.toLowerCase()}@kline_${timeframe}`;

        try {
            const ws = new WebSocket(wsUrl);
            this.wsMap[pair] = ws;

            ws.onmessage = (event: MessageEvent) => {
                // Self-healing check for orphaned WebSocket connections
                if (timeframe !== this.currentTimeframe) {
                    try {
                        (event.target as WebSocket).close();
                    } catch (e) { }
                    return;
                }

                const data = JSON.parse(event.data);
                const kline = data.k;

                const liveCandle: Candle = {
                    time: kline.t / 1000,
                    open: parseFloat(kline.o),
                    high: parseFloat(kline.h),
                    low: parseFloat(kline.l),
                    close: parseFloat(kline.c),
                    volume: parseFloat(kline.v)
                };

                this.livePrices[pair] = liveCandle.close;

                // Sync historical candles
                const candles = this.historicalCandlesMap[pair];
                if (!candles || candles.length === 0) return;

                const lastIdx = candles.length - 1;
                if (lastIdx >= 0 && candles[lastIdx].time === liveCandle.time) {
                    candles[lastIdx] = liveCandle;
                } else {
                    candles.push(liveCandle);
                    candles.shift();

                    // Candle closed!
                    this.addLog('SYSTEM', `${timeframe} candle of ${pair} closed at price ${liveCandle.open}. Running signal evaluation...`, 'system-line');
                    // Adaptive SL/TP: refresh ATR + run candle-close protective checks.
                    this.runAdaptiveCandleClose(pair);
                    if (this.botRunning) {
                        this.evaluateLiveSignal(pair, liveCandle.time);
                    }
                    // Trigger LLM regime check on candle close
                    this.runQuantOperator({ isCandleClose: true, targetPair: pair }).catch(err => {
                        console.error('Error running Quant Operator on candle close:', err);
                    });
                }

                // Check open positions SL/TP/Liquidation and Grid matching
                this.updatePositionsLivePnL(pair, liveCandle.close);
            };

            ws.onerror = (err) => {
                this.addLog('SYSTEM', `WebSocket error for ${pair}: Stream disconnected. Reconnecting automatically...`, 'warning-line');
                const oldTimeout = this.wsReconnectTimeouts[pair];
                if (oldTimeout) clearTimeout(oldTimeout);
                this.wsReconnectTimeouts[pair] = setTimeout(() => this.connectBinanceWS(pair, timeframe), 5000);
            };

            ws.onclose = () => {
                // connection closed
            };

        } catch (e: any) {
            this.addLog('SYSTEM', `WS connection error for ${pair}: ${e.message}`, 'warning-line');
        }
    }

    private getLabelThreshold(timeframe: string): number {
        switch (timeframe) {
            case '1m': return 0.0006;
            case '5m': return 0.0012;
            case '15m': return 0.0020;
            case '1h': return 0.0040;
            case '4h': return 0.0080;
            default: return 0.0020;
        }
    }

    /**
     * Change live trading mode and reload all pairs/streams.
     */
    public async changeLiveTradingMode(newMode: 'simulated' | 'testnet' | 'mainnet' | 'bsc_twak') {
        let targetMode: 'simulated' | 'bsc_twak' = 'simulated';
        if (newMode === 'bsc_twak') {
            targetMode = 'bsc_twak';
        } else if (newMode === 'mainnet' && (process.env.TWAK_WALLET_PASSWORD || process.env.TWAK_AGENT_WALLET)) {
            targetMode = 'bsc_twak';
        } else {
            targetMode = 'simulated';
        }

        const oldMode = this.liveTradingMode;
        if (oldMode === targetMode) return;

        this.liveTradingMode = targetMode;
        this.addLog('SYSTEM', `Change trading mode: ${oldMode.toUpperCase()} -> ${targetMode.toUpperCase()}`, 'info-line');

        // Stop CMC feed bypassed

        // Close Binance WebSockets bypassed

        // Reload pair data & streams for the new mode
        this.addLog('SYSTEM', `Reloading trading pair data for new mode: ${targetMode.toUpperCase()}...`, 'system-line');
        await this.loadAllActivePairsData(this.currentTimeframe);

        // Make sure correct feed is running if bot is running
        if (this.botRunning) {
            this.activePairs.forEach(pair => {
                const candles = this.historicalCandlesMap[pair] || [];
                if (candles.length > 0) {
                    const lastCandle = candles[candles.length - 1];
                    this.lastCandleTimesEvaluated[pair] = null; // force evaluation
                    this.evaluateLiveSignal(pair, lastCandle.time);
                }
            });
        }

        this.persistState();
    }

    public async updateActivePairs(newPairs: string[]) {
        this.addLog('SYSTEM', `⚙️ Updating active trading pairs: ${newPairs.join(', ')}`, 'info-line');

        // Update active pairs list
        this.activePairs = newPairs;

        // Re-initialize maps for any newly added pairs
        this.activePairs.forEach(pair => {
            if (this.livePrices[pair] === undefined) this.livePrices[pair] = 0;
            if (this.priceChanges24h[pair] === undefined) this.priceChanges24h[pair] = 0;
            if (this.volumes24h[pair] === undefined) this.volumes24h[pair] = 0;
            if (!this.historicalCandlesMap[pair]) this.historicalCandlesMap[pair] = [];
            if (this.aiBrainTrainedMap[pair] === undefined) this.aiBrainTrainedMap[pair] = false;
            if (this.trainedModelMap[pair] === undefined) this.trainedModelMap[pair] = null;
            if (!this.trainingFeaturesMap[pair]) this.trainingFeaturesMap[pair] = [];
            if (this.gridActiveMap[pair] === undefined) this.gridActiveMap[pair] = false;
            if (!this.gridOrdersMap[pair]) this.gridOrdersMap[pair] = [];
            if (this.gridCenterPrices[pair] === undefined) this.gridCenterPrices[pair] = 0;
            if (this.gridUpperBoundaries[pair] === undefined) this.gridUpperBoundaries[pair] = 0;
            if (this.gridLowerBoundaries[pair] === undefined) this.gridLowerBoundaries[pair] = 0;
            if (this.wsMap[pair] === undefined) this.wsMap[pair] = null;
            if (this.wsReconnectTimeouts[pair] === undefined) this.wsReconnectTimeouts[pair] = null;
            if (this.lastCandleTimesEvaluated[pair] === undefined) this.lastCandleTimesEvaluated[pair] = null;
        });

        // Trigger loading for new active pairs
        await this.loadAllActivePairsData(this.currentTimeframe);

        // Restart CMC feed if it was configured (which updates the polling pairs automatically)
        this.startCMCFeed();

        this.persistState();
    }

    /**
     * Change timeframe for all active pairs in bulk
     */
    public async changeTimeframe(timeframe: string) {
        if (this.changingTimeframe) {
            this.addLog('SYSTEM', `⚠️ [SYSTEM] Background timeframe change in progress. Skipping switch to ${timeframe} to avoid conflicts.`, 'warning-line');
            return;
        }
        this.changingTimeframe = true;
        try {
            this.currentTimeframe = timeframe;
            this.addLog('SYSTEM', `TIMEFRAME CHANGE: Reloading all 3 trading pairs on timeframe ${timeframe}...`, 'system-line');

            await this.loadAllActivePairsData(timeframe);

            // ML training & optimisation are not needed in bsc_twak mode —
            // all decisions come from CMC data + LLM Quant Operator.
            if (this.liveTradingMode !== 'bsc_twak') {
                // Retrain in-process models with the new timeframe data.
                this.trainModel(this.modelType);

                this.autoOptimizeHyperparameters();
            }
        } finally {
            this.changingTimeframe = false;
        }
    }

    /**
     * Train ML Model on server
     */
    public trainModel(modelType: 'knn' | 'logistic' | 'momentum' | 'ensemble', pair?: string) {
        const symbol = pair || this.currentPair;
        const candles = this.historicalCandlesMap[symbol] || [];
        if (candles.length < 250) {
            this.addLog('SYSTEM', `Error: Need at least 250 candles to train model for ${symbol}.`, 'warning-line');
            return { success: false, error: 'Not enough data' };
        }

        this.modelType = modelType;
        this.addLog('SYSTEM', `Starting ${modelType.toUpperCase()} model training on Node.js Server for ${symbol}...`, 'system-line');

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);

        const dataset = this.ai.extractFeatures(closes, highs, lows, volumes);
        if (dataset.length === 0) {
            return { success: false, error: 'Feature extraction failed' };
        }

        this.addLog('AI', `Feature extraction [${symbol}] successful: created ${dataset.length} feature vectors (${dataset[0].features.length}-d).`, 'info-line');

        // T3.5 — Triple-barrier labeling should use a SYMMETRIC ATR multiplier for training
        // to prevent extreme label imbalance (e.g. TP=2.5 vs SL=1.0 makes the model predict SHORT ~80% of the time).
        // Using a symmetric barrier (e.g. max(slAtrMultiplier, 1.5)) ensures the model learns true price direction.
        const symmetricMultiplier = Math.max(this.slAtrMultiplier, 1.5);
        const horizon = Math.max(5, Math.min(15, Math.round(symmetricMultiplier * 5)));
        const labeledData = (this.tpAtrMultiplier > 0 && this.slAtrMultiplier > 0)
            ? this.ai.labelDatasetTripleBarrier(dataset, highs, lows, closes,
                horizon, symmetricMultiplier, symmetricMultiplier, true, 0.5)
            : this.ai.labelDataset(dataset, closes, 5, this.getLabelThreshold(this.currentTimeframe), true, 0.5);
        const numBuy = labeledData.filter(d => d.label === 1).length;
        const numSell = labeledData.filter(d => d.label === -1).length;
        const numHold = labeledData.filter(d => d.label === 0).length;

        this.addLog('AI', `Labeling [${symbol}] completed (triple-barrier ATR TP×${this.tpAtrMultiplier}/SL×${this.slAtrMultiplier}, horizon ${horizon}): ${numBuy} Long, ${numSell} Short, ${numHold} Hold (time-decay on).`, 'info-line');

        let accuracy = 'N/A';

        if (modelType === 'logistic') {
            const model = this.ai.trainLogisticRegression(labeledData);
            this.trainedModelMap[symbol] = model;

            let correct = 0;
            labeledData.forEach(d => {
                const pred = this.ai.predictLogisticRegression(model, d.features, this.confidenceThreshold);
                if (pred.signal === d.label) correct++;
            });
            const accFraction = correct / labeledData.length;
            this.logisticAccuracyMap[symbol] = accFraction;
            accuracy = (accFraction * 100).toFixed(1);
            this.addLog('AI', `Logistic Regression model [${symbol}] trained successfully! Accuracy: ${accuracy}% (threshold ${this.confidenceThreshold}%)`, 'buy-line');
        } else if (modelType === 'knn') {
            this.trainingFeaturesMap[symbol] = labeledData;
            this.addLog('AI', `KNN [${symbol}] successfully memorized ${labeledData.length} reference samples.`, 'buy-line');
            accuracy = '100.0 (Lazy Learner)';
        } else if (modelType === 'ensemble') {
            // T3.6 — train BOTH KNN and Logistic. Momentum needs no per-pair
            // state. evaluateLiveSignal will weight all three by recent realized
            // winrate per model.
            this.trainingFeaturesMap[symbol] = labeledData;
            const logModel = this.ai.trainLogisticRegression(labeledData);
            this.trainedModelMap[symbol] = logModel;
            let correct = 0;
            labeledData.forEach(d => {
                const pred = this.ai.predictLogisticRegression(logModel, d.features, this.confidenceThreshold);
                if (pred.signal === d.label) correct++;
            });
            const logAccFraction = correct / labeledData.length;
            this.logisticAccuracyMap[symbol] = logAccFraction;
            const logAcc = (logAccFraction * 100).toFixed(1);

            this.addLog('AI', `Ensemble [${symbol}] trained successfully: KNN ${labeledData.length} samples + Logistic (acc ${logAcc}%) + Momentum (stateless).`, 'buy-line');
            accuracy = `Ensemble (Logistic ${logAcc}%, KNN ${labeledData.length}, Momentum dyn)`;
        } else {
            this.addLog('AI', `Initialized quantitative Momentum strategy for [${symbol}].`, 'buy-line');
            accuracy = 'Dynamic';
        }

        this.aiBrainTrainedMap[symbol] = true;
        return { success: true, accuracy, numBuy, numSell, numHold };
    }

    /**
     * T3.6 — Probabilistic regime ensemble prediction.
     *
     * Runs the three in-process models in parallel and votes weighted by:
     *   - each model's per-vote confidence (so a low-confidence vote counts
     *     less than a high-confidence one), AND
     *   - each model's RECENT realized winrate over the last 50 closed
     *     trades attributed to it.
     *
     * Models with no track record yet get the prior weight 1.0 — they
     * still vote, just don't get punished or boosted.
     *
     * If no model produces a non-zero signal the ensemble returns HOLD.
     */
    public async predictEnsemble(
        pair: string,
        closes: number[],
        highs: number[],
        lows: number[],
        volumes: number[],
        currentFeatures: number[]
    ): Promise<{ signal: number; confidence: number; breakdown: string; ensembleCtx: EnsembleSignalContext }> {
        const knn = this.ai.predictKNN(this.trainingFeaturesMap[pair] || [], currentFeatures);
        const logistic = this.ai.predictLogisticRegression(this.trainedModelMap[pair] || null, currentFeatures, this.confidenceThreshold);
        const momentum = this.ai.predictMomentumStrategy(closes, highs, lows, volumes);

        const wKnn = this.modelWinrateWeight('knn');
        const wMom = this.modelWinrateWeight('momentum');

        // Accuracy-based weight multiplier for Logistic: penalize when in-sample
        // accuracy is below random (< 50%). Maps 45%→0.10, 55%→0.50, 65%→1.0.
        // Logistic is still allowed a small floor (0.10) so it's never fully silenced.
        const logAcc = this.logisticAccuracyMap[pair] ?? 0.50;
        const wAccuracy = Math.max(0, (logAcc - 0.45) / 0.20);
        const wLog = this.modelWinrateWeight('logistic') * Math.max(0.10, Math.min(1.0, wAccuracy));

        const votes: { name: string; signal: number; confidence: number; weight: number }[] = [
            { name: 'KNN', signal: knn.signal, confidence: knn.confidence, weight: wKnn },
            { name: 'LOG', signal: logistic.signal, confidence: logistic.confidence, weight: wLog },
            { name: 'MOM', signal: momentum.signal, confidence: momentum.confidence, weight: wMom }
        ];

        let scoreLong = 0;
        let scoreShort = 0;
        let totalWeight = 0;
        for (const v of votes) {
            const w = v.weight * (v.confidence / 100);
            if (v.signal === 1) scoreLong += w;
            else if (v.signal === -1) scoreShort += w;
            totalWeight += v.weight;
        }

        let signal = 0;
        let confidence = 50;
        const margin = Math.abs(scoreLong - scoreShort);
        if (margin > 1e-6 && totalWeight > 0) {
            signal = scoreLong > scoreShort ? 1 : -1;
            confidence = Math.min(95, Math.round((margin / totalWeight) * 100));
        }

        const breakdown = votes
            .map(v => `${v.name}=${v.signal === 1 ? 'L' : v.signal === -1 ? 'S' : 'H'}@${v.confidence}%*w${v.weight.toFixed(2)}`)
            .join(' | ');

        // Determine consensus level across all voting models.
        const modelCount = votes.length;
        const direction = signal === 1 ? 'LONG' : signal === -1 ? 'SHORT' : 'HOLD';
        const agreeing = votes.filter(v => v.signal === signal).length;
        const consensus: EnsembleSignalContext['consensus'] =
            agreeing === modelCount ? 'unanimous' :
                agreeing >= Math.ceil(modelCount / 2) ? 'majority' : 'split';

        const dirStr = (s: number) => s === 1 ? 'L' : s === -1 ? 'S' : 'H';
        const ensembleCtx: EnsembleSignalContext = {
            confidence,
            direction,
            consensus,
            modelVotes: {
                knn: { dir: dirStr(knn.signal), confidence: knn.confidence },
                log: { dir: dirStr(logistic.signal), confidence: logistic.confidence, accuracy: Math.round(logAcc * 100) },
                mom: { dir: dirStr(momentum.signal), confidence: momentum.confidence }
            }
        };

        return { signal, confidence, breakdown, ensembleCtx };
    }

    /**
     * Weight for a model based on its recent realized winrate. Falls back
     * to a neutral prior (1.0) when not enough trade history exists yet.
     * Floor at 0.2 so a temporarily-decayed model still gets some say.
     */
    private modelWinrateWeight(model: 'knn' | 'logistic' | 'momentum' | 'ensemble'): number {
        const h = this.computeModelHealth(model, 50);
        if (h.n < 10) return 1.0;
        // Map winrate ~50% → weight 1.0; 70% → ~1.4; 30% → ~0.4.
        return Math.max(0.2, Math.min(2.0, 0.4 + h.winrate * 2.0));
    }

    /**
     * Run server-side fast backtest
     */
    public runBacktest(params: any) {
        const symbol = params.pair || this.currentPair;
        // 'momentum' is stateless from the backtester's POV
        // (needs no per-pair training in-process), so don't gate it.
        const needsTraining = this.modelType === 'knn' || this.modelType === 'logistic';
        if (needsTraining && !this.aiBrainTrainedMap[symbol]) {
            return { success: false, error: 'Model not trained for this pair' };
        }

        const confidenceThreshold = params.confidenceThreshold || this.confidenceThreshold;
        const leverage = 1; // Force 1x Spot leverage (no leverage)
        const riskRatio = params.riskRatio || this.riskRatio;
        const tpMult = params.tpAtrMultiplier || this.tpAtrMultiplier;
        const slMult = params.slAtrMultiplier || this.slAtrMultiplier;

        // Support passing custom sliced candles/features for Train/Test split auto-optimizer
        const candles: Candle[] = params.candles || this.historicalCandlesMap[symbol] || [];
        if (candles.length < 250) return { success: false, error: 'No enough data for backtest' };

        const trainingFeatures = params.tempTrainingFeatures || this.trainingFeaturesMap[symbol];
        const trainedModel = params.tempTrainedModel || this.trainedModelMap[symbol];

        const closes = candles.map((c: Candle) => c.close);
        const highs = candles.map((c: Candle) => c.high);
        const lows = candles.map((c: Candle) => c.low);
        const volumes = candles.map((c: Candle) => c.volume);

        const dataset = this.ai.extractFeatures(closes, highs, lows, volumes);
        if (dataset.length === 0) return { success: false, error: 'No features extracted' };

        let backtestBalance = 10000.00;
        let activePos: any = null;

        const equityCurve: { time: number; value: number }[] = [];
        const equityCurveBH: { time: number; value: number }[] = [];
        const trades: TradeLog[] = [];

        const initialPrice = dataset[0].price;
        let totalTrades = 0;
        let wins = 0;
        let peak = backtestBalance;
        let maxDD = 0;
        // Per-trade realized PnL (after fees + funding). Used to compute
        // Profit Factor, Expectancy, avgWin/avgLoss, Sharpe — the metrics
        // that actually decide whether a strategy makes money.
        const tradePnLs: number[] = [];

        for (let i = 0; i < dataset.length; i++) {
            const dataPoint = dataset[i];
            const candleIndex = dataPoint.index;
            const currentPrice = dataPoint.price;
            const atr = dataPoint.atr;
            const candleTime = candles[candleIndex].time;

            // Check exiting active position
            if (activePos) {
                const entry = activePos.entryPrice;
                const size = activePos.size;
                const type = activePos.type;
                const originalTp = activePos.originalTp;

                // SMART QUANT: Trailing Stop & Breakeven in Backtest!
                if (this.smartOrderAdjustment) {
                    const targetPriceDiff = Math.abs(activePos.tp - entry);
                    const currentPriceDiff = type === 1 ? (currentPrice - entry) : (entry - currentPrice);
                    const dir = type === 1 ? 1 : -1;
                    const origSl = (activePos as any).originalSl ?? activePos.sl;
                    const originalRisk = Math.abs(origSl - entry);

                    if (!activePos.partialClosed) {
                        // --- BEFORE PARTIAL TP ---
                        // Tier 0: Profit > 30% -> Reduce SL or move to breakeven
                        if (currentPriceDiff > targetPriceDiff * 0.3) {
                            const lockPriceT0 = entry - dir * (originalRisk * 0.5);
                            const targetT0Price = this.riskReduction30ToEntry ? entry : lockPriceT0;
                            if (type === 1 && activePos.sl < targetT0Price) {
                                activePos.sl = targetT0Price;
                            } else if (type === -1 && activePos.sl > targetT0Price) {
                                activePos.sl = targetT0Price;
                            }
                        }

                        // Tier 1: Profit > 50% -> Move SL to Entry (breakeven)
                        if (currentPriceDiff > targetPriceDiff * 0.5) {
                            if (type === 1 && activePos.sl < entry) {
                                activePos.sl = entry;
                            } else if (type === -1 && activePos.sl > entry) {
                                activePos.sl = entry;
                            }

                            // Tier 2: Profit > 75% -> Lock next 25% profit
                            if (currentPriceDiff > targetPriceDiff * 0.75) {
                                const lockProfitPrice = entry + dir * (targetPriceDiff * 0.25);
                                if (type === 1 && activePos.sl < lockProfitPrice) {
                                    activePos.sl = lockProfitPrice;
                                } else if (type === -1 && activePos.sl > lockProfitPrice) {
                                    activePos.sl = lockProfitPrice;
                                }
                            }

                            // Tier 3: Profit > 90% -> Lock next 50% profit (Issue 5)
                            if (currentPriceDiff > targetPriceDiff * 0.90) {
                                const lockProfitPrice = entry + dir * (targetPriceDiff * 0.50);
                                if (type === 1 && activePos.sl < lockProfitPrice) {
                                    activePos.sl = lockProfitPrice;
                                } else if (type === -1 && activePos.sl > lockProfitPrice) {
                                    activePos.sl = lockProfitPrice;
                                }
                            }
                        }
                    } else {
                        // --- AFTER PARTIAL TP ---
                        // Here targetPriceDiff is the expanded TP2 distance (which is 2x the original target diff).
                        // So original target diff = targetPriceDiff / 2.

                        // Tier 4: Profit > 125% of original target (progress > 62.5% of new TP) -> Lock 50% of original profit
                        if (currentPriceDiff > targetPriceDiff * 0.625) {
                            const lockProfitPrice = entry + dir * (targetPriceDiff * 0.25);
                            if (type === 1 && activePos.sl < lockProfitPrice) {
                                activePos.sl = lockProfitPrice;
                            } else if (type === -1 && activePos.sl > lockProfitPrice) {
                                activePos.sl = lockProfitPrice;
                            }
                        }

                        // Tier 5: Profit > 150% of original target (progress > 75% of new TP) -> Lock 75% of original profit
                        if (currentPriceDiff > targetPriceDiff * 0.75) {
                            const lockProfitPrice = entry + dir * (targetPriceDiff * 0.375);
                            if (type === 1 && activePos.sl < lockProfitPrice) {
                                activePos.sl = lockProfitPrice;
                            } else if (type === -1 && activePos.sl > lockProfitPrice) {
                                activePos.sl = lockProfitPrice;
                            }
                        }

                        // Tier 6: Profit > 175% of original target (progress > 87.5% of new TP) -> Lock 90% of original profit
                        if (currentPriceDiff > targetPriceDiff * 0.875) {
                            const lockProfitPrice = entry + dir * (targetPriceDiff * 0.45);
                            if (type === 1 && activePos.sl < lockProfitPrice) {
                                activePos.sl = lockProfitPrice;
                            } else if (type === -1 && activePos.sl > lockProfitPrice) {
                                activePos.sl = lockProfitPrice;
                            }
                        }
                    }
                }

                let closed = false;
                let pnl = 0;
                let reason = '';

                if (type === 1) { // Long
                    // DCA check in backtest!
                    if (this.dcaEnabled && activePos.dcaStep && activePos.dcaStep < (activePos.dcaMaxSteps || this.dcaMaxSteps)) {
                        const dropPct = ((activePos.entryPrice - candles[candleIndex].low) / activePos.entryPrice) * 100;
                        const requiredDrop = activePos.dcaPriceDropPct ?? this.dcaPriceDropPct;
                        if (dropPct >= requiredDrop) {
                            const nextStep = activePos.dcaStep + 1;
                            const totalMargin = activePos.dcaTotalMargin || activePos.margin;
                            const allocationFraction = this.dcaCapitalAllocation[nextStep - 1];
                            if (allocationFraction) {
                                const stepMargin = totalMargin * allocationFraction;
                                const dcaPrice = activePos.entryPrice * (1 - requiredDrop / 100);
                                const slipDcaPrice = this.applySlippage(dcaPrice, 'BUY');
                                const tokenSizeAdded = stepMargin / slipDcaPrice;
                                const stepFee = slipDcaPrice * tokenSizeAdded * this.takerFeeRate;
                                backtestBalance -= stepFee;

                                const oldSize = activePos.size;
                                const oldMargin = activePos.margin;
                                const newSize = oldSize + tokenSizeAdded;
                                const newMargin = oldMargin + stepMargin;
                                const newEntryPrice = newMargin / newSize;

                                activePos.size = newSize;
                                activePos.margin = newMargin;
                                activePos.entryPrice = newEntryPrice;
                                activePos.dcaStep = nextStep;
                                activePos.feesPaid = (activePos.feesPaid || 0) + stepFee;

                                const activeSlMult = activePos.slMult || slMult;
                                const activeTpMult = activePos.tpMult || tpMult;
                                let newSl = newEntryPrice - atr * activeSlMult;
                                const newTp = newEntryPrice + atr * activeTpMult;

                                const minSlDist = atr * 0.8;
                                newSl = Math.min(newSl, newEntryPrice - minSlDist);

                                const start = Math.max(0, candleIndex - 14);
                                const recent = candles.slice(start, candleIndex + 1);
                                const swingLow = Math.min(...recent.map(c => c.low));
                                if (swingLow > 0) {
                                    newSl = Math.min(newSl, swingLow - 0.2 * atr);
                                }
                                const maxSlDistance = 2.5 * atr;
                                if (newEntryPrice - newSl > maxSlDistance) {
                                    newSl = newEntryPrice - maxSlDistance;
                                }

                                activePos.sl = newSl;
                                activePos.tp = newTp;
                                activePos.originalSl = newSl;
                                activePos.trailingTier = 0;

                                trades.push({
                                    time: new Date(candleTime * 1000).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
                                    pair: symbol,
                                    type: 'DCA Buy',
                                    side: 'BUY Long 🛒',
                                    price: slipDcaPrice,
                                    size: (stepMargin / leverage).toFixed(2),
                                    leverage: `${leverage}x`,
                                    pnl: -stepFee,
                                    status: `Step ${nextStep}/${activePos.dcaMaxSteps}`
                                });
                            }
                        }
                    }

                    if (candles[candleIndex].low <= activePos.sl) {
                        // SL fills with adverse slippage going the wrong way.
                        const exitFill = this.applySlippage(activePos.sl, 'SELL');
                        const exitFee = exitFill * size * this.takerFeeRate;
                        pnl = size * (exitFill - entry) - exitFee;
                        activePos.feesPaid = (activePos.feesPaid || 0) + exitFee;
                        closed = true;
                        reason = activePos.partialClosed ? 'Trailing Stop 🟠' : 'Stop Loss 🔴';
                    } else if (candles[candleIndex].high >= activePos.tp) {
                        // Issue 6: Partial Take Profit in Backtest
                        if (!activePos.partialClosed) {
                            const halfSize = size / 2;
                            const tpExit = this.applySlippage(activePos.tp, 'SELL');
                            const exitFee = tpExit * halfSize * this.takerFeeRate;
                            const partialPnL = halfSize * (tpExit - entry) - exitFee;
                            backtestBalance += partialPnL;
                            activePos.feesPaid = (activePos.feesPaid || 0) + exitFee;

                            activePos.size = halfSize;
                            activePos.sl = entry; // Move SL to Entry
                            activePos.tp = entry + Math.abs(originalTp - entry) * 2; // Extend TP2
                            activePos.partialClosed = true;

                            trades.push({
                                time: new Date(candleTime * 1000).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
                                pair: symbol,
                                type: 'Partial Take Profit',
                                side: 'Exit Long',
                                price: tpExit,
                                size: (halfSize * entry / leverage).toFixed(2),
                                leverage: `${leverage}x`,
                                pnl: partialPnL,
                                status: 'Partial TP 50% 🟢'
                            });
                        } else {
                            const tpExit = this.applySlippage(activePos.tp, 'SELL');
                            const exitFee = tpExit * size * this.takerFeeRate;
                            pnl = size * (tpExit - entry) - exitFee;
                            activePos.feesPaid = (activePos.feesPaid || 0) + exitFee;
                            closed = true;
                            reason = 'Take Profit 🟢';
                        }
                    }
                } else { // Short
                    if (candles[candleIndex].high >= activePos.sl) {
                        const exitFill = this.applySlippage(activePos.sl, 'BUY');
                        const exitFee = exitFill * size * this.takerFeeRate;
                        pnl = size * (entry - exitFill) - exitFee;
                        activePos.feesPaid = (activePos.feesPaid || 0) + exitFee;
                        closed = true;
                        reason = activePos.partialClosed ? 'Trailing Stop 🟠' : 'Stop Loss 🔴';
                    } else if (candles[candleIndex].low <= activePos.tp) {
                        // Issue 6: Partial Take Profit in Backtest
                        if (!activePos.partialClosed) {
                            const halfSize = size / 2;
                            const tpExit = this.applySlippage(activePos.tp, 'BUY');
                            const exitFee = tpExit * halfSize * this.takerFeeRate;
                            const partialPnL = halfSize * (entry - tpExit) - exitFee;
                            backtestBalance += partialPnL;
                            activePos.feesPaid = (activePos.feesPaid || 0) + exitFee;

                            activePos.size = halfSize;
                            activePos.sl = entry; // Move SL to Entry
                            activePos.tp = entry - Math.abs(originalTp - entry) * 2; // Extend TP2
                            activePos.partialClosed = true;

                            trades.push({
                                time: new Date(candleTime * 1000).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
                                pair: symbol,
                                type: 'Partial Take Profit',
                                side: 'Exit Short',
                                price: currentPrice,
                                size: (halfSize * entry / leverage).toFixed(2),
                                leverage: `${leverage}x`,
                                pnl: partialPnL,
                                status: 'Partial TP 50% 🟢'
                            });
                        } else {
                            const tpExit = this.applySlippage(activePos.tp, 'BUY');
                            const exitFee = tpExit * size * this.takerFeeRate;
                            pnl = size * (entry - tpExit) - exitFee;
                            activePos.feesPaid = (activePos.feesPaid || 0) + exitFee;
                            closed = true;
                            reason = 'Take Profit 🟢';
                        }
                    }
                }

                if (closed) {
                    // Apply funding cost for time held.
                    if (activePos && activePos.openTimeMs) {
                        const holdMs = (candleTime * 1000) - activePos.openTimeMs;
                        const fundingCost = this.computeFundingCost(size * entry, holdMs);
                        pnl -= fundingCost;
                        activePos.feesPaid = (activePos.feesPaid || 0) + fundingCost;
                    }
                    backtestBalance += pnl;
                    totalTrades++;
                    if (pnl > 0) wins++;
                    tradePnLs.push(pnl);

                    trades.push({
                        time: new Date(candleTime * 1000).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
                        pair: symbol,
                        type: 'Market Exit',
                        side: type === 1 ? 'Exit Long' : 'Exit Short',
                        price: pnl > 0 ? activePos.tp : activePos.sl,
                        size: (size * entry / leverage).toFixed(2),
                        leverage: `${leverage}x`,
                        pnl: pnl,
                        status: reason
                    });
                    activePos = null;
                }
            }

            // Open position if none active
            if (!activePos) {
                let pred = { signal: 0, confidence: 50 };

                if (this.modelType === 'knn') {
                    pred = this.ai.predictKNN(trainingFeatures, dataPoint.features);
                } else if (this.modelType === 'logistic') {
                    pred = this.ai.predictLogisticRegression(trainedModel, dataPoint.features, confidenceThreshold);
                } else {
                    // Issue 3: Pass volumes to Momentum Strategy
                    pred = this.ai.predictMomentumStrategy(closes.slice(0, candleIndex + 1), highs.slice(0, candleIndex + 1), lows.slice(0, candleIndex + 1), volumes.slice(0, candleIndex + 1));
                }

                if (pred.signal === 1 && pred.confidence >= confidenceThreshold) {
                    const direction = 1; // strictly LONG
                    let dynamicTpMultiplier = tpMult;
                    let dynamicSlMultiplier = slMult;
                    let dynamicRiskRatio = riskRatio;

                    // SMART QUANT: Auto scale order size/TP based on AI confidence (Issue 7)
                    if (this.smartOrderAdjustment) {
                        if (pred.confidence >= 80) {
                            dynamicTpMultiplier = tpMult * 1.5; // Extend take profit instead of increasing margin size (increase reward instead of risk)
                        } else if (pred.confidence <= 65) {
                            dynamicRiskRatio = riskRatio * 0.6; // Reduce risk when confidence is low
                        }
                    }

                    // Dynamic market regime adjustment based on pair's Choppiness Index in Backtest
                    const subCandles = closes.slice(0, candleIndex + 1);
                    const localChop = subCandles.length >= 30 ? this.calculateChoppinessIndex(candles.slice(0, candleIndex + 1)) : 50;
                    if (localChop < 50) {
                        dynamicTpMultiplier = dynamicTpMultiplier * 1.3;
                        dynamicSlMultiplier = dynamicSlMultiplier * 0.9;
                    } else if (localChop > 60) {
                        dynamicTpMultiplier = dynamicTpMultiplier * 0.8;
                        dynamicSlMultiplier = dynamicSlMultiplier * 1.2;
                    }

                    let margin = backtestBalance * dynamicRiskRatio;
                    let sizeUSDT = margin * leverage;
                    if (this.dcaEnabled && direction === 1) {
                        const initialFraction = this.dcaCapitalAllocation[0] || 0.2;
                        sizeUSDT = sizeUSDT * initialFraction;
                        margin = margin * initialFraction;
                    }
                    const sizeToken = sizeUSDT / currentPrice;

                    // Honest entry: apply slippage to the fill price.
                    const entryFillPrice = direction === 1
                        ? this.applySlippage(currentPrice, 'BUY')
                        : this.applySlippage(currentPrice, 'SELL');
                    const entryFee = entryFillPrice * sizeToken * this.takerFeeRate;
                    backtestBalance -= entryFee; // entry fee paid out of cash

                    let sl = direction === 1 ? (entryFillPrice - atr * dynamicSlMultiplier) : (entryFillPrice + atr * dynamicSlMultiplier);
                    const tp = direction === 1 ? (entryFillPrice + atr * dynamicTpMultiplier) : (entryFillPrice - atr * dynamicTpMultiplier);

                    // Swing high/low protection for Stop Loss in Backtest
                    if (direction === 1) {
                        const start = Math.max(0, candleIndex - 14);
                        const recent = candles.slice(start, candleIndex + 1);
                        const swingLow = Math.min(...recent.map(c => c.low));
                        if (swingLow > 0) {
                            sl = Math.min(sl, swingLow - 0.2 * atr);
                        }
                        const maxSlDistance = 2.5 * atr;
                        if (entryFillPrice - sl > maxSlDistance) {
                            sl = entryFillPrice - maxSlDistance;
                        }
                    } else {
                        const start = Math.max(0, candleIndex - 14);
                        const recent = candles.slice(start, candleIndex + 1);
                        const swingHigh = Math.max(...recent.map(c => c.high));
                        if (swingHigh > 0) {
                            sl = Math.max(sl, swingHigh + 0.2 * atr);
                        }
                        const maxSlDistance = 2.5 * atr;
                        if (sl - entryFillPrice > maxSlDistance) {
                            sl = entryFillPrice + maxSlDistance;
                        }
                    }

                    let posDcaPriceDropPct: number | undefined = undefined;
                    if (this.dcaEnabled && direction === 1) {
                        const initialSlDistPct = ((entryFillPrice - sl) / entryFillPrice) * 100;
                        const stepsToFit = Math.max(1, this.dcaMaxSteps - 1);
                        posDcaPriceDropPct = Math.max(this.dcaPerStepDropFloor(), Math.min(this.dcaPriceDropPct, (initialSlDistPct / stepsToFit) * 0.8));
                    }

                    activePos = {
                        type: direction,
                        entryPrice: entryFillPrice,
                        size: sizeToken,
                        margin,
                        sl,
                        tp,
                        originalTp: tp,
                        originalSl: sl,
                        partialClosed: false,
                        openTimeMs: candleTime * 1000,
                        feesPaid: entryFee,
                        slMult: dynamicSlMultiplier,
                        tpMult: dynamicTpMultiplier,
                        dcaStep: (this.dcaEnabled && direction === 1) ? 1 : undefined,
                        dcaMaxSteps: (this.dcaEnabled && direction === 1) ? this.dcaMaxSteps : undefined,
                        dcaTotalMargin: (this.dcaEnabled && direction === 1) ? (backtestBalance * dynamicRiskRatio) : undefined,
                        dcaPriceDropPct: posDcaPriceDropPct
                    };

                    trades.push({
                        time: new Date(candleTime * 1000).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit' }),
                        pair: symbol,
                        type: 'Market Entry',
                        side: direction === 1 ? 'BUY Long 🟢' : 'SELL Short 🔴',
                        price: entryFillPrice,
                        size: margin.toFixed(2),
                        leverage: `${leverage}x`,
                        pnl: -entryFee,
                        status: 'Filled'
                    });
                }
            }

            // Record equity (unrealized leg includes negative open fees)
            let tempEquity = backtestBalance;
            if (activePos) {
                const unrealized = activePos.type === 1 ? activePos.size * (currentPrice - activePos.entryPrice) : activePos.size * (activePos.entryPrice - currentPrice);
                tempEquity += unrealized;
            }

            if (tempEquity > peak) peak = tempEquity;
            const dd = ((peak - tempEquity) / peak) * 100;
            if (dd > maxDD) maxDD = dd;

            equityCurve.push({ time: candleTime, value: tempEquity });
            equityCurveBH.push({ time: candleTime, value: 10000.00 * (currentPrice / initialPrice) });
        }

        const botPnL = ((backtestBalance - 10000.00) / 10000.00) * 100;
        const bhPnL = ((closes[closes.length - 1] - initialPrice) / initialPrice) * 100;
        const winrate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

        // ===========================================================
        // Quality metrics (Phase 0.5)
        // Winrate alone is a TERRIBLE indicator. A 90% winrate with one
        // catastrophic loss can wipe an account. These are the metrics
        // professional desks actually optimize for:
        // ===========================================================
        const winningTrades = tradePnLs.filter(p => p > 0);
        const losingTrades = tradePnLs.filter(p => p < 0);
        const grossProfit = winningTrades.reduce((s, p) => s + p, 0);
        const grossLoss = Math.abs(losingTrades.reduce((s, p) => s + p, 0));
        // Profit Factor = gross win / gross loss. >1 means net profitable.
        // Infinity here means there were no losing trades (or only wins).
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
        const avgWin = winningTrades.length > 0 ? grossProfit / winningTrades.length : 0;
        const avgLoss = losingTrades.length > 0 ? grossLoss / losingTrades.length : 0;
        // Expectancy per trade = avg PnL across all trades. >0 means edge.
        const expectancy = totalTrades > 0 ? tradePnLs.reduce((s, p) => s + p, 0) / totalTrades : 0;
        // Simple equity-curve Sharpe (no risk-free rate). Annualization assumes
        // 365 candles ≈ 1 year — rough but useful for relative ranking.
        let sharpe = 0;
        if (equityCurve.length > 2) {
            const rets: number[] = [];
            for (let i = 1; i < equityCurve.length; i++) {
                const prev = equityCurve[i - 1].value;
                if (prev > 0) rets.push((equityCurve[i].value - prev) / prev);
            }
            if (rets.length > 1) {
                const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
                const variance = rets.reduce((s, r) => s + (r - mean) * (r - mean), 0) / rets.length;
                const stdev = Math.sqrt(variance);
                if (stdev > 0) sharpe = (mean / stdev) * Math.sqrt(365);
            }
        }

        return {
            success: true,
            botPnL,
            botPnLUsd: backtestBalance - 10000.00,
            bhPnL,
            winrate,
            wins,
            totalTrades,
            tradesRatio: `${wins} wins / ${totalTrades} trades`,
            maxDrawdown: maxDD,
            // Honest quality metrics — use these to judge strategies, not winrate.
            profitFactor,
            expectancy,
            avgWin,
            avgLoss,
            sharpe,
            equityCurve,
            equityCurveBH,
            trades
        };
    }

    /**
     * Run predictions on Server background tick kline close
     */
    private getTimeframeMs(tf: string): number {
        const value = parseInt(tf.slice(0, -1));
        const unit = tf.slice(-1);
        switch (unit) {
            case 'm': return value * 60 * 1000;
            case 'h': return value * 60 * 60 * 1000;
            case 'd': return value * 24 * 60 * 60 * 1000;
            default: return 15 * 60 * 1000;
        }
    }

    private formatPrice(price: number | undefined | null): string {
        if (price == null) return '0';
        if (price === 0) return '0';
        const abs = Math.abs(price);
        if (abs < 0.0001) return price.toFixed(8);
        if (abs < 1) return price.toFixed(6);
        return price.toLocaleString('vi-VN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    }

    /**
     * Run predictions on Server background tick kline close
     */
    private async evaluateLiveSignal(pair: string, candleTime: number) {
        if (!this.activePairs.includes(pair)) return;
        if (this.lastCandleTimesEvaluated[pair] === candleTime) return;
        this.lastCandleTimesEvaluated[pair] = candleTime;

        // Issue 8: Daily Drawdown Limit Circuit Breaker
        const today = new Date().toISOString().split('T')[0];
        if (today !== this.dailyPnLResetDate) {
            this.dailyPnL = 0;
            this.dailyPnLResetDate = today;
            this.dailyEquityPeak = 0;
        }

        this.refreshDailyEquityPeak();

        if (this.dailyPnL <= -(this.initialCapital * this.maxDailyDrawdown)) {
            this.addLog('BOT', `🛑 DAILY LIMIT: Daily drawdown limit reached (${(this.maxDailyDrawdown * 100)}%). Paused new trades for the rest of the day to protect capital.`, 'warning-line');
            return;
        }

        // Issue 12: Cooldown anti-overtrading (revenge trading)
        const minCooldownMs = 3 * this.getTimeframeMs(this.currentTimeframe);
        if (Date.now() - (this.lastClosedTime[pair] || 0) < minCooldownMs) {
            this.addLog('BOT', `⏳ COOLDOWN [${pair}]: In 3-candle cooldown after previous trade. Ignoring signal.`, 'warning-line');
            return;
        }

        // Auto-retrain AI in background to integrate newly closed candle into dataset (Continuous Learning!)
        // bsc_twak mode uses LLM + CMC signals — no ML retraining needed.
        if (this.modelType !== 'momentum') {
            this.addLog('SYSTEM', `CONTINUOUS LEARNING: Auto-retraining model ${this.modelType.toUpperCase()} on candle close for ${pair}...`, 'info-line');
            this.trainModel(this.modelType, pair);
        }

        // Auto-optimize parameters periodically after every 50 closed candles!
        this.candlesSinceLastOptimization++;
        if (this.candlesSinceLastOptimization >= 50) {
            this.candlesSinceLastOptimization = 0;
            this.addLog('SYSTEM', `PERIODIC OPTIMIZATION: 50 candles since last optimization. Automatically triggering Grid Search parameter optimization for ${pair}...`, 'info-line');
            this.autoOptimizeHyperparameters(pair);
        }

        this.addLog('BOT', `Evaluating candle close signals on Server for ${pair}...`, 'info-line');

        // ── Standard Binance / simulated mode ─────────────────────────────────────
        const candles = this.historicalCandlesMap[pair] || [];
        if (candles.length === 0) return;

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);

        const dataset = this.ai.extractFeatures(closes, highs, lows, volumes);
        if (dataset.length === 0) return;

        const currentPoint = dataset[dataset.length - 1];
        const currentPrice = currentPoint.price;
        const atr = currentPoint.atr;

        let pred = { signal: 0, confidence: 50 };

        if (this.modelType === 'knn') {
            pred = this.ai.predictKNN(this.trainingFeaturesMap[pair], currentPoint.features);
        } else if (this.modelType === 'logistic') {
            pred = this.ai.predictLogisticRegression(this.trainedModelMap[pair], currentPoint.features, this.confidenceThreshold);
        } else if (this.modelType === 'ensemble') {
            // T3.6 — parallel 3-model weighted ensemble.
            const ens = await this.predictEnsemble(pair, closes, highs, lows, volumes, currentPoint.features);
            pred = { signal: ens.signal, confidence: ens.confidence };
            this.lastEnsembleSignalMap[pair] = ens.ensembleCtx;
            this.addLog('AI', `🧠 ENSEMBLE [${pair}] ${ens.breakdown} → ${pred.signal === 1 ? 'LONG' : pred.signal === -1 ? 'SHORT' : 'HOLD'} (${pred.confidence}%)`, 'info-line');
        } else {
            // Issue 3: Pass volumes to Momentum Strategy
            pred = this.ai.predictMomentumStrategy(closes, highs, lows, volumes);
        }

        const signalText = pred.signal === 1 ? 'BUY (LONG)' : (pred.signal === -1 ? 'SELL (SHORT)' : 'HOLD');
        const logStyle = pred.signal === 1 ? 'buy-line' : (pred.signal === -1 ? 'sell-line' : 'system-line');

        this.addLog('AI', `Analysis [${pair}]: [${signalText}] | Confidence: ${pred.confidence}% (Required: ${this.confidenceThreshold}%)`, logStyle);

        // AI SMART GRID: If grid mode is enabled, evaluate for Grid Deployment instead of single-entry order
        if (this.gridModeEnabled) {
            if (!this.gridActiveMap[pair]) {
                const isSideway = this.ai.isMarketSideway(closes, highs, lows);
                if (isSideway) {
                    this.initializeSmartGrid(pair, currentPrice, atr);
                } else {
                    this.addLog('AI', `Grid Analysis [${pair}]: Market trending, grid not deployed. Waiting for sideway phase...`, 'system-line');
                }
            } else {
                this.addLog('BOT', `Smart Grid [${pair}] is active. Price range: ${this.gridLowerBoundaries[pair].toLocaleString()} - ${this.gridUpperBoundaries[pair].toLocaleString()}`, 'info-line');
            }
            return;
        }

        if (pred.signal !== 0) {
            // Adaptive threshold: relax in strong trending markets (aligned with HTF),
            // tighten in choppy/ranging markets to reduce whipsaws.
            const htf = await this.getHtfBias(pair);
            const lastHtfBias = htf ? htf.bias : 0;
            const localChopForThreshold = candles.length >= 30 ? this.calculateChoppinessIndex(candles) : 55;
            const isTrendAligned = (pred.signal === 1 && lastHtfBias === 1);
            let effectiveThreshold = this.confidenceThreshold;
            if (isTrendAligned && localChopForThreshold < 50) {
                // Trending + HTF agreement: lower threshold by 10% to enter faster
                effectiveThreshold = Math.max(45, Math.round(this.confidenceThreshold * 0.90));
            } else if (localChopForThreshold > 65) {
                // Choppy market: raise threshold by 10% to reduce false entries
                effectiveThreshold = Math.min(80, Math.round(this.confidenceThreshold * 1.10));
            }

            if (pred.confidence < effectiveThreshold) {
                const adaptNote = effectiveThreshold !== this.confidenceThreshold
                    ? ` (adaptive threshold: ${effectiveThreshold}%)` : '';
                this.addLog('BOT', `⚠️ Skipping signal [${pair}]: Confidence (${pred.confidence}%) does not meet minimum requirement (${effectiveThreshold}%${adaptNote}).`, 'warning-line');
                return;
            }
        } else {
            // Signal is HOLD, so no order is opened
            return;
        }

        // ============================================================
        // Phase 2: Multi-timeframe confluence filter.
        // bsc_twak returns early above via evaluateCMCSignal, so this
        // block is Binance/simulated mode only.
        // ============================================================
        try {
            const htf = await this.getHtfBias(pair);
            if (htf && htf.bias !== 0) {
                const against = (pred.signal === 1 && htf.bias === -1);
                if (against && pred.confidence < 85) {
                    this.addLog('BOT', `🛡️ HTF CONFLUENCE [${pair}]: Skipping LONG because 1H trend is opposite (bias=${htf.bias}). Need confidence ≥ 85% to trade counter-trend.`, 'warning-line');
                    return;
                }
            }
        } catch {
            // Filter is best-effort; never block trading on a fetch error.
        }

        // ============================================================
        // T3.4 — Risk overlay (3 pre-trade filters)
        // These run BEFORE position sizing because they're cheap and a
        // blocked trade just means we wait for the next candle. The goal
        // is to refuse trades when the realized edge of any model is
        // unlikely to survive the realized risk on the table.
        // ============================================================

        // (a) Volatility blackout: ATR_recent / ATR_baseline > 3 → vol spike
        // (likely crash/pump). Edge for trend-following models collapses in
        // these regimes; skip the candle entirely.
        const atrLookback = Math.min(30, dataset.length - 1);
        if (atrLookback >= 5) {
            let sum = 0;
            let count = 0;
            for (let i = dataset.length - 1 - atrLookback; i < dataset.length - 1; i++) {
                if (i >= 0 && Number.isFinite(dataset[i].atr)) {
                    sum += dataset[i].atr;
                    count++;
                }
            }
            const baseline = count > 0 ? sum / count : currentPoint.atr;
            const ratio = baseline > 0 ? currentPoint.atr / baseline : 1;
            if (ratio > 3.0) {
                this.addLog('BOT', `🌪️ VOL BLACKOUT [${pair}]: Current ATR / Average ATR (${atrLookback} candles) = ${ratio.toFixed(2)}x (>3x). Market spike — skipping trade to avoid extremely high noise zone.`, 'warning-line');
                return;
            }
        }

        // (b) News blackout: FOMC + CPI release windows.
        // The bot is configured via env var BOT_NEWS_BLACKOUTS (CSV of ISO
        // timestamps). For each blackout time we skip from -30m to +60m
        // around it. This is a coarse but reliable way to dodge headline-
        // driven moves that no chart pattern can predict.
        if (this.isInsideNewsBlackout()) {
            this.addLog('BOT', `📰 NEWS BLACKOUT [${pair}]: Inside FOMC / CPI release window. Skipping trade to avoid news volatility.`, 'warning-line');
            return;
        }

        // (c) Correlation cap removed per user request: same-direction positions
        // across multiple pairs are now allowed (no 2-position same-side limit).

        const hasPos = this.openPositions.find(p => p.symbol === pair);
        if (hasPos) {
            this.addLog('BOT', `Skipping signal: Position ${pair} is already open.`, 'warning-line');
            return;
        }

        const direction = pred.signal;
        if (direction === -1) {
            this.addLog('BOT', `Skipping SHORT signal [${pair}]: Bot is running Spot Long-Only.`, 'warning-line');
            return;
        }

        // Strict portfolio capital split: each pair can use maximum 1/N of overall simulated equity
        const totalCapital = this.balance + this.marginUsed;
        const targetPairMargin = totalCapital / this.activePairs.length;
        const pairMarginUsed = this.openPositions.filter(p => p.symbol === pair).reduce((sum, p) => sum + p.margin, 0) + (this.gridActiveMap[pair] ? this.gridOrdersMap[pair].reduce((sum, o) => sum + (o.status === 'FILLED' ? o.margin : 0), 0) : 0);

        let margin = targetPairMargin * this.riskRatio;
        let dynamicTpMultiplier = this.tpAtrMultiplier;
        let dynamicSlMultiplier = this.slAtrMultiplier;
        let sizeMultiplier = 1.0;

        // Dynamic market regime adjustment based on pair's Choppiness Index and Trend Intensity
        const localChop = candles.length >= 30 ? this.calculateChoppinessIndex(candles) : 50;
        if (localChop < 50) {
            // Trending: wider TP, tighter SL
            dynamicTpMultiplier = dynamicTpMultiplier * 1.3;
            dynamicSlMultiplier = dynamicSlMultiplier * 0.9;
        } else if (localChop > 60) {
            // Choppy/Range: tighter TP, wider SL
            dynamicTpMultiplier = dynamicTpMultiplier * 0.8;
            dynamicSlMultiplier = dynamicSlMultiplier * 1.2;
        }

        // SMART QUANT: Auto-adjust order size/TP based on AI confidence (Issue 7)
        if (this.smartOrderAdjustment) {
            if (pred.confidence >= 80) {
                dynamicTpMultiplier = this.tpAtrMultiplier * 1.5; // Extend take profit instead of increasing margin size (increase reward instead of risk)
                this.addLog('BOT', `🛡️ SMART QUANT [${pair}]: Extremely high confidence (${pred.confidence}%). Auto-extended TP to 1.5x (${dynamicTpMultiplier.toFixed(1)} ATR) to optimize Risk/Reward!`, 'buy-line');
            } else if (pred.confidence <= 65) {
                sizeMultiplier = 0.6;
                this.addLog('BOT', `🛡️ SMART QUANT [${pair}]: Low confidence (${pred.confidence}%). Auto-reduced order size to 0.6x to protect capital!`, 'warning-line');
            }
            margin = margin * sizeMultiplier;
        }

        // LLM Quant Operator can scale risk up/down (bounded). When LLM is
        // disabled or returned no decision, llmRiskMultiplier stays at 1.0.
        if (this.quantOperatorEnabled && this.llmRiskMultiplier !== 1.0) {
            margin = margin * this.llmRiskMultiplier;
            this.addLog('BOT', `🤖 LLM RISK [${pair}]: Quant Operator applied risk multiplier x${this.llmRiskMultiplier.toFixed(2)} for this order.`, 'info-line');
        }

        // Global order-size multiplier (e.g. 2.0 = double order size).
        if (this.orderSizeMultiplier && this.orderSizeMultiplier !== 1.0) {
            margin = margin * this.orderSizeMultiplier;
        }

        const pairBudgetRemaining = Math.max(0, targetPairMargin - pairMarginUsed);
        if (margin > pairBudgetRemaining) {
            margin = pairBudgetRemaining;
        }

        if (margin <= 0) {
            this.addLog('BOT', `Skipping signal [${pair}]: Allocated budget for this pair has run out or is 0.`, 'warning-line');
            return;
        }

        let sizeUSDT = margin; // Spot size is exactly the margin allocated (no leverage)
        if (this.dcaEnabled) {
            const initialFraction = this.dcaCapitalAllocation[0] || 0.2;
            sizeUSDT = margin * initialFraction;
        }

        // Enforce minimum order size
        if (sizeUSDT < this.minOrderSize) {
            sizeUSDT = this.minOrderSize;
        }

        if (sizeUSDT > this.marginFree) {
            this.addLog('BOT', `Cancelled order [${pair}]: Insufficient USDT balance. Required: ${sizeUSDT.toFixed(2)}, Available: ${this.marginFree.toFixed(2)}`, 'warning-line');
            return;
        }

        let tokenSize = sizeUSDT / currentPrice;

        // Guard: Binance rejects orders below the LOT_SIZE stepSize (error -4003 / "rounds to 0").
        // Each symbol has a different minimum quantity — e.g. BTC requires ≥0.001 BTC.
        if (this.liveTradingMode !== 'bsc_twak' && this.liveTradingMode !== 'simulated') {
            const minLotSize = this.getMinLotSize(pair);
            if (tokenSize < minLotSize) {
                const minNotionalNeeded = Math.ceil(minLotSize * currentPrice * 1.05);
                this.addLog('BOT', `⚠️ Skipping order [${pair}]: Size too small (${tokenSize.toFixed(6)} < min lot ${minLotSize}). Needs notional ≥${minNotionalNeeded} — increase balance or decrease minimum risk!`, 'warning-line');
                return;
            }
            if (sizeUSDT < 6) {
                this.addLog('BOT', `⚠️ Skipping order [${pair}]: Notional too small (${sizeUSDT.toFixed(2)} < $6 USDT). Increase allocated balance to place order.`, 'warning-line');
                return;
            }
        } else {
            // Soft guard for on-chain/simulation: prevent zero or negative value swaps
            if (sizeUSDT <= 0) {
                this.addLog('BOT', `⚠️ Skipping order [${pair}]: Calculated size is zero or negative (${sizeUSDT.toFixed(2)} USDT).`, 'warning-line');
                return;
            }
        }

        // LLM Quant Operator can tighten/loosen SL and extend/shrink TP (bounded).
        // Neutral (1.0) when the operator is off or returned no adjustment.
        const slMultEff = this.quantOperatorEnabled ? dynamicSlMultiplier * this.llmSlTightness : dynamicSlMultiplier;
        const tpMultEff = this.quantOperatorEnabled ? dynamicTpMultiplier * this.llmTpExtension : dynamicTpMultiplier;
        let sl = 0;
        let tp = 0;

        if (this.liveTradingMode === 'bsc_twak') {
            const expectedCost = this.getExpectedRoundtripCost(sizeUSDT);
            // Log warning if capital allocation is too small (e.g. < $15)
            if (sizeUSDT < 15) {
                this.addLog('BOT', `⚠️ [SIZE WARNING] Trade size ($${sizeUSDT.toFixed(2)}) is too small. Fixed BSC gas fees (~$0.40/tx) and swap slippage will consume ~${((expectedCost / sizeUSDT) * 100).toFixed(1)}% of this trade's value. Consider using at least $15 USDT.`, 'warning-line');
            }
        }

        let finalEntryPrice = currentPrice;
        let binanceOrderId: string | undefined = undefined;
        let slOrderId: string | undefined = undefined;

        if (this.liveTradingMode === 'bsc_twak') {
            // ── BSC TWAK execution (same as standard bsc_twak block) ─────────────
            const twak = this.getTWAKClient();
            if (!twak) {
                this.addLog('BOT', `❌ BSC TWAK [${pair}]: Failed to initialize TWAK client.`, 'warning-line');
                return;
            }

            if (isCompetitionActive()) {
                const totalUsd = await twak.getTotalPortfolioUsd().catch(() => this.balance);
                const guard = checkTradeAllowed(totalUsd);
                if (!guard.allowed) {
                    this.addLog('BOT', `🛑 COMPETITION GUARD [${pair}]: ${guard.reason}`, 'warning-line');
                    return;
                }
                if (!isEligiblePair(pair)) {
                    this.addLog('BOT', `⚠️ BSC [${pair}]: Token is not in the 149 eligible list. Skipping.`, 'warning-line');
                    return;
                }
            }

            try {
                const bscSym = this.bscToken(pair);
                this.addLog('BOT', `📡 BSC TWAK: Swap ${sizeUSDT.toFixed(2)} USDT → ${bscSym} on BSC...`, 'info-line');
                const swapRes = await twak.buyToken(sizeUSDT, bscSym, 1);
                binanceOrderId = swapRes.txHash;
                finalEntryPrice = swapRes.executedPrice > 0 ? swapRes.executedPrice : currentPrice;
                tokenSize = swapRes.toAmount > 0 ? swapRes.toAmount : tokenSize;

                if (isCompetitionActive()) recordTrade(swapRes.txHash);
                this.addLog('BOT', `✅ BSC TWAK Entry filled. Price: ${this.formatPrice(finalEntryPrice)} | ${tokenSize.toFixed(6)} ${bscSym} | TX: ${swapRes.txHash.slice(0, 12)}...`, 'buy-line');

                // Cache entry price details
                this.tokenEntryPrices[pair] = { entryPrice: finalEntryPrice, openTime: Date.now() };
            } catch (e: any) {
                this.addLog('BOT', `❌ BSC TWAK Entry failed [${pair}]: ${e.message}`, 'warning-line');
                return;
            }
        } else {
            finalEntryPrice = this.applySlippage(currentPrice, 'BUY');
            tokenSize = sizeUSDT / finalEntryPrice;
        }

        // Recalculate SL/TP targets based on the final execution price
        sl = finalEntryPrice - atr * slMultEff;
        tp = finalEntryPrice + atr * tpMultEff;

        if (this.liveTradingMode === 'bsc_twak') {
            const exitSlippage = this.effectiveSlippageBps / 10000;
            const exitFeeRate = this.effectiveTakerFeeRate;
            const exitGas = this.getBscGasFeeUsdt();
            // Use actual entry overhead (margin paid - tokens received at entryPrice)
            // instead of estimated entryGas to avoid miscounting sunk costs.
            const notionalReceived = tokenSize * finalEntryPrice;
            const entryOverhead = Math.max(0, sizeUSDT - notionalReceived);
            // Break-even: exit proceeds must cover margin + actual entry overhead
            // exitProceeds = tokenSize × breakEvenPrice × (1-slip) - tokenSize × breakEvenPrice × fee
            // = tokenSize × breakEvenPrice × (1 - slip - fee)
            // Break-even: tokenSize × breakEvenPrice × (1-slip-fee) - exitGas = sizeUSDT
            const breakEvenPrice = (sizeUSDT + exitGas) / (tokenSize * (1 - exitSlippage - exitFeeRate));

            if (tp < breakEvenPrice) {
                tp = breakEvenPrice + (atr * 0.5); // Add buffer for net profit
                this.addLog('BOT', `🛡️ [TP ADJUST] Target TP for ${pair} adjusted to $${this.formatPrice(tp)} to guarantee profitability over break-even price ($${breakEvenPrice.toFixed(4)}) including gas/slippage.`, 'info-line');
            }
            this.addLog('BOT', `🛡️ BSC TWAK: SL $${this.formatPrice(sl)} | TP $${this.formatPrice(tp)} (Managed in-app to save gas)`, 'buy-line');
        }

        // Hard floor: SL must be at least 0.8× ATR away from entry so the LLM
        // cannot place a stop so tight that normal market noise triggers it.
        const minSlDist = atr * 0.8;
        sl = Math.min(sl, finalEntryPrice - minSlDist);

        // Swing low protection for Stop Loss
        const swingLow = this.calculateSwingPrice(pair, 'LONG', 15);
        if (swingLow > 0) {
            sl = Math.min(sl, swingLow - 0.2 * atr);
        }
        const maxSlDistance = 2.5 * atr;
        if (finalEntryPrice - sl > maxSlDistance) {
            sl = finalEntryPrice - maxSlDistance;
        }

        // Entry-side taker fee: charged on full notional.
        const entryFee = finalEntryPrice * tokenSize * this.takerFeeRate;

        let posDcaPriceDropPct: number | undefined = undefined;
        let dcaLastFillPrice: number | undefined = undefined;
        if (this.dcaEnabled) {
            const initialSlDistPct = ((finalEntryPrice - sl) / finalEntryPrice) * 100;
            const stepsToFit = Math.max(1, this.dcaMaxSteps - 1);
            const floor = this.dcaPerStepDropFloor();
            posDcaPriceDropPct = Math.max(floor, Math.min(this.dcaPriceDropPct, (initialSlDistPct / stepsToFit) * 0.8));
            dcaLastFillPrice = finalEntryPrice;
            this.addLog('BOT', `🛡️ SMART DCA [${pair}]: Auto-calibrated DCA trigger drop to ${posDcaPriceDropPct.toFixed(3)}% from ${this.formatPrice(finalEntryPrice)} (SL dist ${initialSlDistPct.toFixed(2)}%)`, 'info-line');
        }

        const newPos: Position = {
            symbol: pair,
            type: 'LONG',
            leverage: 1,
            size: tokenSize,
            entryPrice: finalEntryPrice,
            margin: sizeUSDT,
            liqPrice: 0,
            sl,
            tp,
            pnl: 0,
            pnlPercent: 0,
            partialClosed: false,
            binanceOrderId,
            slOrderId,
            openTime: Date.now(),
            feesPaid: entryFee,
            modelType: this.modelType,
            originalSl: sl,
            trailingTier: 0,
            binanceSlSynced: this.liveTradingMode !== 'simulated' ? (slOrderId != null) : undefined,
            lastLlmCheckTime: Date.now(),
            lastLlmCheckPrice: finalEntryPrice,
            entryAtr: atr,
            dcaStep: this.dcaEnabled ? 1 : undefined,
            dcaMaxSteps: this.dcaEnabled ? this.dcaMaxSteps : undefined,
            dcaTotalMargin: this.dcaEnabled ? margin : undefined,
            dcaPriceDropPct: posDcaPriceDropPct,
            dcaLastFillPrice: dcaLastFillPrice,
        };

        if (this.liveTradingMode === 'simulated') {
            this.balance -= sizeUSDT;
            this.balance -= entryFee; // deduct entry fee from wallet immediately
        }
        this.totalFeesPaid += entryFee;

        this.openPositions.push(newPos);
        this.recomputeLedger();

        // Trigger immediate LLM Quant Operator adjustment check for the new position
        this.runQuantOperator({ forceAdjustment: true, targetPair: pair }).catch(err => {
            console.error('Error running Quant Operator after entry:', err);
        });

        const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        this.orderHistory.push({
            time: timeStr,
            symbol: pair,
            type: 'MARKET',
            side: 'BUY',
            price: finalEntryPrice,
            size: tokenSize,
            status: 'FILLED',
            reason: `AI Signal Entry [${this.liveTradingMode.toUpperCase()}] ⚡`
        });

        this.addLog('BOT', `⚡ SERVER AUTO-ENTRY: LONG position for ${pair} filled at ${this.formatPrice(finalEntryPrice)}!`, 'buy-line');
    }

    /**
     * Convert a triggered grid level into a fully-managed open Position.
     * The position gets ATR-based SL/TP and is then handled by SMART QUANT +
     * adaptive trailing logic exactly like a normal AI entry. In live/mainnet
     * mode this sends a real MARKET order + protective STOP_MARKET to Binance.
     */
    private async openPositionFromGrid(pair: string, type: 'LONG' | 'SHORT', entryPrice: number, sizeToken: number, margin: number) {
        if (type === 'SHORT') {
            this.addLog('BOT', `⚠️ Grid→Position [${pair}]: Skipping SHORT on Spot.`, 'warning-line');
            return;
        }
        const direction = 1;

        // Resolve ATR: prefer the live cache, fall back to recomputing from candles.
        let atr = this.liveAtrMap[pair];
        if (!atr || atr <= 0) {
            const candles = this.historicalCandlesMap[pair];
            if (candles && candles.length >= 20) {
                const highs = candles.map(c => c.high);
                const lows = candles.map(c => c.low);
                const closes = candles.map(c => c.close);
                const series = this.ai.calculateATR(highs, lows, closes, 14).filter((v): v is number => v != null);
                atr = series.length ? series[series.length - 1] : entryPrice * 0.01;
            } else {
                atr = entryPrice * 0.01;
            }
        }

        const candles = this.historicalCandlesMap[pair] || [];
        const localChop = candles.length >= 30 ? this.calculateChoppinessIndex(candles) : 65;
        let dynamicSlMultiplier = this.slAtrMultiplier;
        let dynamicTpMultiplier = this.tpAtrMultiplier;

        if (localChop < 50) {
            dynamicTpMultiplier = dynamicTpMultiplier * 1.3;
            dynamicSlMultiplier = dynamicSlMultiplier * 0.9;
        } else if (localChop > 60) {
            dynamicTpMultiplier = dynamicTpMultiplier * 0.8;
            dynamicSlMultiplier = dynamicSlMultiplier * 1.2;
        }

        // LLM Quant Operator may tighten/loosen SL-TP (neutral when operator off).
        const slMultEff = this.quantOperatorEnabled ? dynamicSlMultiplier * this.llmSlTightness : dynamicSlMultiplier;
        const tpMultEff = this.quantOperatorEnabled ? dynamicTpMultiplier * this.llmTpExtension : dynamicTpMultiplier;
        let sl = entryPrice - atr * slMultEff;
        const tp = entryPrice + atr * tpMultEff;

        // Hard floor: SL must be at least 0.8× ATR from entry.
        const minSlDistGrid = atr * 0.8;
        sl = Math.min(sl, entryPrice - minSlDistGrid);

        // Swing high/low protection for Stop Loss
        const swingLow = this.calculateSwingPrice(pair, 'LONG', 15);
        if (swingLow > 0) {
            sl = Math.min(sl, swingLow - 0.2 * atr);
        }
        const maxSlDistance = 2.5 * atr;
        if (entryPrice - sl > maxSlDistance) {
            sl = entryPrice - maxSlDistance;
        }
        const liqPrice = 0; // Spot has no liquidation

        let finalEntryPrice = entryPrice;
        let binanceOrderId: string | undefined;
        let slOrderId: string | undefined;

        const slippedEntryPrice = this.liveTradingMode === 'simulated'
            ? this.applySlippage(finalEntryPrice, 'BUY')
            : finalEntryPrice;
        const entryFee = slippedEntryPrice * sizeToken * this.takerFeeRate;

        const newPos: Position = {
            symbol: pair,
            type: 'LONG',
            leverage: 1,
            size: sizeToken,
            entryPrice: slippedEntryPrice,
            margin,
            liqPrice,
            sl,
            tp,
            pnl: 0,
            pnlPercent: 0,
            partialClosed: false,
            binanceOrderId,
            slOrderId,
            openTime: Date.now(),
            feesPaid: entryFee,
            modelType: this.modelType,
            originalSl: sl,
            trailingTier: 0,
            binanceSlSynced: this.liveTradingMode !== 'simulated' ? false : undefined,
            lastLlmCheckTime: Date.now(),
            lastLlmCheckPrice: slippedEntryPrice,
            entryAtr: atr,
        };

        this.balance -= margin;
        this.balance -= entryFee;
        this.totalFeesPaid += entryFee;

        this.openPositions.push(newPos);
        this.recomputeLedger();

        // Trigger immediate LLM Quant Operator adjustment check for the new position
        this.runQuantOperator({ forceAdjustment: true, targetPair: pair }).catch(err => {
            console.error('Error running Quant Operator after entry:', err);
        });

        this.addLog('BOT', `⚡ GRID→SMART QUANT [${pair}]: Opening auto-managed LONG position (SL ${sl.toLocaleString()} / TP ${tp.toLocaleString()}).`, 'buy-line');
        this.persistState();
    }

    /**
     * Adaptive SL/TP — runs once per candle close (not per tick).
     * 1. Refresh liveAtrMap[pair] from the rolling candle buffer.
     * 2. ATR spike → tighten SL on open positions (volatility protection).
     * 3. Funding rate alert → tighten SL on winning positions.
     * 4. Momentum exhaustion (RSI + MACD) → arm early-exit signal for the tick loop.
     */
    private async runAdaptiveCandleClose(pair: string) {
        const candles = this.historicalCandlesMap[pair];
        if (!candles || candles.length < 60) return;

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);

        // --- 1. Recompute ATR series; cache the latest value for tick-time trailing TP.
        const atrSeries = this.ai.calculateATR(highs, lows, closes, 14);
        const validAtr = atrSeries.filter((v): v is number => v != null);
        if (validAtr.length === 0) return;
        const atrNow = validAtr[validAtr.length - 1];
        this.liveAtrMap[pair] = atrNow;

        // Mean ATR over the last 30 valid readings (excluding the latest) for spike detection.
        const recentAtr = validAtr.slice(-31, -1);
        const meanAtr = recentAtr.length > 0 ? recentAtr.reduce((a, b) => a + b, 0) / recentAtr.length : atrNow;
        const atrSpike = meanAtr > 0 && atrNow > meanAtr * this.atrSpikeThreshold;

        // --- 4. Momentum exhaustion signal (RSI + MACD histogram slope).
        const rsiSeries = this.ai.calculateRSI(closes, 14);
        const { histogram } = this.ai.calculateMACD(closes, 12, 26, 9);
        const rsiNow = rsiSeries[rsiSeries.length - 1];
        const histValid = histogram.filter((v): v is number => v != null);
        let macdDeclining = false;
        if (histValid.length >= 3) {
            const h0 = histValid[histValid.length - 1];
            const h1 = histValid[histValid.length - 2];
            const h2 = histValid[histValid.length - 3];
            macdDeclining = h0 < h1 && h1 < h2;
        }
        this.momentumExitSignalMap[pair] = {
            long: rsiNow != null && rsiNow > this.momentumExitRsiHigh && macdDeclining,
            short: false,
        };

        if (!this.smartOrderAdjustment) return;

        // --- Apply SL tightening to open positions on this pair.
        for (const pos of this.openPositions) {
            if (pos.symbol !== pair) continue;
            const oldSl = pos.sl;
            const originalRisk = Math.abs((pos.originalSl ?? pos.sl) - pos.entryPrice);

            // ATR spike protection — only tighten, never loosen a trailing SL
            if (atrSpike) {
                const target = pos.pnl > 0 ? pos.entryPrice : pos.entryPrice - (originalRisk * 0.5); // halve risk for losers
                // Only move SL in the favorable direction (never relax it).
                if (pos.sl < target) {
                    pos.sl = target;
                    this.addLog('BOT', `⚡ ADAPTIVE [${pair}]: ATR volatility spiked (x${(atrNow / meanAtr).toFixed(1)}). Tightening Stop Loss to ${target.toLocaleString()} for protection!`, 'warning-line');
                }
            }


        }
    }

    public async updatePositionsLivePnL(pair: string, currentPrice: number) {
        let totalUnrealized = 0;
        let marginSum = 0;

        for (let i = this.openPositions.length - 1; i >= 0; i--) {
            const pos = this.openPositions[i];
            if (pos.symbol !== pair) continue;
            if (pos.isClosing) continue; // Skip if already in progress of closing to prevent race condition!

            const direction = pos.type === 'LONG' ? 1 : -1;

            // Use pure price-action PnL for open positions.
            // On BSC, entry slippage+gas is already reflected in the difference between
            // pos.margin (USDT sent) and pos.size*pos.entryPrice (on-chain notional received).
            // Estimating gas again here would create phantom losses (e.g. -48% on a $2 trade).
            pos.pnl = direction * pos.size * (currentPrice - pos.entryPrice);
            pos.pnlPercent = pos.entryPrice > 0
                ? (direction * (currentPrice - pos.entryPrice) / pos.entryPrice) * 100
                : 0;

            totalUnrealized += pos.pnl;
            marginSum += pos.margin;

            // Check for DCA step execution
            if (this.dcaEnabled && pos.type === 'LONG' && !pos.isClosing) {
                if (pos.dcaStep == null) {
                    this.initializeDcaForPosition(pos);
                }
                if (pos.dcaStep && pos.dcaStep < (pos.dcaMaxSteps || this.dcaMaxSteps)) {
                    const refPrice = pos.dcaLastFillPrice ?? pos.entryPrice;
                    const dropPct = refPrice > 0 ? ((refPrice - currentPrice) / refPrice) * 100 : 0;
                    const requiredDrop = pos.dcaPriceDropPct ?? this.dcaPriceDropPct;
                    const timeSinceLastDcaAttempt = Date.now() - (pos.lastDcaAttemptTime || 0);
                    if (dropPct >= requiredDrop && timeSinceLastDcaAttempt >= this.dcaCooldownMs) {
                        pos.lastDcaAttemptTime = Date.now();
                        const oldMargin = pos.margin;
                        const success = await this.executeDcaStep(pos, currentPrice);
                        if (success) {
                            // Recalculate gross PnL with updated size/entryPrice after DCA fill
                            pos.pnl = direction * pos.size * (currentPrice - pos.entryPrice);
                            pos.pnlPercent = pos.entryPrice > 0
                                ? (direction * (currentPrice - pos.entryPrice) / pos.entryPrice) * 100
                                : 0;
                            marginSum += (pos.margin - oldMargin);
                        }
                    }
                }
            }

            // Real-time LLM Adjustment Trigger Check
            const lastLlmPrice = pos.lastLlmCheckPrice || pos.entryPrice;
            const priceChangePct = Math.abs(currentPrice - lastLlmPrice) / lastLlmPrice;
            const timeSinceLastLlm = Date.now() - (pos.lastLlmCheckTime || 0);

            if (priceChangePct >= 0.015 || timeSinceLastLlm >= 300000) {
                // Instantly update tracking properties to prevent duplicate triggers on subsequent ticks
                pos.lastLlmCheckPrice = currentPrice;
                pos.lastLlmCheckTime = Date.now();

                this.addLog('BOT', `🔄 Triggering LLM to re-evaluate position ${pair} (Price change: ${(priceChangePct * 100).toFixed(2)}%, Elapsed: ${Math.round(timeSinceLastLlm / 1000)}s)`, 'info-line');

                this.runQuantOperator({ forceAdjustment: true, targetPair: pair }).catch(err => {
                    console.error('Error running Quant Operator on event trigger:', err);
                });
            }

            const oldSl = pos.sl;

            // SMART QUANT: Auto breakeven & trailing stop when in profit
            if (this.smartOrderAdjustment) {
                const targetPriceDiff = Math.abs(pos.tp - pos.entryPrice);
                const currentPriceDiff = direction * (currentPrice - pos.entryPrice);
                const isLong = pos.type === 'LONG';
                const originalRisk = Math.abs((pos.originalSl ?? pos.sl) - pos.entryPrice);

                if (!pos.partialClosed) {
                    // --- BEFORE PARTIAL TP ---
                    // Breakeven Shift: Profit > 35% of take profit target -> Move SL to Entry (Breakeven)
                    if (currentPriceDiff > targetPriceDiff * 0.35) {
                        pos.trailingTier = Math.max(pos.trailingTier || 0, 1);
                        if (pos.sl < pos.entryPrice) {
                            pos.sl = pos.entryPrice;
                            this.addLog('BOT', `🛡️ SMART QUANT [${pair}]: Profit exceeded 35% of target. Moved Stop Loss to Entry (${this.formatPrice(pos.entryPrice)}) - Completely locked out risk!`, 'info-line');
                        }
                    }

                    // Trailing Stop Profit: Profit > 70% -> Activate trailing stop at peakPrice - 1.2 * ATR
                    if (currentPriceDiff > targetPriceDiff * 0.70) {
                        pos.trailingTier = Math.max(pos.trailingTier || 0, 2);
                        const atr = this.liveAtrMap[pair] || pos.entryAtr;
                        if (atr && atr > 0) {
                            pos.peakPrice = Math.max(pos.peakPrice ?? currentPrice, currentPrice);
                            const trailStopPrice = pos.peakPrice - 1.2 * atr;
                            if (pos.sl < trailStopPrice) {
                                pos.sl = trailStopPrice;
                                this.addLog('BOT', `📈 SMART QUANT [${pair}]: Profit exceeded 70% of target. Activated Trailing Stop (trailing peak ${this.formatPrice(pos.peakPrice)} by 1.2×ATR = ${this.formatPrice(1.2 * atr)}) -> New SL: ${this.formatPrice(pos.sl)}`, 'info-line');
                            }
                        }
                    }
                } else {
                    // --- AFTER PARTIAL TP ---
                    // Keep trailing stop active behind the peak at 1.2x ATR
                    const atr = this.liveAtrMap[pair] || pos.entryAtr;
                    if (atr && atr > 0) {
                        pos.peakPrice = Math.max(pos.peakPrice ?? currentPrice, currentPrice);
                        const trailStopPrice = pos.peakPrice - 1.2 * atr;
                        if (pos.sl < trailStopPrice) {
                            pos.sl = trailStopPrice;
                            this.addLog('BOT', `🚀 SMART QUANT [${pair}]: Trailing Stop following Partial TP -> New SL: ${this.formatPrice(pos.sl)}`, 'info-line');
                        }
                    }
                }
            }

            // ADAPTIVE (tick-time): Volume spike protection.
            // A sudden volume surge moving against us often precedes a sharp reversal.
            if (this.smartOrderAdjustment) {
                const candles = this.historicalCandlesMap[pair];
                if (candles && candles.length >= 21) {
                    const last = candles[candles.length - 1];
                    const prev20 = candles.slice(-21, -1);
                    const avgVol = prev20.reduce((a, c) => a + c.volume, 0) / prev20.length;
                    const direction2 = pos.type === 'LONG' ? 1 : -1;
                    const movingAgainst = direction2 * (currentPrice - last.open) < 0;
                    if (avgVol > 0 && last.volume > avgVol * this.volSpikeThreshold && movingAgainst) {
                        const originalRisk = Math.abs((pos.originalSl ?? pos.sl) - pos.entryPrice);
                        const target = pos.pnl > 0 ? pos.entryPrice : pos.entryPrice - direction2 * (originalRisk * 0.5);
                        if (pos.type === 'LONG' && pos.sl < target) {
                            pos.sl = target;
                            this.addLog('BOT', `📊 ADAPTIVE [${pair}]: Volume spiked (x${(last.volume / avgVol).toFixed(1)}) in opposite direction. Tightening Stop Loss to ${target.toLocaleString()}!`, 'warning-line');
                        } else if (pos.type === 'SHORT' && pos.sl > target) {
                            pos.sl = target;
                            this.addLog('BOT', `📊 ADAPTIVE [${pair}]: Volume spiked (x${(last.volume / avgVol).toFixed(1)}) in opposite direction. Tightening Stop Loss to $${target.toLocaleString()}!`, 'warning-line');
                        }
                    }
                }
            }

            // ADAPTIVE (tick-time): Trailing TP (Chandelier Exit).
            // Arm once we're deep into the move (after partial close), then trail a stop off the peak by ATR.
            let trailingTpHit = false;
            if (this.smartOrderAdjustment) {
                const targetPriceDiff = Math.abs(pos.tp - pos.entryPrice);
                const progress = targetPriceDiff > 0 ? (direction * (currentPrice - pos.entryPrice)) / targetPriceDiff : 0;
                const atr = this.liveAtrMap[pair];

                // Arm Trailing TP only after the position is already partially closed (beyond TP1)
                const shouldArmTrailingTp = pos.partialClosed && (progress >= 0.5);

                if (shouldArmTrailingTp && atr && atr > 0) {
                    if (!pos.trailingTpActive) {
                        pos.trailingTpActive = true;
                        pos.peakPrice = currentPrice;
                        this.addLog('BOT', `🎯 ADAPTIVE [${pair}]: Activated Trailing TP (position partial-TP'd 50%). Trailing price peak to optimize exit!`, 'buy-line');
                    }
                    // LLM aggressiveness tightens (>1) or loosens (<1) the trail distance.
                    const trailMultEff = this.quantOperatorEnabled
                        ? this.trailingTpMultiplier / this.llmTrailingAggressiveness
                        : this.trailingTpMultiplier;
                    const rawTrailDistance = atr * trailMultEff;
                    const minTrailDistance = targetPriceDiff * 0.4; // breathing room: at least 40% of targetPriceDiff
                    const trailDistance = Math.max(rawTrailDistance, minTrailDistance);

                    // Update the running peak in the favorable direction.
                    if (pos.type === 'LONG') {
                        pos.peakPrice = Math.max(pos.peakPrice ?? currentPrice, currentPrice);
                        pos.trailingTpPrice = pos.peakPrice - trailDistance;
                        if (currentPrice < pos.trailingTpPrice) trailingTpHit = true;
                    } else {
                        pos.peakPrice = Math.min(pos.peakPrice ?? currentPrice, currentPrice);
                        pos.trailingTpPrice = pos.peakPrice + trailDistance;
                        if (currentPrice > pos.trailingTpPrice) trailingTpHit = true;
                    }
                }
            }

            // ADAPTIVE: Momentum exhaustion early exit (signal from candle close).
            // Only fires once we are at least halfway to target, to avoid premature exits.
            let momentumExitHit = false;
            if (this.smartOrderAdjustment && !trailingTpHit) {
                const targetPriceDiff = Math.abs(pos.tp - pos.entryPrice);
                const progress = targetPriceDiff > 0 ? (direction * (currentPrice - pos.entryPrice)) / targetPriceDiff : 0;
                const sig = this.momentumExitSignalMap[pair];
                if (sig && progress >= 0.5) {
                    if (pos.type === 'LONG' && sig.long) momentumExitHit = true;
                    if (pos.type === 'SHORT' && sig.short) momentumExitHit = true;
                }
            }



            // Stop loss / Take profit / Liquidation triggers
            let closed = false;
            let finalPnL = pos.pnl;
            let reason = '';

            if (pos.type === 'LONG') {
                const hasDcaStepsRemaining = this.dcaEnabled && pos.dcaStep != null && pos.dcaStep < (pos.dcaMaxSteps || this.dcaMaxSteps);
                if (currentPrice <= pos.sl && !hasDcaStepsRemaining) {
                    closed = true;
                    reason = pos.partialClosed ? 'Trailing Stop 🟠' : 'Stop Loss 🔴';
                } else if (currentPrice >= pos.tp) {
                    // Issue 6: Partial Take Profit - Exit 50% at TP1, move SL to entry, extend TP2
                    if (!pos.partialClosed) {
                        const halfSize = pos.size / 2;
                        // Slipped exit: market sell fills lower than TP.
                        const tpExitPrice = this.applySlippage(pos.tp, 'SELL');
                        const exitFee = tpExitPrice * halfSize * this.takerFeeRate;
                        const partialPnL = halfSize * (tpExitPrice - pos.entryPrice) - exitFee;

                        if (this.liveTradingMode === 'bsc_twak') {
                            const twak = this.getTWAKClient();
                            if (twak) {
                                try {
                                    if (pos.slOrderId) {
                                        const ids = pos.slOrderId.split('|');
                                        for (const idPart of ids) {
                                            const id = idPart.replace(/^(sl_|tp_)/, '');
                                            if (id) await twak.deleteAutomate(id).catch(() => {});
                                        }
                                        pos.slOrderId = undefined;
                                    }
                                    const bscSym = this.bscToken(pos.symbol);
                                    let sellAmt = halfSize;
                                    if (bscSym === 'BNB') {
                                        sellAmt = Math.min(sellAmt, pos.size - 0.003);
                                    }
                                    if (sellAmt <= 0) {
                                        this.addLog('BOT', `⚠️ [TWAK] Skipping BNB partial swap: remaining BNB is too close to gas reserve (0.003 BNB).`, 'warning-line');
                                        pos.partialClosed = true;
                                        continue;
                                    }
                                    this.addLog('BOT', `📡 BSC TWAK: Swapping 50% partial size (${sellAmt.toFixed(6)} ${bscSym}) → USDT...`, 'info-line');
                                    const sellRes = await twak.sellToken(sellAmt, bscSym, 1);
                                    if (isCompetitionActive() && sellRes.txHash) {
                                        recordTrade(sellRes.txHash);
                                    }
                                    this.addLog('BOT', `✅ BSC TWAK Partial-TP swap successful. TX: ${sellRes.txHash.slice(0, 12)}...`, 'buy-line');
                                } catch (e: any) {
                                    this.addLog('BOT', `❌ BSC TWAK Partial-TP swap failed: ${e.message}`, 'warning-line');
                                    continue; // Skip updating memory state to keep synced
                                }
                            }
                        } else {
                            this.balance += (pos.margin / 2) + partialPnL; // Return 50% margin + profit (fees deducted)
                        }

                        pos.feesPaid = (pos.feesPaid || 0) + exitFee;
                        this.totalFeesPaid += exitFee;
                        pos.size = halfSize;
                        pos.margin = pos.margin / 2;
                        pos.sl = pos.entryPrice; // Move SL to Entry

                        const originalTargetPriceDiff = Math.abs(pos.tp - pos.entryPrice);
                        pos.tp = pos.entryPrice + originalTargetPriceDiff * 2; // Double TP2 target
                        pos.partialClosed = true;

                        const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        this.tradeHistory.push({
                            time: timeStr,
                            pair: pos.symbol,
                            type: 'Partial Take Profit',
                            side: 'Exit Long',
                            price: currentPrice,
                            size: (halfSize * pos.entryPrice).toFixed(2),
                            leverage: '1x',
                            pnl: partialPnL,
                            status: 'Partial TP 50% 🟢'
                        });
                        this.addLog('BOT', `⚡ SERVER PARTIAL-TP: Partial-TP'd 50% of LONG position ${pos.symbol} at ${currentPrice}. PnL: +${partialPnL.toFixed(2)}. SL moved to Entry, extending TP2!`, 'buy-line');

                        // Update daily realized PnL
                        this.dailyPnL += partialPnL;
                        this.recomputeLedger();
                        continue; // Keep remaining 50% position
                    } else {
                        closed = true;
                        reason = 'Take Profit 🟢';
                    }
                }
            }

            // ADAPTIVE bot-initiated exits (only if a hard trigger didn't already fire).
            if (!closed && trailingTpHit) {
                closed = true;
                reason = 'Trailing TP 🟢';
            } else if (!closed && momentumExitHit) {
                closed = true;
                reason = 'Momentum Exit 🟡';
            }

            if (closed) {
                // Compute exit price using SL or TP depending on which triggered,
                // then apply slippage + taker fee.
                let exitPriceForCost = currentPrice;
                if (reason === 'Take Profit 🟢') {
                    exitPriceForCost = pos.tp;
                } else if (reason.includes('Stop Loss') || reason.includes('Trailing Stop')) {
                    exitPriceForCost = pos.sl;
                }
                const exitSide: 'BUY' | 'SELL' = 'SELL';
                const slippedExitPrice = this.applySlippage(exitPriceForCost, exitSide);
                const gasFee = this.liveTradingMode === 'bsc_twak' ? this.getBscGasFeeUsdt() : 0;
                const exitFee = slippedExitPrice * pos.size * this.effectiveTakerFeeRate + gasFee;
                pos.feesPaid = (pos.feesPaid || 0) + exitFee;
                this.totalFeesPaid += exitFee;

                // Realized PnL = exit proceeds - total capital deployed.
                // Entry overhead (gas+slip paid on entry) is already baked into the difference
                // between pos.margin (USDT sent) and pos.size*pos.entryPrice (on-chain notional).
                // We do NOT add a second estimated entryGas here to avoid double-counting.
                const entryOverhead = Math.max(0, pos.margin - pos.size * pos.entryPrice);
                finalPnL = pos.size * (slippedExitPrice - pos.entryPrice) - exitFee - entryOverhead;

                let executeClose = true;
                if (this.liveTradingMode === 'bsc_twak') {
                    // ── BSC on-chain close via TWAK ──────────────────────────────────
                    const twak = this.getTWAKClient();
                    if (twak) {
                        try {
                            pos.isClosing = true; // Mark as closing
                            // Cancel TWAK automate SL/TP orders first
                            if (pos.slOrderId) {
                                const ids = pos.slOrderId.split('|');
                                for (const idPart of ids) {
                                    const id = idPart.replace(/^(sl_|tp_)/, '');
                                    if (id) await twak.deleteAutomate(id).catch(() => { });
                                }
                            }
                            const bscSym = this.bscToken(pos.symbol);
                            let sellAmt = pos.size;
                            if (bscSym === 'BNB') {
                                sellAmt = Math.min(sellAmt, pos.size - 0.003);
                            }
                            if (sellAmt <= 0) {
                                this.addLog('BOT', `⚠️ [TWAK] Cannot close BNB position: remaining BNB is less than gas reserve (0.003 BNB). Removing from tracking.`, 'warning-line');
                            } else {
                                this.addLog('BOT', `📡 BSC TWAK: Swapping ${sellAmt.toFixed(6)} ${bscSym} → USDT (auto-closing position due to ${reason})...`, 'info-line');
                                const sellRes = await twak.sellToken(sellAmt, bscSym, 1);
                                const actualExit = sellRes.executedPrice > 0 ? sellRes.executedPrice : currentPrice;
                                if (isCompetitionActive() && sellRes.txHash) {
                                    recordTrade(sellRes.txHash);
                                }
                                // Use actual on-chain proceeds when available for accurate PnL.
                                if (sellRes.toAmount > 0) {
                                    finalPnL = sellRes.toAmount - pos.margin;
                                    this.addLog('BOT', `✅ BSC TWAK closed position automatically [${reason}]. Price: ${this.formatPrice(actualExit)} | Received: ${sellRes.toAmount.toFixed(4)} USDT | PnL: ${finalPnL >= 0 ? '+' : ''}${finalPnL.toFixed(4)} USDT | TX: ${sellRes.txHash.slice(0, 12)}...`, finalPnL >= 0 ? 'buy-line' : 'sell-line');
                                } else {
                                    this.addLog('BOT', `✅ BSC TWAK closed position automatically [${reason}]. Price: ${this.formatPrice(actualExit)} (USDT received not reported — PnL estimated) | TX: ${sellRes.txHash.slice(0, 12)}...`, finalPnL >= 0 ? 'buy-line' : 'sell-line');
                                }
                            }
                        } catch (e: any) {
                            this.addLog('BOT', `⚠️ BSC TWAK auto-closing position failed: ${e.message}. Retrying on next tick.`, 'warning-line');
                            pos.isClosing = false; // Reset flag so it can retry
                            executeClose = false;  // Keep the position in memory
                        }
                    }
                } else {
                    this.balance += pos.margin + finalPnL;
                }

                if (!executeClose) continue;

                // Issue 8: Record daily realized PnL
                this.dailyPnL += finalPnL;

                // Issue 12: Set cooldown for trading pair
                this.lastClosedTime[pos.symbol] = Date.now();

                // T3.3 — attribute realized PnL to the model that opened it.
                const pnlPct = pos.margin > 0 ? (finalPnL / pos.margin) * 100 : 0;
                this.recordModelTrade(pos.modelType || this.modelType, finalPnL, pnlPct);

                const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                this.tradeHistory.push({
                    time: timeStr,
                    pair: pos.symbol,
                    type: 'Server Auto-Close',
                    side: 'Exit Long',
                    price: currentPrice,
                    size: (pos.size * pos.entryPrice).toFixed(2),
                    leverage: '1x',
                    pnl: finalPnL,
                    status: reason
                });

                this.orderHistory.push({
                    time: timeStr,
                    symbol: pos.symbol,
                    type: 'MARKET',
                    side: pos.type === 'LONG' ? 'SELL' : 'BUY',
                    price: currentPrice,
                    size: pos.size,
                    status: 'CLOSED',
                    pnl: finalPnL,
                    reason: `Auto Closed: ${reason}`
                });

                this.addLog('BOT', `⚡ SERVER AUTO-EXIT: Closed ${pos.type} position ${pos.symbol} at ${currentPrice}. PnL: ${finalPnL >= 0 ? '+' : ''}${finalPnL.toFixed(2)}. Reason: ${reason}`, finalPnL >= 0 ? 'buy-line' : 'sell-line');

                this.openPositions.splice(i, 1);
                // Phase 5: Flush state on every realized trade — these are the
                // events users care most about preserving across restarts.
                this.persistState();
            }
        }

        // AI SMART GRID: Process live grid ticks if active for this pair
        if (this.gridActiveMap[pair] && this.gridOrdersMap[pair].length > 0) {
            // Check absolute breakout global stop loss first
            if (currentPrice >= this.gridUpperBoundaries[pair]) {
                this.dismantleGrid(pair, 'Upper Breakout Stop Loss 🔴');
                return;
            }
            if (currentPrice <= this.gridLowerBoundaries[pair]) {
                this.dismantleGrid(pair, 'Lower Breakout Stop Loss 🔴');
                return;
            }

            // When a grid level is touched, convert it into a fully-managed
            // Position (real Binance MARKET order + SL/TP algorithms) instead of
            // tracking it as a simulated grid leg. Use for...of so Binance calls await.
            for (const o of this.gridOrdersMap[pair]) {
                if (o.status !== 'PENDING') continue;
                const isBuy = o.type === 'BUY_LIMIT';
                const triggered = isBuy ? currentPrice <= o.price : currentPrice >= o.price;
                if (!triggered) continue;

                // Consume this grid slot — the spawned Position owns the risk now.
                o.status = 'CLOSED';
                o.filledPrice = currentPrice;
                o.pnl = 0;

                const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                this.orderHistory.push({
                    time: timeStr,
                    symbol: pair,
                    type: 'LIMIT',
                    side: isBuy ? 'BUY' : 'SELL',
                    price: o.price,
                    size: o.size,
                    status: 'FILLED',
                    reason: 'Grid Triggered → Managed Position 🟢'
                });
                this.addLog('BOT', `${isBuy ? '🟢 Grid BUY' : '🔴 Grid SHORT'} triggered [${pair}] at ${o.price.toLocaleString()} → switching to SMART QUANT managed position.`, isBuy ? 'buy-line' : 'sell-line');

                await this.openPositionFromGrid(pair, isBuy ? 'LONG' : 'SHORT', currentPrice, o.size, o.margin);
            }
        }

        this.recomputeLedger();
    }

    /** Per-step drop floor: global trigger / max steps (e.g. 5% / 3 ≈ 1.67%). */
    private dcaPerStepDropFloor(): number {
        return this.dcaPriceDropPct / Math.max(1, this.dcaMaxSteps);
    }

    /** Recompute the % drop required before the next DCA step. */
    private recalibrateDcaTrigger(pos: Position): void {
        const slDistPct = pos.sl > 0 && pos.entryPrice > 0
            ? ((pos.entryPrice - pos.sl) / pos.entryPrice) * 100
            : this.dcaPriceDropPct;
        const stepsRemaining = Math.max(
            1,
            (pos.dcaMaxSteps || this.dcaMaxSteps) - (pos.dcaStep || 1)
        );
        const floor = this.dcaPerStepDropFloor();
        pos.dcaPriceDropPct = Math.max(
            floor,
            Math.min(this.dcaPriceDropPct, (slDistPct / stepsRemaining) * 0.8)
        );
    }

    /**
     * Attach DCA tracking fields to a LONG position that was opened before DCA was
     * enabled or imported from on-chain sync without bot metadata.
     */
    private initializeDcaForPosition(pos: Position, reason?: string): boolean {
        if (!this.dcaEnabled || pos.type !== 'LONG' || pos.dcaStep != null) {
            return false;
        }

        pos.dcaStep = 1;
        pos.dcaMaxSteps = this.dcaMaxSteps;
        pos.dcaTotalMargin = pos.dcaTotalMargin ?? pos.margin;
        pos.dcaLastFillPrice = pos.dcaLastFillPrice ?? pos.entryPrice;
        if (pos.dcaPriceDropPct == null) {
            this.recalibrateDcaTrigger(pos);
        }

        if (reason) {
            this.addLog(
                'BOT',
                `🛡️ SMART DCA [${pos.symbol}]: ${reason} — trigger drop ${pos.dcaPriceDropPct!.toFixed(3)}% from ${this.formatPrice(pos.dcaLastFillPrice!)} (step 1/${pos.dcaMaxSteps})`,
                'info-line'
            );
        }
        return true;
    }

    /** Backfill DCA state for all open LONG positions (e.g. after toggling DCA ON). */
    public backfillDcaForOpenPositions(): number {
        let count = 0;
        for (const pos of this.openPositions) {
            if (this.initializeDcaForPosition(pos)) {
                count++;
            }
        }
        if (count > 0) {
            this.addLog('SYSTEM', `Auto DCA: initialized ${count} open position(s) for DCA tracking.`, 'info-line');
            this.persistState();
        }
        return count;
    }

    private async executeDcaStep(pos: Position, currentPrice: number): Promise<boolean> {
        const pair = pos.symbol;
        if ((pos as Position & { dcaInProgress?: boolean }).dcaInProgress) {
            return false;
        }
        (pos as Position & { dcaInProgress?: boolean }).dcaInProgress = true;
        const nextStep = (pos.dcaStep || 1) + 1;
        const totalMargin = pos.dcaTotalMargin || pos.margin;
        const allocationFraction = this.dcaCapitalAllocation[nextStep - 1];
        const clearDcaLock = () => {
            (pos as Position & { dcaInProgress?: boolean }).dcaInProgress = false;
        };

        if (!allocationFraction) {
            this.addLog('BOT', `❌ DCA [${pair}]: Error finding capital allocation config for step ${nextStep}.`, 'warning-line');
            clearDcaLock();
            return false;
        }

        let stepMargin = totalMargin * allocationFraction;

        // Enforce minimum DCA step size of 2 USDT
        if (stepMargin < 2) {
            stepMargin = 2;
        }

        // Check if there is enough free margin
        if (stepMargin > this.marginFree) {
            this.addLog('BOT', `⚠️ DCA [${pair}]: Skipping DCA step ${nextStep} due to insufficient USDT. Required: ${stepMargin.toFixed(2)}, Available: ${this.marginFree.toFixed(2)}`, 'warning-line');
            clearDcaLock();
            return false;
        }

        let executedPrice = currentPrice;
        let tokenSizeAdded = stepMargin / currentPrice;
        let txHash: string | undefined = undefined;

        this.addLog('BOT', `📡 DCA [${pair}]: Executing DCA step ${nextStep}/${pos.dcaMaxSteps} with ${stepMargin.toFixed(2)} USDT...`, 'info-line');

        if (this.liveTradingMode === 'bsc_twak') {
            const twak = this.getTWAKClient();
            if (!twak) {
                this.addLog('BOT', `❌ DCA [${pair}]: Failed to initialize TWAK client.`, 'warning-line');
                clearDcaLock();
                return false;
            }
            try {
                const bscSym = this.bscToken(pair);
                const swapRes = await twak.buyToken(stepMargin, bscSym, 1);
                txHash = swapRes.txHash;
                executedPrice = swapRes.executedPrice > 0 ? swapRes.executedPrice : currentPrice;
                tokenSizeAdded = swapRes.toAmount > 0 ? swapRes.toAmount : tokenSizeAdded;
                this.addLog('BOT', `✅ DCA [${pair}] step ${nextStep} filled on-chain. Price: ${executedPrice.toLocaleString()} | TX: ${txHash.slice(0, 12)}...`, 'buy-line');
            } catch (err: any) {
                this.addLog('BOT', `❌ DCA [${pair}] step ${nextStep} failed: ${err.message}`, 'warning-line');
                clearDcaLock();
                return false;
            }
        } else {
            executedPrice = this.applySlippage(currentPrice, 'BUY');
            tokenSizeAdded = stepMargin / executedPrice;
        }

        // Taker fee on the added step size
        const stepFee = executedPrice * tokenSizeAdded * this.takerFeeRate;
        this.totalFeesPaid += stepFee;

        // Recalculate average price and size
        const oldSize = pos.size;
        const oldMargin = pos.margin;
        const newSize = oldSize + tokenSizeAdded;
        const newMargin = oldMargin + stepMargin;
        const newEntryPrice = newMargin / newSize;

        // Update position fields
        pos.size = newSize;
        pos.margin = newMargin;
        pos.entryPrice = newEntryPrice;
        pos.dcaStep = nextStep;
        pos.dcaLastFillPrice = executedPrice;
        pos.lastDcaAttemptTime = Date.now();
        this.recalibrateDcaTrigger(pos);
        pos.feesPaid = (pos.feesPaid || 0) + stepFee;

        // Update local cache with averaged price
        this.tokenEntryPrices[pair] = { entryPrice: newEntryPrice, openTime: pos.openTime || Date.now() };

        if (this.liveTradingMode === 'simulated') {
            this.balance -= stepMargin;
            this.balance -= stepFee;
        }

        // Log the averaging
        this.addLog('BOT', `📈 DCA SUCCESSFUL [${pair}]: Updated position. Average entry price: ${newEntryPrice.toLocaleString()} | Total size: ${newSize.toFixed(6)} | Total margin: ${newMargin.toFixed(2)}`, 'buy-line');

        // Recalculate SL / TP based on current price (lowest point of DCA) to avoid instant stop-outs
        // Retrieve recent ATR
        const atr = this.liveAtrMap[pair] || pos.entryAtr || (pos.entryPrice * 0.02); // fallback
        const slMultEff = this.quantOperatorEnabled ? this.slAtrMultiplier * this.llmSlTightness : this.slAtrMultiplier;
        const tpMultEff = this.quantOperatorEnabled ? this.tpAtrMultiplier * this.llmTpExtension : this.tpAtrMultiplier;

        let newSl = currentPrice - atr * slMultEff;
        const newTp = newEntryPrice + atr * tpMultEff;

        // Apply swing protection and min SL floor
        const minSlDist = atr * 0.8;
        newSl = Math.min(newSl, newEntryPrice - minSlDist);

        const swingLow = this.calculateSwingPrice(pair, 'LONG', 15);
        if (swingLow > 0) {
            newSl = Math.min(newSl, swingLow - 0.2 * atr);
        }
        const maxSlDistance = 2.5 * atr;
        if (newEntryPrice - newSl > maxSlDistance) {
            newSl = newEntryPrice - maxSlDistance;
        }

        pos.sl = newSl;
        pos.tp = newTp;
        pos.originalSl = newSl; // Reset original SL relative to new entry
        pos.trailingTier = 0;   // Reset trailing tier since entry shifted

        // If live trading on-chain, cancel outstanding SL/TP automated orders (we now manage internally)
        if (this.liveTradingMode === 'bsc_twak') {
            const twak = this.getTWAKClient();
            if (twak) {
                // Cancel old TWAK automation orders if tracked
                if (pos.slOrderId) {
                    const parts = pos.slOrderId.split('|');
                    for (const part of parts) {
                        const id = part.replace(/^(sl_|tp_)/, '');
                        if (id) {
                            await twak.deleteAutomate(id).catch(() => { });
                        }
                    }
                }
                pos.slOrderId = undefined; // clear out old on-chain automation IDs
                this.addLog('BOT', `🛡️ BSC TWAK internal monitoring updated: SL ${this.formatPrice(newSl)} | TP ${this.formatPrice(newTp)} (Managed in-app to save gas)`, 'buy-line');
            }
        }

        // Add history log
        const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        this.orderHistory.push({
            time: timeStr,
            symbol: pair,
            type: 'MARKET',
            side: 'BUY',
            price: executedPrice,
            size: tokenSizeAdded,
            status: 'FILLED',
            reason: `DCA Buy Step ${nextStep}/${pos.dcaMaxSteps} 🛒`
        });

        this.recomputeLedger();
        this.persistState();

        clearDcaLock();
        return true;
    }


    /**
     * Close every open position immediately (LLM emergency risk-off).
     * Iterates from the end so splicing inside closePositionManual stays valid.
     */
    public async llmForceCloseAll() {
        if (this.openPositions.length === 0) return;
        for (let i = this.openPositions.length - 1; i >= 0; i--) {
            try {
                await this.closePositionManual(i, 'LLM Force Exit 🧠', 'LLM Emergency Risk-Off 🛑');
            } catch (err: any) {
                this.addLog('BOT', `⚠️ Emergency position close failed for ${this.openPositions[i]?.symbol}: ${err.message}`, 'warning-line');
            }
        }
    }

    /**
     * BSC/CMC mode signal evaluation.
     * Derives entry signal from CMC momentum (no ML model or Binance candles).
     * SL/TP are percentage-based (env vars SL_ATR / TP_ATR used as % multipliers).
     *
     * Signal logic (long-only, spot):
     *   LONG:  change1h > 0.5%  AND  change24h > 1%  AND  htfBias >= 0  AND  !volumeSurge(negative)
     *   HOLD:  anything else
     * The LLM Quant Operator can still override/confirm the signal.
     */
    private async evaluateCMCSignal(pair: string) {
        const upd = this.cmcFeed?.getLatest(pair);
        if (!upd) {
            this.addLog('BOT', `[CMC Signal] ${pair}: No CMC data — skipping tick.`, 'warning-line');
            return;
        }

        const currentPrice = upd.price;
        if (!currentPrice || currentPrice <= 0) return;

        // ── CMC momentum signal ───────────────────────────────────────────────
        // Simple threshold: 1h AND 24h momentum both positive, HTF not bearish
        const isLong = upd.change1h >= 0.5 && upd.change24h >= 1.0 && upd.htfBias >= 0;
        const signal = isLong ? 1 : 0;
        const confidence = isLong
            ? Math.min(95, 55 + Math.round(upd.change1h * 5 + upd.change24h * 2))
            : 0;

        this.addLog('AI', `[CMC Signal] ${pair}: 1h=${upd.change1h.toFixed(2)}% 24h=${upd.change24h.toFixed(2)}% 7d=${upd.change7d.toFixed(2)}% htfBias=${upd.htfBias} → ${signal === 1 ? 'LONG' : 'HOLD'} (${confidence}%)`, signal === 1 ? 'buy-line' : 'system-line');

        if (signal !== 1) return;
        if (confidence < this.confidenceThreshold) {
            this.addLog('BOT', `[CMC Signal] ${pair}: Confidence ${confidence}% < threshold ${this.confidenceThreshold}% — skipping.`, 'warning-line');
            return;
        }

        // ── Portfolio & position guards ───────────────────────────────────────
        const today = new Date().toISOString().split('T')[0];
        if (today !== this.dailyPnLResetDate) {
            this.dailyPnL = 0;
            this.dailyPnLResetDate = today;
            this.dailyEquityPeak = 0;
        }

        if (this.dailyPnL <= -(this.initialCapital * this.maxDailyDrawdown)) {
            this.addLog('BOT', `[CMC Signal] ${pair}: Daily drawdown limit reached — skipping entry.`, 'warning-line');
            return;
        }

        if (this.openPositions.find(p => p.symbol === pair)) {
            this.addLog('BOT', `[CMC Signal] ${pair}: Open position exists — skipping.`, 'warning-line');
            return;
        }

        // ── Position sizing ────────────────────────────────────────────────────
        const totalCapital = this.balance + this.marginUsed;
        const targetPairMargin = totalCapital / this.activePairs.length;
        let margin = targetPairMargin * this.riskRatio;

        if (this.quantOperatorEnabled && this.llmRiskMultiplier !== 1.0) {
            margin *= this.llmRiskMultiplier;
        }

        // Global order-size multiplier
        if (this.orderSizeMultiplier && this.orderSizeMultiplier !== 1.0) {
            margin = margin * this.orderSizeMultiplier;
        }

        margin = Math.min(margin, this.marginFree);

        if (margin <= 0) {
            this.addLog('BOT', `[CMC Signal] ${pair}: Insufficient margin (${margin.toFixed(2)}) — skipping.`, 'warning-line');
            return;
        }

        // ── Percentage-based SL/TP (replacing ATR) ────────────────────────────
        // SL_ATR env var reused as SL % (e.g. 1.0 → 1%), TP_ATR as TP %
        const slPct = parseFloat(process.env.SL_ATR ?? '1.0') / 100;
        const tpPct = parseFloat(process.env.TP_ATR ?? '2.0') / 100;
        const slMultEff = this.quantOperatorEnabled ? (1.0 * this.llmSlTightness) : 1.0;
        const tpMultEff = this.quantOperatorEnabled ? (1.0 * this.llmTpExtension) : 1.0;

        const sl = currentPrice * (1 - slPct * slMultEff);
        const tp = currentPrice * (1 + tpPct * tpMultEff);
        let sizeUSDT = margin;
        if (this.dcaEnabled) {
            const initialFraction = this.dcaCapitalAllocation[0] || 0.2;
            sizeUSDT = margin * initialFraction;
        }

        if (margin > this.marginFree) {
            this.addLog('BOT', `[CMC Signal] ${pair}: Insufficient margin (${margin.toFixed(2)}) — skipping.`, 'warning-line');
            return;
        }

        let tokenSize = sizeUSDT / currentPrice;

        this.addLog('BOT', `[CMC Signal] ${pair}: LONG @ $${currentPrice.toFixed(4)} | SL $${sl.toFixed(4)} (-${(slPct * slMultEff * 100).toFixed(2)}%) | TP $${tp.toFixed(4)} (+${(tpPct * tpMultEff * 100).toFixed(2)}%) | Size: $${sizeUSDT.toFixed(2)}`, 'buy-line');

        // ── BSC TWAK execution (same as standard bsc_twak block) ─────────────
        const twak = this.getTWAKClient();
        if (!twak) {
            this.addLog('BOT', `❌ BSC TWAK [${pair}]: Failed to initialize TWAK client.`, 'warning-line');
            return;
        }

        if (isCompetitionActive()) {
            const totalUsd = await twak.getTotalPortfolioUsd().catch(() => this.balance);
            const guard = checkTradeAllowed(totalUsd);
            if (!guard.allowed) {
                this.addLog('BOT', `🛑 COMPETITION GUARD [${pair}]: ${guard.reason}`, 'warning-line');
                return;
            }
            if (!isEligiblePair(pair)) {
                this.addLog('BOT', `⚠️ BSC [${pair}]: Token is not in the 149 eligible list. Skipping.`, 'warning-line');
                return;
            }
        }

        let finalEntryPrice = currentPrice;
        let binanceOrderId: string | undefined;
        let slOrderId: string | undefined;

        try {
            const bscSym = this.bscToken(pair);
            this.addLog('BOT', `📡 BSC TWAK: Swap ${sizeUSDT.toFixed(2)} USDT → ${bscSym} on BSC...`, 'info-line');
            const swapRes = await twak.buyToken(sizeUSDT, bscSym, 1);
            binanceOrderId = swapRes.txHash;
            finalEntryPrice = swapRes.executedPrice > 0 ? swapRes.executedPrice : currentPrice;
            tokenSize = swapRes.toAmount > 0 ? swapRes.toAmount : tokenSize;

            if (isCompetitionActive()) recordTrade(swapRes.txHash);
            this.addLog('BOT', `✅ BSC TWAK Entry filled. Price: ${finalEntryPrice.toLocaleString()} | ${tokenSize.toFixed(6)} ${bscSym} | TX: ${swapRes.txHash.slice(0, 12)}...`, 'buy-line');

            // Cache entry price details
            this.tokenEntryPrices[pair] = { entryPrice: finalEntryPrice, openTime: Date.now() };

            // SL + TP automations (bypassed to save gas, managed in-app)
            this.addLog('BOT', `🛡️ BSC TWAK: SL $${sl.toLocaleString()} | TP $${tp.toLocaleString()} (Managed in-app to save gas)`, 'buy-line');
        } catch (e: any) {
            this.addLog('BOT', `❌ BSC TWAK Entry failed [${pair}]: ${e.message}`, 'warning-line');
            return;
        }

        // ── Record position ────────────────────────────────────────────────────
        const fee = sizeUSDT * this.takerFeeRate;
        this.marginFree -= sizeUSDT + fee;
        this.marginUsed += sizeUSDT;
        this.balance -= fee;

        this.openPositions.push({
            symbol: pair,
            type: 'LONG',
            leverage: 1,
            size: tokenSize,
            entryPrice: finalEntryPrice,
            margin: sizeUSDT,
            liqPrice: 0,
            sl,
            tp,
            pnl: 0,
            pnlPercent: 0,
            openTime: Date.now(),
            feesPaid: fee,
            modelType: 'momentum',
            originalSl: sl,
            trailingTier: 0,
            entryAtr: currentPrice * slPct, // synthetic ATR proxy
            binanceOrderId,
            slOrderId,
            dcaStep: this.dcaEnabled ? 1 : undefined,
            dcaMaxSteps: this.dcaEnabled ? this.dcaMaxSteps : undefined,
            dcaTotalMargin: this.dcaEnabled ? margin : undefined,
        });

        this.addLog('BOT', `📊 New position [${pair}]: LONG ${finalEntryPrice.toLocaleString()} | ${tokenSize.toFixed(6)} tokens | Margin: ${sizeUSDT.toFixed(2)}`, 'buy-line');
    }

    public updateEntryDetailsManual(symbol: string, entryPrice: number, openTime?: number) {
        const pair = symbol.toUpperCase();
        const t = openTime || Date.now();
        this.tokenEntryPrices[pair] = { entryPrice, openTime: t };

        const pos = this.openPositions.find(p => p.symbol === pair);
        if (pos) {
            pos.entryPrice = entryPrice;
            pos.openTime = t;
            const slPct = parseFloat(process.env.SL_ATR ?? '3.0') / 100;
            const tpPct = parseFloat(process.env.TP_ATR ?? '6.0') / 100;
            pos.sl = entryPrice * (1 - slPct);
            pos.tp = entryPrice * (1 + tpPct);
            pos.originalSl = pos.sl;
            this.addLog('SYSTEM', `⚙️ Manually updated entry price for ${pair} to $${entryPrice.toLocaleString()} (New SL: ${pos.sl.toLocaleString()}, TP: ${pos.tp.toLocaleString()})`, 'info-line');
        }
        this.persistState();
        return true;
    }

    public async closePositionManual(index: number, historyLabel = 'Manual Exit 🚪', orderReason = 'Manual Position Close 🚪') {
        const pos = this.openPositions[index];
        if (!pos) return false;
        if (pos.isClosing) return false; // Prevent parallel manual close calls!

        const rawExit = this.livePrices[pos.symbol] || this.livePrice;
        const exitSide: 'BUY' | 'SELL' = 'SELL';
        const slippedExit = this.applySlippage(rawExit, exitSide);
        const gasFee = this.liveTradingMode === 'bsc_twak' ? this.getBscGasFeeUsdt() : 0;
        const exitFee = slippedExit * pos.size * this.effectiveTakerFeeRate + gasFee;
        // Realized PnL = exit proceeds - total capital deployed.
        // Entry overhead (actual gas+slip paid on entry swap) is the difference between
        // pos.margin (USDT sent) and the on-chain notional (pos.size * pos.entryPrice).
        // Use this instead of re-estimating entry gas, which avoids double-counting.
        const notionalAtEntry = pos.size * pos.entryPrice;
        const entryOverhead = Math.max(0, pos.margin - notionalAtEntry);
        const netPnl = pos.size * (slippedExit - pos.entryPrice) - exitFee - entryOverhead;
        pos.feesPaid = (pos.feesPaid || 0) + exitFee;
        pos.pnl = netPnl; // reflect net pnl in records below
        this.totalFeesPaid += exitFee;
        const exitPrice = slippedExit;

        let executeClose = true;
        if (this.liveTradingMode === 'bsc_twak') {
            // ── BSC on-chain close via TWAK ──────────────────────────────────
            const twak = this.getTWAKClient();
            if (twak) {
                try {
                    pos.isClosing = true; // Mark as closing
                    // Cancel TWAK automate SL/TP orders first
                    if (pos.slOrderId) {
                        const ids = pos.slOrderId.split('|');
                        for (const idPart of ids) {
                            const id = idPart.replace(/^(sl_|tp_)/, '');
                            if (id) await twak.deleteAutomate(id).catch(() => { });
                        }
                    }
                    const bscSym = this.bscToken(pos.symbol);
                    let sellAmt = pos.size;
                    if (bscSym === 'BNB') {
                        sellAmt = Math.min(sellAmt, pos.size - 0.003);
                    }
                    if (sellAmt <= 0) {
                        this.addLog('BOT', `⚠️ [TWAK] Cannot close BNB position: remaining BNB is less than gas reserve (0.003 BNB). Removing from tracking.`, 'warning-line');
                    } else {
                        this.addLog('BOT', `📡 BSC TWAK: Swapping ${sellAmt.toFixed(6)} ${bscSym} → USDT (closing position)...`, 'info-line');
                        const sellRes = await twak.sellToken(sellAmt, bscSym, 1);
                        // executedPrice may be 0 if TWAK CLI exited non-zero but swap was on-chain
                        // (LiquidMesh routing). Fall back to rawExit price estimate.
                        const actualExit = sellRes.executedPrice > 0 ? sellRes.executedPrice : rawExit;
                        if (isCompetitionActive() && sellRes.txHash) {
                            recordTrade(sellRes.txHash);
                        }
                        // Use actual on-chain proceeds (toAmount = USDT received) when available.
                        // This is the most accurate realized PnL: actual USDT received - USDT sent.
                        if (sellRes.toAmount > 0) {
                            const actualNetPnl = sellRes.toAmount - pos.margin;
                            pos.pnl = actualNetPnl;
                            this.addLog('BOT', `✅ BSC TWAK closed position. Price: ${this.formatPrice(actualExit)} | Received: ${sellRes.toAmount.toFixed(4)} USDT | PnL: ${actualNetPnl >= 0 ? '+' : ''}${actualNetPnl.toFixed(4)} USDT | TX: ${sellRes.txHash.slice(0, 12)}...`, actualNetPnl >= 0 ? 'buy-line' : 'sell-line');
                        } else {
                            this.addLog('BOT', `✅ BSC TWAK closed position. Price: ${this.formatPrice(actualExit)} (USDT received not reported — PnL estimated) | TX: ${sellRes.txHash.slice(0, 12)}...`, pos.pnl >= 0 ? 'buy-line' : 'sell-line');
                        }
                    }
                } catch (e: any) {
                    this.addLog('BOT', `⚠️ BSC TWAK position close failed: ${e.message}. Retrying manually or automatically.`, 'warning-line');
                    pos.isClosing = false; // Reset flag so it can retry
                    executeClose = false;  // Keep the position in memory
                }
            }
        } else {
            this.balance += pos.margin + netPnl;
        }

        if (!executeClose) return false;

        // Record daily realized PnL (mirrors the auto-close path).
        // pos.pnl may have been updated above with the actual on-chain toAmount.
        this.dailyPnL += pos.pnl;

        // T3.3 — attribute realized PnL to the model that opened this position.
        const pnlPctManual = pos.margin > 0 ? (pos.pnl / pos.margin) * 100 : 0;
        this.recordModelTrade(pos.modelType || this.modelType, pos.pnl, pnlPctManual);

        const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        this.tradeHistory.push({
            time: timeStr,
            pair: pos.symbol,
            type: 'Manual Close',
            side: 'Exit Long',
            price: exitPrice,
            size: (pos.size * pos.entryPrice).toFixed(2),
            leverage: '1x',
            pnl: pos.pnl,
            status: historyLabel
        });

        this.addLog('BOT', `Closed Position (${historyLabel}): LONG ${pos.symbol} at ${exitPrice}. PnL: ${pos.pnl >= 0 ? '+' : ''}${pos.pnl.toFixed(2)}`, pos.pnl >= 0 ? 'buy-line' : 'sell-line');

        this.orderHistory.push({
            time: timeStr,
            symbol: pos.symbol,
            type: 'MARKET',
            side: 'SELL',
            price: exitPrice,
            size: pos.size,
            status: 'CLOSED',
            pnl: pos.pnl,
            reason: orderReason
        });

        this.openPositions.splice(index, 1);

        this.recomputeLedger();
        this.persistState(); // Phase 5: capture the manual exit
        return true;
    }

    /**
     * Initialize AI Smart Grid strategy
     */
    public initializeSmartGrid(pair: string, currentPrice: number, atr: number) {
        if (this.gridActiveMap[pair]) return;

        this.addLog('BOT', `🤖 [${pair}] Initializing Smart Grid due to sideway market detection...`, 'info-line');

        // Dynamic spacing based on current ATR and multiplier (Issue 9)
        const spacing = atr * this.gridSpacingAtrMultiplier;
        // Cache ATR so grid→position conversions always have a value for SL/TP sizing.
        this.liveAtrMap[pair] = atr;
        this.gridCenterPrices[pair] = currentPrice;
        this.gridActiveMap[pair] = true;
        this.gridOrdersMap[pair] = [];

        // Define absolute breakout global stop loss boundaries
        this.gridUpperBoundaries[pair] = currentPrice + spacing * 4.0;
        this.gridLowerBoundaries[pair] = currentPrice - spacing * 4.0;

        // Portfolio division: 1/N of total simulated balance per pair for Grid
        const totalCapital = this.balance + this.marginUsed;
        const targetPairMargin = totalCapital / this.activePairs.length;

        const totalRiskUSDT = targetPairMargin * this.riskRatio * this.orderSizeMultiplier; // risk budget of this pair's allocation (incl. global size multiplier)
        // Spaced across 6 grids
        const marginPerGrid = (totalRiskUSDT / 6.0);
        const sizePerGridUSDT = marginPerGrid; // Spot has no leverage

        const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const offsets = [-3, -2, -1, 1, 2, 3];
        offsets.forEach((multiplier, i) => {
            const gridPrice = currentPrice + spacing * multiplier;
            const sizeToken = sizePerGridUSDT / gridPrice;
            const isBuy = multiplier < 0;

            this.gridOrdersMap[pair].push({
                id: `grid-${pair}-${i}-${Math.random().toString(36).substring(2, 6)}`,
                type: isBuy ? 'BUY_LIMIT' : 'SELL_LIMIT',
                price: gridPrice,
                size: sizeToken,
                margin: marginPerGrid,
                status: 'PENDING',
                tpPrice: isBuy ? (gridPrice + spacing) : (gridPrice - spacing),
                pnl: 0
            });

            this.orderHistory.push({
                time: timeStr,
                symbol: pair,
                type: 'LIMIT',
                side: isBuy ? 'BUY' : 'SELL',
                price: gridPrice,
                size: sizeToken,
                status: 'PENDING',
                reason: `Smart Grid Placed [Level ${multiplier > 0 ? '+' : ''}${multiplier}]`
            });
        });

        this.addLog('BOT', `🛡️ [${pair}] Deployed 6-level Grid. Upper limit: ${this.gridUpperBoundaries[pair].toLocaleString()}, Lower limit: ${this.gridLowerBoundaries[pair].toLocaleString()}, Spacing: ${spacing.toFixed(2)}`, 'buy-line');
    }

    public dismantleGrid(pair: string, reason: string) {
        if (!this.gridActiveMap[pair]) return;

        this.addLog('BOT', `🛑 Dismantled Smart Grid for ${pair}. Reason: ${reason}`, 'warning-line');

        // Close any filled positions at current price and release margin
        let totalPnl = 0;
        const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        this.gridOrdersMap[pair].forEach(o => {
            if (o.status === 'PENDING') {
                this.orderHistory.push({
                    time: timeStr,
                    symbol: pair,
                    type: 'LIMIT',
                    side: o.type === 'BUY_LIMIT' ? 'BUY' : 'SELL',
                    price: o.price,
                    size: o.size,
                    status: 'CANCELLED',
                    reason: `Grid Dismantled: ${reason}`
                });
            } else if (o.status === 'FILLED') {
                totalPnl += o.pnl;
                this.balance += o.margin + o.pnl; // return margin and credit/debit PnL

                this.orderHistory.push({
                    time: timeStr,
                    symbol: pair,
                    type: 'LIMIT',
                    side: o.type === 'BUY_LIMIT' ? 'SELL' : 'BUY',
                    price: this.livePrices[pair] || o.price,
                    size: o.size,
                    status: 'CLOSED',
                    pnl: o.pnl,
                    reason: `Grid Force Close: ${reason}`
                });
            }
        });

        if (totalPnl !== 0) {
            this.tradeHistory.push({
                time: timeStr,
                pair: pair,
                type: 'Grid Dismantle',
                side: 'Exit Grid Portfolio',
                price: this.livePrices[pair] || 0,
                size: (totalPnl > 0 ? 'Profit' : 'Loss'),
                leverage: `${this.leverage}x`,
                pnl: totalPnl,
                status: reason
            });
        }

        this.gridActiveMap[pair] = false;
        this.gridOrdersMap[pair] = [];
        this.gridCenterPrices[pair] = 0;
        this.gridUpperBoundaries[pair] = 0;
        this.gridLowerBoundaries[pair] = 0;

        this.recomputeLedger();
    }

    public setSimulatedCapital(amount: number) {
        if (isNaN(amount) || amount <= 0) return false;
        this.initialCapital = amount;
        this.balance = amount;
        this.marginUsed = 0;
        this.marginFree = amount;
        this.openPositions = []; // close all current positions to start trading with a new account
        this.tradeHistory = [];  // reset trade history to reflect profit accurately
        this.addLog('SYSTEM', `Updated initial simulated capital to ${amount.toLocaleString()}. Account reset successfully.`, 'info-line');
        return true;
    }

    /**
     * Run background Grid Search Hyperparameter Auto-Optimization
     * Evaluates 108 combinations to find the highest simulated PnL configuration.
     */
    public autoOptimizeHyperparameters(pair?: string) {
        const symbol = pair || this.currentPair;
        // Same logic as runBacktest: momentum needs no in-process training.
        const needsTraining = this.modelType === 'knn' || this.modelType === 'logistic';
        if (needsTraining && !this.aiBrainTrainedMap[symbol]) {
            this.addLog('SYSTEM', `🛡️ AUTO-OPTIMIZER: Cannot optimize because AI model for ${symbol} is not trained.`, 'warning-line');
            return { success: false, error: 'Model not trained' };
        }

        // Ensemble: the backtest uses Momentum as a synchronous proxy.
        // Running 768 Momentum backtests on choppy short timeframes produces
        // near-universal negative expectancy, making optimizer output misleading.
        // Skip it and advise the user to rely on the LLM Quant Operator instead.
        if (this.modelType === 'ensemble') {
            this.addLog('SYSTEM', `ℹ️ AUTO-OPTIMIZER: Skipping Grid Search for model ${this.modelType.toUpperCase()} — SL/TP/Risk parameters will be adjusted by LLM Quant Operator based on actual winrate.`, 'info-line');
            return { success: true, skipped: true };
        }

        this.addLog('SYSTEM', `🚀 AUTO-OPTIMIZER: Running Grid Search parameter optimization for ${symbol}...`, 'info-line');

        // Train/Test Split: Train model on first 70%, evaluate on FULL candle set
        // (extractFeatures needs 200+ candles, so test partition alone is too small)
        const candles = this.historicalCandlesMap[symbol] || [];
        if (candles.length < 300) {
            this.addLog('SYSTEM', `🛡️ AUTO-OPTIMIZER: Cannot optimize because ${symbol} has insufficient candle data (needs ≥ 300).`, 'warning-line');
            return { success: false, error: 'Not enough data' };
        }

        const splitIndex = Math.floor(candles.length * 0.7);
        const trainCandles = candles.slice(0, splitIndex);

        let tempTrainingFeatures: LabeledDataPoint[] = [];
        let tempTrainedModel: LogisticRegressionModel | null = null;

        if (this.modelType !== 'momentum') {
            const closes = trainCandles.map((c: Candle) => c.close);
            const highs = trainCandles.map((c: Candle) => c.high);
            const lows = trainCandles.map((c: Candle) => c.low);
            const volumes = trainCandles.map((c: Candle) => c.volume);

            const dataset = this.ai.extractFeatures(closes, highs, lows, volumes);
            if (dataset.length > 0) {
                const threshold = this.getLabelThreshold(this.currentTimeframe);
                const labeledData = this.ai.labelDataset(dataset, closes, 5, threshold);

                if (this.modelType === 'knn') {
                    tempTrainingFeatures = labeledData;
                } else if (this.modelType === 'logistic') {
                    tempTrainedModel = this.ai.trainLogisticRegression(labeledData, 250, 0.05);
                }
            }
        }

        // Parameter ranges to test (total 4 * 3 * 4 * 4 * 4 = 768 combinations)
        const confidenceRange = [60, 65, 70, 75];
        const leverageRange = [1];
        const riskRange = [0.01, 0.015, 0.02, 0.03];
        const tpAtrRange = [1.5, 2.0, 2.5, 3.0];
        const slAtrRange = [1.0, 1.5, 2.0, 2.5];

        let bestScore = -Infinity;
        let bestPnL = -Infinity;
        let bestParams = {
            confidenceThreshold: this.confidenceThreshold,
            leverage: this.leverage,
            riskRatio: this.riskRatio,
            tpAtrMultiplier: this.tpAtrMultiplier,
            slAtrMultiplier: this.slAtrMultiplier
        };

        let testedCount = 0;
        let validResults = 0;

        // Perform fast backtest on FULL candle set (model trained on train split only)
        for (const conf of confidenceRange) {
            for (const lev of leverageRange) {
                for (const risk of riskRange) {
                    for (const tp of tpAtrRange) {
                        for (const sl of slAtrRange) {
                            testedCount++;
                            const result = this.runBacktest({
                                pair: symbol,
                                confidenceThreshold: conf,
                                leverage: lev,
                                riskRatio: risk,
                                tpAtrMultiplier: tp,
                                slAtrMultiplier: sl,
                                candles: candles, // Use full candle set for meaningful backtest
                                tempTrainingFeatures,
                                tempTrainedModel
                            }) as any;

                            if (result.success && typeof result.botPnLUsd === 'number') {
                                const pnlUsd = result.botPnLUsd;
                                const maxDrawdown = result.maxDrawdown || 0;
                                const totalTrades = result.totalTrades || 0;
                                const winrate = result.winrate || 0; // 0..100
                                const profitFactor = result.profitFactor;
                                const expectancy = result.expectancy || 0;

                                // Risk-adjusted objective. We don't just chase the biggest PnL —
                                // a config that made $X with a 60% drawdown on 2 lucky trades is
                                // worse than a steadier one. So we:
                                //  1) Penalise drawdown (capital preservation),
                                //  2) Require a minimum sample of trades (statistical significance),
                                //  3) Reward higher win rate (consistency),
                                //  4) Use Profit Factor when available (the real edge metric).
                                const MIN_TRADES = 5;

                                // Sample-size factor: ramps from 0 → 1 as trades reach MIN_TRADES,
                                // so flukey 1-2 trade configs are heavily discounted.
                                const sampleFactor = Math.min(1, totalTrades / MIN_TRADES);

                                // Win-rate factor centred at 50%: <50% shrinks score, >50% boosts it.
                                const winFactor = 0.5 + (winrate / 100); // 0.5 .. 1.5

                                const ddPenalty = 1 + (maxDrawdown / 100);

                                // Quality boost: clamp PF to [0.5, 3] to avoid runaway scores.
                                let pfBoost = 1;
                                if (typeof profitFactor === 'number' && isFinite(profitFactor)) {
                                    pfBoost = Math.max(0.5, Math.min(3, profitFactor));
                                } else if (profitFactor === Infinity) {
                                    pfBoost = 3; // perfect (no losers) but capped to be conservative
                                }

                                // Hard reject configs with negative expectancy (every trade loses on
                                // average after costs — no amount of luck makes this a real edge).
                                if (expectancy < 0) continue;

                                let rawScore = (pnlUsd / ddPenalty) * sampleFactor * winFactor * pfBoost;

                                // Guard: skip NaN/Infinity scores
                                if (!isFinite(rawScore) || isNaN(rawScore)) continue;

                                validResults++;
                                if (rawScore > bestScore) {
                                    bestScore = rawScore;
                                    bestPnL = pnlUsd;
                                    bestParams = {
                                        confidenceThreshold: conf,
                                        leverage: lev,
                                        riskRatio: risk,
                                        tpAtrMultiplier: tp,
                                        slAtrMultiplier: sl
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }

        // Fallback: if no valid results, keep current params
        const hasValidResult = isFinite(bestPnL) && !isNaN(bestPnL) && validResults > 0;
        const displayPnL = hasValidResult ? `${bestPnL.toFixed(2)}` : 'N/A (no valid result)';

        if (this.quantOperatorEnabled && hasValidResult) {
            // Only apply if we found a genuinely profitable config
            if (bestPnL > 0) {
                this.confidenceThreshold = bestParams.confidenceThreshold;
                this.leverage = bestParams.leverage;
                this.riskRatio = bestParams.riskRatio;
                this.tpAtrMultiplier = bestParams.tpAtrMultiplier;
                this.slAtrMultiplier = bestParams.slAtrMultiplier;
                this.addLog('SYSTEM', `🛡️ AUTO-OPTIMIZER: Completed Grid Search [${symbol}] (${testedCount} scenarios, ${validResults} valid). Applied optimal config: Spot (no leverage), Risk ${(this.riskRatio * 100).toFixed(1)}%, Confidence: ${this.confidenceThreshold}%, TP ATR: ${this.tpAtrMultiplier}, SL ATR: ${this.slAtrMultiplier}. Expected PnL: ${displayPnL}`, 'buy-line');
            } else {
                this.addLog('SYSTEM', `🛡️ AUTO-OPTIMIZER: Completed Grid Search [${symbol}] (${testedCount} scenarios, ${validResults} valid). No profitable configuration found on current data. Keeping current parameters.`, 'warning-line');
            }
        } else {
            this.addLog('SYSTEM', `🛡️ AUTO-OPTIMIZER: Completed Grid Search [${symbol}] (${testedCount} scenarios, ${validResults} valid). Recommended config: Spot (no leverage), Risk ${(bestParams.riskRatio * 100).toFixed(1)}%, Confidence: ${bestParams.confidenceThreshold}%, TP ATR: ${bestParams.tpAtrMultiplier}, SL ATR: ${bestParams.slAtrMultiplier}. Expected PnL: ${displayPnL}`, 'info-line');
        }

        return {
            success: true,
            bestPnL: hasValidResult ? bestPnL : 0,
            params: bestParams
        };
    }

    public setBotRunning(running: boolean) {
        if (this.botRunning === running) return;
        this.botRunning = running;
        this.addLog('SYSTEM', `Auto-Bot status update: ${running ? 'RUNNING 🟢' : 'STOPPED 🔴'}`, 'info-line');

        if (running) {
            this.activePairs.forEach(pair => {
                const candles = this.historicalCandlesMap[pair] || [];
                if (candles.length > 0) {
                    const lastCandle = candles[candles.length - 1];
                    this.addLog('BOT', `Auto-Bot activated for ${pair}. Running instant signal evaluation on current candle...`, 'info-line');
                    this.lastCandleTimesEvaluated[pair] = null; // force evaluation
                    this.evaluateLiveSignal(pair, lastCandle.time);
                }
            });
        }
    }

    public calculateChoppinessIndex(candles: Candle[], period: number = 14): number {
        if (!candles || candles.length < period + 1) return 50;

        let sumTR = 0;
        let highestHigh = -Infinity;
        let lowestLow = Infinity;

        for (let i = candles.length - period; i < candles.length; i++) {
            const c = candles[i];
            const prev = candles[i - 1];

            const tr = prev
                ? Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
                : c.high - c.low;

            sumTR += tr;
            if (c.high > highestHigh) highestHigh = c.high;
            if (c.low < lowestLow) lowestLow = c.low;
        }

        const range = highestHigh - lowestLow;
        if (range === 0) return 50;

        const chop = 100 * (Math.log10(sumTR / range) / Math.log10(period));
        return isNaN(chop) ? 50 : Math.max(0, Math.min(100, chop));
    }

    public calculateVolatilityRatio(candles: Candle[], period: number = 14): number {
        if (!candles || candles.length < period + 1) return 0.05;

        let sumTR = 0;
        for (let i = candles.length - period; i < candles.length; i++) {
            const c = candles[i];
            const prev = candles[i - 1];
            const tr = prev
                ? Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
                : c.high - c.low;
            sumTR += tr;
        }
        const atr = sumTR / period;
        const currentPrice = candles[candles.length - 1]?.close || 1;
        return (atr / currentPrice) * 100;
    }

    public calculateTrendIntensity(candles: Candle[], period: number = 20): number {
        if (!candles || candles.length < 50) return 0;

        const closes = candles.map(c => c.close);
        const ema20 = this.ai.calculateEMA(closes, 20);
        const ema50 = this.ai.calculateEMA(closes, 50);

        const last = closes.length - 1;
        const lastEma20 = ema20[last];
        const lastEma50 = ema50[last];

        if (lastEma20 === null || lastEma50 === null) return 0;

        const deviation = Math.abs(lastEma20 - lastEma50) / lastEma50;
        const score = Math.min(100, Math.round(deviation * 10000));
        return score;
    }

    public getMaxDailyLossLimitUsd(): number {
        return Math.max(0, this.initialCapital * this.maxDailyDrawdown);
    }

    private getTotalUnrealizedPnl(): number {
        let sum = 0;
        this.openPositions.forEach(p => { sum += p.pnl; });
        this.activePairs.forEach(pair => {
            if (this.gridActiveMap[pair]) {
                this.gridOrdersMap[pair].forEach(o => {
                    if (o.status === 'FILLED') sum += o.pnl;
                });
            }
        });
        return sum;
    }

    private getCurrentEquity(): number {
        return this.balance + this.marginUsed + this.getTotalUnrealizedPnl();
    }

    private refreshDailyEquityPeak(): void {
        const equity = this.getCurrentEquity();
        if (this.dailyEquityPeak <= 0) {
            this.dailyEquityPeak = equity;
            return;
        }
        if (equity > this.dailyEquityPeak) {
            this.dailyEquityPeak = equity;
        }
    }

    private getCurrentDrawdownFromPeak(): number {
        this.refreshDailyEquityPeak();
        const equity = this.getCurrentEquity();
        if (this.dailyEquityPeak <= 0) return 0;
        return Math.max(0, (this.dailyEquityPeak - equity) / this.dailyEquityPeak);
    }

    /**
     * Attempt a real LLM decision for the Quant Operator. Returns null when
     * the LLM is not configured, times out, errors out, or returns junk —
     * the caller then falls back to deterministic rules. This is intentionally
     * a thin wrapper so the strategy logic stays testable.
     */
    private async tryLlmDecision(input: {
        chop: number;
        vol: number;
        trend: number;
        refCandles: Candle[];
        pair: string;
        ensembleSignal?: EnsembleSignalContext;
    }): Promise<QuantOperatorDecision | null> {
        const cfg = readLLMConfig({
            provider: this.llmProvider,
            apiKey: this.llmApiKey,
            model: this.llmModel
        });
        if (!isLLMConfigured(cfg)) return null;

        // In bsc_twak mode: derive HTF bias from CMC feed (7d momentum) instead of Binance klines.
        // In other modes: use Binance HTF klines as before.
        let macroBias: -1 | 0 | 1 = 0;

        const htf = await this.getHtfBias(input.pair).catch(() => null);
        const computedBias = htf?.bias ?? computeMacroBias(input.refCandles);
        macroBias = (computedBias as -1 | 0 | 1);

        // Grok X Sentiment and CMC global snapshot in parallel.
        const [sentiment, cmcSnapshot] = await Promise.all([
            getXSentiment(input.pair),
            getCMCMarketSnapshot().catch(() => null),
        ]);

        const maxLossUsd = this.getMaxDailyLossLimitUsd();

        const xSentiment = sentiment ? {
            score: sentiment.score,
            volume: sentiment.volume,
            narrative: sentiment.narrative,
            ageMinutes: Math.round((Date.now() - sentiment.fetchedAt) / 60000)
        } : undefined;

        const ctx: MarketContext = {
            timestampISO: new Date().toISOString(),
            activePair: input.pair,
            activeTimeframe: this.currentTimeframe,
            activeModel: this.modelType,
            gridEnabled: this.gridModeEnabled,
            confidenceThreshold: this.confidenceThreshold,
            riskRatio: this.riskRatio,
            pairs: [{
                symbol: input.pair,
                livePrice: this.livePrices[input.pair] || 0,
                priceChange24h: this.priceChanges24h[input.pair] || 0,
                volume24h: this.volumes24h[input.pair] || 0,
                choppiness: Number(input.chop.toFixed(2)),
                volatility: Number(input.vol.toFixed(3)),
                trendIntensity: input.trend,
                macroBias,
                xSentiment
            }],
            openPositions: summarizePositions(this.openPositions, this.livePrices),
            recentTrades: summarizeRecentTrades(this.tradeHistory as any),
            walletBalance: Number(this.balance.toFixed(2)),
            // GROSS price-action PnL (excludes gas/slippage so LLM won't mistake sunk costs for price crashes)
            totalUnrealizedPnl: Number(this.openPositions.reduce((sum, p) => {
                const cp = this.livePrices[p.symbol] || p.entryPrice;
                return sum + (p.type === 'LONG' ? 1 : -1) * p.size * (cp - p.entryPrice);
            }, 0).toFixed(2)),
            dailyPnL: Number(this.dailyPnL?.toFixed?.(2) ?? 0),
            maxDailyDrawdownLimitUsd: Number(maxLossUsd.toFixed(2)),
            maxDailyDrawdownPct: Number((this.maxDailyDrawdown * 100).toFixed(2)),
            hoursRemainingInDay: Number(computeHoursRemainingInDay().toFixed(2)),
            currentDrawdownFromPeak: Number(this.getCurrentDrawdownFromPeak().toFixed(4)),
            bscGasOverheadUsd: this.liveTradingMode === 'bsc_twak' ? Number(this.getBscGasFeeUsdt().toFixed(4)) : undefined,
            ensembleSignal: input.ensembleSignal,
            costs: {
                takerFeeRate: this.takerFeeRate,
                slippageBps: this.slippageBps
            },
            cmcMarket: cmcSnapshot ? {
                fearAndGreedScore: cmcSnapshot.fearAndGreedScore,
                fearAndGreedLabel: cmcSnapshot.fearAndGreedLabel,
                marketTrend: cmcSnapshot.marketTrend as 'bullish' | 'neutral' | 'bearish',
                btcDominance: cmcSnapshot.btcDominance,
                totalMarketCapUsd: cmcSnapshot.totalMarketCapUsd,
                topGainers: cmcSnapshot.topGainers,
                skillHubSummary: cmcSnapshot.skillHubSummary,
            } : undefined,
            competition: isCompetitionActive() ? (() => {
                const stats = getCompetitionStats(this.balance + this.marginUsed);
                return {
                    isActive: stats.isActive,
                    drawdownPct: Number(stats.currentDrawdownPct.toFixed(4)),
                    tradeDays: stats.tradeDays,
                    missingTradeDays: stats.missingTradeDays,
                    daysRemaining: stats.daysRemaining,
                };
            })() : undefined,
        };

        const result = await callLLM<QuantOperatorDecision>(
            QUANT_OPERATOR_SYSTEM_PROMPT,
            buildUserPrompt(ctx),
            cfg
        );
        this.llmLastLatencyMs = result.latencyMs || 0;

        if (!result.ok || !result.data) {
            this.addLog('SYSTEM', `⚠️ [LLM Brain] ${result.error || 'Invalid response'}. Auto-switched to rule-based fallback for this turn.`, 'warning-line');
            return null;
        }

        // Validate the decision against the strict schema. Any structural
        // mismatch -> reject and fall back. Better safe than sorry.
        const d = result.data as Partial<QuantOperatorDecision>;
        const validTf = d.timeframe && ['1m', '5m', '15m', '1h'].includes(d.timeframe);
        const validModel = d.modelType && ['knn', 'logistic', 'momentum'].includes(d.modelType);
        if (!validTf || !validModel || typeof d.riskMultiplier !== 'number') {
            this.addLog('SYSTEM', `⚠️ [LLM Brain] Decision JSON did not match schema. Reverting to Rule-based logic.`, 'warning-line');
            return null;
        }

        // Clamp optional SL/TP knobs to safe bounds; default to neutral 1.0.
        const clamp = (v: any, lo: number, hi: number) =>
            typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 1.0;

        // Parse positionAdjustments if present
        let positionAdjustments: any[] | undefined = undefined;
        if (Array.isArray(d.positionAdjustments)) {
            positionAdjustments = d.positionAdjustments.filter(adj => {
                return adj && typeof adj.symbol === 'string' &&
                    ['HOLD', 'EXIT', 'TIGHTEN_SL', 'EXTEND_TP', 'MOVE_TO_ENTRY'].includes(adj.action);
            });
        }

        return {
            regime: d.regime || 'UNDEFINED',
            timeframe: d.timeframe as any,
            modelType: d.modelType as any,
            gridMode: d.gridMode || false,
            riskMultiplier: d.riskMultiplier,
            confidence: typeof d.confidence === 'number' ? d.confidence : 60,
            reasoning: d.reasoning || '',
            slTightnessMultiplier: clamp(d.slTightnessMultiplier, 0.5, 1.5),
            tpExtensionMultiplier: clamp(d.tpExtensionMultiplier, 0.7, 2.0),
            trailingTpAggressiveness: clamp(d.trailingTpAggressiveness, 0.5, 2.0),
            forceExit: d.forceExit === true,
            positionAdjustments
        };
    } public async runQuantOperator(options?: boolean | { forceAdjustment?: boolean; isCandleClose?: boolean; targetPair?: string }): Promise<void> {
        if (!this.quantOperatorEnabled) return;

        let forceAdjustment = false;
        let isCandleClose = false;
        let targetPair: string | undefined = undefined;
        if (typeof options === 'boolean') {
            forceAdjustment = options;
        } else if (options && typeof options === 'object') {
            forceAdjustment = !!options.forceAdjustment;
            isCandleClose = !!options.isCandleClose;
            targetPair = options.targetPair;
        }

        const pair = targetPair || this.currentPair;

        if (this.quantOperatorRunningPairs.has(pair)) {
            this.addLog('SYSTEM', `⚠️ [QUANT OPERATOR] An Operator background process is already running for ${pair}. Skipping to avoid conflict.`, 'warning-line');
            return;
        }

        this.quantOperatorRunningPairs.add(pair);
        try {
            const timeStr = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

            // Throttling and event-driven bypass logic:
            // 1. If we have open positions and this is a periodic check (neither forceAdjustment nor isCandleClose is set), skip it.
            //    We rely entirely on event-driven triggers (price movement or 5-min heartbeat) to call runQuantOperator(true) or candle close triggers.
            // 2. If we have no open positions and this is a periodic check, throttle regime evaluations to once every 5 minutes.
            // 3. If isCandleClose is true, we bypass the 5-minute timer throttling because candle close is a key structural boundary.
            if (!forceAdjustment && !isCandleClose) {
                if (this.openPositions.length > 0) {
                    return;
                }
                if (Date.now() - this.lastRegimeCheckTime < 300000) { // 5 minutes
                    return;
                }
            }

            // Cooldown: 30 minutes between regime switches to prevent flip-flop
            // We bypass the cooldown if forceAdjustment is true, since position adjustments are time-sensitive.
            // But we do NOT bypass it for periodic checks or candle close checks.
            if (!forceAdjustment && (Date.now() - this.quantOperatorLastSwapTime < 1800000)) {
                const lastThought = this.quantOperatorThoughts[this.quantOperatorThoughts.length - 1];
                const minutesRemaining = Math.ceil((1800000 - (Date.now() - this.quantOperatorLastSwapTime)) / 60000);
                if (!lastThought || !lastThought.message.includes('cooldown')) {
                    this.quantOperatorThoughts.push({
                        time: timeStr,
                        message: `🧠 Quant Operator Brain is in 30-minute cooldown (${minutesRemaining}m remaining) to avoid noise and tactical chasing...`,
                        type: 'info'
                    });
                    if (this.quantOperatorThoughts.length > 50) this.quantOperatorThoughts.shift();
                }
                return;
            }

            this.lastRegimeCheckTime = Date.now();

            // Download 100 15m candles directly from Binance as benchmark
            let refCandles: Candle[] = [];
            try {
                const refUrl = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=15m&limit=100`;
                const response = await fetch(refUrl);
                const klines = await response.json();
                refCandles = klines.map((k: any) => ({
                    time: Math.floor(k[0] / 1000),
                    open: parseFloat(k[1]),
                    high: parseFloat(k[2]),
                    low: parseFloat(k[3]),
                    close: parseFloat(k[4]),
                    volume: parseFloat(k[5])
                }));
            } catch (err) {
                console.error('Error loading reference candles for Quant Operator:', err);
                // Fallback to currently active candles in memory if API fails
                refCandles = this.historicalCandlesMap[pair] || [];
            }

            const chop = this.calculateChoppinessIndex(refCandles);
            const vol = this.calculateVolatilityRatio(refCandles);
            const trend = this.calculateTrendIntensity(refCandles);

            // Cheap Pre-filter Rule to save tokens:
            // If there are no open positions and this is not a forced position adjustment check,
            // we check if the indicators have changed significantly.
            // If they are stable, we bypass calling the LLM and return early.
            if (!forceAdjustment && this.openPositions.length === 0 && this.lastLlmChop > 0) {
                const chopDiff = Math.abs(chop - this.lastLlmChop);
                const volDiff = Math.abs(vol - this.lastLlmVol);
                const trendDiff = Math.abs(trend - this.lastLlmTrend);

                if (chopDiff < 3 && volDiff < 0.05 && trendDiff < 10) {
                    this.quantOperatorThoughts.push({
                        time: timeStr,
                        message: `💤 [QUANT OPERATOR] Market indicators stable (ChopΔ: ${chopDiff.toFixed(1)}, VolΔ: ${volDiff.toFixed(2)}%, TrendΔ: ${trendDiff.toFixed(0)}). Skipping LLM call to save tokens.`,
                        type: 'info'
                    });
                    if (this.quantOperatorThoughts.length > 50) this.quantOperatorThoughts.shift();

                    this.addLog('SYSTEM', '💤 [QUANT OPERATOR] Market indicators stable, skipping LLM call to save tokens.', 'info-line');
                    return;
                }
            }

            this.lastLlmChop = chop;
            this.lastLlmVol = vol;
            this.lastLlmTrend = trend;

            let optimalTimeframe: '1m' | '5m' | '15m' | '1h' = this.currentTimeframe as any;
            // The Quant Operator only switches between the three in-process
            // models — ENSEMBLE is opt-in by the user and not regime-driven;
            // we map it to a safe default for ranking but honor the user pin further down.
            const currentModelForRanking: 'knn' | 'logistic' | 'momentum' =
                (this.modelType === 'ensemble')
                    ? 'momentum'
                    : this.modelType;
            let optimalModel: 'knn' | 'logistic' | 'momentum' = currentModelForRanking;
            let optimalGridMode = this.gridModeEnabled;
            let regime = '';
            let reasoning = '';
            let decisionSource: 'LLM' | 'RULE' = 'RULE';

            // ============================================================
            // PHASE 1: Try the real LLM brain first. If it answers in time
            // with a valid decision, use it. Otherwise fall through to the
            // deterministic rule-based logic — so the bot is NEVER blocked
            // by a missing API key, a rate limit, or a hallucination.
            // ============================================================
            // Re-predict ensemble for the active pair so the LLM receives fresh
            // quantitative signal data, not stale values from the last candle close.
            let freshEnsembleSignal: EnsembleSignalContext | undefined =
                this.lastEnsembleSignalMap[pair];
            if (this.modelType === 'ensemble' && this.openPositions.some(p => p.symbol === pair)) {
                try {
                    const candles = this.historicalCandlesMap[pair] || [];
                    if (candles.length > 0) {
                        const closes = candles.map(c => c.close);
                        const highs = candles.map(c => c.high);
                        const lows = candles.map(c => c.low);
                        const volumes = candles.map(c => c.volume);
                        const dataset2 = this.ai.extractFeatures(closes, highs, lows, volumes);
                        if (dataset2.length > 0) {
                            const pt = dataset2[dataset2.length - 1];
                            const ens2 = await this.predictEnsemble(pair, closes, highs, lows, volumes, pt.features);
                            freshEnsembleSignal = ens2.ensembleCtx;
                            this.lastEnsembleSignalMap[pair] = freshEnsembleSignal;
                        }
                    }
                } catch {
                    // Non-fatal: use the cached signal from the last candle close.
                }
            }

            const llmDecision = await this.tryLlmDecision({
                chop, vol, trend, refCandles, pair,
                ensembleSignal: freshEnsembleSignal
            });

            if (llmDecision) {
                decisionSource = 'LLM';
                optimalTimeframe = llmDecision.timeframe;
                optimalModel = llmDecision.modelType;
                optimalGridMode = !!llmDecision.gridMode;
                regime = llmDecision.regime;
                reasoning = llmDecision.reasoning;
                // Bounded multiplier; LLM cannot YOLO leverage on us.
                this.llmRiskMultiplier = Math.max(0.3, Math.min(1.5, llmDecision.riskMultiplier || 1.0));
                // Adaptive SL/TP knobs (already clamped in tryLlmDecision).
                this.llmSlTightness = llmDecision.slTightnessMultiplier ?? 1.0;
                this.llmTpExtension = llmDecision.tpExtensionMultiplier ?? 1.0;
                this.llmTrailingAggressiveness = llmDecision.trailingTpAggressiveness ?? 1.0;
                this.llmLastDecision = llmDecision;

                if (this.llmSlTightness !== 1.0 || this.llmTpExtension !== 1.0 || this.llmTrailingAggressiveness !== 1.0) {
                    this.addLog('SYSTEM', `🧠 [LLM SL/TP] Adjustments: SL x${this.llmSlTightness.toFixed(2)} | TP x${this.llmTpExtension.toFixed(2)} | Trailing x${this.llmTrailingAggressiveness.toFixed(2)}.`, 'info-line');
                }

                // Emergency risk-off: LLM requests closing everything now.
                if (llmDecision.forceExit) {
                    this.addLog('SYSTEM', `🛑 [LLM FORCE EXIT] Quant Brain ordered emergency close of ALL positions! Reason: ${llmDecision.reasoning}`, 'warning-line');
                    await this.llmForceCloseAll();
                }

                // Dynamic LLM Position Adjustments
                if (llmDecision.positionAdjustments && llmDecision.positionAdjustments.length > 0) {
                    for (const adj of llmDecision.positionAdjustments) {
                        const index = this.openPositions.findIndex(p => p.symbol === adj.symbol);
                        if (index === -1) continue;
                        const pos = this.openPositions[index];
                        const currentPrice = this.livePrices[pos.symbol] || this.livePrice;

                        if (adj.action === 'EXIT') {
                            this.addLog('SYSTEM', `🧠 [LLM ADJ] Early exit for position ${pos.symbol}. Reason: ${adj.reason}`, 'warning-line');
                            try {
                                await this.closePositionManual(index, 'LLM Exit 🧠', `LLM Exit: ${adj.reason}`);
                            } catch (err: any) {
                                this.addLog('SYSTEM', `⚠️ Failed to execute LLM close for ${pos.symbol}: ${err.message}`, 'warning-line');
                            }
                        } else if (adj.action === 'MOVE_TO_ENTRY') {
                            let slChanged = false;
                            if (pos.type === 'LONG' && pos.sl < pos.entryPrice) {
                                pos.sl = pos.entryPrice;
                                slChanged = true;
                            }
                            if (slChanged) {
                                this.addLog('SYSTEM', `🧠 [LLM ADJ] Moved SL of ${pos.symbol} to Entry (${this.formatPrice(pos.entryPrice)}). Reason: ${adj.reason}`, 'info-line');
                            }
                        } else if (adj.action === 'TIGHTEN_SL') {
                            // 2-candle entry cooldown: block SL tightening within the first
                            // 2 candles after entry to give the trade room to develop.
                            const tfMs = this.getTimeframeMs(this.currentTimeframe);
                            const msSinceEntry = Date.now() - (pos.openTime ?? 0);
                            if (msSinceEntry < tfMs * 2) {
                                this.addLog('SYSTEM', `⏳ [LLM SL GUARD] ${pos.symbol}: skipping TIGHTEN_SL — ${Math.ceil((tfMs * 2 - msSinceEntry) / 60000)}m remaining for 2-candle cooldown.`, 'info-line');
                            } else {
                                // Hard floor: SL must stay at least 0.6× entry ATR from entry price.
                                const refAtr = pos.entryAtr ?? Math.abs((pos.originalSl ?? pos.sl) - pos.entryPrice);
                                const minSlDist = refAtr * 0.6;

                                let slChanged = false;
                                if (adj.customSlPrice && adj.customSlPrice > 0) {
                                    if (pos.type === 'LONG') {
                                        const floorSl = pos.entryPrice - minSlDist;
                                        const clampedSl = Math.min(adj.customSlPrice, floorSl);
                                        if (clampedSl > pos.sl && clampedSl < currentPrice) {
                                            if (clampedSl < adj.customSlPrice) {
                                                this.addLog('SYSTEM', `🛡️ [LLM SL FLOOR] ${pos.symbol}: LLM suggested SL ${adj.customSlPrice.toFixed(2)}, clamped to ${clampedSl.toFixed(2)} (floor 0.6× ATR).`, 'info-line');
                                            }
                                            pos.sl = clampedSl;
                                            slChanged = true;
                                        }
                                    }
                                }
                                if (slChanged) {
                                    this.addLog('SYSTEM', `🧠 [LLM ADJ] Tightened SL of ${pos.symbol} to ${pos.sl.toLocaleString()}. Reason: ${adj.reason}`, 'info-line');
                                }
                            }
                        } else if (adj.action === 'EXTEND_TP') {
                            let tpChanged = false;
                            if (adj.customTpPrice && adj.customTpPrice > 0) {
                                if (pos.type === 'LONG' && adj.customTpPrice > pos.tp) {
                                    pos.tp = adj.customTpPrice;
                                    tpChanged = true;
                                } else if (pos.type === 'SHORT' && adj.customTpPrice < pos.tp) {
                                    pos.tp = adj.customTpPrice;
                                    tpChanged = true;
                                }
                            }
                            if (tpChanged) {
                                this.addLog('SYSTEM', `🧠 [LLM ADJ] Extended TP of ${pos.symbol} to ${pos.tp.toLocaleString()}. Reason: ${adj.reason}`, 'info-line');
                            }
                        }
                    }
                }

                // Update position tracking properties for evaluated positions of this pair
                this.openPositions.forEach(pos => {
                    if (pos.symbol === pair) {
                        pos.lastLlmCheckTime = Date.now();
                        pos.lastLlmCheckPrice = this.livePrices[pos.symbol] || pos.entryPrice;
                    }
                });
            } else {
                // ---- Rule-based fallback (original logic) ----
                if (vol >= 1.2) {
                    regime = 'MAX VOLATILITY ⚡';
                    optimalTimeframe = '1m';
                    optimalModel = 'logistic';
                    optimalGridMode = false;
                    reasoning = `ATR volatility reached peak level (${vol.toFixed(2)}% > 1.20%). Decision: Lock Grid mode, switch to AI Logistic Regression model on 1m timeframe for fast response and capital protection against candle wick sweeps.`;
                } else if (chop > 62 || (chop > 57 && trend < 15 && vol < 0.25)) {
                    regime = 'NARROW CONSOLIDATION 💤';
                    optimalTimeframe = '5m';
                    optimalModel = 'knn';
                    optimalGridMode = false;
                    reasoning = `Choppiness index high (${chop.toFixed(1)} > 62), low volatility (${vol.toFixed(2)}% < 0.25%). Decision: Use AI KNN model on 5m timeframe to identify repeating price patterns at micro support/resistance within consolidation zone.`;
                } else if (chop > 52 && chop <= 62 && trend < 35) {
                    regime = 'WIDE RANGE SIDEWAY ↕️';
                    optimalTimeframe = '5m';
                    optimalModel = 'knn';
                    optimalGridMode = false;
                    reasoning = `Market is range-bound (Chop = ${chop.toFixed(1)}, Trend = ${trend}). Decision: Disable Grid mode, switch to AI KNN model on 5m timeframe for highly sensitive repeating price pattern identification at micro support/resistance.`;
                } else {
                    regime = 'STRONG TREND 📈';
                    optimalTimeframe = '15m';
                    optimalModel = 'momentum';
                    optimalGridMode = false;
                    reasoning = `Strong trend detected (Chop = ${chop.toFixed(1)} < 52, Trend power = ${trend}). Decision: Disable Grid mode, switch to AI Momentum model on 15m timeframe to follow major trend via EMA200 filter.`;
                }
                // No LLM, conservative risk default.
                this.llmRiskMultiplier = 1.0;
                this.llmSlTightness = 1.0;
                this.llmTpExtension = 1.0;
                this.llmTrailingAggressiveness = 1.0;
            }

            // Regime confidence (0-100). When LLM produced the decision we use
            // its self-reported confidence; otherwise we compute from metric
            // distance to decision boundaries.
            let regimeConfidence = 50;
            if (decisionSource === 'LLM' && llmDecision) {
                regimeConfidence = Math.max(40, Math.min(97, Math.round(llmDecision.confidence || 60)));
            } else if (vol >= 1.2) {
                regimeConfidence = 60 + (vol - 1.2) * 80;
            } else if (chop > 62 || (chop > 57 && trend < 15 && vol < 0.25)) {
                regimeConfidence = 55 + (chop - 57) * 2.5;
            } else if (chop > 52 && chop <= 62 && trend < 35) {
                regimeConfidence = 55 + (10 - Math.abs(chop - 57)) * 2 + (35 - trend) * 0.4;
            } else {
                regimeConfidence = 55 + (52 - chop) * 1.5 + trend * 0.4;
            }
            regimeConfidence = Math.max(40, Math.min(97, Math.round(regimeConfidence)));

            // Update radar buffer for Web UI display
            this.quantOperatorMetrics = { choppiness: chop, volatility: vol, trendIntensity: trend, regimeConfidence };

            // Adaptive hysteresis: clear regimes switch fast, borderline ones wait.
            const requiredConfirmations = regimeConfidence >= 80 ? 1 : (regimeConfidence >= 62 ? 2 : 3);

            // Honor explicit ENSEMBLE pin from the user. The Quant Operator is
            // still free to flip timeframe / grid / regime, but it is NOT
            // allowed to silently swap the model away from what the user
            // selected. Without this, every 30-second tick would reset
            // modelType back to one of the three in-process models and the
            // UI would appear to "revert" on its own.
            // ENSEMBLE is a user-selected mode that the Quant Operator must
            // NOT silently override (online weighted vote across all 3 in-process models).
            const userPinnedEnsemble = this.modelType === 'ensemble';
            const userPinned = userPinnedEnsemble;

            // Hysteresis: Regime must be confirmed N consecutive times before switching
            const currentRegimeKey = `${optimalTimeframe}|${userPinned ? this.modelType : optimalModel}|${optimalGridMode}`;
            const activeRegimeKey = `${this.currentTimeframe}|${this.modelType}|${this.gridModeEnabled}`;

            const needsChange = currentRegimeKey !== activeRegimeKey;

            const sourceTag = decisionSource === 'LLM'
                ? `🤖 LLM (${this.llmProvider}/${this.llmModel || 'default'}, ${this.llmLastLatencyMs}ms)`
                : '🧠 RULE';
            this.quantOperatorThoughts.push({
                time: timeStr,
                message: `${sourceTag} [${pair}]: Choppiness = ${chop.toFixed(1)} | Volatility = ${vol.toFixed(2)}% | Trend Power = ${trend} | Regime Confidence = ${regimeConfidence}% | Risk x${this.llmRiskMultiplier.toFixed(2)}. Identified: ${regime}. ${reasoning}`,
                type: 'info'
            });

            if (needsChange) {
                // Keep the 30-minute regime change cooldown active even when forced for position adjustments
                const canSwapRegime = (Date.now() - this.quantOperatorLastSwapTime >= 1800000);
                if (!canSwapRegime) {
                    const minutesRemaining = Math.ceil((1800000 - (Date.now() - this.quantOperatorLastSwapTime)) / 60000);
                    this.quantOperatorThoughts.push({
                        time: timeStr,
                        message: `🔒 COOLDOWN REGIME: Detected need to switch regimes, but skipping due to 30-minute cooldown (${minutesRemaining}m remaining). Only processing position adjustments.`,
                        type: 'info'
                    });
                } else {
                    // Check hysteresis: must confirm same regime 2 consecutive times
                    if (this.pendingRegime === currentRegimeKey) {
                        this.pendingRegimeCount++;
                    } else {
                        this.pendingRegime = currentRegimeKey;
                        this.pendingRegimeCount = 1;
                    }

                    if (this.pendingRegimeCount < requiredConfirmations) {
                        this.quantOperatorThoughts.push({
                            time: timeStr,
                            message: `⏳ HYSTERESIS: Regime ${regime} (confidence ${regimeConfidence}%) detected ${this.pendingRegimeCount}/${requiredConfirmations} times. Need ${requiredConfirmations - this.pendingRegimeCount} more confirmations before switching.`,
                            type: 'info'
                        });
                    } else {
                        // Confirmed! Apply changes
                        this.pendingRegime = null;
                        this.pendingRegimeCount = 0;

                        const changesList: string[] = [];

                        if (optimalTimeframe !== this.currentTimeframe) {
                            changesList.push(`Timeframe: ${this.currentTimeframe} -> ${optimalTimeframe}`);
                            await this.changeTimeframe(optimalTimeframe);
                        }

                        if (optimalModel !== this.modelType && !userPinned) {
                            changesList.push(`AI Model: ${this.modelType.toUpperCase()} -> ${optimalModel.toUpperCase()}`);
                            this.modelType = optimalModel;
                            this.trainModel(optimalModel);
                        } else if (userPinned && optimalModel !== 'momentum') {
                            // Tell the user we noticed the regime would prefer a
                            // different model but we respect their pin.
                            this.quantOperatorThoughts.push({
                                time: timeStr,
                                message: `🔒 Keeping model ENSEMBLE based on user selection (regime suggested ${optimalModel.toUpperCase()}). Only adjusting timeframe/grid.`,
                                type: 'info'
                            });
                        }

                        if (optimalGridMode !== this.gridModeEnabled) {
                            changesList.push(`AI Smart Grid: ${this.gridModeEnabled ? 'ON' : 'OFF'} -> ${optimalGridMode ? 'ON' : 'OFF'}`);
                            this.gridModeEnabled = optimalGridMode;
                            if (!optimalGridMode) {
                                this.activePairs.forEach(p => {
                                    if (this.gridActiveMap[p]) {
                                        this.dismantleGrid(p, 'Quant Operator Regime Shift');
                                    }
                                });
                            }
                        }

                        if (changesList.length > 0) {
                            this.quantOperatorLastSwapTime = Date.now();
                            this.quantOperatorThoughts.push({
                                time: timeStr,
                                message: `⚡ DECISION: Automatically changed system configuration: [${changesList.join(' | ')}]. Starting new monitoring cycle (30-minute cooldown).`,
                                type: 'decision'
                            });
                            this.addLog('SYSTEM', `🧠 QUANT OPERATOR: Automatically adjusted configuration [${changesList.join(' | ')}] to match ${regime} state.`, 'buy-line');
                            // Phase 5: regime swaps reset the 30-min cooldown clock;
                            // persisting now preserves it across container restarts.
                            this.persistState();
                        }
                    }
                }
            } else {
                // Regime confirmed as current → reset pending
                this.pendingRegime = null;
                this.pendingRegimeCount = 0;
            }

            if (this.quantOperatorThoughts.length > 50) {
                this.quantOperatorThoughts.shift();
            }
        } finally {
            this.quantOperatorRunningPairs.delete(pair);
        }
    }

    public async syncLiveBinanceState(force = false) {
        const now = Date.now();
        const minInterval = this.liveTradingMode === 'bsc_twak' ? 15000 : this.binanceSyncMinIntervalMs;
        if (!force && (now - this.lastBinanceSyncTs < minInterval)) {
            return;
        }
        if (this.binanceSyncInProgress) return;
        this.binanceSyncInProgress = true;
        this.lastBinanceSyncTs = now;

        try {
            // ── BSC / TWAK portfolio sync ────────────────────────────────────────
            if (this.liveTradingMode === 'bsc_twak') {
                const twak = this.getTWAKClient();
                if (!twak) return;
                try {
                    const portfolio = await twak.getPortfolio();

                    // Recover missing open positions or self-heal active pairs directly from chain to bypass indexer lag
                    for (const pair of this.activePairs) {
                        const tokenSym = pair.endsWith('USDT') ? pair.slice(0, -4) : pair;
                        if (tokenSym === 'USDT' || tokenSym === 'BNB') continue;

                        const hasAsset = portfolio.some(a => a.symbol.toUpperCase() === tokenSym.toUpperCase());
                        if (!hasAsset) {
                            const isOpen = this.openPositions.some(p => p.symbol === pair);
                            const lastCheck = this.lastDirectCheckTimeMap[pair] || 0;
                            const timeSinceLastCheck = Date.now() - lastCheck;

                            // Cooldown logic:
                            // - Open positions: re-check every 30s (not every tick, to avoid RPC spam)
                            // - Other active pairs: check once every 2 minutes for self-healing
                            // - Tokens with repeated NETWORK_ERRORs: exponential backoff up to 10 min
                            const failCount = this.syncFailCounts?.[pair] ?? 0;
                            const backoffMs = Math.min(failCount * 60_000, 600_000); // up to 10 min
                            const cooldownMs = isOpen ? Math.max(30_000, backoffMs) : Math.max(120_000, backoffMs);

                            if (timeSinceLastCheck > cooldownMs) {
                                this.lastDirectCheckTimeMap[pair] = Date.now();
                                try {
                                    const directBal = await twak.getTokenBalance(tokenSym);
                                    // Reset failure count on success
                                    if (this.syncFailCounts) this.syncFailCounts[pair] = 0;
                                    if (directBal.balance > 0) {
                                        portfolio.push({
                                            symbol: tokenSym,
                                            balance: directBal.balance,
                                            usdValue: directBal.usdValue,
                                            chain: 'bsc'
                                        });
                                        this.addLog('SYSTEM', `🔍 [TWAK Sync] Recovered missing token ${tokenSym} balance from direct query: ${directBal.balance}`, 'info-line');
                                    }
                                } catch (e: any) {
                                    // Increment failure backoff counter
                                    if (!this.syncFailCounts) this.syncFailCounts = {};
                                    this.syncFailCounts[pair] = failCount + 1;
                                    // Only log every 5 failures to avoid spam
                                    if ((failCount + 1) % 5 === 1) {
                                        this.addLog('SYSTEM', `⚠️ [TWAK Sync] ${tokenSym} balance query failed (attempt ${failCount + 1}), backoff ${Math.round(cooldownMs / 1000)}s: ${e.message?.split('\n')[0]}`, 'warning-line');
                                    }
                                }
                            }
                        }
                    }

                    const automates = await twak.listAutomates().catch(() => []);

                    const usdt = portfolio.find(a => a.symbol?.toUpperCase() === 'USDT');
                    const usdtBal = usdt?.usdValue ?? usdt?.balance ?? 0;
                    const totalUsd = portfolio.reduce((sum, a) => sum + (a.usdValue || 0), 0);
                    this.balance = usdtBal;
                    this.marginFree = usdtBal;
                    if (isCompetitionActive()) {
                        updatePortfolioPeak(totalUsd);
                    }

                    // On-chain Position Sync
                    const updatedPositions: Position[] = [];

                    for (const asset of portfolio) {
                        const tokenSym = asset.symbol.toUpperCase();
                        if (tokenSym === 'USDT') continue;

                        // Check if in 149 eligible list
                        if (!ELIGIBLE_BSC_TOKENS.has(tokenSym)) {
                            continue;
                        }

                        const pairSymbol = tokenSym + 'USDT';

                        // Only load pairs currently present in active configuration (ignore trash coins)
                        if (!this.activePairs.includes(pairSymbol)) {
                            continue;
                        }

                        const currentPrice = this.livePrices[pairSymbol] || this.livePrice || 0;
                        const assetUsdValue = asset.usdValue > 0 ? asset.usdValue : asset.balance * (currentPrice > 0 ? currentPrice : 1);

                        // Ignore BNB gas reserve (balance <= 0.005 BNB)
                        if (tokenSym === 'BNB' && asset.balance <= 0.005) {
                            continue;
                        }

                        // Ignore dust positions (balance < 0.50 USD)
                        if (assetUsdValue <= 0.50) {
                            continue;
                        }

                        // See if there's an existing position in memory for this symbol
                        const existingPos = this.openPositions.find(p => p.symbol === pairSymbol);

                        // Determine SL and TP from on-chain automations if available
                        let sl = existingPos ? existingPos.sl : 0;
                        let tp = existingPos ? existingPos.tp : 0;
                        let slOrderId = existingPos ? existingPos.slOrderId : undefined;

                        // Parse automates for this token
                        const tokenAutomates = automates.filter(
                            a => a.fromSymbol.toUpperCase() === tokenSym || 
                                 a.fromSymbol.toUpperCase() === pairToBscToken(pairSymbol).toUpperCase()
                        );

                        const slAutomate = tokenAutomates.find(a => a.condition === 'below');
                        const tpAutomate = tokenAutomates.find(a => a.condition === 'above');

                        if (slAutomate) {
                            sl = slAutomate.price;
                            if (!slOrderId || !slOrderId.includes(slAutomate.id)) {
                                slOrderId = slOrderId ? `${slOrderId}|sl_${slAutomate.id}` : `sl_${slAutomate.id}`;
                            }
                        }
                        if (tpAutomate) {
                            tp = tpAutomate.price;
                            if (!slOrderId || !slOrderId.includes(tpAutomate.id)) {
                                slOrderId = slOrderId ? `${slOrderId}|tp_${tpAutomate.id}` : `tp_${tpAutomate.id}`;
                            }
                        }

                        // Determine real entryPrice and openTime
                        let entryPrice = existingPos ? existingPos.entryPrice : 0;
                        let openTime = existingPos ? existingPos.openTime : 0;

                        if (existingPos && (!openTime || openTime > Date.now())) {
                            const cached = this.tokenEntryPrices[pairSymbol];
                            openTime = cached?.openTime && cached.openTime <= Date.now()
                                ? cached.openTime
                                : Date.now();
                        }

                        if (!existingPos) {
                            const cached = this.tokenEntryPrices[pairSymbol];
                            if (cached && cached.entryPrice > 0) {
                                entryPrice = cached.entryPrice;
                                openTime = cached.openTime;
                            } else {
                                try {
                                    const entryData = await twak.getTokenEntryFromHistory(tokenSym);
                                    if (entryData) {
                                        entryPrice = entryData.entryPrice > 0 ? entryData.entryPrice : (currentPrice > 0 ? currentPrice : (asset.balance > 0 ? assetUsdValue / asset.balance : 0));
                                        openTime = entryData.entryTime;
                                        this.tokenEntryPrices[pairSymbol] = { entryPrice, openTime };
                                    }
                                } catch (err: any) {
                                    this.addLog('SYSTEM', `⚠️ [TWAK] Failed to query entry details for ${tokenSym}: ${err?.message || err}`, 'warning-line');
                                }
                            }
                        }

                        // Fallback values if still unresolved
                        if (entryPrice === 0) {
                            entryPrice = currentPrice > 0 ? currentPrice : (asset.balance > 0 ? assetUsdValue / asset.balance : 0);
                        }
                        if (openTime === 0) {
                            openTime = Date.now();
                        }

                        // Fallback SL/TP if not set (neither in existingPos nor in automates)
                        if (sl === 0 || tp === 0) {
                            const refPrice = entryPrice; // Use historical entry price as the reference!
                            if (refPrice > 0) {
                                const slPct = parseFloat(process.env.SL_ATR ?? '3.0') / 100;
                                const tpPct = parseFloat(process.env.TP_ATR ?? '6.0') / 100;
                                if (sl === 0) sl = refPrice * (1 - slPct);
                                if (tp === 0) tp = refPrice * (1 + tpPct);
                            }
                        }

                        // Construct the position
                        const pos: Position = {
                            symbol: pairSymbol,
                            type: 'LONG',
                            leverage: 1,
                            size: asset.balance,
                            entryPrice,
                            margin: assetUsdValue,
                            liqPrice: 0,
                            sl,
                            tp,
                            pnl: existingPos ? existingPos.pnl : 0,
                            pnlPercent: existingPos ? existingPos.pnlPercent : 0,
                            partialClosed: existingPos ? existingPos.partialClosed : false,
                            binanceOrderId: existingPos ? existingPos.binanceOrderId : undefined,
                            slOrderId,
                            openTime,
                            feesPaid: existingPos ? existingPos.feesPaid : 0,
                            modelType: existingPos ? existingPos.modelType : this.modelType,
                            originalSl: existingPos ? existingPos.originalSl : sl,
                            trailingTier: existingPos ? existingPos.trailingTier : 0,
                            binanceSlSynced: existingPos ? existingPos.binanceSlSynced : (slOrderId != null),
                            entryAtr: existingPos ? existingPos.entryAtr : undefined,
                            dcaStep: existingPos ? existingPos.dcaStep : undefined,
                            dcaMaxSteps: existingPos ? existingPos.dcaMaxSteps : undefined,
                            dcaTotalMargin: existingPos ? existingPos.dcaTotalMargin : undefined,
                            dcaPriceDropPct: existingPos ? existingPos.dcaPriceDropPct : undefined,
                            dcaLastFillPrice: existingPos?.dcaLastFillPrice ?? entryPrice,
                            lastLlmCheckTime: existingPos?.lastLlmCheckTime && existingPos.lastLlmCheckTime <= Date.now()
                                ? existingPos.lastLlmCheckTime
                                : Date.now(),
                            lastLlmCheckPrice: existingPos?.lastLlmCheckPrice ?? entryPrice,
                        };

                        if (this.dcaEnabled) {
                            this.initializeDcaForPosition(pos, 'Initialized from on-chain sync');
                        }

                        // Update live PnL right away
                        if (currentPrice > 0) {
                            pos.pnl = pos.size * (currentPrice - pos.entryPrice);
                            pos.pnlPercent = (pos.pnl / pos.margin) * 100;
                        }

                        updatedPositions.push(pos);
                    }

                    // Replace openPositions with the updated list from the chain
                    const oldSymbols = this.openPositions.map(p => p.symbol);
                    const newSymbols = updatedPositions.map(p => p.symbol);

                    const added = newSymbols.filter(s => !oldSymbols.includes(s));
                    const removed = oldSymbols.filter(s => !newSymbols.includes(s));

                    if (added.length > 0) {
                        this.addLog('SYSTEM', `📥 Synced open positions: imported ${added.join(', ')}`, 'info-line');
                    }
                    if (removed.length > 0) {
                        this.addLog('SYSTEM', `📤 Synced open positions: removed ${removed.join(', ')}`, 'info-line');
                    }

                    this.openPositions = updatedPositions;
                    this.recomputeLedger();
                } catch (err: any) {
                    this.addLog('SYSTEM', `⚠️ [TWAK] Failed to sync on-chain balance: ${err?.message || err}`, 'warning-line');
                }
                return;
            }
        } finally {
            this.binanceSyncInProgress = false;
        }
    }

    private recomputeLedger() {
        let marginSum = 0;
        this.openPositions.forEach(p => marginSum += p.margin);
        this.activePairs.forEach(pair => {
            if (this.gridActiveMap[pair]) {
                this.gridOrdersMap[pair].forEach(o => {
                    if (o.status === 'FILLED') {
                        marginSum += o.margin;
                    }
                });
            }
        });
        this.marginUsed = marginSum;
        this.marginFree = this.balance;
    }

    public getFullState() {
        let totalUnrealized = 0;
        this.openPositions.forEach(p => totalUnrealized += p.pnl);

        let gridUnrealizedSum = 0;
        this.activePairs.forEach(pair => {
            if (this.gridActiveMap[pair]) {
                this.gridOrdersMap[pair].forEach(o => {
                    if (o.status === 'FILLED') {
                        gridUnrealizedSum += o.pnl;
                    }
                });
            }
        });
        totalUnrealized += gridUnrealizedSum;

        return {
            currentPair: this.currentPair,
            currentTimeframe: this.currentTimeframe,

            // Expose the multi-pair structures
            activePairs: this.activePairs,
            livePrices: this.livePrices,
            priceChanges24h: this.priceChanges24h,
            volumes24h: this.volumes24h,

            // compatibility fields
            livePrice: this.livePrice,
            priceChange24h: this.priceChange24h,
            volume24h: this.volume24h,

            aiBrainTrained: this.aiBrainTrained,
            modelType: this.modelType,
            botRunning: this.botRunning,
            confidenceThreshold: this.confidenceThreshold,
            leverage: this.leverage,
            riskRatio: this.riskRatio,
            orderSizeMultiplier: this.orderSizeMultiplier,
            minOrderSize: this.minOrderSize,
            tpAtrMultiplier: this.tpAtrMultiplier,
            slAtrMultiplier: this.slAtrMultiplier,
            smartOrderAdjustment: this.smartOrderAdjustment,
            riskReduction30ToEntry: this.riskReduction30ToEntry,
            trailingTpMultiplier: this.trailingTpMultiplier,
            trailingTpActivation: this.trailingTpActivation,
            atrSpikeThreshold: this.atrSpikeThreshold,
            volSpikeThreshold: this.volSpikeThreshold,
            initialCapital: this.initialCapital,

            liveTradingMode: this.liveTradingMode,
            binanceApiKey: this.binanceApiKey ? this.binanceApiKey.slice(0, 6) + '...' + this.binanceApiKey.slice(-4) : '',
            binanceApiSecret: this.binanceApiSecret ? '********************' : '',
            twakAgentWallet: this.twakAgentWallet || '',
            twakConfigured: !!(this.twakWalletPassword || this.twakAgentWallet),
            competitionStats: isCompetitionActive()
                ? getCompetitionStats(this.balance + this.marginUsed)
                : null,

            // AI Smart Grid Strategy state maps
            gridModeEnabled: this.gridModeEnabled,
            dcaEnabled: this.dcaEnabled,
            dcaMaxSteps: this.dcaMaxSteps,
            dcaPriceDropPct: this.dcaPriceDropPct,
            dcaCapitalAllocation: this.dcaCapitalAllocation,
            quantOperatorEnabled: this.quantOperatorEnabled,
            quantOperatorThoughts: this.quantOperatorThoughts,
            quantOperatorMetrics: this.quantOperatorMetrics,
            // LLM brain status (Phase 1). API key is masked, like Binance keys.
            llmProvider: this.llmProvider,
            llmModel: this.llmModel,
            llmApiKey: this.llmApiKey ? this.llmApiKey.slice(0, 4) + '...' + this.llmApiKey.slice(-4) : '',
            llmRiskMultiplier: this.llmRiskMultiplier,
            llmSlTightness: this.llmSlTightness,
            llmTpExtension: this.llmTpExtension,
            llmTrailingAggressiveness: this.llmTrailingAggressiveness,
            llmLastLatencyMs: this.llmLastLatencyMs,
            llmLastDecision: this.llmLastDecision,
            gridActiveMap: this.gridActiveMap,
            gridOrdersMap: this.gridOrdersMap,
            gridCenterPrices: this.gridCenterPrices,
            gridUpperBoundaries: this.gridUpperBoundaries,
            gridLowerBoundaries: this.gridLowerBoundaries,

            // compatibility fields for focused asset
            gridActive: this.gridActive,
            gridOrders: this.gridOrders,
            gridCenterPrice: this.gridCenterPrice,
            gridUpperBoundary: this.gridUpperBoundary,
            gridLowerBoundary: this.gridLowerBoundary,

            balance: this.balance + this.marginUsed + gridUnrealizedSum, // total simulated equity including grid unrealized PnL
            walletBalance: this.balance, // wallet balance (excluding margin)
            marginUsed: this.marginUsed,
            marginFree: this.marginFree,
            totalUnrealizedPnl: totalUnrealized,
            // Honest cost transparency (Phase 0):
            // `totalFeesPaid` = cumulative taker fees + funding paid since boot.
            // `netUnrealizedPnl` already reflects per-trade fees inside pos.pnl;
            // we additionally expose pending funding on open positions so the UI
            // can show "what if I closed everything now" net figures.
            totalFeesPaid: this.totalFeesPaid,
            takerFeeRate: this.takerFeeRate,
            slippageBps: this.slippageBps,
            fundingRateHourly: 0,

            dailyPnL: this.dailyPnL,
            maxDailyDrawdown: this.maxDailyDrawdown,
            maxDailyDrawdownLimitUsd: this.getMaxDailyLossLimitUsd(),
            currentDrawdownFromPeak: this.getCurrentDrawdownFromPeak(),
            hoursRemainingInDay: computeHoursRemainingInDay(),

            // Phase 5: persistence status for ops visibility.
            persistence: getPersistenceInfo(),

            openPositions: this.openPositions,
            tradeHistory: this.tradeHistory,
            orderHistory: this.orderHistory,
            logs: this.logs,
            historicalCandles: this.historicalCandles
        };
    }
}

// Global Singleton initialization to avoid Next.js dev server multiple instance hot-reload duplicates
declare global {
    var botEngine: BotEngine | undefined;
}

export const getBotEngine = (): BotEngine => {
    if (!global.botEngine) {
        global.botEngine = new BotEngine();
    }
    return global.botEngine;
};
