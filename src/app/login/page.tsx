'use client';

import React, { useState } from 'react';
import Image from 'next/image';

export default function LoginPage() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            if (res.ok) {
                // Successful login, redirect to trading panel
                window.location.href = '/trade';
            } else {
                const data = await res.json();
                setError(data.error || 'Access Denied');
            }
        } catch {
            setError('Connection failed. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-black flex items-center justify-center relative overflow-hidden text-white font-sans">
            {/* Ambient Background Glows */}
            <div className="absolute top-[-20%] left-[-20%] w-[60%] h-[60%] rounded-full bg-[#226af0]/10 blur-[120px] pointer-events-none"></div>
            <div className="absolute bottom-[-20%] right-[-20%] w-[60%] h-[60%] rounded-full bg-[#226af0]/5 blur-[120px] pointer-events-none"></div>

            <div className="w-full max-w-md p-8 bg-zinc-950/80 border border-zinc-800/80 rounded-2xl backdrop-blur-xl shadow-2xl relative z-10 transition-all duration-300 hover:border-zinc-700/60">
                {/* Brand / Logo */}
                <div className="flex flex-col items-center mb-8">
                    <div className="w-16 h-16 rounded-xl bg-gradient-to-br from-[#226af0]/20 to-blue-900/20 border border-[#226af0]/30 flex items-center justify-center shadow-lg shadow-[#226af0]/20 mb-4 hover:shadow-[#226af0]/40 transition-all duration-300">
                        <Image
                            src="/logo.png"
                            alt="Orocle Auto Trade"
                            width={40}
                            height={40}
                            className="object-contain brightness-0 invert"
                        />
                    </div>
                    <h1 className="text-2xl font-black tracking-wider uppercase bg-clip-text text-transparent bg-gradient-to-r from-white via-zinc-200 to-zinc-400">
                        Orocle Auto Trade Portal
                    </h1>
                    <p className="text-zinc-500 text-xs mt-1.5 uppercase font-mono tracking-widest">
                        Security Access Verification
                    </p>
                </div>

                {/* Form */}
                <form onSubmit={handleSubmit} className="space-y-5">
                    {error && (
                        <div className="p-3 bg-red-950/40 border border-red-900/60 rounded-xl text-red-400 text-xs font-semibold flex items-center gap-2.5 animate-shake">
                            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <span>{error}</span>
                        </div>
                    )}

                    <div className="space-y-2">
                        <label className="text-[10px] font-extrabold uppercase tracking-widest text-zinc-400 block">
                            Operator Username
                        </label>
                        <div className="relative">
                            <input
                                type="text"
                                required
                                value={username}
                                onChange={(e) => setUsername(e.target.value)}
                                className="w-full bg-black/60 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none focus:border-[#226af0] focus:ring-1 focus:ring-[#226af0]/40 transition-all font-mono"
                                placeholder="Enter username..."
                            />
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label className="text-[10px] font-extrabold uppercase tracking-widest text-zinc-400 block">
                            Security Credentials
                        </label>
                        <div className="relative">
                            <input
                                type="password"
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                className="w-full bg-black/60 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-white placeholder-zinc-600 outline-none focus:border-[#226af0] focus:ring-1 focus:ring-[#226af0]/40 transition-all font-mono"
                                placeholder="Enter password..."
                            />
                        </div>
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full mt-6 bg-[#226af0] hover:bg-blue-600 active:scale-[0.98] disabled:opacity-50 text-white font-extrabold py-3.5 px-4 rounded-xl shadow-lg shadow-[#226af0]/20 hover:shadow-[#226af0]/30 transition-all duration-200 cursor-pointer flex items-center justify-center gap-2 text-sm tracking-wider uppercase"
                    >
                        {loading ? (
                            <>
                                <div className="w-4 h-4 border-2 border-t-transparent border-white rounded-full animate-spin"></div>
                                <span>Verifying credentials...</span>
                            </>
                        ) : (
                            <>
                                <span>Authorize Connection</span>
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                                </svg>
                            </>
                        )}
                    </button>
                </form>

                {/* Footer instructions */}
                <div className="mt-8 text-center border-t border-zinc-900 pt-5 select-none">
                    <p className="text-[10px] text-zinc-600 font-mono tracking-wider">
                        SECURE LOGICAL INTERFACE SYSTEM
                    </p>
                    <p className="text-[9px] text-zinc-700 font-mono mt-1">
                        Unauthorized access attempts will be rejected.
                    </p>
                </div>
            </div>

            {/* Custom Animation Keyframes for Shake */}
            <style jsx global>{`
                @keyframes shake {
                    0%, 100% { transform: translateX(0); }
                    25% { transform: translateX(-4px); }
                    75% { transform: translateX(4px); }
                }
                .animate-shake {
                    animation: shake 0.2s ease-in-out 0s 2;
                }
            `}</style>
        </div>
    );
}
