/**
 * BNB Hack Competition Guard
 *
 * Rules from the hackathon (Track 1):
 *   - Max drawdown cap: 30% (exceed = DQ). We hard-stop at 25% to stay safe.
 *   - Min trades: 1 trade per day over the 7-day window (June 22–28, 2026).
 *   - Portfolio must stay > $1 every hour to avoid 0% recording.
 *   - Eligible tokens: fixed 149 BEP-20 list.
 *
 * Competition window: 2026-06-22 00:00 UTC → 2026-06-28 23:59 UTC
 */

import * as fs from 'fs';
import * as path from 'path';

// ─── Constants ────────────────────────────────────────────────────────────────

export const COMPETITION_START = new Date('2026-06-22T00:00:00Z');
export const COMPETITION_END   = new Date('2026-06-28T23:59:59Z');

/** Hard drawdown limit before the competition DQ threshold of 30%. */
const DRAWDOWN_HALT_THRESHOLD = 0.25;

/** Warn at 20% drawdown so the operator can review manually. */
const DRAWDOWN_WARN_THRESHOLD = 0.20;

/** Minimum portfolio USD to keep active (competition: $1, we use $10 as buffer). */
const MIN_PORTFOLIO_USD = 10;

// ─── Eligible tokens (competition's 149 BEP-20 list) ─────────────────────────
// Only a subset is likely to have deep Binance signal data. We filter for those.
export const ELIGIBLE_BSC_TOKENS = new Set([
    'ETH','USDT','USDC','XRP','TRX','DOGE','ZEC','ADA','LINK','BCH','DAI','TON',
    'USD1','USDe','M','LTC','AVAX','SHIB','XAUt','WLFI','H','DOT','UNI','ASTER',
    'DEXE','USDD','ETC','AAVE','ATOM','U','STABLE','FIL','INJ','NIGHT','FET','TUSD',
    'BONK','PENGU','CAKE','SIREN','LUNC','ZRO','KITE','FDUSD','BEAT','PIEVERSE',
    'BTT','NFT','EDGE','FLOKI','LDO','B','FF','PENDLE','NEX','STG','AXS','TWT',
    'HOME','RAY','COMP','GWEI','XCN','GENIUS','XPL','BAT','SKYAI','APE','IP','SFP',
    'TAG','NXPC','AB','SAHARA','1INCH','CHEEMS','BANANAS31','RIVER','MYX','RAVE',
    'SNX','FORM','LAB','HTX','USDf','CTM','BDX','SLX','UB','DUCKY','FRAX','BILL',
    'WFI','KOGE','ALE','FRXUSD','USDF','GOMINING','VCNT','GUA','DUSD','SMILEK',
    '0G','BEAM','MY','SOON','REAL','Q','AIOZ','ZIG','YFI','TAC','CYS','ZAMA',
    'TRIA','HUMA','ZIL','XPR','ZETA','NILA','ROSE','VELO','UAI','BRETT',
    'OPEN','BSB','TOSHI','BAS','ACH','AXL','LUR','ELF','KAVA','APR','IRYS','EURI',
    'XUSD','BARD','DUSK','SUSHI','PEAQ','COAI','BDCA','XAUM','BNB',
]);

/** Returns true if the pair symbol (e.g. 'BNBUSDT') is eligible for the competition. */
export function isEligiblePair(pair: string): boolean {
    const upper = pair.toUpperCase();
    const token = upper.endsWith('USDT') ? upper.slice(0, -4) : upper;
    return ELIGIBLE_BSC_TOKENS.has(token);
}

// ─── State ────────────────────────────────────────────────────────────────────

export interface CompetitionState {
    /** USD value when competition started (set on first call to initCompetition). */
    startPortfolioUsd: number;
    /** Highest USD portfolio value seen during competition. */
    peakPortfolioUsd: number;
    /** ISO date strings (YYYY-MM-DD) on which at least one trade was made. */
    tradeDates: string[];
    /** All BSC tx hashes collected as proof. */
    txHashes: string[];
    /** True if trading was halted by the guard. */
    isHalted: boolean;
    haltReason?: string;
    /** Low-balance warnings already logged (to avoid spam). */
    lowBalanceWarningLogged: boolean;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function stateFile(): string {
    return path.join(process.env.BOT_DATA_DIR ?? 'data', 'competition_state.json');
}

function loadState(): CompetitionState {
    try {
        const p = stateFile();
        if (fs.existsSync(p)) {
            return JSON.parse(fs.readFileSync(p, 'utf-8')) as CompetitionState;
        }
    } catch { /* ignore */ }
    return {
        startPortfolioUsd: 0,
        peakPortfolioUsd: 0,
        tradeDates: [],
        txHashes: [],
        isHalted: false,
        lowBalanceWarningLogged: false,
    };
}

function saveState(state: CompetitionState): void {
    try {
        const p = stateFile();
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(state, null, 2));
    } catch { /* ignore persistence errors */ }
}

let _state: CompetitionState | null = null;

function getState(): CompetitionState {
    if (!_state) _state = loadState();
    return _state;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Call once when the competition starts (or bot boots during competition window). */
export function initCompetition(startBalanceUsd: number): void {
    const state = getState();
    if (state.startPortfolioUsd === 0 && startBalanceUsd > 0) {
        state.startPortfolioUsd = startBalanceUsd;
        state.peakPortfolioUsd  = startBalanceUsd;
        saveState(state);
    }
}

/** Update the running peak whenever a new portfolio snapshot is taken. */
export function updatePortfolioPeak(currentUsd: number): void {
    const state = getState();
    if (currentUsd > state.peakPortfolioUsd) {
        state.peakPortfolioUsd = currentUsd;
        saveState(state);
    }
}

/** Record a completed trade (txHash can be empty for simulated mode). */
export function recordTrade(txHash: string): void {
    const state = getState();
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    if (!state.tradeDates.includes(today)) {
        state.tradeDates.push(today);
    }
    if (txHash && !state.txHashes.includes(txHash)) {
        state.txHashes.push(txHash);
    }
    saveState(state);
}

/**
 * Check whether a new trade entry is allowed.
 * Returns { allowed: true } or { allowed: false, reason }.
 * Also updates the peak with the supplied current balance.
 */
export function checkTradeAllowed(currentPortfolioUsd: number): {
    allowed: boolean;
    drawdownPct: number;
    reason?: string;
    warning?: string;
} {
    const state = getState();
    updatePortfolioPeak(currentPortfolioUsd);

    // If already halted
    if (state.isHalted) {
        return {
            allowed: false,
            drawdownPct: 0,
            reason: state.haltReason ?? 'Trading halted by competition guard',
        };
    }

    if (state.startPortfolioUsd === 0) {
        // Guard not yet initialised; allow trade but warn
        return { allowed: true, drawdownPct: 0 };
    }

    const peak = Math.max(state.peakPortfolioUsd, state.startPortfolioUsd);
    const drawdownPct = peak > 0 ? (peak - currentPortfolioUsd) / peak : 0;

    // Hard stop
    if (drawdownPct >= DRAWDOWN_HALT_THRESHOLD) {
        state.isHalted = true;
        state.haltReason =
            `Drawdown ${(drawdownPct * 100).toFixed(1)}% reached 25% limit. ` +
            `Trading halted to avoid competition DQ (30% threshold).`;
        saveState(state);
        return { allowed: false, drawdownPct, reason: state.haltReason };
    }

    // Low-balance guard
    if (currentPortfolioUsd < MIN_PORTFOLIO_USD) {
        state.isHalted = true;
        state.haltReason = `Portfolio ($${currentPortfolioUsd.toFixed(2)}) below minimum $${MIN_PORTFOLIO_USD}. Halted to prevent 0% hourly recording.`;
        saveState(state);
        return { allowed: false, drawdownPct, reason: state.haltReason };
    }

    // Soft warning
    let warning: string | undefined;
    if (drawdownPct >= DRAWDOWN_WARN_THRESHOLD && !state.lowBalanceWarningLogged) {
        warning = `⚠️ Competition drawdown at ${(drawdownPct * 100).toFixed(1)}% — approaching 25% halt level.`;
        state.lowBalanceWarningLogged = true;
        saveState(state);
    }

    return { allowed: true, drawdownPct, warning };
}

/** True only during the 7-day live trading window. */
export function isCompetitionActive(): boolean {
    const now = new Date();
    return now >= COMPETITION_START && now <= COMPETITION_END;
}

/** Number of competition days that have passed without a trade (should be 0). */
export function getMissingTradeDays(): number {
    const state = getState();
    const now = new Date();
    if (now < COMPETITION_START) return 0;

    const daysSinceStart = Math.floor(
        (now.getTime() - COMPETITION_START.getTime()) / 86_400_000
    );
    const expectedDays = Math.min(daysSinceStart + 1, 7);
    return Math.max(0, expectedDays - state.tradeDates.length);
}

/** Full stats snapshot for the UI / submission writeup. */
export interface CompetitionStats {
    isActive: boolean;
    isHalted: boolean;
    haltReason?: string;
    startPortfolioUsd: number;
    peakPortfolioUsd: number;
    currentReturnPct: number;
    currentDrawdownPct: number;
    tradeDays: number;
    missingTradeDays: number;
    txHashes: string[];
    daysRemaining: number;
}

export function getCompetitionStats(currentPortfolioUsd: number): CompetitionStats {
    const state = getState();
    const start = state.startPortfolioUsd || currentPortfolioUsd;
    const peak  = Math.max(state.peakPortfolioUsd, start);

    const returnPct   = start > 0 ? (currentPortfolioUsd - start) / start : 0;
    const drawdownPct = peak  > 0 ? (peak - currentPortfolioUsd) / peak  : 0;

    const now = new Date();
    const msRemaining = Math.max(0, COMPETITION_END.getTime() - now.getTime());
    const daysRemaining = Math.ceil(msRemaining / 86_400_000);

    return {
        isActive:           isCompetitionActive(),
        isHalted:           state.isHalted,
        haltReason:         state.haltReason,
        startPortfolioUsd:  start,
        peakPortfolioUsd:   peak,
        currentReturnPct:   returnPct,
        currentDrawdownPct: drawdownPct,
        tradeDays:          state.tradeDates.length,
        missingTradeDays:   getMissingTradeDays(),
        txHashes:           state.txHashes,
        daysRemaining,
    };
}

/** Reset the guard state (useful for testing; never call in production during competition). */
export function resetCompetitionState(): void {
    _state = {
        startPortfolioUsd: 0,
        peakPortfolioUsd: 0,
        tradeDates: [],
        txHashes: [],
        isHalted: false,
        lowBalanceWarningLogged: false,
    };
    saveState(_state);
}
