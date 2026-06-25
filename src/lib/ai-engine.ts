/**
 * AI-QuantBot Terminal - AI Engine & Technical Indicators (TypeScript Server-Side)
 * This handles quantitative indicators and machine learning strategies on Node.js.
 */

export interface FeaturePoint {
    index: number;
    price: number;
    atr: number;
    // 10 base features when called without context. 15 features when called
    // with a ContextSeries — see ai-engine.ts:extractFeatures for the schema.
    features: number[];
}

/**
 * Optional time-aligned alpha context. Each array must have the SAME length
 * as the candle close series passed into extractFeatures. Index `i` of every
 * field corresponds to candle `i`.
 *
 * When provided, extractFeatures appends 5 extra features in this order:
 *   f_funding, f_oi_delta_1h, f_htf_bias, f_vol_regime, f_btc_corr
 */
export interface FeatureContextSeries {
    funding: number[];      // raw funding rate (Binance scale, e.g. 0.0001 = 0.01%/8h)
    oiDelta1h: number[];    // OI % change last 1h
    htfBias: number[];      // -1 / 0 / +1
    volRegime: number[];    // ATR1h / ATR24h ratio
    btcCorr: number[];      // -1 .. +1 rolling correlation with BTC
}

export interface LabeledDataPoint {
    features: number[];
    label: number; // 1: Long, -1: Short, 0: Hold
    price: number;
    weight?: number; // T3.2 — time-decay sample weight (default 1.0)
    chop?: number;   // T3.3 — choppiness index for regime classification
    index?: number;
}

/**
 * Build exponential time-decay weights for a training set.
 * Most recent sample weight = 1.0; samples older than `halfLifeFraction` of
 * the total length get weight 0.5; the very oldest sample's weight is
 * ~exp(-ln(2)/halfLifeFraction).
 *
 * Caller is expected to feed this back through labelDataset / trainXxx so
 * recent regimes dominate gradient updates (Logistic) and neighbor votes
 * (KNN), making the model adapt faster to regime shifts.
 */
export function computeTimeDecayWeights(n: number, halfLifeFraction = 0.5): number[] {
    if (n <= 0) return [];
    const halfLifeN = Math.max(1, n * halfLifeFraction);
    const decay = Math.log(2) / halfLifeN;
    const out: number[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const age = n - 1 - i; // 0 for most recent, n-1 for oldest
        out[i] = Math.exp(-decay * age);
    }
    return out;
}

export interface LogisticRegressionModel {
    weightsLong: number[];
    biasLong: number;
    weightsShort: number[];
    biasShort: number;

    // Regime-specific weights
    weightsLongTrending: number[];
    biasLongTrending: number;
    weightsShortTrending: number[];
    biasShortTrending: number;

    weightsLongSideway: number[];
    biasLongSideway: number;
    weightsShortSideway: number[];
    biasShortSideway: number;

    /** Per-feature mean from training set — required for z-score at predict time. */
    featureMeans: number[];
    /** Per-feature std dev from training set (with epsilon). */
    featureStdDevs: number[];
}

export interface MetaModel {
    weights: number[];
    bias: number;
    featureMeans: number[];
    featureStdDevs: number[];
}

export interface PredictionResult {
    signal: number; // 1: Long, -1: Short, 0: Hold
    confidence: number; // percentage
}

/** Clip a number to [lo, hi] — used to keep ML features in a sane range. */
function clipped(v: number, lo: number, hi: number): number {
    if (!Number.isFinite(v)) return 0;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

/** Z-score stats from a labeled training set (same approach as KNN predict). */
function computeFeatureNormalization(data: LabeledDataPoint[]): { means: number[]; stdDevs: number[] } {
    const n = data[0].features.length;
    const means = new Array(n).fill(0);
    const stdDevs = new Array(n).fill(0);
    const count = data.length;

    for (let j = 0; j < n; j++) {
        let sum = 0;
        for (let i = 0; i < count; i++) sum += data[i].features[j];
        means[j] = sum / count;

        let varianceSum = 0;
        for (let i = 0; i < count; i++) {
            const diff = data[i].features[j] - means[j];
            varianceSum += diff * diff;
        }
        stdDevs[j] = Math.sqrt(varianceSum / count) + 1e-8;
    }

    return { means, stdDevs };
}

function normalizeFeatureVector(features: number[], means: number[], stdDevs: number[]): number[] {
    return features.map((f, j) => (f - means[j]) / stdDevs[j]);
}

export class AIEngine {
    private knnK = 7;

    // ==========================================
    // TECHNICAL INDICATORS CALCULATORS
    // ==========================================

    /**
     * Exponential Moving Average (EMA)
     */
    calculateEMA(prices: number[], period: number): (number | null)[] {
        const ema: (number | null)[] = [];
        if (prices.length < period) return Array(prices.length).fill(null);
        
        const k = 2 / (period + 1);
        
        // Calculate SMA for the first element
        let sum = 0;
        for (let i = 0; i < period; i++) {
            sum += prices[i];
        }
        let currentEma = sum / period;
        
        for (let i = 0; i < prices.length; i++) {
            if (i < period - 1) {
                ema.push(null);
            } else if (i === period - 1) {
                ema.push(currentEma);
            } else {
                currentEma = prices[i] * k + currentEma * (1 - k);
                ema.push(currentEma);
            }
        }
        return ema;
    }

    /**
     * Relative Strength Index (RSI)
     */
    calculateRSI(prices: number[], period: number = 14): (number | null)[] {
        const rsi: (number | null)[] = [];
        if (prices.length <= period) return Array(prices.length).fill(null);

        const gains: number[] = [];
        const losses: number[] = [];

        for (let i = 1; i < prices.length; i++) {
            const difference = prices[i] - prices[i - 1];
            if (difference >= 0) {
                gains.push(difference);
                losses.push(0);
            } else {
                gains.push(0);
                losses.push(Math.abs(difference));
            }
        }

        // First average gain/loss
        let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
        let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

        // Fill initial nulls
        for (let i = 0; i <= period; i++) {
            rsi.push(null);
        }

        rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));

        for (let i = period + 1; i < prices.length; i++) {
            avgGain = (avgGain * (period - 1) + gains[i - 1]) / period;
            avgLoss = (avgLoss * (period - 1) + losses[i - 1]) / period;
            
            if (avgLoss === 0) {
                rsi.push(100);
            } else {
                const rs = avgGain / avgLoss;
                rsi.push(100 - (100 / (1 + rs)));
            }
        }

        return rsi;
    }

    /**
     * MACD (Moving Average Convergence Divergence)
     */
    calculateMACD(prices: number[], fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        const macdLine: (number | null)[] = [];
        const signalLine: (number | null)[] = [];
        const histogram: (number | null)[] = [];

        const fastEMA = this.calculateEMA(prices, fastPeriod);
        const slowEMA = this.calculateEMA(prices, slowPeriod);

        for (let i = 0; i < prices.length; i++) {
            const fVal = fastEMA[i];
            const sVal = slowEMA[i];
            if (fVal === null || sVal === null) {
                macdLine.push(null);
            } else {
                macdLine.push(fVal - sVal);
            }
        }

        // Calculate Signal Line (EMA of MACD Line)
        const nonNullMacd = macdLine.filter((val): val is number => val !== null);
        const nonNullSignal = this.calculateEMA(nonNullMacd, signalPeriod);

        let signalIndex = 0;
        const nullCount = macdLine.length - nonNullMacd.length;

        for (let i = 0; i < macdLine.length; i++) {
            if (i < nullCount + signalPeriod - 1) {
                signalLine.push(null);
                histogram.push(null);
            } else {
                const sigVal = nonNullSignal[signalIndex++];
                if (sigVal === null) {
                    signalLine.push(null);
                    histogram.push(null);
                } else {
                    signalLine.push(sigVal);
                    const macdVal = macdLine[i];
                    histogram.push(macdVal !== null ? macdVal - sigVal : null);
                }
            }
        }

        return { macdLine, signalLine, histogram };
    }

    /**
     * Average True Range (ATR)
     */
    calculateATR(highs: number[], lows: number[], closes: number[], period = 14): (number | null)[] {
        const atr: (number | null)[] = [];
        if (closes.length <= period) return Array(closes.length).fill(null);

        const trueRanges = [highs[0] - lows[0]];

        for (let i = 1; i < closes.length; i++) {
            const tr1 = highs[i] - lows[i];
            const tr2 = Math.abs(highs[i] - closes[i - 1]);
            const tr3 = Math.abs(lows[i] - closes[i - 1]);
            trueRanges.push(Math.max(tr1, tr2, tr3));
        }

        let currentAtr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
        
        for (let i = 0; i <= period; i++) {
            atr.push(null);
        }
        atr[period] = currentAtr;

        for (let i = period + 1; i < closes.length; i++) {
            currentAtr = (currentAtr * (period - 1) + trueRanges[i]) / period;
            atr.push(currentAtr);
        }

        return atr;
    }

    /**
     * On-Balance Volume (OBV)
     */
    calculateOBV(closes: number[], volumes: number[]): number[] {
        const obv: number[] = [0];
        for (let i = 1; i < closes.length; i++) {
            const diff = closes[i] - closes[i - 1];
            if (diff > 0) {
                obv.push(obv[i - 1] + volumes[i]);
            } else if (diff < 0) {
                obv.push(obv[i - 1] - volumes[i]);
            } else {
                obv.push(obv[i - 1]);
            }
        }
        return obv;
    }

    /**
     * Bollinger Bands and Bandwidth (Spread)
     */
    calculateBollingerBands(prices: number[], period = 20) {
        const upper: (number | null)[] = [];
        const lower: (number | null)[] = [];
        const middle: (number | null)[] = [];
        const bandwidth: (number | null)[] = [];

        if (prices.length < period) {
            const nil = Array(prices.length).fill(null);
            return { upper: nil, lower: nil, middle: nil, bandwidth: nil };
        }

        for (let i = 0; i < prices.length; i++) {
            if (i < period - 1) {
                upper.push(null);
                lower.push(null);
                middle.push(null);
                bandwidth.push(null);
                continue;
            }

            // SMA
            let sum = 0;
            for (let j = i - period + 1; j <= i; j++) {
                sum += prices[j];
            }
            const sma = sum / period;
            middle.push(sma);

            // Variance & StdDev
            let varianceSum = 0;
            for (let j = i - period + 1; j <= i; j++) {
                const diff = prices[j] - sma;
                varianceSum += diff * diff;
            }
            const stdDev = Math.sqrt(varianceSum / period);

            const upVal = sma + 2 * stdDev;
            const lowVal = sma - 2 * stdDev;
            upper.push(upVal);
            lower.push(lowVal);
            bandwidth.push(sma === 0 ? 0 : (upVal - lowVal) / sma);
        }

        return { upper, lower, middle, bandwidth };
    }

    /**
     * Money Flow Index (MFI) - Volume Weighted RSI
     */
    calculateMFI(highs: number[], lows: number[], closes: number[], volumes: number[], period = 14): (number | null)[] {
        const mfi: (number | null)[] = [];
        if (closes.length <= period) return Array(closes.length).fill(null);

        const typicalPrices: number[] = [];
        const rawMoneyFlows: number[] = [];

        for (let i = 0; i < closes.length; i++) {
            const tp = (highs[i] + lows[i] + closes[i]) / 3;
            typicalPrices.push(tp);
            rawMoneyFlows.push(tp * (volumes[i] || 0));
        }

        // Fill initial nulls
        for (let i = 0; i < period; i++) {
            mfi.push(null);
        }

        for (let i = period; i < closes.length; i++) {
            let posFlow = 0;
            let negFlow = 0;

            for (let j = i - period + 1; j <= i; j++) {
                if (typicalPrices[j] > typicalPrices[j - 1]) {
                    posFlow += rawMoneyFlows[j];
                } else if (typicalPrices[j] < typicalPrices[j - 1]) {
                    negFlow += rawMoneyFlows[j];
                }
            }

            if (negFlow === 0) {
                mfi.push(100);
            } else {
                const mr = posFlow / negFlow;
                mfi.push(100 - (100 / (1 + mr)));
            }
        }

        return mfi;
    }

    /**
     * Average Directional Index (ADX) - Wilder's smoothed DI
     */
    calculateADX(highs: number[], lows: number[], closes: number[], period = 14): (number | null)[] {
        const adx: (number | null)[] = [];
        const len = closes.length;
        if (len < period * 2) return Array(len).fill(null);

        const tr: number[] = [];
        const dmPlus: number[] = [];
        const dmMinus: number[] = [];

        for (let i = 1; i < len; i++) {
            const h = highs[i];
            const l = lows[i];
            const prevClose = closes[i - 1];
            const prevHigh = highs[i - 1];
            const prevLow = lows[i - 1];

            const trVal = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
            tr.push(trVal);

            const upMove = h - prevHigh;
            const downMove = prevLow - l;

            let dmp = 0;
            let dmm = 0;
            if (upMove > downMove && upMove > 0) dmp = upMove;
            if (downMove > upMove && downMove > 0) dmm = downMove;

            dmPlus.push(dmp);
            dmMinus.push(dmm);
        }

        const smoothedTR: number[] = [];
        const smoothedDMPlus: number[] = [];
        const smoothedDMMinus: number[] = [];

        let trSum = tr.slice(0, period).reduce((a, b) => a + b, 0);
        let dmPlusSum = dmPlus.slice(0, period).reduce((a, b) => a + b, 0);
        let dmMinusSum = dmMinus.slice(0, period).reduce((a, b) => a + b, 0);

        smoothedTR.push(trSum);
        smoothedDMPlus.push(dmPlusSum);
        smoothedDMMinus.push(dmMinusSum);

        for (let i = period; i < tr.length; i++) {
            const prevTR = smoothedTR[smoothedTR.length - 1];
            const prevDMPlus = smoothedDMPlus[smoothedDMPlus.length - 1];
            const prevDMMinus = smoothedDMMinus[smoothedDMMinus.length - 1];

            smoothedTR.push(prevTR - prevTR / period + tr[i]);
            smoothedDMPlus.push(prevDMPlus - prevDMPlus / period + dmPlus[i]);
            smoothedDMMinus.push(prevDMMinus - prevDMMinus / period + dmMinus[i]);
        }

        const dx: number[] = [];
        for (let i = 0; i < smoothedTR.length; i++) {
            const str = smoothedTR[i];
            const sPlus = smoothedDMPlus[i];
            const sMinus = smoothedDMMinus[i];

            if (str === 0) {
                dx.push(0);
                continue;
            }

            const plusDI = 100 * (sPlus / str);
            const minusDI = 100 * (sMinus / str);
            const diff = Math.abs(plusDI - minusDI);
            const sum = plusDI + minusDI;

            dx.push(sum === 0 ? 0 : 100 * (diff / sum));
        }

        const adxValues: (number | null)[] = Array(2 * period - 1).fill(null);
        let dxSum = dx.slice(0, period).reduce((a, b) => a + b, 0);
        let currentADX = dxSum / period;
        adxValues.push(currentADX);

        for (let i = period; i < dx.length; i++) {
            currentADX = (currentADX * (period - 1) + dx[i]) / period;
            adxValues.push(currentADX);
        }

        return adxValues;
    }

    /**
     * Calculate Hurst Exponent using Rescaled Range (R/S) method.
     */
    calculateHurstExponent(prices: number[], period = 50): number {
        if (prices.length < period) return 0.5;
        
        const slice = prices.slice(prices.length - period);
        const logReturns: number[] = [];
        for (let i = 1; i < slice.length; i++) {
            const ratio = slice[i] / slice[i - 1];
            logReturns.push(ratio > 0 ? Math.log(ratio) : 0);
        }
        
        const getRS = (series: number[]): number => {
            const n = series.length;
            if (n < 4) return 1.0;
            
            let sum = 0;
            for (const v of series) sum += v;
            const mean = sum / n;
            
            const dev: number[] = [];
            let cumSum = 0;
            for (let i = 0; i < n; i++) {
                cumSum += series[i] - mean;
                dev.push(cumSum);
            }
            
            const maxDev = Math.max(...dev);
            const minDev = Math.min(...dev);
            const range = maxDev - minDev;
            
            let varSum = 0;
            for (const v of series) {
                const d = v - mean;
                varSum += d * d;
            }
            const std = Math.sqrt(varSum / n) + 1e-12;
            
            return range / std;
        };

        try {
            const rsWhole = getRS(logReturns);
            const halfLen = Math.floor(logReturns.length / 2);
            const rsHalf1 = getRS(logReturns.slice(0, halfLen));
            const rsHalf2 = getRS(logReturns.slice(halfLen));
            const rsHalfAvg = (rsHalf1 + rsHalf2) / 2;
            
            const h = Math.log(rsWhole / Math.max(1e-12, rsHalfAvg)) / Math.log(2);
            return isNaN(h) ? 0.5 : Math.max(0.0, Math.min(1.0, h));
        } catch {
            return 0.5;
        }
    }

    /**
     * Calculate VWAP rolling deviation.
     */
    calculateVWAPDeviation(closes: number[], volumes: number[], period = 20): number[] {
        const dev: number[] = Array(closes.length).fill(0);
        for (let i = period; i < closes.length; i++) {
            let sumPriceVol = 0;
            let sumVol = 0;
            for (let j = i - period + 1; j <= i; j++) {
                sumPriceVol += closes[j] * (volumes[j] ?? 0);
                sumVol += (volumes[j] ?? 0);
            }
            const vwap = sumVol > 0 ? sumPriceVol / sumVol : closes[i];
            dev[i] = (closes[i] - vwap) / vwap;
        }
        return dev;
    }

    /**
     * Calculate MACD acceleration (change in histogram slope).
     */
    calculateMACDAcceleration(hist: (number | null)[]): (number | null)[] {
        const accel: (number | null)[] = Array(hist.length).fill(null);
        for (let i = 2; i < hist.length; i++) {
            const h = hist[i];
            const hPrev1 = hist[i - 1];
            const hPrev2 = hist[i - 2];
            if (h !== null && hPrev1 !== null && hPrev2 !== null) {
                accel[i] = h - 2 * hPrev1 + hPrev2;
            }
        }
        return accel;
    }

    /**
     * Detect RSI divergence.
     * Bullish = 1, Bearish = -1, None = 0.
     */
    calculateRSIDivergence(closes: number[], rsi: (number | null)[]): number[] {
        const div: number[] = Array(closes.length).fill(0);
        for (let i = 10; i < closes.length; i++) {
            const r = rsi[i];
            const rPrev = rsi[i - 4];
            if (r === null || rPrev === null) continue;

            const p = closes[i];
            const pPrev = closes[i - 4];

            if (p < pPrev && r > rPrev && r < 38) {
                div[i] = 1;
            } else if (p > pPrev && r < rPrev && r > 62) {
                div[i] = -1;
            }
        }
        return div;
    }

    // ==========================================
    // FEATURE ENGINEERING & MACHINE LEARNING
    // ==========================================

    /**
     * Extract features for ML model.
     *  - Without context: 13-d (RSI, MACD, EMA20Dist, EMACross, momentum,
     *    volatility, EMA200Dist, MFI, OBVChange, BBSpread, VWAPDeviation, MACDAcceleration, RSIDivergence).
     *  - With context: same 13 + 5 alpha features
     *    (funding, OI delta 1h, HTF bias, vol regime, BTC correlation).
     */
    extractFeatures(
        closes: number[],
        highs: number[],
        lows: number[],
        volumes: number[],
        ctx?: FeatureContextSeries | null
    ): FeaturePoint[] {
        const length = closes.length;
        const rsi = this.calculateRSI(closes, 14);
        const { histogram: macdHist } = this.calculateMACD(closes, 12, 26, 9);
        const ema20 = this.calculateEMA(closes, 20);
        const ema50 = this.calculateEMA(closes, 50);
        const ema200 = this.calculateEMA(closes, 200); // Macro Trend indicator
        const atr = this.calculateATR(highs, lows, closes, 14);

        // Advanced volumetric & market indicators
        const obv = this.calculateOBV(closes, volumes);
        const obvEma20 = this.calculateEMA(obv, 20);
        const { bandwidth: bbSpread } = this.calculateBollingerBands(closes, 20);
        const mfi = this.calculateMFI(highs, lows, closes, volumes, 14);

        // Dynamic local quant features
        const vwapDev = this.calculateVWAPDeviation(closes, volumes, 20);
        const macdAccel = this.calculateMACDAcceleration(macdHist);
        const rsiDiv = this.calculateRSIDivergence(closes, rsi);

        const dataset: FeaturePoint[] = [];

        // Shift to index 200 because we need at least 200 candles to get valid EMA200
        for (let i = 200; i < length; i++) {
            const currentRSI = rsi[i];
            const currentMacd = macdHist[i];
            const currentEma20 = ema20[i];
            const currentEma50 = ema50[i];
            const currentEma200 = ema200[i];
            const currentAtr = atr[i];
            const currentOBV = obv[i];
            const currentObvEma20 = obvEma20[i];
            const currentBbSpread = bbSpread[i];
            const currentMfi = mfi[i];
            const currentVwapDev = vwapDev[i];
            const currentMacdAccel = macdAccel[i];
            const currentRsiDiv = rsiDiv[i];

            if (
                currentRSI === null || 
                currentMacd === null || 
                currentEma20 === null || 
                currentEma50 === null || 
                currentEma200 === null ||
                currentAtr === null ||
                currentObvEma20 === null ||
                currentBbSpread === null ||
                currentMfi === null ||
                currentVwapDev === null ||
                currentRsiDiv === null
            ) {
                continue;
            }

            // Normalization
            const f_rsi = currentRSI / 100;
            const f_macd = currentMacd / closes[i];
            const f_ema20Dist = (closes[i] - currentEma20) / closes[i];
            const f_emaCross = (currentEma20 - currentEma50) / currentEma50;
            const f_momentum = (closes[i] - closes[i - 3]) / closes[i - 3];
            const f_volatility = currentAtr / closes[i];

            // Advanced Features Normalized
            const f_ema200Dist = (closes[i] - currentEma200) / closes[i];
            const f_mfi = currentMfi / 100;
            const f_obvChange = currentObvEma20 === 0 ? 0 : (currentOBV - currentObvEma20) / Math.abs(currentObvEma20);
            const f_bbSpread = currentBbSpread;

            // New Local Quant Features
            const f_vwapDev = currentVwapDev;
            const f_macdAccel = currentMacdAccel !== null ? currentMacdAccel / closes[i] : 0;
            const f_rsiDiv = currentRsiDiv;

            const baseFeatures = [
                f_rsi,
                f_macd,
                f_ema20Dist,
                f_emaCross,
                f_momentum,
                f_volatility,
                f_ema200Dist,
                f_mfi,
                f_obvChange,
                f_bbSpread,
                f_vwapDev,
                f_macdAccel,
                f_rsiDiv
            ];

            // ---- T3.1: append 5 alpha features when context provided ---------
            if (ctx) {
                const f_funding = clipped((ctx.funding?.[i] ?? 0) * 1000, -2, 2);
                const f_oi = clipped((ctx.oiDelta1h?.[i] ?? 0) / 5, -3, 3);
                const f_htfBias = ctx.htfBias?.[i] ?? 0;
                const f_volRegime = clipped((ctx.volRegime?.[i] ?? 1) - 1, -2, 2);
                const f_btcCorr = clipped(ctx.btcCorr?.[i] ?? 0, -1, 1);
                baseFeatures.push(f_funding, f_oi, f_htfBias, f_volRegime, f_btcCorr);
            }

            dataset.push({
                index: i,
                price: closes[i],
                atr: currentAtr,
                features: baseFeatures
            });
        }

        return dataset;
    }

    /**
     * Label training dataset based on forward window returns.
     *
     * Optionally attaches a sample weight to each point. When the caller
     * supplies `applyTimeDecay = true`, weights are computed automatically
     * via computeTimeDecayWeights() so recent candles dominate.
     */
    labelDataset(
        dataset: FeaturePoint[],
        closes: number[],
        forwardCandles = 5,
        thresholdPercent = 0.003,
        applyTimeDecay = false,
        halfLifeFraction = 0.5
    ): LabeledDataPoint[] {
        const labeledData: LabeledDataPoint[] = [];

        for (let i = 0; i < dataset.length; i++) {
            const currentItem = dataset[i];
            const currentIndex = currentItem.index;
            
            if (currentIndex + forwardCandles >= closes.length) {
                continue;
            }

            let maxFuturePrice = -Infinity;
            let minFuturePrice = Infinity;
            
            for (let j = 1; j <= forwardCandles; j++) {
                const futPrice = closes[currentIndex + j];
                if (futPrice > maxFuturePrice) maxFuturePrice = futPrice;
                if (futPrice < minFuturePrice) minFuturePrice = futPrice;
            }

            const currentPrice = currentItem.price;
            const upReturn = (maxFuturePrice - currentPrice) / currentPrice;
            const downReturn = (currentPrice - minFuturePrice) / currentPrice;

            let label = 0;
            if (upReturn >= thresholdPercent && upReturn > downReturn) {
                label = 1; // Long
            } else if (downReturn >= thresholdPercent && downReturn > upReturn) {
                label = -1; // Short
            }

            labeledData.push({
                features: currentItem.features,
                label: label,
                price: currentPrice,
                index: currentIndex
            });
        }

        // Attach time-decay weights AFTER filtering so weight indices match.
        if (applyTimeDecay && labeledData.length > 0) {
            const weights = computeTimeDecayWeights(labeledData.length, halfLifeFraction);
            for (let i = 0; i < labeledData.length; i++) {
                labeledData[i].weight = weights[i];
            }
        }

        return labeledData;
    }

    /**
     * T3.5 — Triple-barrier labeling (Marcos López de Prado).
     *
     * For each feature point we walk forward `forwardCandles` candles and ask:
     *   - which barrier was touched FIRST?
     *     • upper barrier (TP) at price + tpAtrMult * ATR  → label +1
     *     • lower barrier (SL) at price − slAtrMult * ATR  → label −1
     *     • neither was hit before horizon expired         → label  0
     *
     * Why this beats fixed-threshold labeling:
     *   - Barriers scale with realized volatility (ATR), so the same TP/SL
     *     multipliers produce comparable signal in BOTH calm and choppy regimes.
     *   - The label answers the EXACT question the bot will execute later:
     *     "will TP get hit before SL within N candles?" → no train/serve skew.
     *
     * Uses high/low data for barrier-touch detection (more realistic than
     * close-only labels because intrabar moves DO close real trades).
     */
    labelDatasetTripleBarrier(
        dataset: FeaturePoint[],
        highs: number[],
        lows: number[],
        closes: number[],
        forwardCandles = 10,
        tpAtrMult = 2.0,
        slAtrMult = 1.0,
        applyTimeDecay = false,
        halfLifeFraction = 0.5
    ): LabeledDataPoint[] {
        const out: LabeledDataPoint[] = [];

        for (let i = 0; i < dataset.length; i++) {
            const item = dataset[i];
            const idx = item.index;
            if (idx + forwardCandles >= closes.length) continue;
            if (!Number.isFinite(item.atr) || item.atr <= 0) continue;

            const price = item.price;
            const upper = price + tpAtrMult * item.atr;
            const lower = price - slAtrMult * item.atr;

            let label = 0;
            for (let j = 1; j <= forwardCandles; j++) {
                const hi = highs[idx + j];
                const lo = lows[idx + j];
                // Long view: TP first → +1, SL first → −1. If both barriers
                // are touched in the SAME candle we conservatively call it
                // an SL hit (worst-case for a long, intrabar order of touches
                // is unknown without tick data).
                const tpHit = hi >= upper;
                const slHit = lo <= lower;
                if (tpHit && slHit) { label = -1; break; }
                if (tpHit) { label = 1; break; }
                if (slHit) { label = -1; break; }
            }

            out.push({ features: item.features, label, price, index: idx });
        }

        if (applyTimeDecay && out.length > 0) {
            const weights = computeTimeDecayWeights(out.length, halfLifeFraction);
            for (let i = 0; i < out.length; i++) {
                out[i].weight = weights[i];
            }
        }

        return out;
    }

    /**
     * Predict using KNN — votes weighted by:
     *   - inverse distance (closer neighbors influence more), AND
     *   - sample's time-decay weight (recent training samples count more
     *     than ancient ones, even if they're geometrically closer).
     */
    predictKNN(trainingData: LabeledDataPoint[], targetFeatures: number[], currentChop?: number): PredictionResult {
        if (!trainingData || trainingData.length === 0) {
            return { signal: 0, confidence: 50 };
        }

        const numFeatures = targetFeatures.length;
        const n = trainingData.length;

        // Calculate Mean and Standard Deviation for each feature across the training set
        const means = new Array(numFeatures).fill(0);
        const stdDevs = new Array(numFeatures).fill(0);

        for (let j = 0; j < numFeatures; j++) {
            let sum = 0;
            for (let i = 0; i < n; i++) {
                sum += trainingData[i].features[j];
            }
            means[j] = sum / n;

            let varianceSum = 0;
            for (let i = 0; i < n; i++) {
                const diff = trainingData[i].features[j] - means[j];
                varianceSum += diff * diff;
            }
            // Standard deviation with tiny epsilon to prevent division by zero
            stdDevs[j] = Math.sqrt(varianceSum / n) + 1e-8;
        }

        // Dynamic feature weighting based on current Choppiness Index
        const featureWeights = new Array(numFeatures).fill(1.0);
        if (currentChop !== undefined) {
            const isTrending = currentChop < 50;
            if (isTrending) {
                // Trending: emphasize trend, suppress oscillators
                if (numFeatures > 0) featureWeights[0] = 0.3;  // RSI
                if (numFeatures > 1) featureWeights[1] = 2.0;  // MACD
                if (numFeatures > 2) featureWeights[2] = 2.0;  // EMA20Dist
                if (numFeatures > 3) featureWeights[3] = 2.0;  // EMACross
                if (numFeatures > 4) featureWeights[4] = 2.0;  // momentum
                if (numFeatures > 6) featureWeights[6] = 2.0;  // EMA200Dist
                if (numFeatures > 7) featureWeights[7] = 0.3;  // MFI
                if (numFeatures > 9) featureWeights[9] = 0.3;  // BBSpread
                if (numFeatures > 12) featureWeights[12] = 2.0; // HTFBias
            } else {
                // Sideway: emphasize oscillators, suppress trend indicators (avoid whipsaw)
                if (numFeatures > 0) featureWeights[0] = 2.0;  // RSI
                if (numFeatures > 1) featureWeights[1] = 0.2;  // MACD
                if (numFeatures > 2) featureWeights[2] = 0.2;  // EMA20Dist
                if (numFeatures > 3) featureWeights[3] = 0.2;  // EMACross
                if (numFeatures > 4) featureWeights[4] = 0.2;  // momentum
                if (numFeatures > 6) featureWeights[6] = 0.2;  // EMA200Dist
                if (numFeatures > 7) featureWeights[7] = 2.0;  // MFI
                if (numFeatures > 9) featureWeights[9] = 2.0;  // BBSpread
                if (numFeatures > 12) featureWeights[12] = 0.2; // HTFBias
            }
        }

        const distances: { distance: number; label: number; weight: number }[] = [];
        for (let i = 0; i < n; i++) {
            const item = trainingData[i];
            let distSquareSum = 0;

            for (let j = 0; j < numFeatures; j++) {
                // Z-score normalize target and training features
                const stdTrain = (item.features[j] - means[j]) / stdDevs[j];
                const stdTarget = (targetFeatures[j] - means[j]) / stdDevs[j];
                const diff = stdTarget - stdTrain;
                distSquareSum += featureWeights[j] * diff * diff;
            }

            distances.push({
                distance: Math.sqrt(distSquareSum),
                label: item.label,
                weight: item.weight ?? 1.0
            });
        }

        distances.sort((a, b) => a.distance - b.distance);
        const kNeighbors = distances.slice(0, this.knnK);

        let buyScore = 0;
        let sellScore = 0;
        let holdScore = 0;
        let totalScore = 0;

        for (let i = 0; i < kNeighbors.length; i++) {
            const { distance, label, weight } = kNeighbors[i];
            // Inverse-distance weighting with small epsilon to avoid div-by-zero.
            const distScore = 1 / (distance + 1e-6);
            const score = distScore * weight;
            totalScore += score;
            if (label === 1) buyScore += score;
            else if (label === -1) sellScore += score;
            else holdScore += score;
        }

        let signal = 0;
        let maxScore = holdScore;

        if (buyScore > maxScore) {
            signal = 1;
            maxScore = buyScore;
        }
        if (sellScore > maxScore) {
            signal = -1;
            maxScore = sellScore;
        }

        const confidence = totalScore > 0 ? Math.round((maxScore / totalScore) * 100) : 50;

        return { signal, confidence };
    }

    /**
     * Train Logistic Regression Classifier (Gradient Descent on Server).
     *
     * Improvements over the original:
     *  - Epochs raised to 500 (was 200/250) with a lower learning rate 0.03 (was 0.05)
     *    to avoid overshooting the loss surface on small datasets (~290 samples).
     *  - L2 regularization reduced 0.01 → 0.005 — previous value over-regularized
     *    with only ~290 samples, flattening weights towards 0 too aggressively.
     *  - Early stopping: validation set (last 15% of data by time order) is evaluated
     *    after each epoch; training halts when val-loss increases 3 consecutive epochs
     *    to prevent over-fitting on the tiny in-sample training window.
     */
    trainLogisticRegression(trainingData: LabeledDataPoint[], epochs = 500, lr = 0.03): LogisticRegressionModel | null {
        if (!trainingData || trainingData.length === 0) return null;

        const numFeatures = trainingData[0].features.length;
        const { means, stdDevs } = computeFeatureNormalization(trainingData);

        // Normalize full dataset
        const normalizedData = trainingData.map(d => ({
            ...d,
            features: normalizeFeatureVector(d.features, means, stdDevs)
        }));

        const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
        const lambda = 0.005; // L2 regularization

        /** Compute average binary-cross-entropy loss on a dataset. */
        function bce(
            data: { features: number[]; label: number; weight?: number }[],
            weights: number[],
            bias: number,
            posLabel: number
        ): number {
            let loss = 0;
            for (const d of data) {
                let dot = bias;
                for (let j = 0; j < weights.length; j++) dot += d.features[j] * weights[j];
                const p = sigmoid(dot);
                const y = d.label === posLabel ? 1 : 0;
                loss += -(y * Math.log(p + 1e-12) + (1 - y) * Math.log(1 - p + 1e-12));
            }
            return loss / data.length;
        }

        /** Train one binary classifier (Long or Short) with early stopping on a given normalized subset. */
        function trainBinary(subset: LabeledDataPoint[], posLabel: number): { weights: number[]; bias: number } {
            const splitIdx = Math.floor(subset.length * 0.85);
            const trainData = subset.slice(0, splitIdx);
            const valData   = subset.slice(splitIdx);
            const effectiveTrain = trainData.length >= 20 ? trainData : subset;
            const effectiveVal   = valData.length   >= 5  ? valData   : null;

            const wt = Array(numFeatures).fill(0) as number[];
            let b = 0;

            let bestWeights = [...wt];
            let bestBias = b;
            let bestValLoss = Infinity;
            let noImprovementCount = 0;
            const patience = 3;

            for (let epoch = 0; epoch < epochs; epoch++) {
                for (let i = 0; i < effectiveTrain.length; i++) {
                    const features = effectiveTrain[i].features;
                    const label = effectiveTrain[i].label === posLabel ? 1 : 0;
                    const sampleW = effectiveTrain[i].weight ?? 1.0;

                    let dot = b;
                    for (let j = 0; j < numFeatures; j++) dot += features[j] * wt[j];
                    const pred = sigmoid(dot);
                    const error = (pred - label) * sampleW;

                    for (let j = 0; j < numFeatures; j++) {
                        wt[j] -= lr * (error * features[j] + lambda * wt[j]);
                    }
                    b -= lr * error;
                }

                // Early stopping check against validation set.
                if (effectiveVal) {
                    const valLoss = bce(effectiveVal, wt, b, posLabel);
                    if (valLoss < bestValLoss) {
                        bestValLoss = valLoss;
                        bestWeights = [...wt];
                        bestBias = b;
                        noImprovementCount = 0;
                    } else {
                        noImprovementCount++;
                        if (noImprovementCount >= patience) break;
                    }
                } else {
                    bestWeights = [...wt];
                    bestBias = b;
                }
            }
            return { weights: bestWeights, bias: bestBias };
        }

        // Split normalized data into Trending and Sideway subsets based on d.chop
        const trendingSubset = normalizedData.filter(d => d.chop === undefined || d.chop < 50);
        const sidewaySubset = normalizedData.filter(d => d.chop !== undefined && d.chop >= 50);

        // Fall back to full dataset if subsets are too small
        const effectiveTrending = trendingSubset.length >= 15 ? trendingSubset : normalizedData;
        const effectiveSideway = sidewaySubset.length >= 15 ? sidewaySubset : normalizedData;

        // Train Global Model (for backward compatibility)
        const globalLong = trainBinary(normalizedData, 1);
        const globalShort = trainBinary(normalizedData, -1);

        // Train Trending Model
        const trendingLong = trainBinary(effectiveTrending, 1);
        const trendingShort = trainBinary(effectiveTrending, -1);

        // Train Sideway Model
        const sidewayLong = trainBinary(effectiveSideway, 1);
        const sidewayShort = trainBinary(effectiveSideway, -1);

        return {
            weightsLong: globalLong.weights,
            biasLong: globalLong.bias,
            weightsShort: globalShort.weights,
            biasShort: globalShort.bias,

            weightsLongTrending: trendingLong.weights,
            biasLongTrending: trendingLong.bias,
            weightsShortTrending: trendingShort.weights,
            biasShortTrending: trendingShort.bias,

            weightsLongSideway: sidewayLong.weights,
            biasLongSideway: sidewayLong.bias,
            weightsShortSideway: sidewayShort.weights,
            biasShortSideway: sidewayShort.bias,

            featureMeans: means,
            featureStdDevs: stdDevs
        };
    }

    /**
     * Predict using Logistic Regression Model.
     * Features are z-score normalized with training-set stats stored on the model.
     * confidenceThresholdPct (UI slider, e.g. 65) replaces the old hardcoded 0.55 gate.
     */
    predictLogisticRegression(
        model: LogisticRegressionModel | null,
        targetFeatures: number[],
        confidenceThresholdPct = 55,
        currentChop?: number
    ): PredictionResult {
        if (!model) return { signal: 0, confidence: 50 };

        const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
        const means = model.featureMeans ?? Array(targetFeatures.length).fill(0);
        const stdDevs = model.featureStdDevs ?? Array(targetFeatures.length).fill(1);
        const features = normalizeFeatureVector(targetFeatures, means, stdDevs);
        const threshold = Math.min(Math.max(confidenceThresholdPct / 100, 0.5), 0.95);

        let dotLong = 0;
        let dotShort = 0;

        // Select active weights based on currentChop
        let wLong = model.weightsLong;
        let bLong = model.biasLong;
        let wShort = model.weightsShort;
        let bShort = model.biasShort;

        if (currentChop !== undefined && model.weightsLongTrending && model.weightsLongSideway) {
            const isTrending = currentChop < 50;
            if (isTrending) {
                wLong = model.weightsLongTrending;
                bLong = model.biasLongTrending;
                wShort = model.weightsShortTrending;
                bShort = model.biasShortTrending;
            } else {
                wLong = model.weightsLongSideway;
                bLong = model.biasLongSideway;
                wShort = model.weightsShortSideway;
                bShort = model.biasShortSideway;
            }
        }

        for (let i = 0; i < features.length; i++) {
            dotLong += features[i] * wLong[i];
            dotShort += features[i] * wShort[i];
        }

        const probLong = sigmoid(dotLong + bLong);
        const probShort = sigmoid(dotShort + bShort);

        let signal = 0;
        let confidence = 50;

        if (probLong > probShort && probLong >= threshold) {
            signal = 1;
            confidence = Math.round(probLong * 100);
        } else if (probShort > probLong && probShort >= threshold) {
            signal = -1;
            confidence = Math.round(probShort * 100);
        } else {
            signal = 0;
            // Best directional probability (below threshold) — aligns with UI threshold in logs.
            confidence = Math.round(Math.max(probLong, probShort) * 100);
        }

        return { signal, confidence };
    }

    /**
     * Helper method to calculate Choppiness Index for AIEngine internal use
     */
    calculateChoppiness(closes: number[], highs: number[], lows: number[], period = 14): number {
        if (!closes || closes.length < period + 1) return 50;

        let sumTR = 0;
        let highestHigh = -Infinity;
        let lowestLow = Infinity;

        for (let i = closes.length - period; i < closes.length; i++) {
            const h = highs[i];
            const l = lows[i];
            const prevClose = closes[i - 1];
            
            const tr = Math.max(h - l, Math.abs(h - prevClose), Math.abs(l - prevClose));
            
            sumTR += tr;
            if (h > highestHigh) highestHigh = h;
            if (l < lowestLow) lowestLow = l;
        }

        const range = highestHigh - lowestLow;
        if (range === 0) return 50;

        const chop = 100 * (Math.log10(sumTR / range) / Math.log10(period));
        return isNaN(chop) ? 50 : Math.max(0, Math.min(100, chop));
    }

    /**
     * Quantitative Momentum Indicator Strategy v2
     * Upgraded: Combines Crossover Signals + Trend Position Scoring + Volume Confirmation
     * Fixes the 97% HOLD issue by not requiring exact crossovers — also scores indicator POSITION.
     */
    predictMomentumStrategy(closes: number[], highs: number[], lows: number[], volumes?: number[], localChop?: number): PredictionResult {
        const rsi = this.calculateRSI(closes, 14);
        const { histogram: macdHist, macdLine, signalLine } = this.calculateMACD(closes, 12, 26, 9);
        const ema9 = this.calculateEMA(closes, 9);
        const ema21 = this.calculateEMA(closes, 21);
        const ema50 = this.calculateEMA(closes, 50);
        const ema200 = this.calculateEMA(closes, 200);

        const last = closes.length - 1;

        const currentRSI = rsi[last];
        const prevRSI = rsi[last - 1];
        
        const currentHist = macdHist[last];
        const prevHist = macdHist[last - 1];

        const lastEma9 = ema9[last];
        const prevEma9 = ema9[last - 1];
        const lastEma21 = ema21[last];
        const prevEma21 = ema21[last - 1];
        const lastEma50 = ema50[last];
        
        const lastMacdLine = macdLine[last];
        const lastSignalLine = signalLine[last];
        const lastEma200 = ema200[last];

        if (
            last < 200 || 
            currentRSI === null || 
            prevRSI === null || 
            currentHist === null || 
            prevHist === null || 
            lastEma9 === null || 
            prevEma9 === null || 
            lastEma21 === null || 
            prevEma21 === null ||
            lastEma50 === null ||
            lastMacdLine === null ||
            lastSignalLine === null ||
            lastEma200 === null
        ) {
            return { signal: 0, confidence: 50 };
        }

        const chop = localChop !== undefined ? localChop : this.calculateChoppiness(closes, highs, lows, 14);
        const isTrending = chop < 50;
        const trendMultiplier = isTrending ? 1.5 : 0.2;
        const oscMultiplier = isTrending ? 0.2 : 2.0;

        let scoreBuy = 0;
        let scoreSell = 0;

        // ============================================================
        // LAYER 1: Classic Crossover Signals (high weight, rare events)
        // ============================================================
        const isEmaBullishCross = lastEma9 > lastEma21 && (
            prevEma9 <= prevEma21 || 
            (ema9[last - 2] !== null && ema21[last - 2] !== null && ema9[last - 2]! <= ema21[last - 2]!)
        );
        const isEmaBearishCross = lastEma9 < lastEma21 && (
            prevEma9 >= prevEma21 || 
            (ema9[last - 2] !== null && ema21[last - 2] !== null && ema9[last - 2]! >= ema21[last - 2]!)
        );

        const isRsiOversoldCross = currentRSI < 35 && prevRSI >= 35;
        const isRsiOverboughtCross = currentRSI > 65 && prevRSI <= 65;

        const isMacdBullishCross = currentHist > 0 && prevHist <= 0;
        const isMacdBearishCross = currentHist < 0 && prevHist >= 0;

        if (isEmaBullishCross) scoreBuy += 2.0 * trendMultiplier;
        if (isRsiOversoldCross) scoreBuy += 2.0 * oscMultiplier;
        if (isMacdBullishCross) scoreBuy += 2.0 * trendMultiplier;

        if (isEmaBearishCross) scoreSell += 2.0 * trendMultiplier;
        if (isRsiOverboughtCross) scoreSell += 2.0 * oscMultiplier;
        if (isMacdBearishCross) scoreSell += 2.0 * trendMultiplier;

        // ============================================================
        // LAYER 2: Trend Position Scoring (moderate weight, frequent)
        // This is the key fix — scores WHERE indicators sit, no crossover needed
        // ============================================================

        // EMA Stack alignment: EMA9 > EMA21 > EMA50 = strong bullish structure
        if (lastEma9 > lastEma21 && lastEma21 > lastEma50) {
            scoreBuy += 1.5 * trendMultiplier;
        } else if (lastEma9 < lastEma21 && lastEma21 < lastEma50) {
            scoreSell += 1.5 * trendMultiplier;
        }

        // Price relative to short-term EMAs (momentum confirmation)
        if (closes[last] > lastEma9 && lastEma9 > lastEma21) {
            scoreBuy += 0.5 * trendMultiplier;
        } else if (closes[last] < lastEma9 && lastEma9 < lastEma21) {
            scoreSell += 0.5 * trendMultiplier;
        }

        // RSI Zone scoring (no crossover needed — just check the zone)
        if (currentRSI < 40 && currentRSI > prevRSI) {
            scoreBuy += 1.0 * oscMultiplier; // RSI in oversold zone AND turning up
        } else if (currentRSI > 60 && currentRSI < prevRSI) {
            scoreSell += 1.0 * oscMultiplier; // RSI in overbought zone AND turning down
        }

        // MACD Histogram momentum (acceleration without requiring zero-cross)
        const prevPrevHist = macdHist[last - 2];
        if (prevPrevHist !== null) {
            // Histogram accelerating positive = bullish momentum building
            if (currentHist > prevHist && prevHist > prevPrevHist && currentHist > 0) {
                scoreBuy += 1.0 * trendMultiplier;
            }
            // Histogram accelerating negative = bearish momentum building
            if (currentHist < prevHist && prevHist < prevPrevHist && currentHist < 0) {
                scoreSell += 1.0 * trendMultiplier;
            }
        }

        // MACD Line vs Signal Line divergence (trend strength without crossover)
        const macdSpread = lastMacdLine - lastSignalLine;
        const macdSpreadNorm = Math.abs(macdSpread) / closes[last];
        if (macdSpread > 0 && macdSpreadNorm > 0.0002) {
            scoreBuy += 0.5 * trendMultiplier;
        } else if (macdSpread < 0 && macdSpreadNorm > 0.0002) {
            scoreSell += 0.5 * trendMultiplier;
        }

        // ============================================================
        // LAYER 3: EMA200 Macro Trend Filter — Soft Penalty/Bonus
        // ============================================================
        const ema200Dist = (closes[last] - lastEma200) / lastEma200;
        const trendStrength = Math.min(1.0, Math.abs(ema200Dist) * 50); // saturate at 2% dist

        if (ema200Dist > 0) { // Above EMA200: Bullish macro bias
            const trendPenalty = isTrending ? 0.5 : 0.1;
            scoreSell *= (1 - trendStrength * trendPenalty); // Penalize Short
            scoreBuy += 0.8 * trendStrength * (isTrending ? 1.2 : 0.5); // Bonus Buy
        } else { // Below EMA200: Bearish macro bias
            const trendPenalty = isTrending ? 0.5 : 0.1;
            scoreBuy *= (1 - trendStrength * trendPenalty); // Penalize Buy
            scoreSell += 0.8 * trendStrength * (isTrending ? 1.2 : 0.5); // Bonus Sell
        }

        // ============================================================
        // LAYER 4: ADX Trend Strength Filter
        // ============================================================
        const adx = this.calculateADX(highs, lows, closes, 14);
        const currentADX = adx[last];
        if (currentADX !== null) {
            if (currentADX < 20) {
                // Range-bound: suppress signals to avoid whipsaw losses
                scoreBuy *= 0.6;
                scoreSell *= 0.6;
            } else if (currentADX > 25) {
                // Trending: boost signals to speed up entries
                scoreBuy += 0.5;
                scoreSell += 0.5;
            }
        }

        // ============================================================
        // LAYER 5: Anti-Whipsaw Filters
        // ============================================================

        // Conflict filter: if both sides scored high, it's ambiguous → HOLD
        if (scoreBuy >= 2.0 && scoreSell >= 2.0) {
            const ratio = Math.min(scoreBuy, scoreSell) / Math.max(scoreBuy, scoreSell);
            if (ratio > 0.6) { // Scores too close → conflicting
                return { signal: 0, confidence: 50 };
            }
        }

        // Volume confirmation via OBV (soft filter — reduce score instead of blocking)
        if (volumes && volumes.length === closes.length) {
            const obv = this.calculateOBV(closes, volumes);
            const obvEma20 = this.calculateEMA(obv, 20);
            const lastObv = obv[last];
            const lastObvEma20 = obvEma20[last];
            
            if (lastObvEma20 !== null) {
                const obvDelta = lastObv - lastObvEma20;
                // Buy signal but money flowing OUT → reduce confidence
                if (scoreBuy >= 2.5 && obvDelta < 0) {
                    scoreBuy *= 0.65;
                }
                // Sell signal but money flowing IN → reduce confidence
                if (scoreSell >= 2.5 && obvDelta > 0) {
                    scoreSell *= 0.65;
                }
                // Volume confirmation bonus: OBV aligns with signal
                if (scoreBuy >= 2.0 && obvDelta > 0) {
                    scoreBuy += 0.5;
                }
                if (scoreSell >= 2.0 && obvDelta < 0) {
                    scoreSell += 0.5;
                }
            }
        }

        // ============================================================
        // FINAL DECISION — threshold lowered from 3.5 to 2.5
        // ============================================================
        let signal = 0;
        let confidence = 50;

        if (scoreBuy >= 2.5 && scoreBuy > scoreSell) {
            signal = 1;
            confidence = Math.min(95, Math.round(50 + (scoreBuy / 8) * 45));
        } else if (scoreSell >= 2.5 && scoreSell > scoreBuy) {
            signal = -1;
            confidence = Math.min(95, Math.round(50 + (scoreSell / 8) * 45));
        } else {
            signal = 0;
            confidence = Math.round(100 - Math.max(scoreBuy, scoreSell) * 12);
        }

        return { signal, confidence };
    }

    /**
     * Detect if market is in range-bound (sideway) condition
     */
    isMarketSideway(closes: number[], highs: number[], lows: number[]): boolean {
        if (closes.length < 30) return false;
        
        // Calculate Bollinger Bands over 20 period to measure volatility contraction
        const { bandwidth } = this.calculateBollingerBands(closes, 20);
        const last = bandwidth.length - 1;
        const currentBandwidth = bandwidth[last];

        if (currentBandwidth === null || isNaN(currentBandwidth)) {
            return false;
        }

        // If Bollinger Bandwidth is tight (< 0.035 / 3.5% of price spread), 
        // it signifies high range-bound consolidation suitable for Grid Trading!
        return currentBandwidth < 0.035;
    }

    /**
     * Train Meta-Labeling Model (Binary Logistic Regression).
     * Label 1 represents successful base model prediction (Win).
     * Label 0 represents failed base model prediction (Loss).
     */
    trainMetaModel(trainingData: LabeledDataPoint[], epochs = 300, lr = 0.03): MetaModel | null {
        if (!trainingData || trainingData.length === 0) return null;

        const numFeatures = trainingData[0].features.length;
        const { means, stdDevs } = computeFeatureNormalization(trainingData);

        const normalizedData = trainingData.map(d => ({
            ...d,
            features: normalizeFeatureVector(d.features, means, stdDevs)
        }));

        const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
        const lambda = 0.005; 

        const wt = Array(numFeatures).fill(0) as number[];
        let b = 0;

        const splitIdx = Math.floor(normalizedData.length * 0.85);
        const trainData = normalizedData.slice(0, splitIdx);
        const valData   = normalizedData.slice(splitIdx);
        const effectiveTrain = trainData.length >= 10 ? trainData : normalizedData;

        let bestWeights = [...wt];
        let bestBias = b;
        let bestValLoss = Infinity;
        let noImprovementCount = 0;
        const patience = 3;

        for (let epoch = 0; epoch < epochs; epoch++) {
            for (let i = 0; i < effectiveTrain.length; i++) {
                const features = effectiveTrain[i].features;
                const label = effectiveTrain[i].label === 1 ? 1 : 0;
                const sampleW = effectiveTrain[i].weight ?? 1.0;

                let dot = b;
                for (let j = 0; j < numFeatures; j++) dot += features[j] * wt[j];
                
                const pred = sigmoid(dot);
                const err = (pred - label) * sampleW;

                b -= lr * err;
                for (let j = 0; j < numFeatures; j++) {
                    wt[j] -= lr * (err * features[j] + lambda * wt[j]);
                }
            }

            if (valData.length >= 3) {
                let valLoss = 0;
                for (const d of valData) {
                    let dot = b;
                    for (let j = 0; j < numFeatures; j++) dot += d.features[j] * wt[j];
                    const p = sigmoid(dot);
                    const y = d.label === 1 ? 1 : 0;
                    valLoss += -(y * Math.log(p + 1e-12) + (1 - y) * Math.log(1 - p + 1e-12));
                }
                valLoss = valLoss / valData.length;

                if (valLoss < bestValLoss) {
                    bestValLoss = valLoss;
                    bestWeights = [...wt];
                    bestBias = b;
                    noImprovementCount = 0;
                } else {
                    noImprovementCount++;
                    if (noImprovementCount >= patience) {
                        break;
                    }
                }
            } else {
                bestWeights = [...wt];
                bestBias = b;
            }
        }

        return {
            weights: bestWeights,
            bias: bestBias,
            featureMeans: means,
            featureStdDevs: stdDevs
        };
    }

    /**
     * Predict the success probability of a trade signal.
     * Returns a probability value between 0.0 and 1.0.
     */
    predictMetaModel(model: MetaModel | null, targetFeatures: number[]): number {
        if (!model) return 1.0; 

        const sigmoid = (z: number) => 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
        const means = model.featureMeans ?? Array(targetFeatures.length).fill(0);
        const stdDevs = model.featureStdDevs ?? Array(targetFeatures.length).fill(1);
        const features = normalizeFeatureVector(targetFeatures, means, stdDevs);

        let dot = model.bias;
        for (let i = 0; i < features.length; i++) {
            dot += features[i] * model.weights[i];
        }

        return sigmoid(dot);
    }
}
