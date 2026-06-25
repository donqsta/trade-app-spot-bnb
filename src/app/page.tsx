'use client';

import React, { useEffect, useRef } from 'react';
import Link from 'next/link';
import Image from 'next/image';

export default function LandingPage() {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        let animationFrameId: number;
        let width = (canvas.width = window.innerWidth);
        let height = (canvas.height = window.innerHeight);

        const particles: Array<{
            x: number;
            y: number;
            vx: number;
            vy: number;
            radius: number;
            alpha: number;
            baseAlpha: number;
        }> = [];

        const particleCount = Math.min(85, Math.floor((width * height) / 18000));
        const connectionDistance = 150;
        const mouse = { x: null as number | null, y: null as number | null, radius: 190 };

        for (let i = 0; i < particleCount; i++) {
            const baseAlpha = Math.random() * 0.25 + 0.05;
            particles.push({
                x: Math.random() * width,
                y: Math.random() * height,
                vx: (Math.random() - 0.5) * 0.3,
                vy: (Math.random() - 0.5) * 0.3,
                radius: Math.random() * 1.5 + 0.6,
                alpha: baseAlpha,
                baseAlpha: baseAlpha,
            });
        }

        const handleMouseMove = (e: MouseEvent) => {
            mouse.x = e.clientX;
            mouse.y = e.clientY;
        };

        const handleMouseLeave = () => {
            mouse.x = null;
            mouse.y = null;
        };

        const handleResize = () => {
            if (!canvas) return;
            width = canvas.width = window.innerWidth;
            height = canvas.height = window.innerHeight;
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseleave', handleMouseLeave);
        window.addEventListener('resize', handleResize);

        const animate = () => {
            ctx.clearRect(0, 0, width, height);

            // Update particles
            particles.forEach((p) => {
                p.x += p.vx;
                p.y += p.vy;

                if (p.x < 0 || p.x > width) p.vx *= -1;
                if (p.y < 0 || p.y > height) p.vy *= -1;

                if (mouse.x !== null && mouse.y !== null) {
                    const dx = mouse.x - p.x;
                    const dy = mouse.y - p.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < mouse.radius) {
                        const force = (mouse.radius - dist) / mouse.radius;
                        p.x += (dx / dist) * force * 0.5;
                        p.y += (dy / dist) * force * 0.5;
                        p.alpha = Math.min(0.7, p.baseAlpha + force * 0.3);
                    } else {
                        p.alpha = p.alpha * 0.95 + p.baseAlpha * 0.05;
                    }
                } else {
                    p.alpha = p.alpha * 0.95 + p.baseAlpha * 0.05;
                }

                ctx.beginPath();
                ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(0, 255, 176, ${p.alpha})`;
                ctx.fill();
            });

            // Draw connections
            for (let i = 0; i < particles.length; i++) {
                for (let j = i + 1; j < particles.length; j++) {
                    const p1 = particles[i];
                    const p2 = particles[j];
                    const dx = p1.x - p2.x;
                    const dy = p1.y - p2.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist < connectionDistance) {
                        const alpha = (1 - dist / connectionDistance) * 0.12;
                        ctx.beginPath();
                        ctx.moveTo(p1.x, p1.y);
                        ctx.lineTo(p2.x, p2.y);
                        ctx.strokeStyle = `rgba(34, 106, 240, ${alpha})`;
                        ctx.lineWidth = 0.6;
                        ctx.stroke();
                    }
                }
            }

            // Draw shaded polygon zones
            for (let i = 0; i < particles.length; i++) {
                for (let j = i + 1; j < particles.length; j++) {
                    const p1 = particles[i];
                    const p2 = particles[j];
                    const d12 = Math.hypot(p1.x - p2.x, p1.y - p2.y);
                    if (d12 > connectionDistance) continue;

                    for (let k = j + 1; k < particles.length; k++) {
                        const p3 = particles[k];
                        const d13 = Math.hypot(p1.x - p3.x, p1.y - p3.y);
                        const d23 = Math.hypot(p2.x - p3.x, p2.y - p3.y);

                        if (d13 < connectionDistance && d23 < connectionDistance) {
                            const avgDist = (d12 + d13 + d23) / 3;
                            const polyAlpha = (1 - avgDist / connectionDistance) * 0.035;

                            ctx.beginPath();
                            ctx.moveTo(p1.x, p1.y);
                            ctx.lineTo(p2.x, p2.y);
                            ctx.lineTo(p3.x, p3.y);
                            ctx.closePath();

                            ctx.fillStyle = `rgba(0, 255, 176, ${polyAlpha})`;
                            ctx.fill();
                        }
                    }
                }
            }

            animationFrameId = requestAnimationFrame(animate);
        };

        animate();

        return () => {
            cancelAnimationFrame(animationFrameId);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseleave', handleMouseLeave);
            window.removeEventListener('resize', handleResize);
        };
    }, []);

    // Intersection Observer scroll reveal effect
    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('is-visible');
                    }
                });
            },
            { threshold: 0.1, rootMargin: '0px 0px -60px 0px' }
        );

        const elements = document.querySelectorAll('.reveal-on-scroll');
        elements.forEach((el) => observer.observe(el));

        return () => {
            elements.forEach((el) => observer.unobserve(el));
        };
    }, []);

    return (
        <div className="min-h-screen bg-[#06080b] text-[#efeeec] flex flex-col relative overflow-x-hidden font-sans selection-none">
            {/* Background Mesh Canvas */}
            <canvas ref={canvasRef} className="absolute inset-0 z-0 pointer-events-none" />

            {/* Glowing Accent Orbs - Nansen-style Green-Blue palette */}
            <div className="absolute top-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-[#00ffa7]/4 blur-[130px] pointer-events-none z-0" />
            <div className="absolute bottom-[-10%] left-[-10%] w-[45%] h-[45%] rounded-full bg-[#226af0]/4 blur-[120px] pointer-events-none z-0" />
            <div className="absolute top-[35%] left-[25%] w-[40%] h-[40%] rounded-full bg-blue-950/5 blur-[140px] pointer-events-none z-0" />

            {/* Fine Grid Background Overlay */}
            <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px),linear-gradient(to_bottom,#ffffff03_1px,transparent_1px)] bg-[size:48px_48px] pointer-events-none z-0" />

            {/* ── HEADER ── */}
            <header className="w-full h-[72px] border-b border-white/[0.04] backdrop-blur-xl bg-[#06080b]/60 flex items-center justify-between px-8 md:px-16 sticky top-0 z-50">
                <div className="flex items-center">
                    <Link href="/" className="relative h-12 w-52 flex items-center">
                        <Image
                            src="/logo.png"
                            alt="Orocle Auto Trade"
                            fill
                            className="object-contain brightness-0 invert"
                            priority
                        />
                    </Link>
                </div>

                <nav className="flex items-center gap-7">
                    <a href="#features" className="text-[11px] uppercase font-bold tracking-widest text-[#949fa6] hover:text-white transition-colors duration-250 hidden md:block">
                        Features
                    </a>
                    <a href="#llm-quant" className="text-[11px] uppercase font-bold tracking-widest text-[#949fa6] hover:text-white transition-colors duration-250 hidden md:block">
                        AI Operator
                    </a>
                    <a href="#algorithms" className="text-[11px] uppercase font-bold tracking-widest text-[#949fa6] hover:text-white transition-colors duration-250 hidden md:block">
                        Algorithms
                    </a>
                    <Link
                        href="/trade"
                        className="px-5 py-2.5 rounded-lg bg-[#efeeec] hover:bg-white text-[#06080b] text-[11px] font-black uppercase tracking-wider transition-all duration-200 shadow-[0_4px_20px_rgba(255,255,255,0.06)]"
                    >
                        Sign In ↗
                    </Link>
                </nav>
            </header>

            {/* ── HERO SECTION ── */}
            <section className="flex flex-col items-center justify-center text-center px-6 relative z-10 pt-28 pb-32">
                {/* Badge Tag */}
                <div className="inline-flex items-center gap-2.5 px-4 py-2 rounded-full border border-white/[0.05] bg-[#ffffff02] text-[#00ffa7] text-[10px] font-bold uppercase tracking-[0.22em] mb-8 shadow-sm reveal-on-scroll">
                    <span className="w-1.5 h-1.5 rounded-full bg-[#00ffa7] animate-pulse" />
                    Autonomous Onchain Execution Engine
                </div>

                {/* Main Hero Header */}
                <h1 className="text-5xl md:text-7xl lg:text-[84px] font-black uppercase tracking-tight leading-[0.9] max-w-5xl text-white reveal-on-scroll delay-100">
                    Autonomous<br />
                    <span className="bg-clip-text text-transparent bg-gradient-to-r from-[#00ffa7] via-[#226af0] to-indigo-400">
                        Trading Agent
                    </span>
                </h1>

                {/* Description */}
                <p className="mt-8 text-sm md:text-[15px] text-[#949fa6] tracking-wide max-w-2xl leading-[1.8] font-medium reveal-on-scroll delay-200">
                    Leverage cutting-edge predictive algorithms and an ensemble quantum AI system to continuously
                    analyze market patterns, deliver highly accurate trend forecasts, and automatically optimize your yields.
                </p>

                {/* Actions */}
                <div className="mt-10 flex flex-col sm:flex-row gap-5 justify-center items-center reveal-on-scroll delay-300">
                    <Link
                        href="/trade"
                        className="group inline-flex items-center gap-2 px-8 py-4 rounded-lg bg-[#226af0] hover:bg-blue-500 text-white font-extrabold text-[11px] uppercase tracking-[0.18em] shadow-[0_0_35px_rgba(34,106,240,0.25)] hover:shadow-[0_0_55px_rgba(34,106,240,0.45)] transition-all duration-300 transform active:scale-[0.98]"
                    >
                        Auto Trade Now
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                        </svg>
                    </Link>
                    <a
                        href="#features"
                        className="inline-flex items-center gap-2 px-8 py-4 rounded-lg border border-white/10 bg-[#ffffff02] hover:bg-[#ffffff06] text-[#efeeec] font-bold text-[11px] uppercase tracking-[0.18em] transition-all duration-200"
                    >
                        Explore Terminal
                    </a>
                </div>

                {/* Superior Advantages Small Grid (English) */}
                <div className="mt-20 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 max-w-5xl w-full text-left reveal-on-scroll delay-400">
                    {[
                        {
                            title: 'Predictive AI Engine',
                            desc: 'Frontier ML ensembles continuously model trend vectors to achieve high-accuracy direction forecasts.',
                            border: 'hover:border-[#00ffa7]/30'
                        },
                        {
                            title: 'Yield Optimization',
                            desc: 'Dynamic parameter calibration automatically adjusts sizing and stop ratios to maximize gains.',
                            border: 'hover:border-[#226af0]/30'
                        },
                        {
                            title: 'On-Chain Autonomy',
                            desc: 'Fully decentralized non-custodial execution directly via PancakeSwap and Trust Wallet Agent Kit.',
                            border: 'hover:border-indigo-500/30'
                        },
                        {
                            title: 'Watchdog Protection',
                            desc: 'Automated expectancy audits instantly reduce allocation sizes when market anomalies are detected.',
                            border: 'hover:border-purple-500/30'
                        }
                    ].map((adv, idx) => (
                        <div
                            key={idx}
                            className={`p-5 rounded-lg border border-white/[0.04] bg-[#0c0f16]/40 backdrop-blur-sm transition-all duration-300 ${adv.border} hover:bg-[#0c0f16]/75 hover:shadow-[0_4px_25px_rgba(0,0,0,0.35)]`}
                        >
                            <h3 className="text-xs font-black uppercase tracking-wider text-white flex items-center gap-2">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#00ffa7]" />
                                {adv.title}
                            </h3>
                            <p className="text-[11px] text-[#949fa6] mt-2.5 leading-relaxed font-semibold">
                                {adv.desc}
                            </p>
                        </div>
                    ))}
                </div>
            </section>

            {/* ── FEATURES SECTION ── */}
            <section id="features" className="py-32 border-t border-white/[0.04] bg-[#06080b] relative z-10 px-8 md:px-16">
                <div className="max-w-6xl mx-auto">
                    <div className="text-center mb-20 reveal-on-scroll">
                        <span className="text-[10px] text-[#00ffa7] font-black uppercase tracking-[0.24em] font-mono">Terminal Protocol</span>
                        <h2 className="text-3xl font-black uppercase tracking-wider text-white mt-3">
                            Core Capabilities
                        </h2>
                        <div className="w-12 h-[2px] bg-[#00ffa7] mx-auto mt-4" />
                    </div>

                    <div className="grid md:grid-cols-3 gap-6">
                        {[
                            {
                                num: '01',
                                title: 'Onchain Spot Execution',
                                desc: 'Uses Decentralized routing loops via PancakeSwap spot liquidity pools. Executes instantly using Trust Wallet Agent Kit (TWAK) framework modules.',
                                action: 'PANCAKESWAP ROUTER',
                            },
                            {
                                num: '02',
                                title: 'Risk Insulation Matrix',
                                desc: 'Guards spot assets using automated trailing ATR stop-losses, daily maximum drawdown safeguards, and dynamic DCA scaling layers.',
                                action: 'CAPITAL SAFEGUARDS',
                            },
                            {
                                num: '03',
                                title: 'Chandelier Exit Trailing',
                                desc: 'Optimizes profit execution targets by automatically pulling stop-losses to entry zones. Continuous tracking locks in profit on long swings.',
                                action: 'DYNAMIC TRAILING TP/SL',
                            },
                            {
                                num: '04',
                                title: 'Adaptive Market Grid',
                                desc: 'Pivots automatically to grid market mode when low volatility indices are confirmed. Arbitrages minor fluctuations within bounds.',
                                action: 'VOLATILITY GRID PROTOCOL',
                            },
                            {
                                num: '05',
                                title: 'Simulate & Backtest',
                                desc: 'Evaluates strategies against real historical candles from Binance. Instantly plots win expectations, Sharpe ratios, and max drawdown.',
                                action: 'METRICS BACKTEST ENGINE',
                            },
                            {
                                num: '06',
                                title: 'Integrated 149 Whitepaper',
                                desc: 'Excludes all non-eligible assets automatically. Strictly limits trading execution strictly to the BNB Hackathon asset whitelist.',
                                action: 'WHITELIST FILTER GUARD',
                            },
                        ].map((item) => (
                            <div
                                key={item.num}
                                className="group relative p-8 bg-[#090d16]/30 border border-white/[0.04] rounded-lg transition-all duration-300 hover:bg-[#0c111c]/60 hover:border-white/[0.08] reveal-on-scroll"
                            >
                                <div className="absolute top-4 right-4 text-[10px] font-mono font-black text-white/[0.06] group-hover:text-[#00ffa7]/20 transition-colors">
                                    {item.num}
                                </div>
                                <h3 className="text-sm font-bold text-white uppercase tracking-wider">{item.title}</h3>
                                <p className="text-[12px] text-[#949fa6] mt-3 leading-relaxed font-semibold">{item.desc}</p>
                                <div className="mt-6 flex items-center gap-2">
                                    <span className="text-[9px] text-[#00ffa7] font-mono font-black uppercase tracking-wider bg-[#00ffa7]/5 border border-[#00ffa7]/10 px-2 py-0.5 rounded">
                                        {item.action}
                                    </span>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </section>

            {/* ── LLM QUANT OPERATOR ── */}
            <section id="llm-quant" className="py-32 border-t border-white/[0.04] relative z-10 px-8 md:px-16 bg-[#090d16]/10">
                <div className="max-w-6xl mx-auto">
                    <div className="grid lg:grid-cols-2 gap-20 items-center">
                        <div className="reveal-on-scroll">
                            <span className="text-[10px] text-[#00ffa7] font-black uppercase tracking-[0.24em] font-mono">Cognitive Brain</span>
                            <h2 className="text-3xl md:text-4xl font-black uppercase tracking-tight text-white mt-3 leading-none">
                                LOCAL QUANT AI BRAIN
                            </h2>
                            <div className="w-12 h-[2px] bg-[#00ffa7] mt-4" />

                            <p className="mt-6 text-[13px] text-[#949fa6] leading-[1.8] font-semibold">
                                The <span className="text-white font-black">Local Quant AI Brain</span> orchestrates parameters in real-time. 
                                By formatting pricing telemetry, indicator slopes, and transaction outcomes, it runs local offline decision models to solve optimal risk limits.
                            </p>
                            <p className="mt-4 text-[13px] text-[#949fa6] leading-[1.8] font-semibold">
                                The execution limits and thresholds are fine-tuned block-by-block. When anomalous regimes are detected, the Brain compresses stops instantly.
                            </p>

                            <div className="mt-8 space-y-4">
                                {[
                                    { label: 'Processing Model', value: 'Local Quantum Offline AI Engine (100% Offline)' },
                                    { label: 'Dynamic Outputs', value: 'Risk Factor, DCA allocations, Stop Tiers' },
                                    { label: 'Security Gateway', value: 'Runs fully local on Node.js server with zero network dependencies' },
                                    { label: 'Decay Safeguard', value: 'Auto-degrades AI factor if win rates drop' },
                                ].map((item, idx) => (
                                    <div key={idx} className="flex items-center gap-3">
                                        <div className="w-1.5 h-1.5 rounded-full bg-[#00ffa7]" />
                                        <div className="text-[12px] font-semibold">
                                            <span className="uppercase tracking-wider text-zinc-500 mr-2">{item.label}:</span>
                                            <span className="text-zinc-200">{item.value}</span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </div>

                        {/* Interactive flow container */}
                        <div className="relative reveal-on-scroll">
                            <div className="absolute inset-0 bg-[#00ffa7]/4 blur-3xl rounded-2xl pointer-events-none" />
                            <div className="relative bg-[#090b10] border border-white/[0.05] rounded-xl p-8 shadow-2xl">
                                <div className="flex items-center justify-between border-b border-white/[0.04] pb-4 mb-6">
                                    <div className="flex items-center gap-2">
                                        <div className="w-2.5 h-2.5 rounded-full bg-[#00ffa7] animate-pulse" />
                                        <span className="text-[11px] font-mono font-black text-white uppercase tracking-widest">Operator Engine</span>
                                    </div>
                                    <span className="text-[9px] font-mono text-zinc-600 uppercase tracking-widest">Real-time Stream</span>
                                </div>

                                <div className="space-y-4">
                                    {[
                                        { step: '01', title: 'Compile State telemetry', desc: 'Prepares structured indicators, volume vectors, and active holdings into JSON payload.' },
                                        { step: '02', title: 'Local AI reasoning', desc: 'Processes quantitative indicators, Hurst regime, and drawdown rules locally with zero network delay.' },
                                        { step: '03', title: 'Execute Calibration', desc: 'Overwrites live thread config instantly. Triggers DCA or adjusts stops based on decision payload.' },
                                    ].map((s) => (
                                        <div key={s.step} className="flex gap-4 p-4 rounded bg-[#06080b] border border-white/[0.03]">
                                            <span className="text-[10px] font-mono font-black text-[#00ffa7]">{s.step}</span>
                                            <div>
                                                <h4 className="text-xs font-black uppercase tracking-wider text-white">{s.title}</h4>
                                                <p className="text-[11px] text-[#949fa6] mt-1 leading-relaxed font-semibold">{s.desc}</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ── ALGORITHMS SECTION ── */}
            <section id="algorithms" className="py-32 border-t border-white/[0.04] relative z-10 px-8 md:px-16">
                <div className="max-w-5xl mx-auto">
                    <div className="text-center mb-20 reveal-on-scroll">
                        <span className="text-[10px] text-[#00ffa7] font-black uppercase tracking-[0.24em] font-mono">Mathematical layer</span>
                        <h2 className="text-3xl font-black uppercase tracking-wider text-white mt-3">
                            Strategy Voting Ensemble
                        </h2>
                        <div className="w-12 h-[2px] bg-[#00ffa7] mx-auto mt-4" />
                    </div>

                    <div className="relative bg-[#090b10] border border-white/[0.04] rounded-xl p-8 overflow-hidden reveal-on-scroll">
                        <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff02_1px,transparent_1px),linear-gradient(to_bottom,#ffffff02_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none" />

                        <div className="grid md:grid-cols-3 gap-6 relative z-10">
                            {[
                                {
                                    id: '01', title: 'KNN Clustering', math: 'Vector Clustered Pivots',
                                    desc: 'Locates local support and resistance arrays by grouping technical oscillators in multidimensional space.'
                                },
                                {
                                    id: '02', title: 'Logistic Classifier', math: 'Stochastic Direction',
                                    desc: 'Predicts target candle direction velocity indices using historical trend parameters and volume profiles.'
                                },
                                {
                                    id: '03', title: 'Momentum Vector', math: 'Trend Boundary Limit',
                                    desc: 'Generates buy/sell triggers using moving average crossovers. Operates with maximum weight in high-volume regimes.'
                                },
                            ].map((item) => (
                                <div key={item.id} className="p-6 bg-[#06080b]/90 border border-white/[0.04] rounded-lg flex flex-col justify-between hover:border-white/[0.1] transition-all">
                                    <div>
                                        <span className="text-[9px] text-[#00ffa7] font-mono font-black uppercase">Model {item.id}</span>
                                        <h4 className="text-sm font-bold text-white uppercase tracking-wider mt-1">{item.title}</h4>
                                        <p className="text-[11px] text-[#949fa6] mt-2.5 leading-relaxed font-semibold">{item.desc}</p>
                                    </div>
                                    <span className="inline-block w-fit mt-5 text-[9px] bg-[#090b10] text-[#949fa6] font-mono px-2.5 py-1 rounded border border-white/[0.03]">
                                        {item.math}
                                    </span>
                                </div>
                            ))}
                        </div>

                        <div className="mt-8 pt-8 border-t border-white/[0.04] grid md:grid-cols-2 gap-8 relative z-10">
                            <div>
                                <h4 className="text-xs font-black uppercase tracking-wider text-white flex items-center gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-[#226af0]" />
                                    Composite Vote Weighing
                                </h4>
                                <p className="text-[11px] text-[#949fa6] mt-2 leading-relaxed font-semibold">
                                    Runs separate algorithms simultaneously. Compiles weight indexes dynamically using the win expectancy of each component.
                                </p>
                            </div>
                            <div>
                                <h4 className="text-xs font-black uppercase tracking-wider text-white flex items-center gap-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                                    Performance Guard Watchdog
                                </h4>
                                <p className="text-[11px] text-[#949fa6] mt-2 leading-relaxed font-semibold">
                                    Ensures risk protocols remain locked. Instantly mitigates asset sizes if performance metrics break established thresholds.
                                </p>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            {/* ── CTA SECTION ── */}
            <section className="py-32 border-t border-white/[0.04] bg-gradient-to-t from-[#06080b] to-transparent relative z-10 text-center px-8 reveal-on-scroll">
                <div className="max-w-xl mx-auto">
                    <span className="text-[10px] text-[#00ffa7] font-black uppercase tracking-[0.24em] font-mono">Terminal Gateway</span>
                    <h2 className="text-3xl font-black uppercase tracking-tight text-white mt-3">
                        Launch Autonomous Panel
                    </h2>
                    <p className="text-[#949fa6] text-xs mt-3 leading-relaxed font-semibold">
                        Sign in using terminal security credentials and boot the autonomous execution engine.
                    </p>
                    <div className="mt-8">
                        <Link
                            href="/trade"
                            className="inline-flex items-center gap-2 bg-[#226af0] hover:bg-blue-500 text-white font-extrabold text-[11px] uppercase tracking-[0.18em] px-9 py-4.5 rounded-lg shadow-[0_0_35px_rgba(34,106,240,0.25)] transition-all duration-300"
                        >
                            Launch Terminal ↗
                        </Link>
                    </div>
                </div>
            </section>

            {/* ── FOOTER ── */}
            <footer className="w-full border-t border-white/[0.04] py-10 px-8 md:px-16 flex flex-col md:flex-row items-center justify-between gap-6 text-[#949fa6]/50 text-[10px] font-mono relative z-10 bg-[#06080b]">
                <div className="flex flex-col md:flex-row items-center gap-4">
                    <Image src="/logo.png" alt="Orocle Auto Trade" width={130} height={38} className="object-contain brightness-0 invert opacity-30" />
                    <span className="uppercase tracking-wider">© 2026 OROCLE AUTO TRADE. ALL RIGHTS RESERVED.</span>
                </div>
                <div className="flex items-center gap-6 uppercase tracking-wider text-[#949fa6]/40">
                    <span>BNB CHAIN TERMINAL</span>
                    <span className="w-1.5 h-1.5 rounded-full bg-white/[0.05]" />
                    <span>SECURED SYSTEM GATE</span>
                </div>
            </footer>

            <style>{`
                .reveal-on-scroll {
                    opacity: 0;
                    transform: translateY(24px);
                    filter: blur(4px);
                    transition: opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1), transform 0.8s cubic-bezier(0.16, 1, 0.3, 1), filter 0.8s cubic-bezier(0.16, 1, 0.3, 1);
                    will-change: opacity, transform, filter;
                }
                .reveal-on-scroll.is-visible {
                    opacity: 1;
                    transform: translateY(0);
                    filter: blur(0);
                }
                .delay-100 {
                    transition-delay: 100ms;
                }
                .delay-200 {
                    transition-delay: 200ms;
                }
                .delay-300 {
                    transition-delay: 300ms;
                }
                .delay-400 {
                    transition-delay: 400ms;
                }
            `}</style>
        </div>
    );
}
