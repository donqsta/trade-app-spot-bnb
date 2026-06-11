/**
 * CmcPriceFeed — replaces Binance WebSocket in bsc_twak mode.
 *
 * Instead of streaming candles from Binance, this module polls the CMC REST API
 * every CMC_POLL_MS (default 30 s) for live quotes of the active pairs.
 * It maintains a rolling "synthetic candle" history so the rest of the engine
 * can build OHLCV arrays when needed. Each synthetic candle represents one
 * polling interval (OHLC = close price of the interval, volume from CMC 24h).
 *
 * Signals derived per poll (no candlestick data needed):
 *   momentum1h   — CMC percentChange1h    → quick signal
 *   momentum24h  — CMC percentChange24h   → daily trend
 *   momentum7d   — CMC percentChange7d    → HTF bias proxy
 *   volumeSurge  — volume24h > rolling avg * 1.5
 *
 * The feed fires two callbacks:
 *   onPriceUpdate  — every poll, gives latest price + metrics
 *   onEvalTick     — every EVAL_INTERVAL_MS (default 5 min), triggers a full
 *                    signal-evaluation cycle (replaces candle-close event)
 */

import { getTokenQuotes, type CryptoQuote } from './cmc-agent-hub';
import { pairToBscToken } from './twak-bsc-client';

// ─── Config ───────────────────────────────────────────────────────────────────

const CMC_POLL_MS     = 30_000;           // quote poll interval
const EVAL_INTERVAL_MS = 5 * 60_000;     // how often to trigger signal eval
const HISTORY_LIMIT   = 500;             // synthetic candle history length

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CmcPriceUpdate {
    symbol: string;          // e.g. "BNBUSDT"
    cmcSymbol: string;       // e.g. "BNB"
    price: number;
    change1h: number;
    change24h: number;
    change7d: number;
    volume24h: number;
    marketCap: number;
    /** Simple directional bias derived from CMC momentum: -1 bearish / 0 neutral / 1 bullish */
    htfBias: -1 | 0 | 1;
    /** True when 24h volume is 1.5× the rolling average volume */
    volumeSurge: boolean;
    ts: number;
}

export interface SyntheticCandle {
    time: number;   // Unix seconds
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number; // 24h volume from CMC (proxy)
}

// ─── CmcPriceFeed ─────────────────────────────────────────────────────────────

export class CmcPriceFeed {
    private pairs: string[];
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private evalTimer: ReturnType<typeof setInterval> | null = null;
    private stopped = false;

    /** Rolling synthetic candle history per pair symbol */
    readonly candles: Record<string, SyntheticCandle[]> = {};

    /** Volume history for surge detection (last 48 polls = ~24 min) */
    private volHistory: Record<string, number[]> = {};

    /** Callbacks */
    onPriceUpdate?: (update: CmcPriceUpdate) => void;
    onEvalTick?: (symbol: string, update: CmcPriceUpdate) => void;

    /** Latest snapshot per pair */
    private latest: Record<string, CmcPriceUpdate> = {};

    constructor(pairs: string[]) {
        this.pairs = pairs;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /** Start polling. Fires an immediate first poll then repeats. */
    async start() {
        this.stopped = false;
        await this.poll(); // immediate first tick

        this.pollTimer = setInterval(async () => {
            if (!this.stopped) await this.poll();
        }, CMC_POLL_MS);

        this.evalTimer = setInterval(() => {
            if (this.stopped) return;
            for (const pair of this.pairs) {
                const upd = this.latest[pair];
                if (upd && this.onEvalTick) {
                    this.onEvalTick(pair, upd);
                }
            }
        }, EVAL_INTERVAL_MS);
    }

    stop() {
        this.stopped = true;
        if (this.pollTimer)  { clearInterval(this.pollTimer);  this.pollTimer  = null; }
        if (this.evalTimer)  { clearInterval(this.evalTimer);  this.evalTimer  = null; }
    }

    updatePairs(pairs: string[]) {
        this.pairs = pairs;
    }

    getLatest(pair: string): CmcPriceUpdate | null {
        return this.latest[pair] ?? null;
    }

    getSyntheticCandles(pair: string): SyntheticCandle[] {
        return this.candles[pair] ?? [];
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private async poll() {
        // Convert internal pair symbols (e.g. BNBUSDT) → CMC symbols (e.g. BNB)
        const cmcSymbols = [...new Set(this.pairs.map(p => pairToBscToken(p)))];
        if (cmcSymbols.length === 0) return;

        let quotes: CryptoQuote[] = [];
        try {
            quotes = await getTokenQuotes(cmcSymbols);
        } catch (e) {
            console.error('[CmcFeed] poll error:', e);
            return;
        }

        const now = Math.floor(Date.now() / 1000);

        for (const pair of this.pairs) {
            const cmcSym = pairToBscToken(pair);
            const q = quotes.find(r => r.symbol.toUpperCase() === cmcSym.toUpperCase());
            if (!q) continue;

            // ── Volume surge detection ──────────────────────────────────────
            if (!this.volHistory[pair]) this.volHistory[pair] = [];
            const vh = this.volHistory[pair];
            vh.push(q.volume24h);
            if (vh.length > 48) vh.shift();
            const avgVol = vh.reduce((s, v) => s + v, 0) / vh.length;
            const volumeSurge = avgVol > 0 && q.volume24h > avgVol * 1.5;

            // ── HTF bias from CMC momentum ─────────────────────────────────
            // Use 7d change as primary HTF signal; 24h for confirmation.
            let htfBias: -1 | 0 | 1 = 0;
            if (q.percentChange7d >= 5 && q.percentChange24h >= 0) {
                htfBias = 1;     // bullish: rising 7d + positive today
            } else if (q.percentChange7d <= -5 && q.percentChange24h <= 0) {
                htfBias = -1;    // bearish: falling 7d + negative today
            }

            const update: CmcPriceUpdate = {
                symbol: pair,
                cmcSymbol: cmcSym,
                price: q.price,
                change1h: q.percentChange1h,
                change24h: q.percentChange24h,
                change7d: q.percentChange7d ?? 0,
                volume24h: q.volume24h,
                marketCap: q.marketCap,
                htfBias,
                volumeSurge,
                ts: Date.now(),
            };

            this.latest[pair] = update;

            // ── Synthetic candle ───────────────────────────────────────────
            const prevClose = this.candles[pair]?.at(-1)?.close ?? q.price;
            const priceHigh = Math.max(prevClose, q.price);
            const priceLow  = Math.min(prevClose, q.price);
            const synCandle: SyntheticCandle = {
                time:   now,
                open:   prevClose,
                high:   priceHigh,
                low:    priceLow,
                close:  q.price,
                volume: q.volume24h / (24 * (3600 / (CMC_POLL_MS / 1000))), // approximate slice of 24h vol
            };

            if (!this.candles[pair]) this.candles[pair] = [];
            const hist = this.candles[pair];
            const lastCandle = hist.at(-1);
            if (lastCandle && now - lastCandle.time < CMC_POLL_MS / 1000 * 0.8) {
                // Same polling bucket — update in place
                hist[hist.length - 1] = {
                    ...lastCandle,
                    high:  Math.max(lastCandle.high, q.price),
                    low:   Math.min(lastCandle.low, q.price),
                    close: q.price,
                };
            } else {
                hist.push(synCandle);
                if (hist.length > HISTORY_LIMIT) hist.shift();
            }

            // ── Notify listener ───────────────────────────────────────────
            if (this.onPriceUpdate) this.onPriceUpdate(update);
        }
    }
}

// ─── Singleton per process ────────────────────────────────────────────────────

let _feed: CmcPriceFeed | null = null;

export function getCmcPriceFeed(pairs?: string[]): CmcPriceFeed {
    if (!_feed) {
        _feed = new CmcPriceFeed(pairs ?? []);
    } else if (pairs) {
        _feed.updatePairs(pairs);
    }
    return _feed;
}

export function stopCmcPriceFeed() {
    _feed?.stop();
    _feed = null;
}
