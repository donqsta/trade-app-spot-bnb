import { NextResponse } from 'next/server';
import { getBotEngine } from '@/lib/bot-engine';

export async function POST(req: Request) {
    try {
        const bot = getBotEngine();
        const data = await req.json();

        if (data.action === 'update-entry') {
            const { symbol, entryPrice, openTime } = data;
            if (!symbol || typeof entryPrice !== 'number' || entryPrice <= 0) {
                return NextResponse.json({ error: 'Invalid symbol or entry price' }, { status: 400 });
            }
            bot.updateEntryDetailsManual(symbol, entryPrice, openTime);
            return NextResponse.json({ success: true, state: bot.getFullState() });
        }

        const { index } = data;

        if (typeof index !== 'number') {
            return NextResponse.json({ error: 'Invalid position index' }, { status: 400 });
        }

        const success = await bot.closePositionManual(index);
        
        if (!success) {
            return NextResponse.json({ error: 'Position to close not found' }, { status: 400 });
        }

        return NextResponse.json({ success: true, state: bot.getFullState() });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
