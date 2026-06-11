/**
 * Grok X Sentiment fetcher.
 *
 * Uses xAI Responses API (`/v1/responses`) with the `x_search` tool to
 * retrieve real-time post sentiment on X for a given coin symbol.
 *
 * Design:
 *  - One API call per coin per cache window (default 30 minutes).
 *  - Non-blocking: always returns cached data or null, never throws.
 *  - Calls are serialised (no concurrent bursts) to respect xAI rate limits.
 *  - Env: XAI_API_KEY (required). If absent, all calls return null silently.
 *
 * Cost estimate (grok-4.3 @ $1.25/1M input, $2.50/1M output):
 *   ~1000 input + 300 output tokens per call = ~$0.0016 per call.
 *   4 coins × 48 calls/day = ~$0.31/day — negligible.
 */

export interface SentimentResult {
    /** Normalised score: -1 (very bearish) to +1 (very bullish). */
    score: number;
    /** Post volume vs baseline on X today. */
    volume: 'low' | 'normal' | 'high' | 'spiking';
    /** One-sentence summary of the dominant narrative on X. */
    narrative: string;
    /** Unix ms when this result was fetched. */
    fetchedAt: number;
}

interface CacheEntry {
    data: SentimentResult;
    ts: number;
}

const cache: Record<string, CacheEntry> = {};
let fetchQueue: Promise<any> = Promise.resolve();

const CACHE_TTL_MS = 30 * 60_000; // 30 minutes

/** Extract coin ticker from a trading symbol (BTCUSDT → BTC, SOLUSDT → SOL). */
function symbolToTicker(symbol: string): string {
    return symbol.replace(/USDT$/i, '').replace(/BUSD$/i, '');
}

/** Extract the final assistant text from a Responses API reply. */
function extractResponseText(body: any): string {
    const output = body?.output ?? [];
    for (const item of output) {
        if (item?.type === 'message' && Array.isArray(item?.content)) {
            for (const c of item.content) {
                if (c?.type === 'output_text' && typeof c?.text === 'string') {
                    return c.text;
                }
            }
        }
    }
    return '';
}

/** Best-effort JSON extraction from model text (may be wrapped in prose). */
function extractJson(raw: string): any | null {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { /* fall through */ }
    const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (fenced) { try { return JSON.parse(fenced[1]); } catch { /* fall through */ } }
    const first = raw.indexOf('{');
    const last  = raw.lastIndexOf('}');
    if (first >= 0 && last > first) { try { return JSON.parse(raw.slice(first, last + 1)); } catch { /* fall through */ } }
    return null;
}

async function fetchSentimentFromApi(symbol: string): Promise<SentimentResult | null> {
    const apiKey = (typeof process !== 'undefined' && process.env?.XAI_API_KEY) || '';
    if (!apiKey) return null;

    const ticker = symbolToTicker(symbol);
    const now = new Date();
    const fromDate = new Date(now.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
    const toDate   = now.toISOString().slice(0, 10);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000); // 20s timeout

    try {
        const res = await fetch('https://api.x.ai/v1/responses', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'grok-4.3',
                input: [{
                    role: 'user',
                    content: [
                        `Search X (Twitter) for posts about ${ticker} crypto in the last 24 hours.`,
                        `Return a JSON object with EXACTLY these keys (no other text):`,
                        `{ "score": <number -1 to 1>, "volume": <"low"|"normal"|"high"|"spiking">, "narrative": <string max 120 chars> }`,
                        `Where:`,
                        `  score = -1 (extremely bearish) to +1 (extremely bullish), 0 = neutral`,
                        `  volume = relative post volume vs baseline ("spiking" means >5x normal)`,
                        `  narrative = dominant theme/event driving the conversation`,
                        `Return ONLY the JSON object.`
                    ].join('\n')
                }],
                tools: [{
                    type: 'x_search',
                    from_date: fromDate,
                    to_date: toDate
                }]
            }),
            signal: controller.signal
        });

        clearTimeout(timer);

        if (!res.ok) {
            console.warn(`[Grok] API error ${res.status} for ${symbol}`);
            return null;
        }

        const body = await res.json();
        const text = extractResponseText(body);
        const parsed = extractJson(text);

        if (!parsed || typeof parsed.score !== 'number') return null;

        return {
            score: Math.max(-1, Math.min(1, Number(parsed.score) || 0)),
            volume: (['low', 'normal', 'high', 'spiking'].includes(parsed.volume) ? parsed.volume : 'normal') as SentimentResult['volume'],
            narrative: typeof parsed.narrative === 'string' ? parsed.narrative.slice(0, 120) : '',
            fetchedAt: Date.now()
        };
    } catch (e: any) {
        clearTimeout(timer);
        if (e?.name !== 'AbortError') {
            console.warn(`[Grok] Fetch error for ${symbol}: ${e?.message}`);
        }
        return null;
    }
}

/**
 * Get X sentiment for a symbol.
 * Returns cached data if fresh (< CACHE_TTL_MS), otherwise fetches in background
 * and returns the stale cache immediately (non-blocking).
 * If no cache exists, waits for the first fetch (cold start).
 */
export async function getXSentiment(symbol: string): Promise<SentimentResult | null> {
    const key = symbol.toUpperCase();
    const hit = cache[key];
    const now = Date.now();

    if (hit && (now - hit.ts) < CACHE_TTL_MS) {
        return hit.data;
    }

    // Serialise calls to avoid bursting xAI API.
    fetchQueue = fetchQueue.then(async () => {
        try {
            const result = await fetchSentimentFromApi(key);
            if (result) {
                cache[key] = { data: result, ts: Date.now() };
            }
        } catch { /* swallow */ }
    });

    if (hit) {
        // Return stale data immediately while refresh runs in background.
        return hit.data;
    }

    // Cold start: wait for the first result.
    await fetchQueue;
    return cache[key]?.data ?? null;
}

/**
 * Kick off background refresh for a set of symbols without blocking.
 * Call this from a periodic interval in the bot engine.
 */
export function refreshSentimentBatch(symbols: string[]): void {
    for (const sym of symbols) {
        const key = sym.toUpperCase();
        const hit = cache[key];
        const now = Date.now();
        if (!hit || (now - hit.ts) >= CACHE_TTL_MS) {
            getXSentiment(key).catch(() => { /* swallow */ });
        }
    }
}

/** Age in minutes of the cached sentiment for a symbol (null if no cache). */
export function sentimentAgeMinutes(symbol: string): number | null {
    const hit = cache[symbol.toUpperCase()];
    if (!hit) return null;
    return (Date.now() - hit.ts) / 60_000;
}
