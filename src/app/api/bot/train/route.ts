import { NextResponse } from 'next/server';
import { getBotEngine } from '@/lib/bot-engine';

export async function POST(req: Request) {
    try {
        const bot = getBotEngine();
        const { modelType } = await req.json();

        if (modelType !== 'knn' && modelType !== 'logistic' && modelType !== 'momentum' && modelType !== 'onnx' && modelType !== 'ensemble') {
            return NextResponse.json({ error: 'Invalid model' }, { status: 400 });
        }

        // ONNX models are trained in the background using Python.
        // We trigger trainOnnxAsync for all active pairs so the user gets real-time feedback.
        if (modelType === 'onnx') {
            bot.modelType = 'onnx';
            bot.activePairs.forEach(p => { 
                bot.trainOnnxAsync(p, bot.currentTimeframe);
                bot.aiBrainTrainedMap[p] = true; 
            });
            return NextResponse.json({
                success: true,
                accuracy: 'Training...',
                numBuy: 0,
                numSell: 0,
                numHold: 0,
                note: 'Running Python ONNX (XGBoost/LightGBM) training process in the background...',
                state: bot.getFullState()
            });
        }

        // Concurrently train models for all 3 active pairs in background
        const results = bot.activePairs.map(pair => bot.trainModel(modelType, pair));
        
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
