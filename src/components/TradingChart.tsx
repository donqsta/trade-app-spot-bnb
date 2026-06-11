'use client';

import React, { useEffect, useRef } from 'react';
import { AIEngine } from '@/lib/ai-engine';
import { 
    createChart, 
    CandlestickSeries, 
    HistogramSeries, 
    LineSeries, 
    ColorType, 
    CrosshairMode,
    createSeriesMarkers
} from 'lightweight-charts';

interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

interface TradingChartProps {
    candles: Candle[];
    markers: any[];
    showEma: boolean;
    pricePrecision?: number;
}

export const TradingChart: React.FC<TradingChartProps> = ({ candles, markers, showEma, pricePrecision }) => {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<any>(null);
    const candleSeriesRef = useRef<any>(null);
    const volumeSeriesRef = useRef<any>(null);
    const ema9SeriesRef = useRef<any>(null);
    const ema21SeriesRef = useRef<any>(null);
    const markersPrimitiveRef = useRef<any>(null);

    // Initialize Chart once on mount (no pricePrecision dependency — precision is updated in-place via applyOptions)
    useEffect(() => {
        try {
            if (!chartContainerRef.current) return;
            if (chartRef.current) return;

            // Wipe clean any leftover DOM elements to prevent "HTMLElement already contains a chart" error during Dev Fast Refresh remounts!
            chartContainerRef.current.innerHTML = '';

            const chart = createChart(chartContainerRef.current, {
                autoSize: true,
                layout: {
                    background: { type: ColorType.Solid, color: '#0c0d12' },
                    textColor: '#94a3b8',
                    fontSize: 11,
                    fontFamily: 'Inter, sans-serif',
                },
                grid: {
                    vertLines: { color: 'rgba(255,255,255,0.02)' },
                    horzLines: { color: 'rgba(255,255,255,0.02)' },
                },
                crosshair: { mode: CrosshairMode.Normal },
                rightPriceScale: { borderColor: 'rgba(255,255,255,0.06)' },
                timeScale: {
                    borderColor: 'rgba(255,255,255,0.06)',
                    timeVisible: true,
                    secondsVisible: false,
                },
            });

            const precision = pricePrecision ?? 2;
            const candleSeries = chart.addSeries(CandlestickSeries, {
                upColor: '#00c076',
                downColor: '#ff3b30',
                borderDownColor: '#ff3b30',
                borderUpColor: '#00c076',
                wickDownColor: '#ff3b30',
                wickUpColor: '#00c076',
                priceFormat: {
                    type: 'price',
                    precision: precision,
                    minMove: 1 / Math.pow(10, precision),
                },
            });

            const volumeSeries = chart.addSeries(HistogramSeries, {
                color: 'rgba(0,192,118,0.12)',
                priceFormat: { type: 'volume' as const },
                priceScaleId: 'volumeOverlay',
            });

            volumeSeries.priceScale().applyOptions({
                scaleMargins: { top: 0.82, bottom: 0 },
            });

            const ema9Series = chart.addSeries(LineSeries, {
                color: '#00b0ff',
                lineWidth: 1.5 as any,
                title: 'EMA 9',
            });

            const ema21Series = chart.addSeries(LineSeries, {
                color: '#ff9100',
                lineWidth: 1.5 as any,
                title: 'EMA 21',
            });

            const markersPrimitive = createSeriesMarkers(candleSeries);
            markersPrimitiveRef.current = markersPrimitive;

            chartRef.current = chart;
            candleSeriesRef.current = candleSeries;
            volumeSeriesRef.current = volumeSeries;
            ema9SeriesRef.current = ema9Series;
            ema21SeriesRef.current = ema21Series;
        } catch (error) {
            console.error("Critical error initializing TradingChart:", error);
        }

        return () => {
            try {
                if (chartRef.current) {
                    chartRef.current.remove();
                    chartRef.current = null;
                    candleSeriesRef.current = null;
                    volumeSeriesRef.current = null;
                    ema9SeriesRef.current = null;
                    ema21SeriesRef.current = null;
                    markersPrimitiveRef.current = null;
                }
            } catch (err) {
                console.error("Error destroying/cleaning up TradingChart:", err);
            }
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    // Update price precision in-place without destroying the chart
    useEffect(() => {
        if (!candleSeriesRef.current) return;
        const p = pricePrecision ?? 2;
        candleSeriesRef.current.applyOptions({
            priceFormat: {
                type: 'price',
                precision: p,
                minMove: 1 / Math.pow(10, p),
            },
        });
    }, [pricePrecision]);

    // Data-sync effect runs when variables update
    useEffect(() => {
        try {
            if (!chartRef.current || !candleSeriesRef.current || !volumeSeriesRef.current) return;
            if (!candles || candles.length === 0) return;

            // Deduplicate, validate, and sort candles chronologically to prevent "Value is null" error in lightweight-charts
            const seenTimes = new Set<number>();
            const uniqueCandles: Candle[] = [];
            
            for (const c of candles) {
                if (!c) continue;
                const time = Number(c.time);
                if (isNaN(time) || seenTimes.has(time)) continue;
                
                const open = Number(c.open);
                const high = Number(c.high);
                const low = Number(c.low);
                const close = Number(c.close);
                const volume = Number(c.volume);
                
                if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) continue;
                
                seenTimes.add(time);
                uniqueCandles.push({
                    time,
                    open,
                    high,
                    low,
                    close,
                    volume
                });
            }
            
            // Sort by time ascending
            uniqueCandles.sort((a, b) => a.time - b.time);

            if (uniqueCandles.length === 0) return;

            const chartCandles = uniqueCandles.map(c => ({
                time: c.time as any,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
            }));
            candleSeriesRef.current.setData(chartCandles);

            const volumeData = uniqueCandles.map(c => ({
                time: c.time as any,
                value: c.volume,
                color: c.close >= c.open ? 'rgba(0,192,118,0.12)' : 'rgba(255,59,48,0.12)',
            }));
            volumeSeriesRef.current.setData(volumeData);

            if (showEma && ema9SeriesRef.current && ema21SeriesRef.current) {
                const ai = new AIEngine();
                const prices = uniqueCandles.map(c => c.close);
                const ema9 = ai.calculateEMA(prices, 9);
                const ema21 = ai.calculateEMA(prices, 21);

                const ema9Data = uniqueCandles
                    .map((c, i) => ({ time: c.time as any, value: ema9[i] as number }))
                    .filter(d => d.value !== null && d.value !== undefined && !isNaN(d.value));
                const ema21Data = uniqueCandles
                    .map((c, i) => ({ time: c.time as any, value: ema21[i] as number }))
                    .filter(d => d.value !== null && d.value !== undefined && !isNaN(d.value));

                ema9SeriesRef.current.setData(ema9Data);
                ema21SeriesRef.current.setData(ema21Data);
            } else if (ema9SeriesRef.current && ema21SeriesRef.current) {
                ema9SeriesRef.current.setData([]);
                ema21SeriesRef.current.setData([]);
            }

            if (markersPrimitiveRef.current) {
                if (markers && markers.length > 0) {
                    markersPrimitiveRef.current.setMarkers(markers);
                } else {
                    markersPrimitiveRef.current.setMarkers([]);
                }
            }

            // Only fit content when data is loaded and has a non-zero length to prevent time-scale ranges error!
            chartRef.current.timeScale().fitContent();
        } catch (error) {
            console.error("Error syncing TradingChart data:", error);
        }
    }, [candles, showEma, markers]);

    return (
        <div ref={chartContainerRef} style={{ width: '100%', height: '100%', minHeight: '310px', position: 'relative' }} />
    );
};
