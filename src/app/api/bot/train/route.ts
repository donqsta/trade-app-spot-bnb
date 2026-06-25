import { NextResponse } from 'next/server';
import { getBotEngine } from '@/lib/bot-engine';
import { checkAuth } from '@/lib/auth-helper';

export async function POST(req: Request) {
    if (!(await checkAuth())) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    try {
        const bot = getBotEngine();
        const { modelType } = await req.json();

        if (modelType !== 'knn' && modelType !== 'logistic' && modelType !== 'momentum' && modelType !== 'ensemble') {
            return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
        }

        // Concurrently train models for all 3 active pairs in background
        const results = await Promise.all(
            bot.activePairs.map(pair => bot.trainModel(modelType, pair))
        );
        
        // Find the result for the currently focused pair to return to UI stats
        const currentIdx = bot.activePairs.indexOf(bot.currentPair);
        const res = results[currentIdx] || { success: false, error: 'Training failed' };
        
        if (!res.success) {
            return NextResponse.json({ error: res.error }, { status: 400 });
        }

        return NextResponse.json({ 
            success: true, 
            accuracy: res.accuracy,
            numBuy: res.numBuy,
            numSell: res.numSell,
            numHold: res.numHold,
            state: bot.getFullState()
        });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
