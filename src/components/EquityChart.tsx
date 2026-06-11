'use client';

import React, { useEffect, useRef } from 'react';
import { 
    createChart, 
    LineSeries, 
    ColorType, 
    CrosshairMode, 
    LineStyle 
} from 'lightweight-charts';

interface EquityChartProps {
    botData: any[];
    bhData: any[];
}

export const EquityChart: React.FC<EquityChartProps> = ({ botData, bhData }) => {
    const chartContainerRef = useRef<HTMLDivElement>(null);
    const chartRef = useRef<any>(null);
    const botSeriesRef = useRef<any>(null);
    const bhSeriesRef = useRef<any>(null);

    // Initialize Chart synchronously (runs client-side only due to dynamic component wrapping)
    useEffect(() => {
        try {
            if (!chartContainerRef.current) return;
            if (chartRef.current) return;

            // Wipe clean any leftover DOM elements to prevent double-canvas error
            chartContainerRef.current.innerHTML = '';

            const chart = createChart(chartContainerRef.current, {
                autoSize: true,
                layout: {
                    background: { type: ColorType.Solid, color: '#0c0d12' },
                    textColor: '#64748b',
                    fontSize: 10,
                    fontFamily: 'Inter, sans-serif',
                },
                grid: {
                    vertLines: { color: 'rgba(255,255,255,0.01)' },
                    horzLines: { color: 'rgba(255,255,255,0.01)' },
                },
                crosshair: { mode: CrosshairMode.Normal },
                rightPriceScale: { borderColor: 'rgba(255,255,255,0.04)' },
                timeScale: { borderColor: 'rgba(255,255,255,0.04)' },
            });

            const botSeries = chart.addSeries(LineSeries, {
                color: '#00c076',
                lineWidth: 2 as any,
                title: 'Bot AI Balance',
            });

            const bhSeries = chart.addSeries(LineSeries, {
                color: '#64748b',
                lineWidth: 1.5 as any,
                lineStyle: LineStyle.Dashed,
                title: 'Buy & Hold',
            });

            chartRef.current = chart;
            botSeriesRef.current = botSeries;
            bhSeriesRef.current = bhSeries;
        } catch (error) {
            console.error("Critical error initializing EquityChart:", error);
        }

        return () => {
            try {
                if (chartRef.current) {
                    chartRef.current.remove();
                    chartRef.current = null;
                    botSeriesRef.current = null;
                    bhSeriesRef.current = null;
                }
            } catch (err) {
                console.error("Error destroying/cleaning up EquityChart:", err);
            }
        };
    }, []);

    // Synchronous data updates
    useEffect(() => {
        try {
            if (!chartRef.current || !botSeriesRef.current || !bhSeriesRef.current) return;

            botSeriesRef.current.setData(botData && botData.length > 0 ? botData : []);
            bhSeriesRef.current.setData(bhData && bhData.length > 0 ? bhData : []);

            if ((botData && botData.length > 0) || (bhData && bhData.length > 0)) {
                chartRef.current.timeScale().fitContent();
            }
        } catch (error) {
            console.error("Error syncing EquityChart data:", error);
        }
    }, [botData, bhData]);

    return (
        <div ref={chartContainerRef} style={{ width: '100%', height: '100%', minHeight: '200px', position: 'relative' }} />
    );
};
