/**
 * CoinMarketCap AI Agent Hub client.
 *
 * Two data paths:
 *
 * A) CMC Skill Hub (MCP) — `https://mcp.coinmarketcap.com/skill-hub/stream`
 *    Header: X-CMC-MCP-API-KEY
 *    Tools: find_skill / execute_skill (pre-computed analytics, agent-ready)
 *    Used for: market overview snapshots fed directly to the LLM Quant Operator.
 *
 * B) CMC REST API — `https://pro-api.coinmarketcap.com`
 *    Header: X-CMC_PRO_API_KEY
 *    Used for: Fear & Greed, global metrics, token quotes (structured, cacheable).
 *
 * Both paths use the same API key from CMC_API_KEY env var.
 *
 * Rate limits: Free plan = 10k credits/month. Cache aggressively.
 *   - Skill Hub snapshots: cache 10 min
 *   - Fear & Greed: cache 30 min (updates daily)
 *   - Global metrics: cache 5 min
 *   - Quotes: cache 3 min
 *   - Trending: cache 10 min
 */

const CMC_BASE      = 'https://pro-api.coinmarketcap.com';
const CMC_SKILL_HUB = 'https://mcp.coinmarketcap.com/skill-hub/stream';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface FearAndGreedResult {
    score: number;            // 0–100
    classification: string;  // 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed'
    timestamp: string;
}

export interface GlobalMetrics {
    totalMarketCapUsd: number;
    totalVolume24hUsd: number;
    btcDominance: number;
    ethDominance: number;
    activeCurrencies: number;
    fearAndGreed: FearAndGreedResult;
    marketTrend: 'bullish' | 'neutral' | 'bearish';
}

export interface CryptoQuote {
    symbol: string;
    name: string;
    price: number;
    percentChange1h: number;
    percentChange24h: number;
    percentChange7d: number;
    marketCap: number;
    volume24h: number;
    lastUpdated: string;
}

export interface TrendingToken {
    symbol: string;
    name: string;
    percentChange24h: number;
    volume24h: number;
    price: number;
}

// ─── Cache layer ──────────────────────────────────────────────────────────────

interface CacheEntry<T> { data: T; ts: number }
const _cache: Record<string, CacheEntry<unknown>> = {};

function getCache<T>(key: string, ttlMs: number): T | null {
    const entry = _cache[key] as CacheEntry<T> | undefined;
    if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
    return null;
}
function setCache<T>(key: string, data: T): void {
    _cache[key] = { data, ts: Date.now() };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function cmcGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const apiKey = process.env.CMC_API_KEY;
    if (!apiKey) throw new Error('CMC_API_KEY env var not set');

    const url = new URL(`${CMC_BASE}${path}`);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const resp = await fetch(url.toString(), {
        headers: {
            'X-CMC_PRO_API_KEY': apiKey,
            'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(12_000),
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        let errMsg = text;
        try {
            const parsed = JSON.parse(text);
            if (parsed.status?.error_message) {
                errMsg = parsed.status.error_message;
            }
        } catch {}
        const cleanMsg = errMsg.replace(/\r?\n/g, ' ').trim().slice(0, 150);
        throw new Error(`CMC HTTP ${resp.status}: ${cleanMsg}`);
    }

    const json = await resp.json() as { status?: { error_code: number | string; error_message: string }; data?: unknown };
    const errCode = json.status?.error_code;
    if (errCode !== undefined && errCode !== null && String(errCode) !== '0') {
        const cleanMsg = (json.status?.error_message || '').replace(/\r?\n/g, ' ').trim().slice(0, 150);
        throw new Error(`CMC API error ${errCode}: ${cleanMsg}`);
    }
    return json.data;
}

/**
 * Call a CMC Skill Hub MCP tool via HTTP (Streamable HTTP transport).
 * tool:   'find_skill' | 'execute_skill'
 * params: tool-specific parameters
 */
async function cmcSkillHub(tool: string, params: Record<string, unknown>): Promise<unknown> {
    const apiKey = process.env.CMC_API_KEY;
    if (!apiKey) throw new Error('CMC_API_KEY env var not set');

    // MCP JSON-RPC 2.0 request format
    const body = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: {
            name: tool,
            arguments: params,
        },
    };

    const resp = await fetch(CMC_SKILL_HUB, {
        method: 'POST',
        headers: {
            'X-CMC-MCP-API-KEY': apiKey,
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000), // Skill Hub calls can take up to 300s (5 minutes)
    });

    if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`CMC Skill Hub HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }

    const contentType = resp.headers.get('content-type') || '';
    let raw: string;

    if (contentType.includes('text/event-stream')) {
        // Streamable HTTP — read SSE-framed response and extract the last data line
        raw = await resp.text();
        const lines = raw.split('\n').filter(l => l.startsWith('data:'));
        const lastData = lines[lines.length - 1]?.replace(/^data:\s*/, '') ?? '{}';
        try {
            const parsed = JSON.parse(lastData) as { result?: unknown; error?: unknown };
            if (parsed.error) throw new Error(`Skill Hub error: ${JSON.stringify(parsed.error)}`);
            return parsed.result;
        } catch {
            return lastData;
        }
    } else {
        raw = await resp.text();
        const parsed = JSON.parse(raw) as { result?: unknown; error?: unknown };
        if (parsed.error) throw new Error(`Skill Hub error: ${JSON.stringify(parsed.error)}`);
        return parsed.result;
    }
}

/**
 * Execute a named CMC Skill (pre-computed analytics pipeline).
 * Returns the skill output text/JSON.
 */
export async function executeSkill(
    skillName: string,
    parameters: Record<string, unknown> = {},
): Promise<string> {
    const TTL = 10 * 60_000;
    const key = `skill_${skillName}_${JSON.stringify(parameters)}`;
    const cached = getCache<string>(key, TTL);
    if (cached) return cached;

    const result = await cmcSkillHub('execute_skill', {
        unique_name: skillName,
        parameters,
    });

    // Skill results come as { content: [{ type: 'text', text: '...' }] }
    let text = '';
    if (typeof result === 'string') {
        text = result;
    } else if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if (Array.isArray(r.content)) {
            text = (r.content as Array<{ text?: string }>)
                .map(c => c.text ?? '')
                .join('\n');
        } else {
            text = JSON.stringify(result);
        }
    }

    setCache(key, text);
    return text;
}

/**
 * Find relevant CMC Skills for a query (like "btc price", "market overview").
 */
export async function findSkill(query: string): Promise<string[]> {
    const result = await cmcSkillHub('find_skill', { query });
    if (Array.isArray(result)) return result.map(r => String(r));
    if (result && typeof result === 'object') {
        const r = result as Record<string, unknown>;
        if (Array.isArray(r.content)) {
            return (r.content as Array<{ text?: string }>).map(c => c.text ?? '').filter(Boolean);
        }
    }
    return [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Crypto Fear & Greed Index — updates daily, cached 30 min.
 * Score: 0–100 (0 = Extreme Fear, 100 = Extreme Greed)
 */
export async function getFearAndGreed(): Promise<FearAndGreedResult> {
    const TTL = 30 * 60_000;
    const cached = getCache<FearAndGreedResult>('fg', TTL);
    if (cached) return cached;

    const data = await cmcGet('/v3/fear-and-greed/latest') as Record<string, unknown>;
    const result: FearAndGreedResult = {
        score: Number(data.value ?? data.score ?? 50),
        classification: String(data.value_classification ?? data.classification ?? 'Neutral'),
        timestamp: String(data.update_time ?? data.timestamp ?? new Date().toISOString()),
    };
    setCache('fg', result);
    return result;
}

/**
 * Global market metrics including Fear & Greed. Cached 5 min.
 */
export async function getGlobalMetrics(): Promise<GlobalMetrics> {
    const TTL = 5 * 60_000;
    const cached = getCache<GlobalMetrics>('global', TTL);
    if (cached) return cached;

    const [metricsRaw, fg] = await Promise.all([
        cmcGet('/v1/global-metrics/quotes/latest') as Promise<Record<string, unknown>>,
        getFearAndGreed(),
    ]);

    const metrics = metricsRaw as Record<string, unknown>;
    const quote = (metrics.quote as Record<string, unknown>)?.USD as Record<string, unknown> ?? {};
    const totalMcap = Number(quote.total_market_cap ?? 0);
    const totalVol = Number(quote.total_volume_24h ?? 0);
    const btcDom = Number(metrics.btc_dominance ?? 0);
    const ethDom = Number(metrics.eth_dominance ?? 0);

    // Derive simple trend from FG + BTC dominance
    let marketTrend: 'bullish' | 'neutral' | 'bearish' = 'neutral';
    if (fg.score >= 65) marketTrend = 'bullish';
    else if (fg.score <= 35) marketTrend = 'bearish';

    const result: GlobalMetrics = {
        totalMarketCapUsd: totalMcap,
        totalVolume24hUsd: totalVol,
        btcDominance: btcDom,
        ethDominance: ethDom,
        activeCurrencies: Number(metrics.active_cryptocurrencies ?? 0),
        fearAndGreed: fg,
        marketTrend,
    };
    setCache('global', result);
    return result;
}

/**
 * Quotes for a list of symbols (e.g. ['BNB', 'CAKE', 'LINK']).
 * Cached 3 min per symbol batch.
 */
export async function getTokenQuotes(symbols: string[]): Promise<CryptoQuote[]> {
    const key = `quotes_${symbols.sort().join(',')}`;
    const TTL = 3 * 60_000;
    const cached = getCache<CryptoQuote[]>(key, TTL);
    if (cached) return cached;

    const data = await cmcGet('/v2/cryptocurrency/quotes/latest', {
        symbol: symbols.join(','),
        convert: 'USD',
    }) as Record<string, unknown[]>;

    const results: CryptoQuote[] = [];
    for (const sym of symbols) {
        const entries = data[sym] ?? data[sym.toUpperCase()];
        if (!entries || !Array.isArray(entries) || entries.length === 0) continue;
        const entry = entries[0] as Record<string, unknown>;
        const q = (entry.quote as Record<string, unknown>)?.USD as Record<string, unknown> ?? {};
        results.push({
            symbol: sym,
            name: String(entry.name ?? sym),
            price: Number(q.price ?? 0),
            percentChange1h: Number(q.percent_change_1h ?? 0),
            percentChange24h: Number(q.percent_change_24h ?? 0),
            percentChange7d: Number(q.percent_change_7d ?? 0),
            marketCap: Number(q.market_cap ?? 0),
            volume24h: Number(q.volume_24h ?? 0),
            lastUpdated: String(q.last_updated ?? new Date().toISOString()),
        });
    }

    setCache(key, results);
    return results;
}

/**
 * Single token quote shorthand.
 */
export async function getTokenQuote(symbol: string): Promise<CryptoQuote | null> {
    const quotes = await getTokenQuotes([symbol]);
    return quotes[0] ?? null;
}

/**
 * Top trending/gaining tokens over 24h. Cached 10 min.
 */
export async function getTrendingGainers(limit = 10): Promise<TrendingToken[]> {
    const TTL = 10 * 60_000;
    const cached = getCache<TrendingToken[]>('gainers', TTL);
    if (cached) return cached;

    try {
        const data = await cmcGet('/v1/cryptocurrency/trending/gainers-losers', {
            limit: String(limit),
            convert: 'USD',
            time_period: '24h',
            sort_dir: 'desc',
        }) as Record<string, unknown>[];

        const results: TrendingToken[] = (data ?? []).map((item) => {
            const i = item as Record<string, unknown>;
            const q = ((i.quote as Record<string, unknown>)?.USD as Record<string, unknown>) ?? {};
            return {
                symbol: String(i.symbol ?? ''),
                name: String(i.name ?? ''),
                percentChange24h: Number(q.percent_change_24h ?? 0),
                volume24h: Number(q.volume_24h ?? 0),
                price: Number(q.price ?? 0),
            };
        });

        setCache('gainers', results);
        return results;
    } catch (e: any) {
        console.warn('[CMC] getTrendingGainers failed (likely plan limitation):', e.message || e);
        return [];
    }
}

/**
 * Community trending tokens. Cached 10 min.
 */
export async function getCommunityTrending(limit = 10): Promise<TrendingToken[]> {
    const TTL = 10 * 60_000;
    const cached = getCache<TrendingToken[]>('trending', TTL);
    if (cached) return cached;

    try {
        const data = await cmcGet('/v1/cryptocurrency/trending/most-visited', {
            limit: String(limit),
            convert: 'USD',
            time_period: '24h',
        }) as Record<string, unknown>[];

        const results: TrendingToken[] = (data ?? []).map((item) => {
            const i = item as Record<string, unknown>;
            const q = ((i.quote as Record<string, unknown>)?.USD as Record<string, unknown>) ?? {};
            return {
                symbol: String(i.symbol ?? ''),
                name: String(i.name ?? ''),
                percentChange24h: Number(q.percent_change_24h ?? 0),
                volume24h: Number(q.volume_24h ?? 0),
                price: Number(q.price ?? 0),
            };
        });

        setCache('trending', results);
        return results;
    } catch {
        return [];
    }
}

/**
 * Convenience: get a summary for the LLM Quant Operator context.
 * Returns a compact object ready to embed in MarketContext.
 */
export async function getCMCMarketSnapshot(): Promise<{
    fearAndGreedScore: number;
    fearAndGreedLabel: string;
    marketTrend: string;
    btcDominance: number;
    totalMarketCapUsd: number;
    topGainers: string[];
    skillHubSummary?: string; // rich narrative from CMC Skill Hub
} | null> {
    try {
        // Fire all three in parallel; Skill Hub may fail gracefully
        const [global, gainers, skillText] = await Promise.all([
            getGlobalMetrics(),
            getTrendingGainers(5),
            executeSkill('daily_market_overview', { preview: true }).catch(() => null),
        ]);

        return {
            fearAndGreedScore: global.fearAndGreed.score,
            fearAndGreedLabel: global.fearAndGreed.classification,
            marketTrend: global.marketTrend,
            btcDominance: global.btcDominance,
            totalMarketCapUsd: global.totalMarketCapUsd,
            topGainers: gainers.map(g => `${g.symbol}(+${g.percentChange24h.toFixed(1)}%)`),
            skillHubSummary: skillText ?? undefined,
        };
    } catch (e) {
        console.error('[CMC] getCMCMarketSnapshot failed:', e);
        return null;
    }
}
