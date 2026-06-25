/**
 * Provider-agnostic LLM client for the Quant Operator "AI Brain" - Simplified Local Version.
 *
 * Removes all external network API calls (OpenAI, Anthropic, Gemini, DeepSeek)
 * to run 100% locally on Node.js using local quantitative decision logic.
 */

import { runLocalQuantAI } from './local-quant-ai';

export type LLMProvider = 'local_ai' | 'off';

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

/**
 * Read config from env.
 */
export function readLLMConfig(overrides: Partial<LLMConfig> = {}): LLMConfig {
    const env = (typeof process !== 'undefined' && process.env) ? process.env : {} as Record<string, string | undefined>;
    const provider = (overrides.provider || env.LLM_PROVIDER || 'off') as LLMProvider;
    const model = overrides.model || 'local-quant';
    const timeoutMs = overrides.timeoutMs ?? 500;
    return { provider, apiKey: '', model, timeoutMs };
}

export function isLLMConfigured(cfg: LLMConfig): boolean {
    return cfg.provider === 'local_ai';
}

/**
 * Executes local Quant AI decision matrix.
 * Returns a structured result (never throws).
 */
export async function callLLM<T = any>(
    system: string,
    user: string,
    overrides: Partial<LLMConfig> = {}
): Promise<LLMCallResult<T>> {
    const cfg = readLLMConfig(overrides);
    if (!isLLMConfigured(cfg)) {
        return { ok: false, error: 'Local Quant AI Brain is turned off.' };
    }

    const started = Date.now();
    try {
        const decision = runLocalQuantAI(user);
        return {
            ok: true,
            data: decision as T,
            raw: JSON.stringify(decision),
            latencyMs: Date.now() - started,
            provider: 'local_ai',
            model: cfg.model
        };
    } catch (e: any) {
        return {
            ok: false,
            error: e?.message || String(e),
            latencyMs: Date.now() - started,
            provider: 'local_ai',
            model: cfg.model
        };
    }
}
