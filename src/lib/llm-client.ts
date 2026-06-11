/**
 * Provider-agnostic LLM client for the Quant Operator "AI Brain".
 *
 * Design goals:
 *  1. Switch provider with a single env var — no code changes.
 *  2. Force JSON output so the bot can act on the response deterministically.
 *  3. NEVER crash the bot: timeout + 1 retry, then a clean error the caller
 *     can use to fall back to the rule-based logic.
 *
 * Configuration (read at call time, so hot-swap works):
 *   LLM_PROVIDER  = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'off'   (default 'off')
 *   LLM_API_KEY   = api key for the provider
 *   LLM_MODEL     = model id (e.g. 'gpt-4o-mini', 'claude-3-5-haiku-20241022',
 *                   'gemini-2.5-flash', 'deepseek-chat')
 *
 * The strategist layer runs every ~30s, not on every tick — so model latency
 * of 1–5s is perfectly fine. We pick "Flash / mini" tier models by default.
 */

export type LLMProvider = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'off';

export interface LLMConfig {
    provider: LLMProvider;
    apiKey: string;
    model: string;
    timeoutMs: number;
}

export interface LLMCallResult<T = any> {
    ok: boolean;
    data?: T;
    raw?: string;
    error?: string;
    latencyMs?: number;
    provider?: LLMProvider;
    model?: string;
}

const DEFAULT_MODELS: Record<Exclude<LLMProvider, 'off'>, string> = {
    openai: 'gpt-4o-mini',
    anthropic: 'claude-3-5-haiku-20241022',
    gemini: 'gemini-2.5-flash',
    deepseek: 'deepseek-chat'
};

/**
 * Read config from env. Process.env access is wrapped so that this still
 * works in edge runtimes that may surface env vars differently.
 */
export function readLLMConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {} as Record<string, string | undefined>;
    const provider = (overrides.provider || env.LLM_PROVIDER || 'off') as LLMProvider;
    // Provider-specific key env vars (e.g. DEEPSEEK_API_KEY) are tried last.
    const providerKeyFallback = provider === 'deepseek' ? (env.DEEPSEEK_API_KEY ?? '') : '';
    // Priority: env LLM_API_KEY → override (from UI/bot state) → provider-specific env key
    const apiKey = (env.LLM_API_KEY?.trim()) || overrides.apiKey || providerKeyFallback;
    const fallbackModel = provider !== 'off' ? DEFAULT_MODELS[provider] : '';
    // Priority: env LLM_MODEL → override (from UI/bot state) → built-in default
    // env always wins so that .env is the single source of truth for production.
    const model = (env.LLM_MODEL?.trim()) || overrides.model || fallbackModel;
    const timeoutMs = overrides.timeoutMs ?? 8000;
    return { provider, apiKey, model, timeoutMs };
}

export function isLLMConfigured(cfg: LLMConfig): boolean {
    return cfg.provider !== 'off' && !!cfg.apiKey && !!cfg.model;
}

/** Fetch with timeout — falls back cleanly when the provider hangs. */
async function fetchWithTimeout(url: string, init: any, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...init, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

/** Extract the first JSON object substring from arbitrary text. LLMs love to
 * wrap JSON in prose / markdown code fences even when told not to. */
function extractJson(raw: string): any | null {
    if (!raw) return null;
    // Try a direct parse first (fast path when the model obeys).
    try { return JSON.parse(raw); } catch { /* fall through */ }
    // Strip markdown fences.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)```/);
    if (fenced) {
        try { return JSON.parse(fenced[1]); } catch { /* fall through */ }
    }
    // Greedy: first '{' to last '}'.
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first >= 0 && last > first) {
        try { return JSON.parse(raw.slice(first, last + 1)); } catch { /* fall through */ }
    }
    return null;
}

// ============================================================
// Provider adapters — all return raw model text. The shared
// callLLM wrapper handles JSON extraction + retry + timing.
// ============================================================

async function callOpenAICompatible(baseUrl: string, providerName: string, cfg: LLMConfig, system: string, user: string): Promise<string> {
    const res = await fetchWithTimeout(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({
            model: cfg.model,
            temperature: 0.2,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user }
            ]
        })
    }, cfg.timeoutMs);
    if (!res.ok) throw new Error(`${providerName} ${res.status}: ${await res.text()}`);
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
}

async function callOpenAI(cfg: LLMConfig, system: string, user: string): Promise<string> {
    return callOpenAICompatible('https://api.openai.com', 'OpenAI', cfg, system, user);
}

async function callDeepSeek(cfg: LLMConfig, system: string, user: string): Promise<string> {
    return callOpenAICompatible('https://api.deepseek.com', 'DeepSeek', cfg, system, user);
}

async function callAnthropic(cfg: LLMConfig, system: string, user: string): Promise<string> {
    const res = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': cfg.apiKey,
            'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
            model: cfg.model,
            max_tokens: 1024,
            temperature: 0.2,
            system,
            messages: [{ role: 'user', content: user }]
        })
    }, cfg.timeoutMs);
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const j = await res.json();
    // Claude returns content as an array of blocks.
    const block = (j.content || []).find((b: any) => b.type === 'text');
    return block?.text || '';
}

async function callGemini(cfg: LLMConfig, system: string, user: string): Promise<string> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent?key=${cfg.apiKey}`;
    const res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json'
            }
        })
    }, cfg.timeoutMs);
    if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
    const j = await res.json();
    const parts = j.candidates?.[0]?.content?.parts || [];
    return parts.map((p: any) => p.text || '').join('');
}

/**
 * Single call with timeout + 1 retry on transient failure.
 * Returns a structured result (never throws) so the caller can fall back.
 */
export async function callLLM<T = any>(
    system: string,
    user: string,
    overrides: Partial<LLMConfig> = {}
): Promise<LLMCallResult<T>> {
    const cfg = readLLMConfig(overrides);
    if (!isLLMConfigured(cfg)) {
        return { ok: false, error: 'LLM not configured (set LLM_PROVIDER + LLM_API_KEY).' };
    }

    const started = Date.now();
    const maxAttempts = 2;
    let lastErr = '';
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            let raw = '';
            if (cfg.provider === 'openai') raw = await callOpenAI(cfg, system, user);
            else if (cfg.provider === 'anthropic') raw = await callAnthropic(cfg, system, user);
            else if (cfg.provider === 'gemini') raw = await callGemini(cfg, system, user);
            else if (cfg.provider === 'deepseek') raw = await callDeepSeek(cfg, system, user);
            else throw new Error(`Unknown provider: ${cfg.provider}`);

            const parsed = extractJson(raw);
            return {
                ok: !!parsed,
                data: parsed as T,
                raw,
                error: parsed ? undefined : 'Could not parse JSON from model response.',
                latencyMs: Date.now() - started,
                provider: cfg.provider,
                model: cfg.model
            };
        } catch (e: any) {
            lastErr = e?.message || String(e);
            // Only retry transient-looking errors (timeouts, 5xx, network).
            const transient = lastErr.includes('aborted') || lastErr.includes('timeout') || /\b5\d\d\b/.test(lastErr);
            if (!transient || attempt === maxAttempts - 1) break;
        }
    }
    return {
        ok: false,
        error: lastErr,
        latencyMs: Date.now() - started,
        provider: cfg.provider,
        model: cfg.model
    };
}
