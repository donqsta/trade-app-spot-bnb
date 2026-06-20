import { NextResponse } from 'next/server';
import { getBotEngine } from '@/lib/bot-engine';
import { checkAuth } from '@/lib/auth-helper';

export async function POST(req: Request) {
    if (!(await checkAuth())) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
        const bot = getBotEngine();
        const data = await req.json();

        // Pass parameters to the backtester
        const res = bot.runBacktest({
            confidenceThreshold: data.confidenceThreshold,
            leverage: data.leverage,
            riskRatio: data.riskRatio ? data.riskRatio / 100 : undefined,
            tpAtrMultiplier: data.tpAtrMultiplier,
            slAtrMultiplier: data.slAtrMultiplier
        });

        if (!res.success) {
            return NextResponse.json({ error: res.error }, { status: 400 });
        }

        return NextResponse.json(res);
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
