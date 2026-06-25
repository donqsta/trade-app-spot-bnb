import type { MarketContext, QuantOperatorDecision, PositionAdjustment } from './market-context';

/**
 * Built-in Local Quant AI Engine (Smart Upgrade).
 * Parses the stringified MarketContext passed to the LLM and runs a multi-factor
 * quantitative decision matrix to determine the optimal trading regime, timeframe,
 * model type, risk, SL/TP scalers, and active position adjustments.
 *
 * Fuses machine learning ensemble signals, dynamic ATR measurements, and funding rate
 * leverage warnings to perform institutional-grade local risk management.
 */
export function runLocalQuantAI(userPrompt: string): QuantOperatorDecision {
    try {
        const jsonStart = userPrompt.indexOf('{');
        const jsonEnd = userPrompt.lastIndexOf('}');
        if (jsonStart < 0 || jsonEnd <= jsonStart) {
            throw new Error('Could not find JSON payload in user prompt');
        }
        const ctxJson = userPrompt.slice(jsonStart, jsonEnd + 1);
        const ctx = JSON.parse(ctxJson) as MarketContext;
        return evaluateLocalQuantDecision(ctx);
    } catch (e: any) {
        return {
            regime: 'FALLBACK_LOCAL_ERROR',
            timeframe: '15m',
            modelType: 'momentum',
            gridMode: false,
            riskMultiplier: 1.0,
            confidence: 50,
            reasoning: 'Lỗi đồng bộ dữ liệu cục bộ: ' + e.message,
            slTightnessMultiplier: 1.0,
            tpExtensionMultiplier: 1.0,
            trailingTpAggressiveness: 1.0,
            forceExit: false,
            targetMetAction: 'NORMAL',
            positionAdjustments: []
        };
    }
}

function evaluateLocalQuantDecision(ctx: MarketContext): QuantOperatorDecision {
    const pairSymbol = ctx.activePair;
    const activePairMetrics = ctx.pairs.find(p => p.symbol === pairSymbol);

    // Default indicators if metrics are missing
    const chop = activePairMetrics?.choppiness ?? 50;
    const vol = activePairMetrics?.volatility ?? 0.5; // Volatility as % of price
    const trend = activePairMetrics?.trendIntensity ?? 25;
    const macroBias = activePairMetrics?.macroBias ?? 0;
    const fundingRate = (activePairMetrics as any)?.fundingRate ?? 0; // Raw fraction (e.g. 0.0001 = 0.01%)
    const oiChange = (activePairMetrics as any)?.openInterestChange ?? 0; // % change in OI
    const livePrice = activePairMetrics?.livePrice ?? 0;
    const hurst = (activePairMetrics as any)?.hurst ?? 0.5;
    const adx = (activePairMetrics as any)?.adx ?? 20;

    // Reconstruct ATR in price units from volatility (which is ATR/Price * 100)
    // Avoid division by zero or NaN issues
    const safeVol = (vol > 0 && !isNaN(vol)) ? vol : 0.5;
    const atrFraction = safeVol / 100;
    const atr = livePrice > 0 ? (livePrice * atrFraction) : 0;

    // 1. Ensemble Signal Analysis & Fusion
    const ensemble = ctx.ensembleSignal;
    const hasEnsemble = !!ensemble && ensemble.direction && ensemble.consensus;
    const ensembleDir = ensemble?.direction ?? 'HOLD';
    const ensembleConsensus = ensemble?.consensus ?? 'split';
    const ensembleConf = ensemble?.confidence ?? 50;

    // 2. Volatility & Hurst Regime Clustering
    let regime = 'RANGE_BOUND';
    const isExtremeVol = vol > 1.2;
    const isCompressedAccumulation = (hurst < 0.45 || chop > 58) && vol < 0.4 && trend < 20;

    if (isExtremeVol) {
        regime = 'EXHAUSTION_CLIMAX'; // Extreme volatility spike
    } else if (hurst > 0.53 && adx > 22) {
        regime = 'STRONG_CONFORMING_TREND'; // Strong mathematical trending expansion
    } else if (isCompressedAccumulation) {
        regime = 'COMPRESSED_ACCUMULATION'; // Low volatility, tight sideways range
    } else if (hurst < 0.47 && adx < 18) {
        regime = 'STABLE_MEAN_REVERTING'; // Statistically mean-reverting range
    } else {
        regime = macroBias > 0 ? 'MODERATE_TREND_UP' : (macroBias < 0 ? 'MODERATE_TREND_DOWN' : 'BALANCED');
    }

    // 3. Timeframe Selection Rules (pinned to indicator bands)
    let timeframe: '1m' | '5m' | '15m' | '1h' = '15m';
    if (vol > 2.5 && chop < 38 && trend > 70) {
        timeframe = '1m'; // High-volatility fast scalp
    } else if (hurst > 0.55 && adx > 28 && vol > 0.8) {
        timeframe = '1h'; // Long macro trends
    } else if (hurst < 0.45 || chop > 52 || (vol < 0.4 && trend < 30)) {
        timeframe = '5m'; // Low timeframe range-bound oscillations
    } else {
        timeframe = '15m'; // Default balanced timeframe
    }

    // 4. Model Selection Rules
    let modelType: 'knn' | 'logistic' | 'momentum' = 'momentum';
    if (hurst > 0.53 && adx > 22) {
        modelType = 'momentum'; // Trend bám đuổi
    } else if (hurst < 0.47 && adx < 18) {
        modelType = 'knn'; // Pattern cluster recognition
    } else {
        modelType = 'logistic'; // Dynamic linear weight classification
    }

    // 5. Grid Mode Activation
    // Smart Grid triggers in stable mean-reverting markets to extract profits from oscillations
    const gridMode = (regime === 'COMPRESSED_ACCUMULATION' || regime === 'STABLE_MEAN_REVERTING') && vol < 0.8;

    // 6. Leverage Risk Protections (Funding & Open Interest Delta)
    let hasLongSqueezeRisk = false;
    let hasShortSqueezeRisk = false;

    // Raw funding rate threshold of 0.0005 corresponds to 0.05% per 8 hours
    if (fundingRate >= 0.0005 && oiChange > 5) {
        hasLongSqueezeRisk = true; // Retail heavily long, prone to long liquidations
    } else if (fundingRate <= -0.0005 && oiChange > 5) {
        hasShortSqueezeRisk = true; // Retail heavily short, prone to short squeezes
    }

    // 7. Base Multipliers & Daily Target Defense
    let riskMultiplier = 1.0;
    let slTightnessMultiplier = 1.0;
    let tpExtensionMultiplier = 1.0;
    let trailingTpAggressiveness = 1.0;
    let forceExit = false;
    let targetMetAction: 'NORMAL' | 'PAUSE_NEW_ENTRIES' = 'NORMAL';

    const progressPct = (ctx as any).dailyTargetProgressPct ?? 0;
    const dailyPnL = ctx.dailyPnL;
    const maxLossLimit = ctx.maxDailyDrawdownLimitUsd;
    const drawdownFromPeak = ctx.currentDrawdownFromPeak;
    const winrate = ctx.recentTrades?.winrateLast20 ?? 50;

    // Daily Profit Target protection
    if (progressPct >= 100) {
        targetMetAction = 'PAUSE_NEW_ENTRIES';
        riskMultiplier = 0.5;
        slTightnessMultiplier = 0.75;
        trailingTpAggressiveness = 1.5;
    } else if (progressPct >= 80) {
        // Protect daily profits near the target
        slTightnessMultiplier = 0.85;
        trailingTpAggressiveness = 1.3;
        tpExtensionMultiplier = 0.9;
    } else {
        tpExtensionMultiplier = 1.1; // Far from target: let trends develop
    }

    // Daily Loss Limit protection
    const lossPctOfLimit = maxLossLimit > 0 ? (-dailyPnL / maxLossLimit) : 0;
    if (dailyPnL < 0) {
        if (lossPctOfLimit >= 0.9) {
            forceExit = true;
            riskMultiplier = 0.3;
            slTightnessMultiplier = 0.6;
        } else if (lossPctOfLimit >= 0.7) {
            riskMultiplier = 0.3;
            slTightnessMultiplier = 0.7;
        } else if (lossPctOfLimit >= 0.4) {
            riskMultiplier = 0.6;
            slTightnessMultiplier = 0.8;
        }
    }

    // Drawdown safety multiplier
    if (drawdownFromPeak > 0.03) {
        riskMultiplier *= 0.7;
        slTightnessMultiplier = Math.min(slTightnessMultiplier, 0.8);
    }

    // Volatility protection
    if (vol > 1.4) {
        riskMultiplier *= 0.8;
        slTightnessMultiplier = Math.min(slTightnessMultiplier, 0.8);
        trailingTpAggressiveness = Math.max(trailingTpAggressiveness, 1.25);
    }

    // 8. Fusing Ensemble Signals into Multipliers
    if (hasEnsemble) {
        if (ensembleConsensus === 'unanimous') {
            // High confidence, strong agreement: scale up slightly
            if (ensembleDir === 'LONG' || ensembleDir === 'SHORT') {
                riskMultiplier *= 1.2;
                tpExtensionMultiplier = Math.max(tpExtensionMultiplier, 1.25);
                trailingTpAggressiveness = Math.min(trailingTpAggressiveness, 0.85); // let winners run
            }
        } else if (ensembleConsensus === 'split') {
            // Model disagreement: decrease risk, tighten stops
            riskMultiplier *= 0.75;
            slTightnessMultiplier = Math.min(slTightnessMultiplier, 0.85);
            trailingTpAggressiveness = Math.max(trailingTpAggressiveness, 1.3);
            tpExtensionMultiplier = Math.min(tpExtensionMultiplier, 0.9);
        }
    }

    // Squeeze protection multiplier adjustments
    if (hasLongSqueezeRisk || hasShortSqueezeRisk) {
        riskMultiplier *= 0.75;
        slTightnessMultiplier = Math.min(slTightnessMultiplier, 0.75); // Tighter stops for quick exits
        trailingTpAggressiveness = Math.max(trailingTpAggressiveness, 1.4); // Lock profits faster
    }

    // Hard bounds clamps
    riskMultiplier = Math.max(0.3, Math.min(1.5, riskMultiplier));
    slTightnessMultiplier = Math.max(0.5, Math.min(1.5, slTightnessMultiplier));
    tpExtensionMultiplier = Math.max(0.7, Math.min(2.0, tpExtensionMultiplier));
    trailingTpAggressiveness = Math.max(0.5, Math.min(2.0, trailingTpAggressiveness));

    // 10. ATR-based Dynamic Position Adjustments
    const positionAdjustments: PositionAdjustment[] = [];
    if (ctx.openPositions && ctx.openPositions.length > 0 && atr > 0) {
        for (const pos of ctx.openPositions) {
            const side = pos.side;
            const pnlPercent = pos.pnlPercent;

            // Compute distance from entry to current price as fraction of entry price
            // profitFraction = pnlPercent / 100
            const profitFraction = pnlPercent / 100;
            const priceDelta = pos.entry * profitFraction;

            // Check price movement relative to ATR unit
            const atrUnitsProfit = priceDelta / atr;

            // Target met exit (lock gains near target)
            if (pnlPercent >= 3.0 && progressPct >= 80) {
                positionAdjustments.push({
                    symbol: pos.symbol,
                    action: 'EXIT',
                    reason: `[Local AI] Chốt lãi sớm (${pnlPercent.toFixed(1)}%) để bảo vệ mục tiêu ngày`
                });
                continue;
            }

            // Severe loss exit (exceeds -1.5 ATR adverse movement)
            if (atrUnitsProfit <= -1.5) {
                positionAdjustments.push({
                    symbol: pos.symbol,
                    action: 'EXIT',
                    reason: `[Local AI] Thoát vị thế khẩn cấp khi giá đi ngược -1.5 ATR (${pnlPercent.toFixed(1)}%)`
                });
                continue;
            }

            // Exhaustion exit (+3.0 ATR profit hit)
            if (atrUnitsProfit >= 3.0) {
                positionAdjustments.push({
                    symbol: pos.symbol,
                    action: 'EXIT',
                    reason: `[Local AI] Chốt lời chủ động khi đạt cản kiệt sức biên độ (+3 ATR: ${pnlPercent.toFixed(1)}%)`
                });
                continue;
            }

            // Tighten stop loss to lock +1 ATR profit once price reaches +2 ATR profit
            if (atrUnitsProfit >= 2.0) {
                let customSlPrice = side === 'LONG' ? (pos.entry + atr) : (pos.entry - atr);
                positionAdjustments.push({
                    symbol: pos.symbol,
                    action: 'TIGHTEN_SL',
                    reason: `[Local AI] Giá đạt biên độ cực đại +2 ATR. Khóa 1 ATR lợi nhuận ($${customSlPrice.toLocaleString()}).`,
                    customSlPrice: Number(customSlPrice.toFixed(2))
                });
                continue;
            }

            // Risk-free lock (Move SL to entry once price reaches +1.0 ATR profit)
            if (atrUnitsProfit >= 1.0) {
                positionAdjustments.push({
                    symbol: pos.symbol,
                    action: 'MOVE_TO_ENTRY',
                    reason: `[Local AI] Lợi nhuận chạm +1 ATR. Dời SL về Entry ($${pos.entry.toLocaleString()}) bảo toàn vốn.`
                });
                continue;
            }

            // Squeeze protection warnings (liquidate position if funding spikes against us)
            if (side === 'LONG' && hasLongSqueezeRisk && pnlPercent < 0) {
                positionAdjustments.push({
                    symbol: pos.symbol,
                    action: 'MOVE_TO_ENTRY',
                    reason: `[Local AI] Phát hiện rủi ro Long Squeeze (Funding cao). Ép dời SL về Entry phòng thủ.`
                });
                continue;
            } else if (side === 'SHORT' && hasShortSqueezeRisk && pnlPercent < 0) {
                positionAdjustments.push({
                    symbol: pos.symbol,
                    action: 'MOVE_TO_ENTRY',
                    reason: `[Local AI] Phát hiện rủi ro Short Squeeze (Funding âm). Ép dời SL về Entry phòng thủ.`
                });
                continue;
            }
        }
    }

    // 11. Generate Vietnamese reasoning string
    let reasoning = `[Local Quant AI] Thị trường ${regime} (Chop: ${chop.toFixed(1)}, Vol: ${vol.toFixed(2)}%, Lực trend: ${trend.toFixed(0)}). `;
    reasoning += `Cấu hình mô hình ${modelType.toUpperCase()} khung ${timeframe}. `;
    
    if (gridMode) {
        reasoning += `Kích hoạt Lưới lệnh Smart Grid tận dụng hộp tích lũy. `;
    }

    if (hasEnsemble) {
        reasoning += `Tín hiệu học máy đồng thuận ${ensembleConsensus.toUpperCase()} (${ensembleConf}%). `;
    }

    if (hasLongSqueezeRisk) {
        reasoning += `Phát hiện rủi ro Long Squeeze do Funding rate quá mua. `;
    } else if (hasShortSqueezeRisk) {
        reasoning += `Phát hiện rủi ro Short Squeeze do Funding rate quá bán. `;
    }

    reasoning += `Hệ số rủi ro điều chỉnh x${riskMultiplier.toFixed(2)}.`;

    // 12. Self-Confidence Score
    let confidence = 50;
    if (trend > 50 && chop < 42) {
        confidence = 85; // Strong trend alignment
    } else if (chop > 55 && vol < 0.5) {
        confidence = 78; // Perfect sideways oscillation
    } else if (vol > 1.3) {
        confidence = 55; // High noise
    } else {
        confidence = 68;
    }

    return {
        regime,
        timeframe,
        modelType,
        gridMode,
        riskMultiplier,
        confidence,
        reasoning,
        slTightnessMultiplier,
        tpExtensionMultiplier,
        trailingTpAggressiveness,
        forceExit,
        targetMetAction,
        positionAdjustments
    };
}
