import { NextResponse } from 'next/server';
import { getBotEngine } from '@/lib/bot-engine';

export async function POST(req: Request) {
    try {
        const bot = getBotEngine();
        const { index } = await req.json();

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
