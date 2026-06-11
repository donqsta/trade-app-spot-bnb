import { NextResponse } from 'next/server';
import { getBotEngine } from '@/lib/bot-engine';

export async function POST(req: Request) {
    try {
        const bot = getBotEngine();
        const { pair, timeframe } = await req.json();

        if (!pair || !timeframe) {
            return NextResponse.json({ error: 'Missing pair or timeframe parameter' }, { status: 400 });
        }

        // If timeframe changed, reload all active pairs in bulk
        if (bot.currentTimeframe !== timeframe) {
            await bot.changeTimeframe(timeframe);
        }

        // Switch focused pair instantly
        if (bot.activePairs.includes(pair)) {
            bot.currentPair = pair;
        } else {
            // Dynamic fallback for any other pair
            const success = await bot.loadPairData(pair, timeframe);
            if (!success) {
                return NextResponse.json({ error: 'Failed to load candle data from Binance' }, { status: 400 });
            }
            bot.currentPair = pair;
        }

        return NextResponse.json({ success: true, state: bot.getFullState() });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
