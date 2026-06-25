'use client';

import React, { useState, useEffect, useRef } from 'react';

import dynamic from 'next/dynamic';

const TradingChart = dynamic(() => import('@/components/TradingChart').then(mod => mod.TradingChart), { ssr: false });
const EquityChart = dynamic(() => import('@/components/EquityChart').then(mod => mod.EquityChart), { ssr: false });

const FIFTY_POTENTIAL_TOKENS = [
    'BNBUSDT', 'CAKEUSDT', 'LINKUSDT', 'AAVEUSDT', 'FLOKIUSDT', 'TWTUSDT', 'ETHUSDT', 'USDCUSDT', 'XRPUSDT', 'TRXUSDT',
    'DOGEUSDT', 'ADAUSDT', 'BCHUSDT', 'TONUSDT', 'LTCUSDT', 'AVAXUSDT', 'SHIBUSDT', 'DOTUSDT', 'UNIUSDT', 'ATOMUSDT',
    'FILUSDT', 'INJUSDT', 'FETUSDT', 'ZROUSDT', 'LDOUSDT', 'PENDLEUSDT', 'STGUSDT', 'AXSUSDT', 'RAYUSDT', 'COMPUSDT',
    'BATUSDT', 'APEUSDT', 'SFPUSDT', '1INCHUSDT', 'SNXUSDT', 'CHEEMSUSDT', 'LUNCUSDT', 'BONKUSDT', 'ZECUSDT', 'SUSHIUSDT',
    'DEXEUSDT', 'BEAMUSDT', 'YFIUSDT', 'ZILUSDT', 'BTTUSDT', 'NFTUSDT', 'EURIUSDT', 'ACHUSDT', 'AXLUSDT', 'KAVAUSDT'
];

const SELECTABLE_TOKENS = FIFTY_POTENTIAL_TOKENS;


// Local type to avoid SSR import issues with lightweight-charts
interface ChartMarker {
    time: number;
    position: 'aboveBar' | 'belowBar' | 'inBar';
    color: string;
    shape: 'circle' | 'square' | 'arrowUp' | 'arrowDown';
    text?: string;
}

interface Position {
    symbol: string;
    type: 'LONG' | 'SHORT';
    leverage: number;
    size: number;
    entryPrice: number;
    margin: number;
    liqPrice: number;
    sl: number;
    tp: number;
    pnl: number;
    pnlPercent: number;
    partialClosed?: boolean;
    originalSl?: number;
    trailingTier?: number;
    binanceSlSynced?: boolean;
    hybridCloseMode?: boolean;
    hybridRetries?: number;
    trailingTpActive?: boolean;
    trailingTpPrice?: number;
    peakPrice?: number;
}

interface TradeLog {
    time: string;
    pair: string;
    type: string;
    side: string;
    price: number;
    size: string;
    leverage: string;
    pnl: number;
    status: string;
}

interface OrderLog {
    time: string;
    symbol: string;
    type: 'MARKET' | 'LIMIT';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    status: 'PENDING' | 'FILLED' | 'CANCELLED' | 'CLOSED';
    pnl?: number;
    reason?: string;
}

interface SystemLog {
    time: string;
    source: string;
    message: string;
    styleClass: string;
}

interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export default function Home() {
    const [authorized, setAuthorized] = useState<boolean | null>(null);

    useEffect(() => {
        const check = async () => {
            try {
                const res = await fetch('/api/auth/check');
                const data = await res.json();
                if (data.authorized) {
                    setAuthorized(true);
                } else {
                    window.location.href = '/login';
                }
            } catch {
                window.location.href = '/login';
            }
        };
        check();
    }, []);

    // Primary sync states
    const [pair, setPair] = useState('BNBUSDT');
    const [activePairs, setActivePairs] = useState<string[]>(['BNBUSDT', 'ETHUSDT', 'CAKEUSDT', 'LINKUSDT']);
    const [timeframe, setTimeframe] = useState('15m');
    const [searchQuery, setSearchQuery] = useState('');
    const [pairFilterQuery, setPairFilterQuery] = useState('');
    const [livePrice, setLivePrice] = useState(0);
    const [prevPrice, setPrevPrice] = useState(0);
    const [priceChange24h, setPriceChange24h] = useState(0);
    const [volume24h, setVolume24h] = useState(0);

    // Helper to get decimal precision based on symbol
    const getDigits = (sym: string): number => {
        const s = sym.toUpperCase();
        if (s.includes('FLOKI') || s.includes('PEPE') || s.includes('SHIB') || s.includes('BONK')) return 8;
        if (s.includes('XRP') || s.includes('ADA') || s.includes('DOGE') || s.includes('TRX') || s.includes('GALA')) return 4;
        return 2;
    };

    // Multi-pair state mappings
    const [livePrices, setLivePrices] = useState<{ [key: string]: number }>({ BNBUSDT: 0, ETHUSDT: 0, CAKEUSDT: 0, LINKUSDT: 0 });
    const [priceChanges24hMap, setPriceChanges24hMap] = useState<{ [key: string]: number }>({ BNBUSDT: 0, ETHUSDT: 0, CAKEUSDT: 0, LINKUSDT: 0 });
    const [volumes24hMap, setVolumes24hMap] = useState<{ [key: string]: number }>({ BNBUSDT: 0, ETHUSDT: 0, CAKEUSDT: 0, LINKUSDT: 0 });
    const [gridActiveMap, setGridActiveMap] = useState<{ [key: string]: boolean }>({ BNBUSDT: false, ETHUSDT: false, CAKEUSDT: false, LINKUSDT: false });

    const [orderHistory, setOrderHistory] = useState<OrderLog[]>([]);
    const [candles, setCandles] = useState<Candle[]>([]);
    const [chartMarkers, setChartMarkers] = useState<ChartMarker[]>([]);
    const [showEma, setShowEma] = useState(true);
    const [showRsi, setShowRsi] = useState(false);

    // AI & Bot parameters
    const [botRunning, setBotRunning] = useState(false);
    const [aiBrainTrained, setAiBrainTrained] = useState(false);
    const [aiBrainStatus, setAiBrainStatus] = useState('UNTRAINED');
    const [modelType, setModelType] = useState('knn');
    const [confidence, setConfidence] = useState(70);
    const [leverage, setLeverage] = useState(1);
    const [risk, setRisk] = useState(2);
    const [maxDailyDrawdown, setMaxDailyDrawdown] = useState(5);
    const [dailyPnL, setDailyPnL] = useState(0);
    const [maxDailyDrawdownLimitUsd, setMaxDailyDrawdownLimitUsd] = useState(0);
    const [tpAtr, setTpAtr] = useState(2.0);
    const [slAtr, setSlAtr] = useState(1.5);
    const [isTraining, setIsTraining] = useState(false);
    const [smartOrderAdjustment, setSmartOrderAdjustment] = useState(true);
    const [simulatedCapital, setSimulatedCapital] = useState(300);
    const [dcaEnabled, setDcaEnabled] = useState(false);
    const [dcaMaxSteps, setDcaMaxSteps] = useState(3);
    const [dcaPriceDropPct, setDcaPriceDropPct] = useState(5.0);
    const [dcaCapitalAllocation, setDcaCapitalAllocation] = useState<number[]>([0.2, 0.3, 0.5]);


    // Binance live trading API config
    const [liveTradingMode, setLiveTradingMode] = useState('simulated');
    const [binanceApiKey, setBinanceApiKey] = useState('');
    const [binanceApiSecret, setBinanceApiSecret] = useState('');
    const [twakAgentWallet, setTwakAgentWallet] = useState('');
    const [twakConfigured, setTwakConfigured] = useState(false);
    // LLM "AI Brain" config (Phase 1). Provider 'off' = rule-based fallback.
    const [llmProvider, setLlmProvider] = useState<'off' | 'local_ai' | 'openai' | 'anthropic' | 'gemini' | 'deepseek'>('off');
    const [llmModel, setLlmModel] = useState('');
    const [llmApiKey, setLlmApiKey] = useState('');
    const [llmApiKeyInput, setLlmApiKeyInput] = useState('');
    const [llmRiskMultiplier, setLlmRiskMultiplier] = useState(1.0);
    const [orderSizeMultiplier, setOrderSizeMultiplier] = useState(1.0);
    const [minOrderSize, setMinOrderSize] = useState(2.0);
    const [llmSlTightness, setLlmSlTightness] = useState(1.0);
    const [llmTpExtension, setLlmTpExtension] = useState(1.0);
    const [llmTrailingAggressiveness, setLlmTrailingAggressiveness] = useState(1.0);
    const [llmLastLatency, setLlmLastLatency] = useState(0);
    const [showApiSecret, setShowApiSecret] = useState(false);

    // AI Smart Grid Strategy state variables
    const [gridModeEnabled, setGridModeEnabled] = useState(false);
    const [quantOperatorEnabled, setQuantOperatorEnabled] = useState(false);
    const [quantOperatorThoughts, setQuantOperatorThoughts] = useState<any[]>([]);
    const [quantOperatorMetrics, setQuantOperatorMetrics] = useState<any>({ choppiness: 50, volatility: 0.05, trendIntensity: 0 });
    const [gridActive, setGridActive] = useState(false);
    const [gridOrders, setGridOrders] = useState<any[]>([]);
    const [gridCenterPrice, setGridCenterPrice] = useState(0);
    const [gridUpperBoundary, setGridUpperBoundary] = useState(0);
    const [gridLowerBoundary, setGridLowerBoundary] = useState(0);

    // Simulated ledger state
    const [balance, setBalance] = useState(300.00);
    const [marginUsed, setMarginUsed] = useState(0);
    const [marginFree, setMarginFree] = useState(300.00);
    const [totalUnrealizedPnl, setTotalUnrealizedPnl] = useState(0);
    const [openPositions, setOpenPositions] = useState<Position[]>([]);
    const [tradeHistory, setTradeHistory] = useState<TradeLog[]>([]);
    const [logs, setLogs] = useState<SystemLog[]>([]);

    // Backtest results
    const [backtestMode, setBacktestMode] = useState(false);
    const [backtestStats, setBacktestStats] = useState({
        botPnL: 0,
        botPnLUsd: 0,
        bhPnL: 0,
        winrate: 0,
        tradesRatio: '0 wins / 0 trades',
        maxDrawdown: 0,
        profitFactor: 0,
        expectancy: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpe: 0
    });
    const [equityCurveBot, setEquityCurveBot] = useState<any[]>([]);
    const [equityCurveBH, setEquityCurveBH] = useState<any[]>([]);

    // UI Tab Selection
    const [activeTab, setActiveTab] = useState('positions');

    // Simulated Orderbook & Trades
    const [orderbook, setOrderbook] = useState<{ asks: any[]; bids: any[]; spread: number }>({ asks: [], bids: [], spread: 0 });
    const [recentTrades, setRecentTrades] = useState<any[]>([]);

    // Console logs scrolling ref
    const logsEndRef = useRef<HTMLDivElement>(null);

    // ==========================================
    // DATA SYNC POLLING & WEBSOCKETS
    // ==========================================

    // Load persisted settings on client-side mount
    useEffect(() => {
        if (typeof window !== 'undefined') {
            const savedTimeframe = localStorage.getItem('selected_timeframe');
            if (savedTimeframe) {
                setTimeframe(savedTimeframe);
            }
            const savedPair = localStorage.getItem('selected_pair');
            if (savedPair) {
                setPair(savedPair);
            }
        }
    }, []);

    // Fetch initial status and startup loop
    useEffect(() => {
        const fetchStatus = async () => {
            try {
                const res = await fetch('/api/bot/status');
                if (res.ok) {
                    const data = await res.json();
                    syncServerState(data);
                }
            } catch (e: any) {
                // Reduce red error logs when server restarts during development (HMR)
                if (e instanceof TypeError && e.message === 'Failed to fetch') {
                    console.warn('🔄 Temporary loss of connection to the bot server (restarting or network down).');
                } else {
                    console.error('Error fetching status:', e);
                }
            }
        };

        fetchStatus();

        // 3-second polling loop to keep client PnL, logs and stats in-sync with server bot engine!
        const interval = setInterval(fetchStatus, 3000);
        return () => clearInterval(interval);
    }, []);

    // Fetch real-time candles from server when pair or timeframe changes
    useEffect(() => {
        const loadPair = async () => {
            try {
                const res = await fetch('/api/bot/load-pair', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pair, timeframe })
                });
                if (res.ok) {
                    const data = await res.json();
                    syncServerState(data.state);
                }
            } catch (e) {
                console.error('Error loading trading pair data:', e);
            }
        };

        loadPair();
    }, [pair, timeframe]);

    // Sync Server state into React states
    const syncServerState = (data: any) => {
        if (!data) return;

        setBalance(data.balance);
        setMarginUsed(data.marginUsed);
        setMarginFree(data.marginFree);
        setTotalUnrealizedPnl(data.totalUnrealizedPnl);
        setOpenPositions(data.openPositions);

        // Sync historical candles fetched from server
        if (data.logs) setLogs(data.logs);

        // Render server trades into trade history only if NOT in backtestMode
        if (!backtestMode) {
            setTradeHistory(data.tradeHistory);
        }

        setAiBrainTrained(data.aiBrainTrained);
        setAiBrainStatus(data.aiBrainTrained ? 'READY' : 'UNTRAINED');

        // Update Live Price changes
        setPrevPrice(prev => {
            if (data.livePrice !== prev) {
                setLivePrice(data.livePrice);
                return data.livePrice;
            }
            return prev;
        });

        setPriceChange24h(data.priceChange24h);
        setVolume24h(data.volume24h);

        // Sync multi-pair mapped states
        if (data.activePairs && Array.isArray(data.activePairs) && data.activePairs.length > 0) {
            setActivePairs(data.activePairs);
            // If current pair is not in the active pairs list, switch to the first active pair
            const currentSelected = localStorage.getItem('selected_pair') || pair;
            if (!data.activePairs.includes(currentSelected)) {
                const firstPair = data.activePairs[0];
                setPair(firstPair);
                localStorage.setItem('selected_pair', firstPair);
            }
        }
        if (data.livePrices) setLivePrices(data.livePrices);
        if (data.priceChanges24h) setPriceChanges24hMap(data.priceChanges24h);
        if (data.volumes24h) setVolumes24hMap(data.volumes24h);
        if (data.gridActiveMap) setGridActiveMap(data.gridActiveMap);
        if (data.orderHistory) setOrderHistory(data.orderHistory);
        setBotRunning(data.botRunning);

        if (data.liveTradingMode) setLiveTradingMode(data.liveTradingMode);
        if (data.binanceApiKey !== undefined) setBinanceApiKey(data.binanceApiKey);
        if (data.binanceApiSecret !== undefined) setBinanceApiSecret(data.binanceApiSecret);
        if (data.twakAgentWallet !== undefined) setTwakAgentWallet(data.twakAgentWallet);
        if (data.twakConfigured !== undefined) setTwakConfigured(data.twakConfigured);
        if (data.llmProvider !== undefined) setLlmProvider(data.llmProvider);
        if (data.llmModel !== undefined) setLlmModel(data.llmModel);
        if (data.llmApiKey !== undefined) setLlmApiKey(data.llmApiKey);
        if (typeof data.llmRiskMultiplier === 'number') setLlmRiskMultiplier(data.llmRiskMultiplier);
        if (typeof data.orderSizeMultiplier === 'number') setOrderSizeMultiplier(data.orderSizeMultiplier);
        if (typeof data.minOrderSize === 'number') setMinOrderSize(data.minOrderSize);
        if (typeof data.llmSlTightness === 'number') setLlmSlTightness(data.llmSlTightness);
        if (typeof data.llmTpExtension === 'number') setLlmTpExtension(data.llmTpExtension);
        if (typeof data.llmTrailingAggressiveness === 'number') setLlmTrailingAggressiveness(data.llmTrailingAggressiveness);
        if (typeof data.llmLastLatencyMs === 'number') setLlmLastLatency(data.llmLastLatencyMs);

        if (data.currentTimeframe) {
            setTimeframe(data.currentTimeframe);
        }
        if (data.modelType) {
            setModelType(data.modelType);
        }

        // Map live positions to chart markers for real-time overlay
        if (data.openPositions && data.openPositions.length > 0) {
            const lastCandleTime = data.historicalCandles && data.historicalCandles.length > 0
                ? data.historicalCandles[data.historicalCandles.length - 1].time
                : Math.floor(Date.now() / 1000);

            const activeMarkers = data.openPositions.map((pos: Position) => ({
                time: lastCandleTime,
                position: pos.type === 'LONG' ? 'belowBar' : 'aboveBar',
                color: pos.type === 'LONG' ? '#00c076' : '#ff3b30',
                shape: pos.type === 'LONG' ? 'arrowUp' : 'arrowDown',
                text: `${pos.type} (Spot)`
            }));
            setChartMarkers(activeMarkers);
        } else {
            setChartMarkers([]);
        }

        if (typeof data.gridModeEnabled === 'boolean') {
            setGridModeEnabled(data.gridModeEnabled);
        }
        if (typeof data.gridActive === 'boolean') {
            setGridActive(data.gridActive);
        }
        if (data.gridOrders) {
            setGridOrders(data.gridOrders);
        }
        if (typeof data.gridCenterPrice === 'number') {
            setGridCenterPrice(data.gridCenterPrice);
        }
        if (typeof data.gridUpperBoundary === 'number') {
            setGridUpperBoundary(data.gridUpperBoundary);
        }
        if (typeof data.gridLowerBoundary === 'number') {
            setGridLowerBoundary(data.gridLowerBoundary);
        }

        if (typeof data.quantOperatorEnabled === 'boolean') {
            setQuantOperatorEnabled(data.quantOperatorEnabled);
        }
        if (data.quantOperatorThoughts) {
            setQuantOperatorThoughts(data.quantOperatorThoughts);
        }
        if (data.quantOperatorMetrics) {
            setQuantOperatorMetrics(data.quantOperatorMetrics);
        }

        if (typeof data.smartOrderAdjustment === 'boolean') {
            setSmartOrderAdjustment(data.smartOrderAdjustment);
        }
        if (typeof data.initialCapital === 'number') {
            setSimulatedCapital(data.initialCapital);
        }
        if (typeof data.confidenceThreshold === 'number') {
            setConfidence(data.confidenceThreshold);
        }
        if (typeof data.leverage === 'number') {
            setLeverage(data.leverage);
        }
        if (typeof data.riskRatio === 'number') {
            setRisk(data.riskRatio * 100);
        }
        if (typeof data.maxDailyDrawdown === 'number') {
            setMaxDailyDrawdown(data.maxDailyDrawdown * 100);
        }
        if (typeof data.dailyPnL === 'number') {
            setDailyPnL(data.dailyPnL);
        }
        if (typeof data.maxDailyDrawdownLimitUsd === 'number') {
            setMaxDailyDrawdownLimitUsd(data.maxDailyDrawdownLimitUsd);
        }
        if (typeof data.tpAtrMultiplier === 'number') {
            setTpAtr(data.tpAtrMultiplier);
        }
        if (typeof data.slAtrMultiplier === 'number') {
            setSlAtr(data.slAtrMultiplier);
        }
        if (typeof data.dcaEnabled === 'boolean') {
            setDcaEnabled(data.dcaEnabled);
        }
        if (typeof data.dcaMaxSteps === 'number') {
            setDcaMaxSteps(data.dcaMaxSteps);
        }
        if (typeof data.dcaPriceDropPct === 'number') {
            setDcaPriceDropPct(data.dcaPriceDropPct);
        }
        if (Array.isArray(data.dcaCapitalAllocation)) {
            setDcaCapitalAllocation(data.dcaCapitalAllocation);
        }

        if (data.historicalCandles) {
            setCandles(data.historicalCandles);
        }
    };

    const handleSwitchPair = async (newPair: string) => {
        setPair(newPair);
        localStorage.setItem('selected_pair', newPair);
        try {
            const res = await fetch('/api/bot/load-pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pair: newPair, timeframe })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error switching trading pair:', e);
        }
    };

    // Auto-scroll terminal logs to bottom on new log arrival
    useEffect(() => {
        if (logsEndRef.current) {
            logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
        }
    }, [logs]);

    // Simulated Orderbook & Trades center around live price
    useEffect(() => {
        if (livePrice === 0) return;

        const spreadPct = 0.0004; // 0.04% typical spread
        const spreadVal = livePrice * spreadPct;

        // Generate asks
        const newAsks = [];
        let cumAsk = 0;
        for (let i = 5; i >= 1; i--) {
            const price = livePrice + spreadVal / 2 + (i * (livePrice * 0.0001));
            const size = Math.random() * 2.1 + 0.05;
            cumAsk += price * size;
            newAsks.push({ price, size, total: price * size, cumulative: cumAsk });
        }

        // Generate bids
        const newBids = [];
        let cumBid = 0;
        for (let i = 1; i <= 5; i++) {
            const price = livePrice - spreadVal / 2 - (i * (livePrice * 0.0001));
            const size = Math.random() * 2.1 + 0.05;
            cumBid += price * size;
            newBids.push({ price, size, total: price * size, cumulative: cumBid });
        }

        setOrderbook({ asks: newAsks, bids: newBids, spread: spreadVal });

        // Add simulated recent market trades
        const newTrade = {
            time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            price: livePrice + (Math.random() - 0.5) * (livePrice * 0.0005),
            size: Math.random() * 1.8 + 0.005,
            side: Math.random() > 0.49 ? 'buy' : 'sell'
        };

        setRecentTrades(prev => {
            const updated = [newTrade, ...prev];
            return updated.slice(0, 15); // keep 15 trades
        });

    }, [livePrice]);

    // ==========================================
    // ACTION TRIGGERS (Training, Configuration, Backtest)
    // ==========================================

    const handleParamChange = async (key: string, val: number) => {
        try {
            const params: any = {};
            params[key] = val;

            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params)
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error updating configuration:', e);
        }
    };

    const handleToggleActivePair = async (symbol: string) => {
        let newActivePairs = [...activePairs];
        if (newActivePairs.includes(symbol)) {
            if (newActivePairs.length <= 1) {
                alert("You must keep at least 1 active pair!");
                return;
            }
            newActivePairs = newActivePairs.filter(p => p !== symbol);
        } else {
            newActivePairs.push(symbol);
        }

        // Optimistically update frontend state
        setActivePairs(newActivePairs);

        try {
            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ activePairs: newActivePairs })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error toggling active pair:', e);
        }
    };


    const handleModelTypeChange = async (type: string) => {
        setModelType(type);
        try {
            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelType: type })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error changing AI algorithm:', e);
        }
    };

    const handleToggleBot = async (checked: boolean) => {
        if (checked && !aiBrainTrained) {
            alert('You need to Train the AI Model before activating Auto-Bot!');
            return;
        }

        try {
            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ botRunning: checked })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error toggling bot:', e);
        }
    };

    const trainAIBrain = async () => {
        setIsTraining(true);
        try {
            const res = await fetch('/api/bot/train', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelType })
            });

            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error training AI:', e);
        } finally {
            setIsTraining(false);
        }
    };

    const runBacktest = async () => {
        try {
            const res = await fetch('/api/bot/backtest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    confidenceThreshold: confidence,
                    leverage,
                    riskRatio: risk,
                    tpAtrMultiplier: tpAtr,
                    slAtrMultiplier: slAtr
                })
            });

            if (res.ok) {
                const data = await res.json();

                // Switch dashboard to show backtest equity curve & backtest trades
                setBacktestMode(true);
                setBacktestStats({
                    botPnL: data.botPnL,
                    botPnLUsd: data.botPnLUsd,
                    bhPnL: data.bhPnL,
                    winrate: data.winrate,
                    tradesRatio: data.tradesRatio,
                    maxDrawdown: data.maxDrawdown,
                    profitFactor: typeof data.profitFactor === 'number' && isFinite(data.profitFactor) ? data.profitFactor : 0,
                    expectancy: data.expectancy || 0,
                    avgWin: data.avgWin || 0,
                    avgLoss: data.avgLoss || 0,
                    sharpe: data.sharpe || 0
                });

                setEquityCurveBot(data.equityCurve);
                setEquityCurveBH(data.equityCurveBH);

                // Show backtest trades in the history tab
                setTradeHistory(data.trades);

                // Focus on metrics tab
                setActiveTab('metrics');
            }
        } catch (e) {
            console.error('Error running backtest:', e);
        }
    };

    const [isOptimizing, setIsOptimizing] = useState(false);

    const runAutoOptimize = async () => {
        setIsOptimizing(true);
        try {
            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'optimize' })
            });
            if (res.ok) {
                const data = await res.json();

                // Sync status with UI states
                syncServerState(data.state);

                if (data.params) {
                    setConfidence(data.params.confidenceThreshold);
                    setLeverage(data.params.leverage);
                    setRisk(data.params.riskRatio * 100);
                    setTpAtr(data.params.tpAtrMultiplier);
                    setSlAtr(data.params.slAtrMultiplier);

                    // Automatically run backtest with newly optimized parameters
                    const backtestRes = await fetch('/api/bot/backtest', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            confidenceThreshold: data.params.confidenceThreshold,
                            leverage: data.params.leverage,
                            riskRatio: data.params.riskRatio,
                            tpAtrMultiplier: data.params.tpAtrMultiplier,
                            slAtrMultiplier: data.params.slAtrMultiplier
                        })
                    });

                    if (backtestRes.ok) {
                        const btData = await backtestRes.json();
                        setBacktestMode(true);
                        setBacktestStats({
                            botPnL: btData.botPnL,
                            botPnLUsd: btData.botPnLUsd,
                            bhPnL: btData.bhPnL,
                            winrate: btData.winrate,
                            tradesRatio: btData.tradesRatio,
                            maxDrawdown: btData.maxDrawdown,
                            profitFactor: typeof btData.profitFactor === 'number' && isFinite(btData.profitFactor) ? btData.profitFactor : 0,
                            expectancy: btData.expectancy || 0,
                            avgWin: btData.avgWin || 0,
                            avgLoss: btData.avgLoss || 0,
                            sharpe: btData.sharpe || 0
                        });
                        setEquityCurveBot(btData.equityCurve);
                        setEquityCurveBH(btData.equityCurveBH);
                        setTradeHistory(btData.trades);
                        setActiveTab('metrics');
                    }
                }
            }
        } catch (e) {
            console.error('Error optimizing parameters:', e);
        } finally {
            setIsOptimizing(false);
        }
    };

    const closePositionManual = async (idx: number) => {
        try {
            const res = await fetch('/api/bot/positions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ index: idx })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error closing position:', e);
        }
    };

    const clearSystemLogs = async () => {
        // Clear locally for convenience
        setLogs([]);
    };

    const handleSetCapital = async (amount: number) => {
        if (isNaN(amount) || amount <= 0) return;
        setSimulatedCapital(amount);
        try {
            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ simulatedBalance: amount })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error setting simulated capital:', e);
        }
    };

    const handleToggleSmartQuant = async (checked: boolean) => {
        setSmartOrderAdjustment(checked);
        try {
            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ smartOrderAdjustment: checked })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error toggling Smart Quant:', e);
        }
    };

    const handleUpdateLiveTradingConfig = async (mode: string, key: string, secret: string) => {
        try {
            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    liveTradingMode: mode,
                    binanceApiKey: key,
                    binanceApiSecret: secret
                })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error updating Binance API configuration:', e);
        }
    };

    const handleToggleQuantOperator = async (checked: boolean) => {
        setQuantOperatorEnabled(checked);
        try {
            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quantOperatorEnabled: checked })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error toggling Quant Operator Brain:', e);
        }
    };

    const handleToggleGrid = async (checked: boolean) => {
        setGridModeEnabled(checked);
        try {
            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ gridModeEnabled: checked })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error toggling AI Grid Orders:', e);
        }
    };

    const handleToggleDca = async (checked: boolean) => {
        setDcaEnabled(checked);
        try {
            const res = await fetch('/api/bot/status', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dcaEnabled: checked })
            });
            if (res.ok) {
                const data = await res.json();
                syncServerState(data.state);
            }
        } catch (e) {
            console.error('Error toggling DCA:', e);
        }
    };

    if (authorized === null) {
        return (
            <div className="min-h-screen bg-black flex flex-col items-center justify-center text-white">
                <div className="w-12 h-12 border-4 border-t-[#226af0] border-gray-800 rounded-full animate-spin"></div>
                <p className="mt-4 text-gray-400 font-mono text-sm tracking-wider animate-pulse">AUTHORIZING ACCESS...</p>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-screen max-h-screen overflow-hidden text-slate-100 bg-[#08090c]">
            {/* HEADER */}
            <header className="flex items-center justify-between px-6 py-1 bg-[#11141c]/70 backdrop-blur-md border-b border-white/5 h-16 shadow-lg">
                <div className="flex items-center">
                    <img src="/logo.png" alt="Orocle Logo" className="h-14 w-auto object-contain" />
                </div>

                {/* Selected Token Stats Summary */}
                <div className="flex items-center gap-6 ml-6 mr-auto border-l border-white/5 pl-6">
                    <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 font-extrabold uppercase tracking-wider">Trading Asset</span>
                        <span className="text-[13px] font-black text-slate-100">{pair.replace('USDT', '')}/USDT</span>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 font-extrabold uppercase tracking-wider">Live Price</span>
                        <span className={`text-[13px] font-mono font-black ${livePrice >= prevPrice ? 'text-[#00c076]' : 'text-[#ff3b30]'}`}>
                            {livePrice > 0 ? livePrice.toLocaleString(undefined, { minimumFractionDigits: getDigits(pair), maximumFractionDigits: getDigits(pair) }) : '--.--'}
                        </span>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 font-extrabold uppercase tracking-wider">24h Change</span>
                        <span className={`text-[13px] font-mono font-black ${priceChange24h >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]'}`}>
                            {priceChange24h >= 0 ? '+' : ''}{priceChange24h.toFixed(2)}%
                        </span>
                    </div>
                    <div className="flex flex-col">
                        <span className="text-[9px] text-slate-500 font-extrabold uppercase tracking-wider">24h Volume</span>
                        <span className="text-[13px] font-mono font-black text-slate-200">
                            {volume24h > 0 ? volume24h.toLocaleString() : '--.--'}
                        </span>
                    </div>
                </div>

                {/* Account */}
                <div className="flex items-center gap-4">
                    <div className="flex flex-col items-end">
                        <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">
                            {liveTradingMode === 'simulated' ? 'DemoAccount Balance' : (liveTradingMode === 'testnet' ? 'Binance Testnet Balance' : (liveTradingMode === 'bsc_twak' ? 'BSC Agent Wallet Balance' : 'Binance Live Balance'))}
                        </span>
                        <span className="text-sm font-extrabold text-[#00c076] font-mono">
                            ${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                    </div>

                    <div className="flex flex-col items-end">
                        <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Holding Status</span>
                        {openPositions.length > 0 ? (
                            <span className={`text-[10px] font-extrabold px-2 py-0.5 rounded ${openPositions[0].type === 'LONG' ? 'bg-[#00c076]/15 text-[#00c076] border border-[#00c076]/30' : 'bg-[#ff3b30]/15 text-[#ff3b30] border border-[#ff3b30]/30'}`}>
                                {openPositions[0].type}
                            </span>
                        ) : (
                            <span className="text-[10px] font-bold text-slate-400 bg-white/5 border border-white/5 px-2 py-0.5 rounded">
                                NONE
                            </span>
                        )}
                    </div>
                </div>
            </header>

            {/* MAIN CONTENT WRAPPER */}
            <div className="flex flex-1 min-h-0 overflow-hidden">
                {/* LEFT SIDEBAR: Asset list & TF */}
                <aside className="w-72 bg-[#11141c]/45 backdrop-blur-md border-r border-white/5 flex flex-col min-h-0 select-none shadow-xl">
                    <div className="p-4 border-b border-white/5 flex flex-col gap-2">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-black uppercase tracking-wider text-slate-400">Assets ({activePairs.length})</span>
                            <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-slate-500 font-extrabold uppercase">TF</span>
                                <select
                                    value={timeframe}
                                    onChange={(e) => {
                                        const newTimeframe = e.target.value;
                                        setTimeframe(newTimeframe);
                                        localStorage.setItem('selected_timeframe', newTimeframe);
                                    }}
                                    disabled={quantOperatorEnabled}
                                    className={`border text-[10px] font-black px-1.5 py-0.5 rounded outline-none cursor-pointer transition-all ${
                                        quantOperatorEnabled
                                            ? 'bg-white/5 border-white/5 text-slate-500 cursor-not-allowed opacity-75'
                                            : 'bg-[#181d28] border-white/10 text-slate-300 focus:border-[#226af0]'
                                    }`}
                                    title={quantOperatorEnabled ? "Automatically adjusted by the LLM Quant Operator" : ""}
                                >
                                    <option value="1m">1m</option>
                                    <option value="5m">5m</option>
                                    <option value="15m">15m</option>
                                    <option value="1h">1h</option>
                                    <option value="4h">4h</option>
                                </select>
                            </div>
                        </div>
                        <input
                            type="text"
                            placeholder="Search asset..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full bg-[#181d28]/70 border border-white/5 px-3 py-1.5 rounded-lg text-xs outline-none text-slate-200 placeholder-slate-500 focus:border-[#226af0] focus:bg-[#181d28] transition-all font-semibold"
                        />
                    </div>
                    
                    <div className="flex-1 overflow-y-auto px-2 py-2 flex flex-col gap-1 custom-scrollbar">
                        {activePairs
                            .filter(p => p.toLowerCase().includes(searchQuery.toLowerCase()))
                            .map((symbol) => {
                                const active = pair === symbol;
                                const price = livePrices[symbol] || 0;
                                const change = priceChanges24hMap[symbol] || 0;
                                const hasGrid = gridActiveMap[symbol];
                                const activePos = openPositions.find(p => p.symbol === symbol);
                                const priceFractionDigits = getDigits(symbol);

                                return (
                                    <div
                                        key={symbol}
                                        onClick={() => handleSwitchPair(symbol)}
                                        className={`flex items-center justify-between px-3 py-2.5 rounded-xl border transition-all duration-200 cursor-pointer ${
                                            active
                                                ? 'border-[#226af0] bg-[#226af0]/15 shadow-[0_0_12px_rgba(34,106,240,0.15)]'
                                                : 'border-transparent bg-transparent hover:bg-white/3 hover:border-white/5'
                                        }`}
                                    >
                                        <div className="flex flex-col gap-0.5">
                                            <div className="flex items-center gap-1.5">
                                                <span className={`text-[12px] font-black tracking-wide ${active ? 'text-slate-100' : 'text-slate-300'}`}>
                                                    {symbol.replace('USDT', '')}
                                                </span>
                                                <span className="text-[9px] text-slate-500 font-bold">/USDT</span>
                                                {hasGrid && (
                                                    <span className="text-[8px] font-black px-1.5 py-0.2 bg-[#ffb300]/15 text-[#ffb300] border border-[#ffb300]/30 rounded shadow-[0_0_5px_rgba(255,179,0,0.15)] animate-pulse">
                                                        GRID
                                                    </span>
                                                )}
                                                {activePos && (
                                                    <span className="text-[8px] font-black px-1.5 py-0.2 bg-[#00c076]/15 text-[#00c076] border border-[#00c076]/30 rounded">
                                                        LONG
                                                    </span>
                                                )}
                                            </div>
                                            {activePos && (
                                                <span className={`text-[9px] font-black ${activePos.pnl >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]'}`}>
                                                    PnL: {activePos.pnl >= 0 ? '+' : ''}{activePos.pnlPercent.toFixed(1)}% (${activePos.pnl.toFixed(2)})
                                                </span>
                                            )}
                                        </div>
                                        
                                        <div className="flex flex-col items-end gap-0.5">
                                            <span className={`text-[12px] font-black font-mono transition-colors duration-200 ${
                                                price > 0 ? (active && price > prevPrice ? 'text-[#00c076]' : 'text-slate-200') : 'text-slate-500'
                                            }`}>
                                                {price > 0 ? price.toLocaleString(undefined, { minimumFractionDigits: priceFractionDigits, maximumFractionDigits: priceFractionDigits }) : '--.--'}
                                            </span>
                                            <span className={`text-[9px] font-black font-mono ${change >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]'}`}>
                                                {change >= 0 ? '+' : ''}{change.toFixed(1)}%
                                            </span>
                                        </div>
                                    </div>
                                );
                            })}
                    </div>

                    {/* Active Trading Pairs Selection */}
                    <div className="shrink-0 border-t border-white/5 p-3 flex flex-col gap-2 bg-[#0c0d12]/40">
                        <div className="flex items-center justify-between">
                            <label className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Active Trading Pairs</label>
                            <span className="text-[9px] text-[#226af0] font-black">{activePairs.length} Selected</span>
                        </div>
                        <input
                            type="text"
                            placeholder="Search pair config..."
                            value={pairFilterQuery}
                            onChange={(e) => setPairFilterQuery(e.target.value)}
                            className="w-full bg-[#181d28]/70 border border-white/5 px-2 py-1.5 rounded-lg text-[10px] outline-none text-slate-200 placeholder-slate-500 focus:border-[#226af0] focus:bg-[#181d28] transition-all font-semibold"
                        />
                        <div className="max-h-36 overflow-y-auto pr-1 border border-white/5 rounded-lg bg-slate-950/40 p-1.5 custom-scrollbar">
                            <div className="grid grid-cols-3 gap-1">
                                {SELECTABLE_TOKENS
                                    .filter(token => token.toLowerCase().includes(pairFilterQuery.toLowerCase()))
                                    .map((token) => {
                                        const isActive = activePairs.includes(token);
                                        const displaySym = token.replace('USDT', '');
                                        return (
                                            <button
                                                key={token}
                                                type="button"
                                                onClick={() => handleToggleActivePair(token)}
                                                className={`text-[9px] font-bold py-1 px-0.5 border rounded text-center transition-all cursor-pointer ${
                                                    isActive
                                                        ? 'border-[#226af0] text-[#226af0] bg-[#226af0]/10 shadow-[0_0_8px_rgba(34,106,240,0.1)]'
                                                        : 'border-white/5 bg-slate-900/40 text-slate-500 hover:text-slate-300 hover:border-white/10'
                                                }`}
                                            >
                                                {displaySym}
                                            </button>
                                        );
                                    })}
                            </div>
                        </div>
                    </div>
                </aside>

                {/* RIGHT AREA: Dashboard Grid + Position Footer */}
                <div className="flex-1 flex flex-col min-h-0 overflow-hidden bg-[#0a0c10]/40">

            {/* DASHBOARD GRID */}
            <main className="flex-1 grid grid-cols-[1.6fr_0.9fr_1.1fr] gap-3 p-3 min-h-0">

                {/* LEFT COLUMN: Candlestick & Profit charts */}
                <section className="flex flex-col gap-3 min-h-0">
                    {/* Price Chart Card */}
                    <div className="flex-1 flex flex-col bg-[#11141c]/50 border border-white/5 rounded-xl overflow-hidden shadow-lg min-h-[350px]">
                        <div className="flex items-center justify-between px-4 h-10 border-b border-white/5 select-none">
                            <div className="flex items-center gap-2">

                                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Technical Chart</h2>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setShowEma(!showEma)}
                                    className={`px-2 py-0.5 text-[10px] font-bold rounded cursor-pointer transition-all border ${showEma ? 'bg-[#226af0]/15 border-[#226af0] text-[#226af0]' : 'bg-white/5 border-white/5 text-slate-400 hover:text-slate-200'
                                        }`}
                                >
                                    EMA
                                </button>
                                <span className="relative text-[9px] font-bold bg-[#00c076]/10 text-[#00c076] border border-[#00c076]/30 px-2 py-0.5 rounded pl-4 before:content-[''] before:absolute before:left-1.5 before:top-1/2 before:-translate-y-1/2 before:w-1.5 before:height-1.5 before:bg-[#00c076] before:rounded-full before:shadow-[0_0_5px_#00c076]">
                                    Live
                                </span>
                            </div>
                        </div>
                        <div className="flex-1 min-h-0 bg-[#0c0d12] relative">
                            <TradingChart candles={candles} markers={chartMarkers} showEma={showEma} pricePrecision={getDigits(pair)} />
                        </div>
                    </div>

                    {/* Equity curve */}
                    <div className="h-60 flex flex-col bg-[#11141c]/50 border border-white/5 rounded-xl overflow-hidden shadow-lg">
                        <div className="flex items-center justify-between px-4 h-10 border-b border-white/5 select-none">
                            <div className="flex items-center gap-2">

                                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">
                                    Cumulative Equity Curve {backtestMode && '(Backtest Mode)'}
                                </h2>
                            </div>
                            <div className="flex items-center gap-2">
                                {backtestMode ? (
                                    <button
                                        onClick={() => {
                                            setBacktestMode(false);
                                            setActiveTab('positions');
                                        }}
                                        className="text-[9px] bg-white/5 border border-white/10 hover:bg-white/10 text-slate-300 font-bold px-2 py-0.5 rounded"
                                    >
                                        Back to Live
                                    </button>
                                ) : (
                                    <span className="text-[9px] font-bold bg-white/5 text-slate-400 border border-white/5 px-2 py-0.5 rounded">
                                        Live (Real-time)
                                    </span>
                                )}
                            </div>
                        </div>
                        <div className="flex-1 min-h-0 bg-[#0c0d12] relative">
                            <EquityChart botData={equityCurveBot} bhData={equityCurveBH} />
                        </div>
                    </div>
                </section>

                {/* MIDDLE COLUMN: Order book & trades */}
                <section className="flex flex-col gap-3 min-h-0">
                    {/* Order Book */}
                    <div className="flex-[1.3] flex flex-col bg-[#11141c]/50 border border-white/5 rounded-xl overflow-hidden shadow-lg min-h-0 font-mono">
                        <div className="flex items-center justify-between px-4 h-10 border-b border-white/5 select-none">
                            <div className="flex items-center gap-2">

                                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Order Book</h2>
                            </div>
                            <span className="text-[10px] text-slate-500 font-bold">
                                Spread: <span className="text-slate-300">${orderbook.spread.toLocaleString(undefined, { minimumFractionDigits: getDigits(pair), maximumFractionDigits: getDigits(pair) })}</span>
                            </span>
                        </div>

                        <div className="flex-1 flex flex-col px-3 py-2 min-h-0 text-[11px]">
                            {/* Table header */}
                            <div className="grid grid-cols-3 text-[9px] font-bold text-slate-500 uppercase tracking-wider pb-2 border-b border-white/5">
                                <span>Price (USDT)</span>
                                <span>Size</span>
                                <span className="text-right">Cumulative</span>
                            </div>

                            {/* Asks (Sells) */}
                            <div className="flex-1 flex flex-col justify-end overflow-hidden my-1">
                                {orderbook.asks.map((ask, idx) => {
                                    const widthPercent = Math.min(100, (ask.cumulative / 250000) * 100);
                                    return (
                                        <div key={`ask-${idx}`} className="grid grid-cols-3 h-[19px] items-center relative hover:bg-white/2 cursor-pointer">
                                            <div className="absolute right-0 top-0 bottom-0 bg-[#ff3b30]/10" style={{ width: `${widthPercent}%` }} />
                                            <span className="relative z-10 text-[#ff3b30] font-bold">{ask.price.toLocaleString(undefined, { minimumFractionDigits: getDigits(pair), maximumFractionDigits: getDigits(pair) })}</span>
                                            <span className="relative z-10 text-slate-300">{ask.size.toFixed(3)}</span>
                                            <span className="relative z-10 text-right text-slate-400">{Math.round(ask.cumulative).toLocaleString()}</span>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* Spread line */}
                            <div className="flex items-center justify-center gap-2 h-7 my-1 border-y border-white/5 bg-white/1 bg-slate-950/40 text-center font-bold">
                                <span className={`text-[13px] ${livePrice >= prevPrice ? 'text-[#00c076]' : 'text-[#ff3b30]'}`}>
                                    {livePrice.toLocaleString(undefined, { minimumFractionDigits: getDigits(pair), maximumFractionDigits: getDigits(pair) })}
                                </span>
                            </div>

                            {/* Bids (Buys) */}
                            <div className="flex-1 flex flex-col overflow-hidden my-1">
                                {orderbook.bids.map((bid, idx) => {
                                    const widthPercent = Math.min(100, (bid.cumulative / 250000) * 100);
                                    return (
                                        <div key={`bid-${idx}`} className="grid grid-cols-3 h-[19px] items-center relative hover:bg-white/2 cursor-pointer">
                                            <div className="absolute right-0 top-0 bottom-0 bg-[#00c076]/10" style={{ width: `${widthPercent}%` }} />
                                            <span className="relative z-10 text-[#00c076] font-bold">{bid.price.toLocaleString(undefined, { minimumFractionDigits: getDigits(pair), maximumFractionDigits: getDigits(pair) })}</span>
                                            <span className="relative z-10 text-slate-300">{bid.size.toFixed(3)}</span>
                                            <span className="relative z-10 text-right text-slate-400">{Math.round(bid.cumulative).toLocaleString()}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>

                    {/* Trades list */}
                    <div className="flex-1 flex flex-col bg-[#11141c]/50 border border-white/5 rounded-xl overflow-hidden shadow-lg min-h-0 font-mono">
                        <div className="flex items-center justify-between px-4 h-10 border-b border-white/5 select-none">
                            <div className="flex items-center gap-2">

                                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Market Trades</h2>
                            </div>
                            <span className="inline-block w-1.5 h-1.5 bg-[#ff3b30] rounded-full shadow-[0_0_5px_#ff3b30]" />
                        </div>
                        <div className="flex-1 flex flex-col px-3 py-2 overflow-hidden text-[11px]">
                            <div className="grid grid-cols-3 text-[9px] font-bold text-slate-500 uppercase tracking-wider pb-2 border-b border-white/5">
                                <span>Time</span>
                                <span>Price (USDT)</span>
                                <span className="text-right">Size</span>
                            </div>
                            <div className="flex-1 overflow-y-hidden flex flex-col gap-1 mt-1.5">
                                {recentTrades.map((t, idx) => (
                                    <div key={`rt-${idx}`} className="grid grid-cols-3 h-5 items-center">
                                        <span className="text-slate-500">{t.time}</span>
                                        <span className={t.side === 'buy' ? 'text-[#00c076] font-bold' : 'text-[#ff3b30] font-bold'}>
                                            {t.price.toLocaleString(undefined, { minimumFractionDigits: getDigits(pair), maximumFractionDigits: getDigits(pair) })}
                                        </span>
                                        <span className="text-right text-slate-400">{t.size.toFixed(4)}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>

                {/* RIGHT COLUMN: AI settings & Console terminal */}
                <section className="flex flex-col gap-3 min-h-0">

                    {/* Bot Configuration Panel */}
                    <div className="flex-[1.4] flex flex-col bg-[#11141c]/50 border border-white/5 rounded-xl overflow-hidden shadow-lg min-h-0">
                        <div className="flex items-center justify-between px-4 h-10 border-b border-white/5 select-none">
                            <div className="flex items-center gap-2">

                                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">AI Bot Configuration</h2>
                            </div>
                            {/* ON/OFF Switch */}
                            <div className="flex items-center gap-2 bg-slate-900/50 border border-white/5 px-2 py-0.5 rounded-lg">
                                <span className={`text-[9px] font-black ${botRunning ? 'text-[#00c076] drop-shadow-[0_0_5px_rgba(0,192,118,0.2)]' : 'text-slate-500'}`}>
                                    {botRunning ? 'ACTIVE' : 'OFF'}
                                </span>
                                <label className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={botRunning}
                                        onChange={(e) => handleToggleBot(e.target.checked)}
                                        className="sr-only peer"
                                    />
                                    <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[#00c076] shadow-sm"></div>
                                </label>
                            </div>
                        </div>

                        <div className="flex-1 flex flex-col gap-3.5 p-4 overflow-y-auto min-h-0 text-xs">
                            {/* AI Training and Brain indicator */}
                            <div className="flex flex-col gap-3 bg-white/2 border border-white/5 rounded-lg p-2.5">
                                <div className="flex items-center gap-3">
                                    <div className="flex items-center justify-center w-10 h-10 bg-white/5 border border-white/5 rounded-full">
                                        <i className={`fa-solid fa-brain text-base ${isTraining ? 'text-[#ffb300] animate-spin' : (botRunning ? 'text-[#00c076] animate-bounce' : 'text-slate-400')}`} />
                                    </div>
                                    <div className="flex flex-col">
                                        <div className="flex items-center gap-1.5">
                                            <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Brain Status:</span>
                                            <span className="text-[8px] font-black px-1.5 py-0.2 bg-[#226af0]/10 text-[#226af0] rounded border border-[#226af0]/25 animate-pulse uppercase tracking-wider">
                                                Background Auto-Train</span>
                                        </div>
                                        <span className={`text-xs font-bold tracking-wider ${aiBrainTrained ? 'text-[#00c076]' : 'text-[#ffb300]'
                                            }`}>
                                            {isTraining ? 'TRAINING...' : aiBrainStatus.toUpperCase()}
                                        </span>
                                    </div>
                                </div>

                                <button
                                    onClick={trainAIBrain}
                                    disabled={isTraining}
                                    className="w-full flex items-center justify-center gap-1.5 bg-[#226af0] text-white font-bold py-2 rounded-lg shadow-[0_0_10px_rgba(34,106,240,0.15)] hover:shadow-[0_0_15px_rgba(34,106,240,0.35)] transition-all cursor-pointer text-xs disabled:opacity-50"
                                >
                                    Train AI Model
                                </button>
                            </div>

                            {/* Binance API configuration panel */}
                            <div className="flex flex-col gap-3 bg-white/2 border border-white/5 rounded-lg p-2.5 mt-1">
                                <div className="flex flex-col gap-1">
                                    <label className="text-[9px] text-slate-500 font-bold uppercase">Trading Mode</label>
                                    <div className="grid grid-cols-2 gap-1">
                                        {[
                                            { id: 'simulated', label: 'Demo', activeColor: 'border-[#226af0] text-[#226af0] bg-[#226af0]/10 shadow-[0_0_10px_rgba(34,106,240,0.1)]' },
                                            { id: 'bsc_twak', label: 'Real BSC', activeColor: 'border-[#00c076] text-[#00c076] bg-[#00c076]/10 shadow-[0_0_10px_rgba(0,192,118,0.1)]' }
                                        ].map((m) => (
                                            <button
                                                key={m.id}
                                                type="button"
                                                onClick={() => {
                                                    if (m.id === 'bsc_twak') {
                                                        const conf = window.confirm("WARNING: You are switching to LIVE TRADING on the BSC blockchain. Please ensure you fully understand the risks. Do you want to proceed?");
                                                        if (!conf) return;
                                                    }
                                                    setLiveTradingMode(m.id);
                                                    handleUpdateLiveTradingConfig(m.id, '', '');
                                                }}
                                                className={`text-[10px] font-bold py-1 border rounded-md transition-all duration-200 cursor-pointer ${liveTradingMode === m.id
                                                        ? m.activeColor
                                                        : 'border-white/5 bg-slate-900/40 text-slate-400 hover:text-slate-200 hover:border-white/10'
                                                    }`}
                                            >
                                                {m.label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {liveTradingMode === 'bsc_twak' && (
                                    <div className="flex flex-col gap-2 mt-1 border-t border-white/5 pt-2">
                                        {twakConfigured ? (
                                            <div className="flex flex-col gap-1.5 bg-[#00c076]/5 border border-[#00c076]/20 rounded-lg p-2.5">
                                                <span className="text-[9px] font-black text-[#00c076] uppercase tracking-wider flex items-center gap-1 justify-center">
                                                    BSC TWAK Wallet Configured
                                                </span>
                                                {twakAgentWallet && (
                                                    <span className="text-[9px] font-mono text-slate-400 text-center select-all block bg-slate-950/40 py-0.5 rounded">
                                                        {twakAgentWallet}
                                                    </span>
                                                )}
                                            </div>
                                        ) : (
                                            <div className="flex flex-col gap-1.5 bg-[#ff9500]/5 border border-[#ff9500]/20 rounded-lg p-2.5 text-center">
                                                <span className="text-[9px] font-black text-[#ff9500] uppercase tracking-wider">
                                                    TWAK Credentials Missing
                                                </span>
                                                <span className="text-[9px] text-slate-400 leading-normal">
                                                    Please configure TWAK_WALLET_PASSWORD / TWAK_AGENT_WALLET in your .env file.
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* ===== LLM BRAIN CONFIG (Phase 1) ===== */}
                                <div className="flex flex-col gap-2 mt-2 border-t border-white/5 pt-2">
                                    <span className="text-[9px] font-black text-[#a29bfe] uppercase tracking-wider">LLM AI Brain</span>
                                    <div className="flex flex-col gap-1.5">
                                        <select
                                            value={llmProvider}
                                            onChange={(e) => {
                                                const p = e.target.value as any;
                                                setLlmProvider(p);
                                                fetch('/api/bot/status', {
                                                    method: 'POST',
                                                    headers: { 'Content-Type': 'application/json' },
                                                    body: JSON.stringify({ llmProvider: p })
                                                });
                                            }}
                                            className="w-full bg-white/5 border border-white/5 text-slate-200 text-[10px] font-bold px-1.5 py-1 rounded outline-none focus:border-[#a29bfe]"
                                        >
                                            <option value="off">OFF (Rule-based Baseline)</option>
                                            <option value="local_ai">ON (Local Quant AI Brain) 🧠</option>
                                        </select>
                                    </div>
                                    {llmProvider === 'local_ai' && (
                                        <div className="flex flex-col gap-1 bg-[#a29bfe]/5 border border-[#a29bfe]/15 rounded-lg p-1.5">
                                            <div className="flex items-center justify-between">
                                                <span className="text-[9px] text-slate-400">Risk x{llmRiskMultiplier.toFixed(2)}</span>
                                                <span className="text-[9px] text-slate-400 font-mono">{llmLastLatency}ms</span>
                                                <span className="text-[9px] font-bold text-[#00c076]">
                                                    🧠 Offline Brain Active
                                                </span>
                                            </div>
                                            <div className="flex items-center justify-between border-t border-[#a29bfe]/10 pt-1">
                                                <span className={`text-[9px] font-mono ${llmSlTightness !== 1 ? 'text-[#ff9500]' : 'text-slate-500'}`}>SL x{llmSlTightness.toFixed(2)}</span>
                                                <span className={`text-[9px] font-mono ${llmTpExtension !== 1 ? 'text-[#00c076]' : 'text-slate-500'}`}>TP x{llmTpExtension.toFixed(2)}</span>
                                                <span className={`text-[9px] font-mono ${llmTrailingAggressiveness !== 1 ? 'text-cyan-400' : 'text-slate-500'}`}>Trail x{llmTrailingAggressiveness.toFixed(2)}</span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Parameters config */}
                            <div className="flex flex-col gap-3">
                                {/* Model Selection */}
                                <div className="flex flex-col gap-1">
                                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                        AI Algorithm <span title="KNN: K-Nearest Neighbors grouping | Logistic: Regression learning weights"><i className="fa-solid fa-circle-info text-[10px] text-slate-500 cursor-help" /></span>
                                    </label>
                                    <select
                                        value={modelType}
                                        onChange={(e) => handleModelTypeChange(e.target.value)}
                                        disabled={quantOperatorEnabled}
                                        className={`border text-slate-200 text-xs font-bold px-2 py-1.5 rounded-lg outline-none cursor-pointer transition-all ${quantOperatorEnabled
                                                ? 'bg-white/1 border-[#706fd3]/25 text-[#a29bfe] cursor-not-allowed opacity-75'
                                                : 'bg-white/5 border-white/5 focus:border-[#226af0]'
                                            }`}
                                        title={quantOperatorEnabled ? "Automatically adjusted by the LLM Quant Operator Brain" : ""}
                                    >
                                        <option value="knn">K-Nearest Neighbors (KNN)</option>
                                        <option value="logistic">Logistic Regression</option>
                                        <option value="momentum">Advanced Momentum Quant</option>
                                        <option value="ensemble"> Ensemble (3-model weighted vote)</option>
                                    </select>
                                </div>

                                {/* Confidence */}
                                <div className="flex flex-col gap-1">
                                    <div className="flex justify-between items-center text-[10px] font-bold uppercase">
                                        <span className="text-slate-400">Min Confidence</span>
                                        <span className="text-[#226af0] font-mono">{confidence}%</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="55"
                                        max="90"
                                        value={confidence}
                                        onChange={(e) => {
                                            const val = parseInt(e.target.value);
                                            setConfidence(val);
                                            handleParamChange('confidenceThreshold', val);
                                        }}
                                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-[#226af0]"
                                    />
                                </div>

                                {/* Risk */}
                                <div className="flex flex-col gap-1">
                                    <div className="flex justify-between items-center text-[10px] font-bold uppercase">
                                        <span className="text-slate-400">Risk Ratio</span>
                                        <span className="text-[#226af0] font-mono">{risk}%</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="1"
                                        max="10"
                                        step="0.5"
                                        value={risk}
                                        onChange={(e) => {
                                            const val = parseFloat(e.target.value);
                                            setRisk(val);
                                            handleParamChange('riskRatio', val);
                                        }}
                                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-[#226af0]"
                                    />
                                </div>

                                {/* Order Size Multiplier */}
                                <div className="flex flex-col gap-1">
                                    <div className="flex justify-between items-center text-[10px] font-bold uppercase">
                                        <span className="text-slate-400">Order Size Multiplier</span>
                                        <span className="text-[#226af0] font-mono">{orderSizeMultiplier.toFixed(1)}x</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="0.5"
                                        max="5.0"
                                        step="0.1"
                                        value={orderSizeMultiplier}
                                        onChange={(e) => {
                                            const val = parseFloat(e.target.value);
                                            setOrderSizeMultiplier(val);
                                            handleParamChange('orderSizeMultiplier', val);
                                        }}
                                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-[#226af0]"
                                    />
                                </div>

                                {/* Minimum Order Size */}
                                <div className="flex flex-col gap-1">
                                    <div className="flex justify-between items-center text-[10px] font-bold uppercase">
                                        <span className="text-slate-400">Min Order Size</span>
                                        <span className="text-[#226af0] font-mono">${minOrderSize.toFixed(1)} USDT</span>
                                    </div>
                                    <input
                                        type="range"
                                        min="1.0"
                                        max="50.0"
                                        step="0.5"
                                        value={minOrderSize}
                                        onChange={(e) => {
                                            const val = parseFloat(e.target.value);
                                            setMinOrderSize(val);
                                            handleParamChange('minOrderSize', val);
                                        }}
                                        className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-[#226af0]"
                                    />
                                </div>



                                {/* TP & SL multipliers */}
                                <div className="grid grid-cols-2 gap-3.5">
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Take Profit ATR</label>
                                        <input
                                            type="number"
                                            min="1.0"
                                            max="5.0"
                                            step="0.1"
                                            value={tpAtr}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                setTpAtr(val);
                                                handleParamChange('tpAtrMultiplier', val);
                                            }}
                                            className="bg-white/3 border border-white/5 rounded-lg py-1 px-2.5 outline-none font-mono text-slate-200 focus:border-[#226af0]"
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Stop Loss ATR</label>
                                        <input
                                            type="number"
                                            min="0.5"
                                            max="3.0"
                                            step="0.1"
                                            value={slAtr}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                setSlAtr(val);
                                                handleParamChange('slAtrMultiplier', val);
                                            }}
                                            className="bg-white/3 border border-white/5 rounded-lg py-1 px-2.5 outline-none font-mono text-slate-200 focus:border-[#226af0]"
                                        />
                                    </div>
                                </div>

                                {/* Simulated Capital & Smart Quant Switch */}
                                <div className="grid grid-cols-2 gap-3.5 border-t border-white/5 pt-3.5 mt-1">
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">Simulated Starting Capital ($)</label>
                                        <input
                                            type="number"
                                            min="100"
                                            max="1000000"
                                            step="100"
                                            value={simulatedCapital}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                handleSetCapital(val);
                                            }}
                                            className="bg-white/3 border border-white/5 rounded-lg py-1 px-2.5 outline-none font-mono text-slate-200 focus:border-[#226af0]"
                                        />
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                            Smart Quant (Order Adjuster)
                                        </label>
                                        <div className="flex items-center h-8 gap-2 bg-white/2 border border-white/5 px-2.5 rounded-lg">
                                            <span className={`text-[9px] font-black ${smartOrderAdjustment ? 'text-[#226af0]' : 'text-slate-500'}`}>
                                                {smartOrderAdjustment ? 'ACTIVE' : 'OFF'}
                                            </span>
                                            <label className="relative inline-flex items-center cursor-pointer ml-auto">
                                                <input
                                                    type="checkbox"
                                                    checked={smartOrderAdjustment}
                                                    onChange={(e) => handleToggleSmartQuant(e.target.checked)}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[#00c076] shadow-sm"></div>
                                            </label>
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 border-t border-white/5 pt-3.5 mt-1">
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                            AI Smart Grid Mode
                                        </label>
                                        <div className="flex items-center h-8 gap-2 bg-white/2 border border-white/5 px-2.5 rounded-lg">
                                            <span className={`text-[9px] font-black ${gridModeEnabled ? 'text-[#226af0] animate-pulse' : 'text-slate-500'}`}>
                                                {gridModeEnabled ? 'ACTIVE' : 'OFF'}
                                            </span>
                                            <label className="relative inline-flex items-center cursor-pointer ml-auto">
                                                <input
                                                    type="checkbox"
                                                    checked={gridModeEnabled}
                                                    onChange={(e) => handleToggleGrid(e.target.checked)}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[#00c076] shadow-sm"></div>
                                            </label>
                                        </div>
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 border-t border-white/5 pt-3.5 mt-1">
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                            Auto DCA (Dollar-Cost Averaging)
                                        </label>
                                        <div className="flex items-center h-8 gap-2 bg-white/2 border border-white/5 px-2.5 rounded-lg">
                                            <span className={`text-[9px] font-black ${dcaEnabled ? 'text-[#226af0]' : 'text-slate-500'}`}>
                                                {dcaEnabled ? 'ACTIVE' : 'OFF'}
                                            </span>
                                            <label className="relative inline-flex items-center cursor-pointer ml-auto">
                                                <input
                                                    type="checkbox"
                                                    checked={dcaEnabled}
                                                    onChange={(e) => handleToggleDca(e.target.checked)}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[#00c076] shadow-sm"></div>
                                            </label>
                                        </div>
                                    </div>
                                </div>

                                {dcaEnabled && (
                                    <div className="grid grid-cols-2 gap-3.5 border-t border-white/5 pt-3.5 mt-1">
                                        <div className="flex flex-col gap-1">
                                            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">DCA Max Steps</label>
                                            <input
                                                type="number"
                                                min="1"
                                                max="10"
                                                value={dcaMaxSteps}
                                                onChange={(e) => handleParamChange('dcaMaxSteps', parseInt(e.target.value))}
                                                className="bg-white/3 border border-white/5 rounded-lg py-1 px-2.5 outline-none font-mono text-slate-200 focus:border-[#226af0]"
                                            />
                                        </div>
                                        <div className="flex flex-col gap-1">
                                            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider">DCA Trigger Drop (%)</label>
                                            <input
                                                type="number"
                                                min="0.1"
                                                max="50"
                                                step="0.5"
                                                value={dcaPriceDropPct}
                                                onChange={(e) => handleParamChange('dcaPriceDropPct', parseFloat(e.target.value))}
                                                className="bg-white/3 border border-white/5 rounded-lg py-1 px-2.5 outline-none font-mono text-slate-200 focus:border-[#226af0]"
                                            />
                                        </div>
                                    </div>
                                )}

                                <div className="grid grid-cols-1 border-t border-white/5 pt-3.5 mt-1 gap-3">
                                    <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                        Daily Risk Limits
                                    </label>

                                    <div className="bg-white/2 border border-white/5 rounded-lg p-2.5 flex flex-col gap-1.5">
                                        <div className="flex justify-between items-center text-[10px] font-bold uppercase">
                                            <span className="text-slate-400">PnL Today</span>
                                            <span className={`font-mono ${dailyPnL >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]'}`}>
                                                {dailyPnL >= 0 ? '+' : ''}${dailyPnL.toFixed(2)}
                                            </span>
                                        </div>
                                        <div className="text-[9px] text-slate-500">
                                            Max daily loss: ${maxDailyDrawdownLimitUsd.toFixed(2)} ({maxDailyDrawdown}% capital)
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-1">
                                        <div className="flex justify-between items-center text-[10px] font-bold uppercase">
                                            <span className="text-slate-400">Daily Drawdown Limit (% Capital)</span>
                                            <span className="text-[#ff3b30] font-mono">{maxDailyDrawdown}%</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="1"
                                            max="50"
                                            step="0.5"
                                            value={maxDailyDrawdown}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                setMaxDailyDrawdown(val);
                                                handleParamChange('maxDailyDrawdown', val);
                                            }}
                                            className="w-full h-1 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-[#ff3b30]"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 border-t border-white/5 pt-3.5 mt-1">
                                    <div className="flex flex-col gap-1">
                                        <label className="text-[9px] font-bold text-slate-400 uppercase tracking-wider flex items-center gap-1">
                                            LLM Quant Operator Brain
                                        </label>
                                        <div className="flex items-center h-8 gap-2 bg-white/2 border border-white/5 px-2.5 rounded-lg">
                                            <span className={`text-[9px] font-black ${quantOperatorEnabled ? 'text-[#a29bfe] animate-pulse' : 'text-slate-500'}`}>
                                                {quantOperatorEnabled ? 'ACTIVE' : 'OFF'}
                                            </span>
                                            <label className="relative inline-flex items-center cursor-pointer ml-auto">
                                                <input
                                                    type="checkbox"
                                                    checked={quantOperatorEnabled}
                                                    onChange={(e) => handleToggleQuantOperator(e.target.checked)}
                                                    className="sr-only peer"
                                                />
                                                <div className="w-7 h-4 bg-slate-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[#706fd3] shadow-sm"></div>
                                            </label>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Console Logs */}
                    <div className="flex-1 flex flex-col bg-[#040507] border border-white/5 rounded-xl overflow-hidden shadow-lg min-h-[160px]">
                        <div className="flex items-center justify-between px-4 h-10 border-b border-white/5 bg-[#11141c]/50 select-none">
                            <div className="flex items-center gap-2">

                                <h2 className="text-xs font-bold uppercase tracking-wider text-slate-200">Server Console Logs</h2>
                            </div>
                            <button
                                onClick={clearSystemLogs}
                                className="text-slate-500 hover:text-slate-200 transition-colors cursor-pointer"
                                title="Clear logs"
                            >
                                <i className="fa-regular fa-trash-can text-xs" />
                            </button>
                        </div>
                        <div className="flex-1 p-3 overflow-y-auto flex flex-col gap-1 font-mono text-[10px] leading-relaxed">
                            {logs.map((log, idx) => {
                                let borderClass = 'border-l-2 border-transparent pl-1.5 ';
                                let textClass = 'text-slate-300';

                                if (log.styleClass === 'system-line') {
                                    borderClass += 'border-slate-500';
                                    textClass = 'text-slate-400';
                                } else if (log.styleClass === 'info-line') {
                                    borderClass += 'border-[#226af0]';
                                    textClass = 'text-[#e0f7fa]';
                                } else if (log.styleClass === 'buy-line') {
                                    borderClass += 'border-[#00c076] bg-[#00c076]/5 rounded-r px-1';
                                    textClass = 'text-[#e8f5e9]';
                                } else if (log.styleClass === 'sell-line') {
                                    borderClass += 'border-[#ff3b30] bg-[#ff3b30]/5 rounded-r px-1';
                                    textClass = 'text-[#ffebee]';
                                } else if (log.styleClass === 'warning-line') {
                                    borderClass += 'border-[#ff9500]';
                                    textClass = 'text-[#ffe0b2]';
                                }

                                return (
                                    <div key={`log-${idx}`} className={`${borderClass} ${textClass} break-all`}>
                                        [{log.time}] <strong className="text-[#226af0]">{log.source}</strong>: {log.message}
                                    </div>
                                );
                            })}
                            <div ref={logsEndRef} />
                        </div>
                    </div>
                </section>
            </main>

            {/* BOTTOM PANELS: Position Manager */}
            <footer className="h-[210px] min-h-[210px] flex flex-col bg-[#11141c]/50 border-t border-white/5 shadow-2xl">
                {/* Tabs bar */}
                <div className="flex items-center justify-between px-6 h-[38px] border-b border-white/5 bg-slate-950/20 select-none">
                    <div className="flex gap-2 h-full items-end">
                        <button
                            onClick={() => setActiveTab('positions')}
                            className={`h-full px-4 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center ${activeTab === 'positions' ? 'text-[#226af0] border-[#226af0]' : 'text-slate-400 border-transparent hover:text-slate-200'
                                }`}
                        >
                            Active Holdings ({openPositions.length})
                        </button>
                        <button
                            onClick={() => setActiveTab('grid')}
                            className={`h-full px-4 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center ${activeTab === 'grid' ? 'text-[#226af0] border-[#226af0]' : 'text-slate-400 border-transparent hover:text-slate-200'
                                }`}
                        >
                            AI Smart Grid ({gridOrders.length})
                        </button>
                        <button
                            onClick={() => setActiveTab('orders')}
                            className={`h-full px-4 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center ${activeTab === 'orders' ? 'text-[#226af0] border-[#226af0]' : 'text-slate-400 border-transparent hover:text-slate-200'
                                }`}
                        >
                            Order History ({orderHistory.length})
                        </button>
                        <button
                            onClick={() => setActiveTab('history')}
                            className={`h-full px-4 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center ${activeTab === 'history' ? 'text-[#226af0] border-[#226af0]' : 'text-slate-400 border-transparent hover:text-slate-200'
                                }`}
                        >
                            {backtestMode ? 'Backtest Trade History' : 'Trade History'}
                        </button>
                        <button
                            onClick={() => setActiveTab('metrics')}
                            className={`h-full px-4 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center ${activeTab === 'metrics' ? 'text-[#226af0] border-[#226af0]' : 'text-slate-400 border-transparent hover:text-slate-200'
                                }`}
                        >
                            Performance Metrics
                        </button>
                        <button
                            onClick={() => setActiveTab('operator')}
                            className={`h-full px-4 text-xs font-bold border-b-2 transition-all cursor-pointer flex items-center gap-1.5 ${activeTab === 'operator' ? 'text-[#a29bfe] border-[#706fd3]' : 'text-slate-400 border-transparent hover:text-[#a29bfe]/80'
                                }`}
                        >
                            Quant Operator Brain (LLM)
                        </button>
                    </div>

                    <div className="flex items-center gap-6 font-mono text-[11px]">
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">Capital Allocated:</span>
                            <span className="font-extrabold">${marginUsed.toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">USDT Available:</span>
                            <span className="text-[#00c076] font-extrabold">${marginFree.toFixed(2)}</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">Unrealized PnL:</span>
                            <span className={`font-extrabold ${totalUnrealizedPnl >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]'}`}>
                                ${totalUnrealizedPnl >= 0 ? '+' : ''}{totalUnrealizedPnl.toFixed(2)} ({marginUsed > 0 ? `${totalUnrealizedPnl >= 0 ? '+' : ''}${((totalUnrealizedPnl / marginUsed) * 100).toFixed(2)}%` : '0.00%'})
                            </span>
                        </div>
                    </div>
                </div>

                {/* Tab content body */}
                <div className="flex-1 overflow-y-auto p-0 min-h-0 bg-[#0c0d12]/30">

                    {/* Orders tab */}
                    {activeTab === 'orders' && (
                        <div className="h-full overflow-auto">
                            <table className="w-full border-collapse text-left text-[11px]">
                                <thead>
                                    <tr className="bg-slate-950/45 text-slate-500 border-b border-white/5 font-semibold sticky top-0 z-10 uppercase tracking-wider text-[9px]">
                                        <th className="py-2 px-5">Time</th>
                                        <th className="py-2 px-4">Symbol</th>
                                        <th className="py-2 px-4">Order Type</th>
                                        <th className="py-2 px-4">Side</th>
                                        <th className="py-2 px-4">Order Price</th>
                                        <th className="py-2 px-4">Quantity</th>
                                        <th className="py-2 px-4">Status</th>
                                        <th className="py-2 px-4 text-right">Realized PnL</th>
                                        <th className="py-2 px-5 text-right">Details</th>
                                    </tr>
                                </thead>
                                <tbody className="font-mono text-slate-300">
                                    {orderHistory.length === 0 ? (
                                        <tr className="text-center font-sans text-slate-500">
                                            <td colSpan={9} className="py-12">No order logs recorded.</td>
                                        </tr>
                                    ) : (
                                        [...orderHistory].reverse().map((o, idx) => {
                                            const isBuy = o.side === 'BUY';
                                            return (
                                                <tr key={`ord-${idx}`} className="border-b border-white/5 hover:bg-white/1">
                                                    <td className="py-2.5 px-5 text-slate-500">{o.time}</td>
                                                    <td className="py-2.5 px-4"><span className="bg-[#226af0]/10 text-[#226af0] px-2 py-0.5 rounded text-[10px] font-bold">{o.symbol}</span></td>
                                                    <td className="py-2.5 px-4">
                                                        <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${o.type === 'LIMIT' ? 'bg-[#9b51e0]/10 text-[#9b51e0] border border-[#9b51e0]/20' : 'bg-[#af52de]/10 text-[#af52de] border border-[#af52de]/20'}`}>
                                                            {o.type}
                                                        </span>
                                                    </td>
                                                    <td className="py-2.5 px-4"><span className={`px-2 py-0.5 rounded text-[10px] font-extrabold ${isBuy ? 'bg-[#00c076]/10 text-[#00c076] border border-[#00c076]/30' : 'bg-[#ff3b30]/10 text-[#ff3b30] border border-[#ff3b30]/30'}`}>{o.side}</span></td>
                                                    <td className="py-2.5 px-4">${o.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                    <td className="py-2.5 px-4">{o.size.toFixed(4)}</td>
                                                    <td className="py-2.5 px-4">
                                                        <span className={`px-2 py-0.5 rounded text-[9px] font-black tracking-wide uppercase ${o.status === 'PENDING' ? 'bg-slate-800 text-slate-400 border border-slate-700/50' :
                                                                o.status === 'FILLED' ? 'bg-[#ff9500]/15 text-[#ff9500] border border-[#ff9500]/30 animate-pulse' :
                                                                    o.status === 'CANCELLED' ? 'bg-slate-900 text-slate-500 border border-slate-800' :
                                                                        'bg-[#00c076]/15 text-[#00c076] border border-[#00c076]/30'
                                                            }`}>
                                                            {o.status}
                                                        </span>
                                                    </td>
                                                    <td className={`py-2.5 px-4 text-right font-bold ${typeof o.pnl === 'number' ? (o.pnl >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]') : 'text-slate-500'
                                                        }`}>
                                                        {typeof o.pnl === 'number'
                                                            ? (o.pnl === 0 ? '$0.00' : `${o.pnl > 0 ? '+' : '-'}$${Math.abs(o.pnl).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
                                                            : '--'}
                                                    </td>
                                                    <td className="py-2.5 px-5 text-right text-slate-400 font-sans text-[10px]">
                                                        {o.reason || '-'}
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* Grid tab */}
                    {activeTab === 'grid' && (
                        <div className="h-full flex flex-col p-4 gap-4 overflow-y-auto">
                            {/* Grid stats cards */}
                            <div className="grid grid-cols-4 gap-4 select-none">
                                <div className="bg-white/2 border border-white/5 rounded-xl p-3 flex flex-col gap-1">
                                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Grid Status</span>
                                    <span className={`text-[13px] font-extrabold ${gridActive ? 'text-[#226af0] animate-pulse' : 'text-[#ff9500]'}`}>
                                        {gridActive ? 'RUNNING (DEPLOYED) ' : (gridModeEnabled ? 'WAITING FOR SIDEWAYS' : 'INACTIVE ')}
                                    </span>
                                </div>
                                <div className="bg-white/2 border border-white/5 rounded-xl p-3 flex flex-col gap-1 font-mono">
                                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Grid Profit</span>
                                    <span className={`text-[13px] font-extrabold ${gridOrders.reduce((a, o) => a + (o.status === 'FILLED' ? o.pnl : 0), 0) >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]'
                                        }`}>
                                        {(() => {
                                            const total = gridOrders.reduce((a, o) => a + (o.status === 'FILLED' ? o.pnl : 0), 0);
                                            return total === 0 ? '$0.00' : `${total > 0 ? '+$' : '-$'}${Math.abs(total).toFixed(2)}`;
                                        })()}
                                    </span>
                                </div>
                                <div className="bg-white/2 border border-white/5 rounded-xl p-3 flex flex-col gap-1 font-mono">
                                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Safety Boundary</span>
                                    <span className="text-[12px] font-bold text-slate-200">
                                        Upper Limit: <span className="text-[#ff3b30]">${gridUpperBoundary > 0 ? gridUpperBoundary.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '--.--'}</span>
                                    </span>
                                </div>
                                <div className="bg-white/2 border border-white/5 rounded-xl p-3 flex flex-col gap-1 font-mono">
                                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Safety Boundary</span>
                                    <span className="text-[12px] font-bold text-slate-200">
                                        Lower Limit: <span className="text-[#ff3b30]">${gridLowerBoundary > 0 ? gridLowerBoundary.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '--.--'}</span>
                                    </span>
                                </div>
                            </div>

                            {/* Grid orders table */}
                            <div className="flex-1 border border-white/5 rounded-xl overflow-hidden min-h-[140px] bg-slate-950/20">
                                <table className="w-full border-collapse text-left text-[11px]">
                                    <thead>
                                        <tr className="bg-slate-950/45 text-slate-500 border-b border-white/5 font-semibold sticky top-0 z-10 uppercase tracking-wider text-[9px]">
                                            <th className="py-2 px-5">Grid ID</th>
                                            <th className="py-2 px-4">Order Type</th>
                                            <th className="py-2 px-4">Trigger Price</th>
                                            <th className="py-2 px-4">Notional Size</th>
                                            <th className="py-2 px-4">Capital</th>
                                            <th className="py-2 px-4">Take Profit Price</th>
                                            <th className="py-2 px-4">Status</th>
                                            <th className="py-2 px-5 text-right">Grid Profit</th>
                                        </tr>
                                    </thead>
                                    <tbody className="font-mono text-slate-300">
                                        {gridOrders.length === 0 ? (
                                            <tr className="text-center font-sans text-slate-500">
                                                <td colSpan={8} className="py-12">
                                                    {gridModeEnabled
                                                        ? "AI Grid is not active. Scanning for sideways market signals..."
                                                        : "Please enable AI Smart Grid Mode in Settings to initialize grids."}
                                                </td>
                                            </tr>
                                        ) : (
                                            gridOrders.map((order, idx) => (
                                                <tr key={order.id || idx} className="border-b border-white/2 hover:bg-white/2 transition-colors">
                                                    <td className="py-2.5 px-5 font-bold text-slate-400">{order.id}</td>
                                                    <td className="py-2.5 px-4 font-bold">
                                                        <span className={order.type === 'BUY_LIMIT' ? 'text-[#00c076]' : 'text-[#ff3b30]'}>
                                                            {order.type === 'BUY_LIMIT' ? 'BUY LONG' : 'SELL SHORT'}
                                                        </span>
                                                    </td>
                                                    <td className="py-2.5 px-4 text-slate-200">${order.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                    <td className="py-2.5 px-4 text-slate-300">{order.size.toFixed(4)}</td>
                                                    <td className="py-2.5 px-4 text-slate-300">${order.margin.toFixed(2)}</td>
                                                    <td className="py-2.5 px-4 text-[#00c076] font-bold">${order.tpPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                    <td className="py-2.5 px-4">
                                                        <span className={`px-2 py-0.5 rounded text-[9px] font-black tracking-wide uppercase ${order.status === 'PENDING' ? 'bg-slate-800 text-slate-400 border border-slate-700/50' :
                                                                order.status === 'FILLED' ? 'bg-[#ff9500]/15 text-[#ff9500] border border-[#ff9500]/30 animate-pulse' :
                                                                    'bg-[#00c076]/15 text-[#00c076] border border-[#00c076]/30'
                                                            }`}>
                                                            {order.status === 'PENDING' ? 'PENDING' :
                                                                order.status === 'FILLED' ? 'FILLED' :
                                                                    'CLOSED'}
                                                        </span>
                                                    </td>
                                                    <td className={`py-2.5 px-5 text-right font-bold ${order.status === 'FILLED' ? (order.pnl >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]') :
                                                            order.status === 'CLOSED' ? 'text-[#00c076]' : 'text-slate-500'
                                                        }`}>
                                                        {order.status === 'PENDING' ? '$0.00' : (
                                                            order.pnl === 0 ? '$0.00' : `${order.pnl > 0 ? '+' : '-'}$${Math.abs(order.pnl).toFixed(2)}`
                                                        )}
                                                    </td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Positions tab */}
                    {activeTab === 'positions' && (
                        <div className="h-full overflow-auto">
                            <table className="w-full border-collapse text-left text-[11px]">
                                <thead>
                                    <tr className="bg-slate-950/45 text-slate-500 border-b border-white/5 font-semibold sticky top-0 z-10 uppercase tracking-wider text-[9px]">
                                        <th className="py-2 px-5">Symbol</th>
                                        <th className="py-2 px-4">Notional Size</th>
                                        <th className="py-2 px-4">Entry Price</th>
                                        <th className="py-2 px-4">Mark Price</th>
                                        <th className="py-2 px-4">Capital</th>
                                        <th className="py-2 px-4">SL / TP & Trailing</th>
                                        <th className="py-2 px-4">Unrealized PnL (%)</th>
                                        <th className="py-2 px-5 text-right">Actions</th>
                                    </tr>
                                </thead>
                                <tbody className="font-mono text-slate-300">
                                    {openPositions.length === 0 ? (
                                        <tr className="text-center font-sans text-slate-500">
                                            <td colSpan={8} className="py-12">No active holdings.</td>
                                        </tr>
                                    ) : (
                                        openPositions.map((pos, idx) => {
                                            const isProfit = pos.pnl >= 0;
                                            const currentPosPrice = livePrices[pos.symbol] || pos.entryPrice;
                                            const tpDist = Math.abs(pos.tp - pos.entryPrice);
                                            const rawProgress = tpDist > 0
                                                ? (pos.type === 'LONG'
                                                    ? (currentPosPrice - pos.entryPrice) / tpDist
                                                    : (pos.entryPrice - currentPosPrice) / tpDist)
                                                : 0;
                                            const progressPct = Math.max(0, Math.min(rawProgress * 100, 130));
                                            const tierLabels: Record<number, string> = {
                                                1: 'T0 -50% Risk',
                                                2: 'T1 Breakeven',
                                                3: 'T2 Lock 25%',
                                                4: 'T3 Lock 50%',
                                                5: 'T4 Lock 75%',
                                            };
                                            const tierColors: Record<number, string> = {
                                                1: 'text-yellow-400',
                                                2: 'text-blue-400',
                                                3: 'text-[#00c076]',
                                                4: 'text-emerald-400',
                                                5: 'text-purple-400',
                                            };
                                            const activeTier = pos.trailingTier || 0;
                                            const barColor = activeTier >= 5 ? '#a855f7' : activeTier >= 3 ? '#00c076' : activeTier >= 2 ? '#3b82f6' : activeTier >= 1 ? '#eab308' : '#475569';
                                            return (
                                                <tr key={`pos-${idx}`} className="border-b border-white/5 hover:bg-white/1">
                                                    <td className="py-2.5 px-5"><span className="bg-[#226af0]/10 text-[#226af0] px-2 py-0.5 rounded border border-[#226af0]/20 text-[10px] font-bold">{pos.symbol}</span></td>
                                                    <td className="py-2.5 px-4">${(pos.size * pos.entryPrice).toFixed(2)}</td>
                                                    <td className="py-2.5 px-4">${pos.entryPrice.toLocaleString(undefined, { minimumFractionDigits: getDigits(pos.symbol), maximumFractionDigits: getDigits(pos.symbol) })}</td>
                                                    <td className="py-2.5 px-4">${currentPosPrice.toLocaleString(undefined, { minimumFractionDigits: getDigits(pos.symbol), maximumFractionDigits: getDigits(pos.symbol) })}</td>
                                                    <td className="py-2.5 px-4">${pos.margin.toFixed(2)}</td>
                                                    <td className="py-2.5 px-4 min-w-[160px]">
                                                        <div className="flex flex-col gap-0.5">
                                                            <div className="flex items-center gap-1 text-[9px]">
                                                                <span className="text-[#ff3b30]">SL ${pos.sl.toLocaleString(undefined, { minimumFractionDigits: getDigits(pos.symbol), maximumFractionDigits: getDigits(pos.symbol) })}</span>
                                                                {pos.binanceSlSynced === false && (
                                                                    <span className="text-yellow-400 font-bold">sync</span>
                                                                )}
                                                            </div>
                                                            <div className="text-[9px] text-[#00c076]">TP ${pos.tp.toLocaleString(undefined, { minimumFractionDigits: getDigits(pos.symbol), maximumFractionDigits: getDigits(pos.symbol) })}</div>
                                                            <div className="relative h-1.5 w-full bg-white/5 rounded-full overflow-hidden mt-0.5">
                                                                <div
                                                                    className="absolute left-0 top-0 h-full rounded-full transition-all"
                                                                    style={{ width: `${Math.min(progressPct, 100)}%`, backgroundColor: barColor }}
                                                                />
                                                                {[30, 50, 75, 90, 100].map(mark => (
                                                                    <div key={mark} className="absolute top-0 h-full w-px bg-white/20" style={{ left: `${mark}%` }} />
                                                                ))}
                                                            </div>
                                                            <div className="flex items-center gap-1 mt-0.5">
                                                                {activeTier > 0 ? (
                                                                    <span className={`text-[8px] font-bold ${tierColors[activeTier] || 'text-slate-400'}`}>
                                                                        {tierLabels[activeTier]} · {progressPct.toFixed(0)}%
                                                                    </span>
                                                                ) : (
                                                                    <span className="text-[8px] text-slate-500">{progressPct.toFixed(0)}% to TP</span>
                                                                )}
                                                                {pos.partialClosed && <span className="text-[8px] text-[#00c076] font-bold ml-1">✓TP1</span>}
                                                            </div>
                                                            {pos.trailingTpActive && pos.trailingTpPrice != null && (
                                                                <span className="text-[8px] text-cyan-400 font-bold">
                                                                    Trailing TP ${pos.trailingTpPrice.toLocaleString(undefined, { minimumFractionDigits: getDigits(pos.symbol), maximumFractionDigits: getDigits(pos.symbol) })}
                                                                    {pos.peakPrice != null && ` · peak $${pos.peakPrice.toLocaleString(undefined, { minimumFractionDigits: getDigits(pos.symbol), maximumFractionDigits: getDigits(pos.symbol) })}`}
                                                                </span>
                                                            )}
                                                            {pos.hybridCloseMode && (
                                                                <span className="text-[8px] text-orange-400 font-bold">HYBRID x{pos.hybridRetries}</span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className={`py-2.5 px-4 font-extrabold ${isProfit ? 'text-[#00c076]' : 'text-[#ff3b30]'}`}>
                                                        {pos.pnl === 0 ? '$0.00' : `${pos.pnl > 0 ? '+$' : '-$'}${Math.abs(pos.pnl).toFixed(2)}`} ({pos.pnl === 0 ? '0.00%' : `${pos.pnlPercent >= 0 ? '+' : ''}${pos.pnlPercent.toFixed(2)}%`})
                                                    </td>
                                                    <td className="py-2.5 px-5 text-right">
                                                        <button
                                                            onClick={() => closePositionManual(idx)}
                                                            className="bg-[#ff3b30]/10 text-[#ff3b30] border border-[#ff3b30]/30 hover:bg-[#ff3b30] hover:text-white px-3 py-1 rounded font-bold cursor-pointer transition-all text-[10px]"
                                                        >
                                                            Sell Asset
                                                        </button>
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* Trade history */}
                    {activeTab === 'history' && (
                        <div className="h-full overflow-auto">
                            <table className="w-full border-collapse text-left text-[11px]">
                                <thead>
                                    <tr className="bg-slate-950/45 text-slate-500 border-b border-white/5 font-semibold sticky top-0 z-10 uppercase tracking-wider text-[9px]">
                                        <th className="py-2 px-5">Time</th>
                                        <th className="py-2 px-4">Symbol</th>
                                        <th className="py-2 px-4">Order Type</th>
                                        <th className="py-2 px-4">Side</th>
                                        <th className="py-2 px-4">Fill Price</th>
                                        <th className="py-2 px-4">Quantity</th>
                                        <th className="py-2 px-4">Realized PnL</th>
                                        <th className="py-2 px-5 text-right">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="font-mono text-slate-300">
                                    {tradeHistory.length === 0 ? (
                                        <tr className="text-center font-sans text-slate-500">
                                            <td colSpan={8} className="py-12">No trade history recorded.</td>
                                        </tr>
                                    ) : (
                                        [...tradeHistory].reverse().map((t, idx) => {
                                            const isBuy = t.side.includes('BUY') || t.side.includes('Long');
                                            const isProfit = t.pnl > 0;
                                            return (
                                                <tr key={`his-${idx}`} className="border-b border-white/5 hover:bg-white/1">
                                                    <td className="py-2.5 px-5 text-slate-500">{t.time}</td>
                                                    <td className="py-2.5 px-4"><span className="bg-[#226af0]/10 text-[#226af0] px-2 py-0.5 rounded text-[10px] font-bold">{t.pair}</span></td>
                                                    <td className="py-2.5 px-4">{t.type}</td>
                                                    <td className="py-2.5 px-4"><span className={`px-2 py-0.5 rounded text-[10px] font-extrabold ${isBuy ? 'bg-[#00c076]/10 text-[#00c076] border border-[#00c076]/30' : 'bg-[#ff3b30]/10 text-[#ff3b30] border border-[#ff3b30]/30'}`}>{t.side}</span></td>
                                                    <td className="py-2.5 px-4">${t.price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                                                    <td className="py-2.5 px-4">${t.size}</td>
                                                    <td className={`py-2.5 px-4 font-bold ${t.pnl === 0 ? 'text-slate-500' : (isProfit ? 'text-[#00c076]' : 'text-[#ff3b30]')}`}>
                                                        {t.pnl === 0 ? '$0.00' : `${isProfit ? '+' : '-'}$${Math.abs(t.pnl).toFixed(2)}`}
                                                    </td>
                                                    <td className="py-2.5 px-5 text-right">
                                                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${(t.status.includes('Profit') || t.status.includes('TP')) ? 'bg-[#00c076]/10 text-[#00c076] border border-[#00c076]/20' :
                                                                t.status.includes('Momentum') ? 'bg-[#ffb300]/10 text-[#ffb300] border border-[#ffb300]/20' :
                                                                    (t.status.includes('Loss') ? 'bg-[#ff3b30]/10 text-[#ff3b30] border border-[#ff3b30]/20' : 'bg-white/5 border border-white/5 text-slate-400')
                                                            }`}>
                                                            {t.status}
                                                        </span>
                                                    </td>
                                                </tr>
                                            );
                                        })
                                    )}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {/* Performance metrics */}
                    {activeTab === 'metrics' && (
                        <div className="grid grid-cols-4 gap-4 p-4 h-full">
                            <div className="flex flex-col justify-center bg-white/2 border border-white/5 rounded-lg p-3">
                                <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">AI Bot Performance (PnL %)</span>
                                <span className={`text-xl font-extrabold font-mono mt-0.5 ${(backtestMode ? backtestStats.botPnL : ((balance - simulatedCapital) / simulatedCapital) * 100) >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]'
                                    }`}>
                                    {backtestMode ? (backtestStats.botPnL >= 0 ? '+' : '') : (((balance - simulatedCapital) / simulatedCapital) * 100 >= 0 ? '+' : '')}
                                    {backtestMode ? backtestStats.botPnL.toFixed(2) : (((balance - simulatedCapital) / simulatedCapital) * 100).toFixed(2)}%
                                </span>
                                <span className="text-[10px] text-slate-400 font-mono mt-0.5">
                                    {backtestMode ? (backtestStats.botPnLUsd >= 0 ? '+$' : '-$') : (balance - simulatedCapital >= 0 ? '+$' : '-$')}
                                    {backtestMode ? Math.abs(backtestStats.botPnLUsd).toFixed(2) : Math.abs(balance - simulatedCapital).toFixed(2)}
                                </span>
                            </div>

                            <div className="flex flex-col justify-center bg-white/2 border border-white/5 rounded-lg p-3">
                                <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Benchmark Buy & Hold</span>
                                <span className={`text-xl font-extrabold font-mono mt-0.5 ${(backtestMode ? backtestStats.bhPnL : 0) >= 0 ? 'text-[#00c076]' : 'text-[#ff3b30]'
                                    }`}>
                                    {backtestMode ? (backtestStats.bhPnL >= 0 ? '+' : '') : ''}
                                    {backtestMode ? backtestStats.bhPnL.toFixed(2) : '0.00'}%
                                </span>
                                <span className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wider">Market Performance</span>
                            </div>

                            <div className="flex flex-col justify-center bg-white/2 border border-white/5 rounded-lg p-3">
                                <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Win Rate</span>
                                <span className="text-xl font-extrabold text-slate-200 font-mono mt-0.5">
                                    {backtestMode ? backtestStats.winrate.toFixed(1) : (tradeHistory.length > 0 ? ((tradeHistory.filter(t => t.pnl > 0).length / tradeHistory.length) * 100).toFixed(1) : '0.0')}%
                                </span>
                                <span className="text-[10px] text-slate-400 font-mono mt-0.5">
                                    {backtestMode ? backtestStats.tradesRatio : `${tradeHistory.filter(t => t.pnl > 0).length} wins / ${tradeHistory.length} trades`}
                                </span>
                            </div>

                            <div className="flex flex-col justify-center bg-white/2 border border-white/5 rounded-lg p-3">
                                <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Max Drawdown</span>
                                <span className="text-xl font-extrabold text-[#ff3b30] font-mono mt-0.5">
                                    -{backtestMode ? backtestStats.maxDrawdown.toFixed(2) : '0.00'}%
                                </span>
                                <span className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wider">Max Drawdown</span>
                            </div>

                            <div className="flex flex-col justify-center bg-white/2 border border-white/5 rounded-lg p-3">
                                <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Profit Factor</span>
                                <span className={`text-xl font-extrabold font-mono mt-0.5 ${backtestMode && backtestStats.profitFactor >= 1.5 ? 'text-[#00c076]' :
                                        backtestMode && backtestStats.profitFactor >= 1.0 ? 'text-slate-200' : 'text-[#ff3b30]'
                                    }`}>
                                    {backtestMode ? (backtestStats.profitFactor > 99 ? '∞' : backtestStats.profitFactor.toFixed(2)) : '–'}
                                </span>
                                <span className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wider">Profit / Loss</span>
                            </div>

                            <div className="flex flex-col justify-center bg-white/2 border border-white/5 rounded-lg p-3">
                                <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Expectancy / Trade</span>
                                <span className={`text-xl font-extrabold font-mono mt-0.5 ${backtestMode && backtestStats.expectancy > 0 ? 'text-[#00c076]' :
                                        backtestMode && backtestStats.expectancy < 0 ? 'text-[#ff3b30]' : 'text-slate-200'
                                    }`}>
                                    {backtestMode ? `${backtestStats.expectancy >= 0 ? '+$' : '-$'}${Math.abs(backtestStats.expectancy).toFixed(2)}` : '–'}
                                </span>
                                <span className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wider">
                                    {backtestMode ? `Avg win +$${backtestStats.avgWin.toFixed(2)} / loss -$${backtestStats.avgLoss.toFixed(2)}` : 'Expectancy'}
                                </span>
                            </div>

                            <div className="flex flex-col justify-center bg-white/2 border border-white/5 rounded-lg p-3">
                                <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider">Sharpe Ratio</span>
                                <span className={`text-xl font-extrabold font-mono mt-0.5 ${backtestMode && backtestStats.sharpe >= 1 ? 'text-[#00c076]' :
                                        backtestMode && backtestStats.sharpe <= 0 ? 'text-[#ff3b30]' : 'text-slate-200'
                                    }`}>
                                    {backtestMode ? backtestStats.sharpe.toFixed(2) : '–'}
                                </span>
                                <span className="text-[10px] text-slate-500 mt-0.5 uppercase tracking-wider">Profit / Volatility</span>
                            </div>
                        </div>
                    )}

                    {/* Quant Operator Terminal */}
                    {activeTab === 'operator' && (
                        <div className="flex h-full min-h-0 bg-[#07080d]/80 text-[11px] overflow-hidden select-none">
                            {/* Radar / Metrics Panel */}
                            <div className="w-[300px] min-w-[300px] border-r border-white/5 p-4 flex flex-col gap-3.5 bg-slate-950/20 font-mono">
                                <div className="text-[10px] font-bold text-slate-500 uppercase tracking-widest border-b border-white/5 pb-2 flex items-center gap-1.5">
                                    Market Radar Metrics
                                </div>

                                <div className="bg-white/2 border border-white/5 rounded-xl p-3 flex flex-col gap-1.5">
                                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Choppiness Index</span>
                                    <div className="flex items-center justify-between">
                                        <span className="text-[14px] font-extrabold text-slate-200">{quantOperatorMetrics.choppiness.toFixed(1)}</span>
                                        <span className={`text-[9px] font-black px-2 py-0.5 rounded ${quantOperatorMetrics.choppiness > 62 ? 'bg-[#00c076]/10 text-[#00c076]' :
                                                quantOperatorMetrics.choppiness < 52 ? 'bg-[#ff3b30]/10 text-[#ff3b30]' :
                                                    'bg-slate-800 text-slate-400'
                                            }`}>
                                            {quantOperatorMetrics.choppiness > 62 ? 'SIDEWAYS (CHOP)' :
                                                quantOperatorMetrics.choppiness < 52 ? 'TRENDING' :
                                                    'NEUTRAL (NORMAL)'}
                                        </span>
                                    </div>
                                    <div className="w-full bg-slate-850 h-1.5 rounded-full overflow-hidden mt-0.5 border border-white/5">
                                        <div
                                            className={`h-full transition-all duration-500 ${quantOperatorMetrics.choppiness > 62 ? 'bg-[#00c076]' :
                                                    quantOperatorMetrics.choppiness < 52 ? 'bg-[#ff3b30]' : 'bg-slate-500'
                                                }`}
                                            style={{ width: `${quantOperatorMetrics.choppiness}%` }}
                                        ></div>
                                    </div>
                                </div>

                                <div className="bg-white/2 border border-white/5 rounded-xl p-3 flex flex-col gap-1.5">
                                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">ATR Volatility %</span>
                                    <div className="flex items-center justify-between">
                                        <span className="text-[14px] font-extrabold text-slate-200">{quantOperatorMetrics.volatility.toFixed(2)}%</span>
                                        <span className={`text-[9px] font-black px-2 py-0.5 rounded ${quantOperatorMetrics.volatility >= 1.2 ? 'bg-[#ff3b30]/15 text-[#ff3b30] border border-[#ff3b30]/30 animate-pulse' :
                                                quantOperatorMetrics.volatility < 0.25 ? 'bg-slate-800 text-slate-400' :
                                                    'bg-[#226af0]/10 text-[#226af0]'
                                            }`}>
                                            {quantOperatorMetrics.volatility >= 1.2 ? 'EXTREME ' :
                                                quantOperatorMetrics.volatility < 0.25 ? 'LOW' :
                                                    'STABLE'}
                                        </span>
                                    </div>
                                    <div className="w-full bg-slate-850 h-1.5 rounded-full overflow-hidden mt-0.5 border border-white/5">
                                        <div
                                            className={`h-full transition-all duration-500 ${quantOperatorMetrics.volatility >= 1.2 ? 'bg-[#ff3b30]' :
                                                    quantOperatorMetrics.volatility < 0.25 ? 'bg-slate-600' : 'bg-[#226af0]'
                                                }`}
                                            style={{ width: `${Math.min(100, (quantOperatorMetrics.volatility / 1.5) * 100)}%` }}
                                        ></div>
                                    </div>
                                </div>

                                <div className="bg-white/2 border border-white/5 rounded-xl p-3 flex flex-col gap-1.5">
                                    <span className="text-[9px] font-bold text-slate-500 uppercase tracking-wider">Trend Intensity</span>
                                    <div className="flex items-center justify-between">
                                        <span className="text-[14px] font-extrabold text-slate-200">{quantOperatorMetrics.trendIntensity}</span>
                                        <span className={`text-[9px] font-black px-2 py-0.5 rounded ${quantOperatorMetrics.trendIntensity >= 35 ? 'bg-[#ff3b30]/10 text-[#ff3b30]' : 'bg-slate-800 text-slate-400'
                                            }`}>
                                            {quantOperatorMetrics.trendIntensity >= 35 ? 'STRONG ' : 'WEAK/ACCUMULATION'}
                                        </span>
                                    </div>
                                    <div className="w-full bg-slate-850 h-1.5 rounded-full overflow-hidden mt-0.5 border border-white/5">
                                        <div
                                            className={`h-full transition-all duration-550 ${quantOperatorMetrics.trendIntensity >= 35 ? 'bg-[#ff3b30]' : 'bg-slate-600'
                                                }`}
                                            style={{ width: `${quantOperatorMetrics.trendIntensity}%` }}
                                        ></div>
                                    </div>
                                </div>
                            </div>

                            {/* Scrolling Thoughts Terminal */}
                            <div className="flex-1 flex flex-col min-w-0 bg-[#05060a]/90">
                                <div className="h-8 border-b border-white/5 bg-slate-950/40 px-4 flex items-center justify-between select-none">
                                    <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1.5">
                                        QUANT COGNITIVE PROMPT LOGS (OPERATOR COGNITION)
                                    </span>
                                    <span className="flex items-center gap-1">
                                        <span className={`w-1.5 h-1.5 rounded-full ${quantOperatorEnabled ? 'bg-[#00c076] animate-pulse' : 'bg-slate-600'}`}></span>
                                        <span className="text-[9px] text-slate-500 font-bold uppercase">{quantOperatorEnabled ? 'ACTIVE MONITORING' : 'OFF'}</span>
                                    </span>
                                </div>

                                <div className="flex-1 overflow-y-auto p-4 font-mono text-[10px] flex flex-col gap-2.5 leading-relaxed">
                                    {quantOperatorThoughts.length === 0 ? (
                                        <div className="flex flex-col items-center justify-center h-full text-slate-500 py-12">
                                            <i className="fa-solid fa-brain text-4xl text-[#a29bfe]/20 animate-pulse mb-3" />
                                            <p className="font-sans">No cognitive logs recorded yet. Enable "LLM Quant Operator Brain" in configuration panel for real-time analysis.</p>
                                        </div>
                                    ) : (
                                        [...quantOperatorThoughts].reverse().map((t, idx) => {
                                            const isDecision = t.type === 'decision';
                                            const isWarning = t.type === 'warning' || t.message.includes('') || t.message.includes('');

                                            let cardClass = "border-l-2 border-slate-700 bg-slate-900/20 text-slate-300";
                                            let tagClass = "text-[#a29bfe]";
                                            let icon = <i className="fa-solid fa-brain text-[11px] text-[#a29bfe] shrink-0 mt-0.5" />;

                                            if (isDecision) {
                                                cardClass = "border-l-2 border-[#226af0] bg-[#226af0]/5 text-[#e0f7fa] font-semibold border border-[#226af0]/15";
                                                tagClass = "text-[#226af0]";
                                                icon = <i className="fa-solid fa-bolt text-[11px] text-[#226af0] shrink-0 animate-pulse mt-0.5" />;
                                            } else if (isWarning) {
                                                cardClass = "border-l-2 border-[#ffb142] bg-[#ffb142]/5 text-[#ffeaa7] border border-[#ffb142]/15";
                                                tagClass = "text-[#ffb142]";
                                                icon = <i className="fa-solid fa-triangle-exclamation text-[11px] text-[#ffb142] shrink-0 animate-bounce mt-0.5" />;
                                            } else if (t.message.includes('')) {
                                                cardClass = "border-l-2 border-slate-600 bg-slate-800/10 text-slate-400";
                                                tagClass = "text-slate-500";
                                                icon = <i className="fa-solid fa-star text-[10px] text-slate-500 shrink-0 mt-0.5" />;
                                            }

                                            return (
                                                <div key={`thought-${idx}`} className={`pl-3 pr-2 py-1.5 rounded-r flex items-start gap-2.5 ${cardClass}`}>
                                                    <div className="mt-0.5">{icon}</div>
                                                    <div className="flex-1">
                                                        <span className="text-slate-500 font-bold mr-1">[{t.time}]</span>
                                                        <span className={`font-bold mr-1.5 ${tagClass}`}>[OPERATOR]</span>
                                                        <span>{t.message}</span>
                                                    </div>
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </footer>
        </div>
    </div>
</div>
    );
}
