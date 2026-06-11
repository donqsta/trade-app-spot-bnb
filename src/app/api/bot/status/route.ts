import { NextResponse } from 'next/server';
import { getBotEngine } from '@/lib/bot-engine';

export async function GET() {
    try {
        const bot = getBotEngine();
        if (bot.liveTradingMode !== 'simulated') {
            await bot.syncLiveBinanceState();
        }
        return NextResponse.json(bot.getFullState());
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}

export async function POST(req: Request) {
    try {
        const bot = getBotEngine();
        const data = await req.json();

        if (data.action === 'optimize') {
            const optRes = bot.autoOptimizeHyperparameters();
            return NextResponse.json({ 
                success: optRes.success, 
                optimized: true, 
                bestPnL: optRes.success ? (optRes as any).bestPnL : 0,
                params: optRes.success ? (optRes as any).params : null, 
                state: bot.getFullState() 
            });
        }

        if (typeof data.botRunning === 'boolean') {
            bot.setBotRunning(data.botRunning);
        }

        if (typeof data.quantOperatorEnabled === 'boolean') {
            const wasEnabled = bot.quantOperatorEnabled;
            bot.quantOperatorEnabled = data.quantOperatorEnabled;
            if (wasEnabled !== data.quantOperatorEnabled) {
                bot.addLog('SYSTEM', `QUANT OPERATOR BRAIN (LLM) Configuration: ${bot.quantOperatorEnabled ? 'ACTIVE 🧠' : 'OFF 🔴'}`, 'info-line');
                if (bot.quantOperatorEnabled) {
                    bot.runQuantOperator(true);
                }
            }
        }

        if (typeof data.gridModeEnabled === 'boolean') {
            const wasGrid = bot.gridModeEnabled;
            bot.gridModeEnabled = data.gridModeEnabled;
            if (wasGrid !== data.gridModeEnabled) {
                bot.addLog('SYSTEM', `AI Smart Grid Configuration: ${bot.gridModeEnabled ? 'ACTIVE 🤖' : 'OFF 🔴'}`, 'info-line');
                if (!bot.gridModeEnabled) {
                    bot.activePairs.forEach(pair => {
                        if (bot.gridActiveMap[pair]) {
                            bot.dismantleGrid(pair, 'Manual disable');
                        }
                    });
                }
            }
        }

        if (typeof data.dcaEnabled === 'boolean') {
            const wasDca = bot.dcaEnabled;
            bot.dcaEnabled = data.dcaEnabled;
            if (wasDca !== data.dcaEnabled) {
                bot.addLog('SYSTEM', `Auto DCA Configuration: ${bot.dcaEnabled ? 'ACTIVE 🛒' : 'OFF 🔴'}`, 'info-line');
            }
        }

        if (typeof data.dcaMaxSteps === 'number' && data.dcaMaxSteps >= 1) {
            bot.dcaMaxSteps = data.dcaMaxSteps;
        }

        if (typeof data.dcaPriceDropPct === 'number' && data.dcaPriceDropPct > 0) {
            bot.dcaPriceDropPct = data.dcaPriceDropPct;
        }

        if (Array.isArray(data.dcaCapitalAllocation)) {
            const sum = data.dcaCapitalAllocation.reduce((a: number, b: number) => a + b, 0);
            if (Math.abs(sum - 1.0) < 0.01) {
                bot.dcaCapitalAllocation = data.dcaCapitalAllocation;
            }
        }

        if (typeof data.confidenceThreshold === 'number') {
            bot.confidenceThreshold = data.confidenceThreshold;
        }

        if (typeof data.modelType === 'string') {
            const allowed = ['knn', 'logistic', 'momentum', 'ensemble', 'onnx'];
            if (allowed.includes(data.modelType)) {
                bot.modelType = data.modelType as any;
                if (data.modelType === 'onnx') {
                    bot.activePairs.forEach(p => { bot.aiBrainTrainedMap[p] = true; });
                }
                bot.addLog('SYSTEM', `AI algorithm configuration: ${data.modelType.toUpperCase()}`, 'info-line');
            }
        }

        if (typeof data.leverage === 'number') {
            bot.leverage = 1; // Force 1x Spot leverage (no leverage)
        }

        if (typeof data.riskRatio === 'number') {
            bot.riskRatio = data.riskRatio / 100; // convert percentage back to ratio
        }

        if (typeof data.dailyProfitTarget === 'number' && data.dailyProfitTarget > 0) {
            bot.dailyProfitTarget = Math.min(Math.max(data.dailyProfitTarget / 100, 0.01), 0.5);
            bot.addLog('SYSTEM', `Daily profit target configuration: ${(bot.dailyProfitTarget * 100).toFixed(1)}% (~$${bot.getDailyProfitTargetUsd().toFixed(2)})`, 'info-line');
        }

        if (typeof data.maxDailyDrawdown === 'number' && data.maxDailyDrawdown > 0) {
            bot.maxDailyDrawdown = Math.min(Math.max(data.maxDailyDrawdown / 100, 0.01), 0.5);
            bot.addLog('SYSTEM', `Daily loss limit configuration: ${(bot.maxDailyDrawdown * 100).toFixed(1)}% (~$${bot.getMaxDailyLossLimitUsd().toFixed(2)})`, 'info-line');
        }

        if (typeof data.stopOnTargetMet === 'boolean') {
            bot.stopOnTargetMet = data.stopOnTargetMet;
            bot.addLog('SYSTEM', `Stop trading when daily target met: ${bot.stopOnTargetMet ? 'ON 🎯' : 'OFF'}`, 'info-line');
        }

        if (typeof data.pauseNewEntries === 'boolean') {
            bot.pauseNewEntries = data.pauseNewEntries;
            bot.addLog('SYSTEM', `Pause new entry orders: ${bot.pauseNewEntries ? 'ON ⏸️' : 'OFF ▶️'}`, 'info-line');
        }

        if (typeof data.orderSizeMultiplier === 'number' && data.orderSizeMultiplier > 0) {
            const clamped = Math.min(Math.max(data.orderSizeMultiplier, 0.5), 5);
            bot.orderSizeMultiplier = clamped;
            bot.addLog('SYSTEM', `Order size multiplier configuration: x${clamped.toFixed(2)}`, 'info-line');
        }

        if (typeof data.tpAtrMultiplier === 'number') {
            bot.tpAtrMultiplier = data.tpAtrMultiplier;
        }

        if (typeof data.slAtrMultiplier === 'number') {
            bot.slAtrMultiplier = data.slAtrMultiplier;
        }

        if (typeof data.smartOrderAdjustment === 'boolean') {
            const wasSmart = bot.smartOrderAdjustment;
            bot.smartOrderAdjustment = data.smartOrderAdjustment;
            if (wasSmart !== data.smartOrderAdjustment) {
                bot.addLog('SYSTEM', `SMART QUANT Order Auto-Adjustment: ${bot.smartOrderAdjustment ? 'ACTIVE 🛡️' : 'OFF 🔴'}`, 'info-line');
            }
        }

        if (typeof data.riskReduction30ToEntry === 'boolean') {
            const wasReduction = bot.riskReduction30ToEntry;
            bot.riskReduction30ToEntry = data.riskReduction30ToEntry;
            if (wasReduction !== data.riskReduction30ToEntry) {
                bot.addLog('SYSTEM', `Move SL to break-even at 30% progress: ${bot.riskReduction30ToEntry ? 'ACTIVE 🛡️' : 'OFF 🔴'}`, 'info-line');
            }
        }

        if (typeof data.trailingTpMultiplier === 'number' && data.trailingTpMultiplier > 0) {
            bot.trailingTpMultiplier = data.trailingTpMultiplier;
        }
        if (typeof data.trailingTpActivation === 'number' && data.trailingTpActivation > 0 && data.trailingTpActivation <= 1) {
            bot.trailingTpActivation = data.trailingTpActivation;
        }
        if (typeof data.atrSpikeThreshold === 'number' && data.atrSpikeThreshold > 1) {
            bot.atrSpikeThreshold = data.atrSpikeThreshold;
        }
        if (typeof data.volSpikeThreshold === 'number' && data.volSpikeThreshold > 1) {
            bot.volSpikeThreshold = data.volSpikeThreshold;
        }

        if (typeof data.simulatedBalance === 'number') {
            // Check if setSimulatedCapital exists, otherwise do direct assign
            if (typeof (bot as any).setSimulatedCapital === 'function') {
                (bot as any).setSimulatedCapital(data.simulatedBalance);
            } else {
                bot.balance = data.simulatedBalance;
                bot.marginFree = data.simulatedBalance;
            }
        }

        if (typeof data.liveTradingMode === 'string') {
            const allowed = ['simulated', 'bsc_twak'];
            if (allowed.includes(data.liveTradingMode)) {
                await bot.changeLiveTradingMode(data.liveTradingMode as any);
            }
        }

        // ============================================================
        // LLM Brain configuration (Phase 1)
        // Same masking pattern as the Binance keys: only persist a real
        // value, never a masked placeholder echoed back from the UI.
        // ============================================================
        if (typeof data.llmProvider === 'string') {
            const allowed = ['openai', 'anthropic', 'gemini', 'deepseek', 'off'];
            if (allowed.includes(data.llmProvider)) {
                const prevProvider = bot.llmProvider;
                bot.llmProvider = data.llmProvider as any;
                // When provider changes, reset stored model so the correct default is used.
                // This prevents a stale model name (e.g. "gemini-2.5-flash") carrying over
                // to a new provider (e.g. deepseek) and causing API errors.
                if (prevProvider !== bot.llmProvider) {
                    const providerDefaults: Record<string, string> = {
                        openai: 'gpt-4o-mini',
                        anthropic: 'claude-3-5-haiku-20241022',
                        gemini: 'gemini-2.5-flash',
                        deepseek: 'deepseek-chat',
                    };
                    bot.llmModel = providerDefaults[bot.llmProvider] ?? '';
                }
                bot.addLog('SYSTEM', `🤖 Switched LLM provider: ${bot.llmProvider.toUpperCase()} (model: ${bot.llmModel || 'default'})`, 'info-line');
            }
        }
        if (typeof data.llmModel === 'string') {
            bot.llmModel = data.llmModel.trim();
        }
        if (typeof data.llmApiKey === 'string') {
            const cleanKey = data.llmApiKey.trim().replace(/\r/g, '');
            if (cleanKey !== '' && !cleanKey.includes('...')) {
                bot.llmApiKey = cleanKey;
            }
        }

        bot.persistState();
        return NextResponse.json({ success: true, state: bot.getFullState() });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
