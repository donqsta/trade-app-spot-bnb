import { NextResponse } from 'next/server';
import { getBotEngine } from '@/lib/bot-engine';

/**
 * Ultra-light liveness probe for Coolify / Kubernetes / any reverse proxy.
 *
 * IMPORTANT: this endpoint MUST NOT touch the Binance REST API. Every probe
 * (typically every 5–30s) would otherwise add to the IP rate-limit budget,
 * which is the very thing that produced the original HTTP 429 we fixed.
 *
 * We only return:
 *  - whether the singleton has started,
 *  - how many open positions / pairs are active,
 *  - last persisted-snapshot timestamp.
 *
 * If you need a deeper check, use `/api/bot/status` (heavier).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
    try {
        const bot = getBotEngine();
        return NextResponse.json({
            ok: true,
            uptime: typeof process !== 'undefined' && process.uptime ? Math.round(process.uptime()) : 0,
            activePairs: bot.activePairs.length,
            openPositions: bot.openPositions.length,
            liveTradingMode: bot.liveTradingMode,
            botRunning: bot.botRunning,
            quantOperatorEnabled: bot.quantOperatorEnabled,
            modelType: bot.modelType,
            // Last successful disk snapshot — useful to confirm the volume is mounted.
            persistenceSavedAt: (bot as any).getFullState?.()?.persistence?.mtime || null
        });
    } catch (e: any) {
        return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
    }
}
