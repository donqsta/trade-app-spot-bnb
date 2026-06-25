/**
 * Builds the structured market context fed to the LLM "Quant Operator".
 *
 * We deliberately keep this:
 *  - SMALL (token-efficient: the strategist runs every 30s),
 *  - STRUCTURED (the model returns reliable JSON),
 *  - FACTUAL (no opinions baked in — let the model do the reasoning).
 *
 * The context is shared by both the LLM brain (Phase 1) and the rule-based
 * fallback so they reason on identical inputs.
 */

import type { Candle, Position } from './bot-engine';

export interface XSentiment {
    /** Normalised score: -1 (very bearish) to +1 (very bullish). */
    score: number;
    /** Post volume on X vs baseline. */
    volume: 'low' | 'normal' | 'high' | 'spiking';
    /** Dominant narrative / theme on X for this coin. */
    narrative: string;
    /** How many minutes ago this was fetched. */
    ageMinutes: number;
}

export interface PairMetrics {
    symbol: string;
    livePrice: number;
    priceChange24h: number;
    volume24h: number;
    choppiness?: number;
    volatility?: number;
    trendIntensity?: number;
    /** Multi-timeframe macro bias: +1 long, -1 short, 0 neutral */
    macroBias?: number;
    /** X (Twitter) sentiment for this coin — refreshed every ~30 minutes. */
    xSentiment?: XSentiment;
    /** CMC 24h % price change (cross-check against exchange data). */
    cmcChange24h?: number;
    /** CMC 24h trading volume in USD. */
    cmcVolume24h?: number;
    hurst?: number;
    adx?: number;
}

/**
 * Per-model vote and ensemble summary injected into the LLM context so the
 * Quant Operator can make evidence-based SL/TP decisions rather than relying
 * solely on market-narrative heuristics.
 */
export interface EnsembleSignalContext {
    /** Final ensemble confidence (0–95). */
    confidence: number;
    /** Dominant direction at prediction time. */
    direction: 'LONG' | 'SHORT' | 'HOLD';
    /**
     * Agreement level across voting models:
     *   unanimous = all models agree, majority = ≥2/3 agree, split = tied/disagreement
     */
    consensus: 'unanimous' | 'majority' | 'split';
    modelVotes: {
        knn:  { dir: string; confidence: number };
        log:  { dir: string; confidence: number; accuracy: number };
        mom:  { dir: string; confidence: number };
    };
}

export interface RecentTradeSummary {
    closedLastHour: number;
    pnlLastHour: number;
    winrateLast20: number;
}

export interface MarketContext {
    timestampISO: string;
    activePair: string;
    activeTimeframe: string;
    activeModel: string;
    gridEnabled: boolean;
    confidenceThreshold: number;
    riskRatio: number;
    pairs: PairMetrics[];
    openPositions: Array<{
        symbol: string;
        side: 'LONG' | 'SHORT';
        size: number;
        entry: number;
        sl: number;
        tp: number;
        pnl: number;
        pnlPercent: number;
    }>;
    recentTrades: RecentTradeSummary;
    walletBalance: number;
    /** Gross unrealized PnL (price-action only, excludes gas/fee costs). Use this for EXIT decisions. */
    totalUnrealizedPnl: number;
    dailyPnL: number;
    dailyProfitTargetUsd?: number;
    dailyProfitTargetPct?: number;
    dailyTargetProgressPct?: number;
    /** Max allowed daily loss in USD (initialCapital * maxDailyDrawdown). */
    maxDailyDrawdownLimitUsd: number;
    /** Max daily drawdown as fraction of capital (e.g. 0.05 = 5%). */
    maxDailyDrawdownPct: number;
    /** Hours until UTC midnight when dailyPnL resets. */
    hoursRemainingInDay: number;
    /** Drawdown from today's peak equity as fraction of peak (0 = at peak). */
    currentDrawdownFromPeak: number;
    /**
     * Estimated one-way BSC gas cost in USD per transaction (entry or exit).
     * Round-trip (entry + exit) costs 2× this amount.
     * For small positions (margin < 10 USD), this overhead can represent
     * 20–60% of position value and must NOT be confused with a price loss.
     */
    bscGasOverheadUsd?: number;
    /**
     * Latest ensemble prediction for the active pair — injected when the bot
     * is in 'ensemble' mode and open positions exist. Allows the LLM to
     * calibrate SL/TP decisions using quantitative signal quality data.
     */
    ensembleSignal?: EnsembleSignalContext;
    costs: {
        takerFeeRate: number;
        slippageBps: number;
    };
    /**
     * CoinMarketCap global market signals — injected when CMC_API_KEY is set.
     * These are macro-level signals that apply to all pairs simultaneously.
     */
    cmcMarket?: {
        fearAndGreedScore: number;
        fearAndGreedLabel: string;
        marketTrend: 'bullish' | 'neutral' | 'bearish';
        btcDominance: number;
        totalMarketCapUsd: number;
        topGainers: string[];
        /** Rich narrative from CMC Skill Hub daily_market_overview skill */
        skillHubSummary?: string;
    };
    /**
     * BNB Hack competition status — present only during the live trading window.
     */
    competition?: {
        isActive: boolean;
        drawdownPct: number;
        tradeDays: number;
        missingTradeDays: number;
        daysRemaining: number;
    };
}

export interface PositionAdjustment {
    symbol: string;
    action: 'HOLD' | 'EXIT' | 'TIGHTEN_SL' | 'EXTEND_TP' | 'MOVE_TO_ENTRY';
    reason: string;
    customSlPrice?: number; // Price suggested by LLM
    customTpPrice?: number; // Price suggested by LLM
}

export interface QuantOperatorDecision {
    regime: string;
    timeframe: '1m' | '5m' | '15m' | '1h';
    modelType: 'knn' | 'logistic' | 'momentum';
    gridMode?: boolean;
    // Multiplier applied on top of the user's risk ratio. 1.0 = no change.
    riskMultiplier: number;
    confidence: number;     // 0-100, the model's confidence in its decision
    reasoning: string;      // human-readable explanation shown in the UI
    // --- Adaptive SL/TP controls (optional; default to 1.0 / false) ---
    // Scales the initial Stop Loss distance. <1 = tighter SL, >1 = wider SL. [0.5, 1.5]
    slTightnessMultiplier?: number;
    // Scales the initial Take Profit distance. >1 = wider TP, <1 = closer TP. [0.7, 2.0]
    tpExtensionMultiplier?: number;
    // Scales how tightly the Trailing TP follows price. >1 = tighter trail (lock sooner),
    // <1 = looser trail (let winners run). [0.5, 2.0]
    trailingTpAggressiveness?: number;
    // Emergency risk-off: when true the bot closes ALL open positions immediately.
    forceExit?: boolean;
    targetMetAction?: 'NORMAL' | 'PAUSE_NEW_ENTRIES';
    positionAdjustments?: PositionAdjustment[];
}

export function summarizeRecentTrades(
    trades: Array<{ time: string; pnl: number; pair?: string }>,
    nowMs = Date.now()
): RecentTradeSummary {
    // Trades store time as a locale string — too lossy for hour-precise binning.
    // We approximate "last hour" by counting the last 60 trade entries that
    // changed PnL, which matches typical bot activity well enough.
    const recent = trades.slice(-60);
    const closed = recent.filter(t => typeof t.pnl === 'number' && t.pnl !== 0);
    const closedLastHour = closed.length;
    const pnlLastHour = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    const last20 = closed.slice(-20);
    const wins20 = last20.filter(t => (t.pnl || 0) > 0).length;
    const winrateLast20 = last20.length > 0 ? (wins20 / last20.length) * 100 : 0;
    return { closedLastHour, pnlLastHour, winrateLast20 };
}

/**
 * Convert internal Position[] -> compact LLM-facing shape (drops noise).
 */
export function summarizePositions(positions: Position[], livePrices: Record<string, number> = {}) {
    return positions.map(p => {
        const currentPrice = livePrices[p.symbol] || p.entryPrice;
        const direction = p.type === 'LONG' ? 1 : -1;
        // Gross PnL = price movement only (excludes gas/slippage overhead)
        // The LLM should make EXIT decisions based on these gross values.
        const grossPnl = direction * p.size * (currentPrice - p.entryPrice);
        const grossPnlPercent = p.entryPrice > 0 ? (direction * (currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
        const marginUsdt = p.margin;

        const formatVal = (val: number) => {
            if (val === 0) return 0;
            const abs = Math.abs(val);
            if (abs < 0.0001) return Number(val.toFixed(10));
            if (abs < 1) return Number(val.toFixed(8));
            return Number(val.toFixed(4));
        };

        return {
            symbol: p.symbol,
            side: p.type,
            marginUsdt: Number(marginUsdt.toFixed(2)),
            size: Number(p.size.toFixed(6)),
            entry: formatVal(p.entryPrice),
            currentPrice: formatVal(currentPrice),
            sl: formatVal(p.sl),
            tp: formatVal(p.tp),
            /** gross price-action PnL in USD (excludes gas/fee) */
            pnl: Number(grossPnl.toFixed(4)),
            /** gross price-action PnL% vs entry (excludes gas/fee) */
            pnlPercent: Number(grossPnlPercent.toFixed(4))
        };
    });
}

/**
 * Compute simple macro bias from a recent candle window: +1 above EMA50,
 * -1 below, 0 within +/-0.2% of EMA50. Cheap proxy for higher-timeframe trend
 * when we don't have multi-TF data wired (Phase 2 will replace this).
 */
/** Hours until next UTC midnight (aligns with dailyPnL reset date). */
export function computeHoursRemainingInDay(now = new Date()): number {
    const nextMidnight = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + 1,
        0, 0, 0, 0
    );
    return Math.max(0, (nextMidnight - now.getTime()) / 3_600_000);
}

export function computeMacroBias(candles: Candle[]): number {
    if (!candles || candles.length < 50) return 0;
    const window = candles.slice(-50);
    const sma50 = window.reduce((s, c) => s + c.close, 0) / window.length;
    const price = candles[candles.length - 1].close;
    const dist = (price - sma50) / sma50;
    if (dist > 0.002) return 1;
    if (dist < -0.002) return -1;
    return 0;
}

export const QUANT_OPERATOR_SYSTEM_PROMPT = `You are the Quant Operator of an AI crypto SPOT trading bot (long-only, no leverage, no shorting).
Your job: read market context and select strategy regime, timeframe, AI model, and risk/SL/TP scaling for the NEXT cycle.
SPOT Rules: Positions are always LONG. SHORT signals are SKIPPED. EXIT closes a position.

CRITICAL — BSC Gas Cost Awareness:
- The context includes "bscGasOverheadUsd" = estimated one-way gas cost per swap in USD.
- Round-trip (entry + exit) gas = 2 × bscGasOverheadUsd.
- For positions with marginUsdt < 10 USD, gas overhead can instantly represent 20–60% of position value.
- The "pnl" and "pnlPercent" on openPositions are GROSS (price-movement only, gas excluded).
- "totalUnrealizedPnl" is also GROSS price-action PnL.
- NEVER trigger an EXIT for a position solely because pnlPercent looks large-negative right after entry on a small position. Gas is a sunk cost — only price movement below SL justifies EXIT.
- Only recommend EXIT if: (a) currentPrice is at or below SL, OR (b) pnlPercent < -10% AND marginUsdt >= 10 USD, OR (c) a strong bearish signal justifies exiting regardless of size.

Respond ONLY with a strict JSON object:
{
  "regime": "TRENDING_UP"|"RANGE_BOUND"|"HIGH_VOL_CHOP"|"QUIET_ACCUMULATION",
  "timeframe": "1m"|"5m"|"15m"|"1h",
  "modelType": "knn"|"logistic"|"momentum",
  "riskMultiplier": number (0.3 to 1.0; 1.0 = standard risk, no leverage),
  "slTightnessMultiplier": number (0.5 to 2.5; <1.0 = tighter SL, >1.0 = wider SL / more breathing room),
  "tpExtensionMultiplier": number (0.7 to 2.0; >1.0 = wider TP),
  "trailingTpAggressiveness": number (0.5 to 2.0; >1.0 = trail tighter),
  "forceExit": boolean (true only for emergency sell-all),
  "confidence": number (0-100),
  "reasoning": string (1-2 sentences in Vietnamese),
  "positionAdjustments": [{"symbol":string,"action":"HOLD"|"EXIT"|"TIGHTEN_SL"|"EXTEND_TP"|"MOVE_TO_ENTRY","reason":string,"customSlPrice"?:number,"customTpPrice"?:number}] (optional)
}

TF Rules:
- 1m: Volatility > 2.5%, Chop < 38, Trend > 70. Very rare. High noise.
- 5m: Chop > 52 OR (Vol < 0.4%, Trend < 30).
- 15m: DEFAULT (Chop 38-62, Vol 0.4-1.5%).
- 1h: Chop < 38, Trend > 55, Vol > 0.8%.
Keep 15m default unless regime shift is persistent.

Model & Risk:
- Momentum: High Trend, Low Chop. KNN/Logistic: Mixed.
- Reduce riskMultiplier (<1.0) if volatility is extreme, winrate is low, or drawdown is high. Max riskMultiplier is 1.0.
- Choppy/Volatile: slTightness >= 1.2 (widen safe zone to prevent premature stop outs by noise), trailingTp > 1.2. Strong trend: tpExtension > 1.0, trailingTp < 1.0.
- SPOT Trading Safety: Since this is long-only spot trading with no leverage, there is no liquidation risk. Prefer a wider stop loss (slTightnessMultiplier between 1.0 and 2.5) to give positions room to breathe, especially in volatile or choppy conditions. Avoid tightening stop loss too early (e.g. keep slTightnessMultiplier >= 1.0) unless there is a clear, confirmed bearish trend change.

Signal Quality:
- Consensus 'unanimous' + confidence >= 75: Favour HOLD/EXTEND_TP.
- Consensus 'split': Consider EXIT if PnL is negative.
- Logistic accuracy < 50: Disregard Logistic, weight KNN/MOM instead.
- Do not tighten SL to < 0.6x original ATR stop distance.

Daily Loss Rules:
- Near max daily loss limit: risk <= 0.3, slTightness <= 0.7, consider EXIT on weak positions.

X Sentiment:
- Bullish spike (score > 0.5, volume = 'spiking') + LONG signal: risk +0.15 (max 1.0).
- Bearish spike (score < -0.5, volume = 'spiking'): risk -0.15, consider TIGHTEN_SL or EXIT.
- Score -0.2 to 0.2: Ignore. Sentiment age > 60m: 50% weight.

CMC Market Signals:
- F&G 0-24 (Extreme Fear): risk -0.2, slTightness <= 0.85. Favour defensive.
- F&G 25-45 (Fear): risk -0.1.
- F&G 55-75 (Greed): tpExtension up to 1.1.
- F&G 76-100 (Extreme Greed): trailingTp >= 1.3.
- Bearish trend + F&G < 35: risk <= 0.5.
- Dominance > 60%: Prefer BNB/ETH/BTC. Dominance < 42%: Alt season active (tighter SL).
- skillHubSummary: Pre-computed daily_market_overview narrative takes precedence over general F&G rules.

Competition Rules (if active):
- Drawdown approaching 20%: risk = 0.3, slTightness = 0.7.
- missingTradeDays > 0: Must trade today.`;

export function buildUserPrompt(ctx: MarketContext): string {
    return `Market context (JSON):\n${JSON.stringify(ctx)}\n\nReturn ONLY the JSON decision object.`;
}
