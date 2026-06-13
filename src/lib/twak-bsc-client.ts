/**
 * Trust Wallet Agent Kit (TWAK) client for BSC on-chain execution.
 *
 * Wraps the `twak` CLI (npx @trustwallet/cli) via child_process.
 * The CLI must be installed: npm install -g @trustwallet/cli
 * Credentials must be initialized: twak init --api-key <key> --api-secret <secret>
 *
 * BSC chain identifier in TWAK: 'bsc'
 * Execution model: USDT-in → token-out via PancakeSwap routing (best execution).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// On Windows, npm global binaries (.cmd) require shell:true to execute via execFile.
const TWAK_BIN = 'twak';
const TWAK_SHELL = process.platform === 'win32';

// Mapping from our internal pair symbol (e.g. "BNBUSDT") to BSC token symbol for TWAK
const PAIR_TO_BSC_TOKEN: Record<string, string> = {
    BNBUSDT:   'BNB',
    CAKEUSDT:  'CAKE',
    LINKUSDT:  'LINK',
    AAVEUSDT:  'AAVE',
    FLOKIUSDT: 'FLOKI',
    SHIBUSDT:  'SHIB',
    DOTUSDT:   'DOT',
    UNIUSDT:   'UNI',
    INJEDT:    'INJ',
    FETUSDT:   'FET',
    PENDLEUSDT:'PENDLE',
    STGUSDT:   'STG',
    AXSUSDT:   'AXS',
    COMPUSDT:  'COMP',
    SNXUSDT:   'SNX',
    LTCUSDT:   'LTC',
    ADAUSDT:   'ADA',
    ETCUSDT:   'ETC',
    ATOMUSDT:  'ATOM',
    FILUSDT:   'FIL',
    LDOUSDT:   'LDO',
    APEUSDT:   'APE',
    SUSHIUSDT: 'SUSHI',
    BATUSDT:   'BAT',
    ZROUSDT:   'ZRO',
    BONKUSDT:  'BONK',
    PENGUUSDT: 'PENGU',
    BTTUSDT:   'BTT',
    NFTUSDT:   'NFT',
    RAYUSDT:   'RAY',
    YFIUSDT:   'YFI',
};

export function pairToBscToken(pair: string): string {
    const upper = pair.toUpperCase();
    if (PAIR_TO_BSC_TOKEN[upper]) return PAIR_TO_BSC_TOKEN[upper];
    // Fallback: strip USDT suffix
    return upper.endsWith('USDT') ? upper.slice(0, -4) : upper;
}

export interface PortfolioAsset {
    symbol: string;
    balance: number;
    usdValue: number;
    chain: string;
    address?: string;
}

export interface SwapResult {
    txHash: string;
    fromAmount: number;
    toAmount: number;
    fromSymbol: string;
    toSymbol: string;
    executedPrice: number;
}

export interface AutomateOrder {
    id: string;
    fromSymbol: string;
    toSymbol: string;
    amount: number;
    price: number;
    condition: 'above' | 'below';
    status: string;
}

export class TWAKBscClient {
    private readonly chain = 'bsc';
    private static _rateLimitedUntil = 0;
    private static _callCount = 0;
    private static _callWindowStart = 0;
    private readonly walletPassword?: string;

    constructor(walletPassword?: string) {
        this.walletPassword = walletPassword || process.env.TWAK_WALLET_PASSWORD;
    }

    static isRateLimited(): boolean {
        return Date.now() < TWAKBscClient._rateLimitedUntil;
    }

    private async run(args: string[]): Promise<any> {
        if (TWAKBscClient.isRateLimited()) {
            throw new Error('TWAK rate limited, retry later');
        }

        const fullArgs = [...args, '--json'];

        const needsWallet = args.some(a =>
            ['swap', 'transfer', 'automate', 'compete'].includes(a)
        );
        if (needsWallet && this.walletPassword) {
            fullArgs.push('--password', this.walletPassword);
        }

        try {
            const { stdout, stderr } = await execFileAsync(TWAK_BIN, fullArgs, {
                timeout: 45_000,
                shell: TWAK_SHELL,
                env: { ...process.env },
            });

            if (stderr && stderr.includes('rate limit')) {
                TWAKBscClient._rateLimitedUntil = Date.now() + 60_000;
                throw new Error('TWAK rate limited');
            }

            const output = stdout.trim();
            if (!output) throw new Error('TWAK returned empty response');
            return JSON.parse(output);
        } catch (e: any) {
            const msg = e.stderr || e.stdout || e.message || String(e);
            throw new Error(`TWAK CLI error [${args.join(' ')}]: ${msg.slice(0, 300)}`);
        }
    }

    // ─── Portfolio ───────────────────────────────────────────────────────────

    async getPortfolio(): Promise<PortfolioAsset[]> {
        const result = await this.run(['wallet', 'portfolio', '--chains', this.chain]);

        // TWAK JSON shape: { chains: { bsc: { address, native, tokens } }, totalUsd }
        // or flat array — normalise both
        const assets: PortfolioAsset[] = [];

        const bscData = result?.chains?.bsc || result?.bsc;
        if (bscData) {
            const walletAddr: string = bscData.address || '';
            if (bscData.native) {
                assets.push({
                    symbol: bscData.native.symbol || 'BNB',
                    balance: parseFloat(bscData.native.balance || '0'),
                    usdValue: parseFloat(bscData.native.usdValue || bscData.native.usd_value || '0'),
                    chain: this.chain,
                    address: walletAddr,
                });
            }
            for (const t of bscData.tokens || []) {
                assets.push({
                    symbol: t.symbol,
                    balance: parseFloat(t.balance || '0'),
                    usdValue: parseFloat(t.usdValue || t.usd_value || '0'),
                    chain: this.chain,
                    address: walletAddr,
                });
            }
        } else if (Array.isArray(result)) {
            for (const a of result) {
                if (a.chain === this.chain) {
                    assets.push({
                        symbol: a.symbol,
                        balance: typeof a.balance === 'number' ? a.balance : parseFloat(a.balance || '0'),
                        usdValue: typeof a.usdValue === 'number' ? a.usdValue : parseFloat(a.usdValue || a.usd_value || '0'),
                        chain: this.chain,
                        address: a.address,
                    });
                }
            }
        } else if (Array.isArray(result?.assets)) {
            for (const a of result.assets) {
                if (a.chain === this.chain) {
                    assets.push({
                        symbol: a.symbol,
                        balance: typeof a.balance === 'number' ? a.balance : parseFloat(a.balance || '0'),
                        usdValue: typeof a.usdValue === 'number' ? a.usdValue : parseFloat(a.usdValue || a.usd_value || '0'),
                        chain: this.chain,
                        address: a.address,
                    });
                }
            }
        }

        return assets;
    }

    async getUsdtBalance(): Promise<number> {
        const portfolio = await this.getPortfolio();
        const usdt = portfolio.find(a => a.symbol?.toUpperCase() === 'USDT');
        return usdt?.usdValue ?? usdt?.balance ?? 0;
    }

    async getTotalPortfolioUsd(): Promise<number> {
        const portfolio = await this.getPortfolio();
        return portfolio.reduce((sum, a) => sum + (a.usdValue || 0), 0);
    }

    async getTokenBalance(symbol: string): Promise<{ balance: number; usdValue: number }> {
        const portfolio = await this.getPortfolio();
        const asset = portfolio.find(a => a.symbol?.toUpperCase() === symbol.toUpperCase());
        return { balance: asset?.balance ?? 0, usdValue: asset?.usdValue ?? 0 };
    }

    async getWalletAddress(): Promise<string> {
        try {
            const result = await this.run(['wallet', 'address', '--chain', this.chain]);
            return result?.address || result?.bsc || '';
        } catch {
            return '';
        }
    }

    // ─── Price ───────────────────────────────────────────────────────────────

    async getPrice(symbol: string): Promise<number> {
        const result = await this.run(['price', symbol]);
        // TWAK JSON: { symbol, price, chain } or { usd }
        return parseFloat(result?.price ?? result?.usd ?? '0');
    }

    // ─── Swap ────────────────────────────────────────────────────────────────

    async getSwapQuote(
        amountUsdt: number,
        toSymbol: string,
    ): Promise<{ toAmount: number; price: number }> {
        const result = await this.run([
            'swap', String(amountUsdt), 'USDT', toSymbol,
            '--chain', this.chain,
            '--quote-only',
        ]);
        const toAmount = parseFloat(result?.toAmount ?? result?.amount ?? '0');
        const price = toAmount > 0 ? amountUsdt / toAmount : 0;
        return { toAmount, price };
    }

    /** Buy token with USDT. Returns txHash + fill price. */
    async buyToken(
        amountUsdt: number,
        toSymbol: string,
        slippagePct = 1,
    ): Promise<SwapResult> {
        const result = await this.run([
            'swap', String(amountUsdt), 'USDT', toSymbol,
            '--chain', this.chain,
            '--slippage', String(slippagePct),
        ]);
        const toAmount = parseFloat(result?.toAmount ?? result?.received ?? '0');
        return {
            txHash: result?.txHash ?? result?.hash ?? '',
            fromAmount: amountUsdt,
            toAmount,
            fromSymbol: 'USDT',
            toSymbol,
            executedPrice: toAmount > 0 ? amountUsdt / toAmount : 0,
        };
    }

    /** Sell all (or specified amount) of a token back to USDT. */
    async sellToken(
        tokenAmount: number,
        fromSymbol: string,
        slippagePct = 1,
    ): Promise<SwapResult> {
        const result = await this.run([
            'swap', String(tokenAmount), fromSymbol, 'USDT',
            '--chain', this.chain,
            '--slippage', String(slippagePct),
        ]);
        const usdtReceived = parseFloat(result?.toAmount ?? result?.received ?? '0');
        return {
            txHash: result?.txHash ?? result?.hash ?? '',
            fromAmount: tokenAmount,
            toAmount: usdtReceived,
            fromSymbol,
            toSymbol: 'USDT',
            executedPrice: tokenAmount > 0 ? usdtReceived / tokenAmount : 0,
        };
    }

    // ─── Automate (Limit / Stop-Loss orders) ─────────────────────────────────

    /** Place a take-profit limit sell. Returns automation ID. */
    async placeTakeProfit(
        fromSymbol: string,
        amount: number,
        targetPriceUsdt: number,
    ): Promise<string> {
        const result = await this.run([
            'automate', 'add',
            '--from', fromSymbol,
            '--to', 'USDT',
            '--amount', String(amount),
            '--chain', this.chain,
            '--price', String(targetPriceUsdt),
            '--condition', 'above',
            '--max-runs', '1',
        ]);
        return result?.id ?? '';
    }

    /** Place a stop-loss sell. Returns automation ID. */
    async placeStopLoss(
        fromSymbol: string,
        amount: number,
        stopPriceUsdt: number,
    ): Promise<string> {
        const result = await this.run([
            'automate', 'add',
            '--from', fromSymbol,
            '--to', 'USDT',
            '--amount', String(amount),
            '--chain', this.chain,
            '--price', String(stopPriceUsdt),
            '--condition', 'below',
            '--max-runs', '1',
        ]);
        return result?.id ?? '';
    }

    async deleteAutomate(id: string): Promise<void> {
        try {
            await this.run(['automate', 'delete', id]);
        } catch {
            // Best-effort — may already be filled/deleted
        }
    }

    async listAutomates(): Promise<AutomateOrder[]> {
        const result = await this.run(['automate', 'list']);
        return (result?.automations ?? result?.items ?? []).map((a: any) => ({
            id: a.id,
            fromSymbol: a.from ?? a.fromToken,
            toSymbol: a.to ?? a.toToken,
            amount: parseFloat(a.amount ?? '0'),
            price: parseFloat(a.price ?? '0'),
            condition: a.condition ?? 'below',
            status: a.status ?? 'active',
        }));
    }

    // ─── History / proof ─────────────────────────────────────────────────────

    async getTxHistory(limit = 20): Promise<any[]> {
        const address = await this.getWalletAddress();
        if (!address) return [];
        const result = await this.run([
            'history',
            '--address', address,
            '--chain', this.chain,
            '--limit', String(limit),
        ]);
        return result?.transactions ?? result?.items ?? [];
    }

    // ─── Competition registration ─────────────────────────────────────────────

    /**
     * Get the BSC agent wallet address and print manual registration instructions.
     * NOTE: TWAK CLI does NOT have a "compete register" command.
     * On-chain registration must be done via BSCScan or the DoraHacks portal.
     *
     * Contract: 0x212c61b9b72c95d95bf29cf032f5e5635629aed5
     */
    async registerCompetition(): Promise<string> {
        const address = await this.getWalletAddress();
        if (!address) throw new Error('Could not retrieve BSC wallet address from TWAK');

        // Return instructions instead of attempting a non-existent CLI command
        const instructions = [
            `Agent wallet: ${address}`,
            `Register via BSCScan: https://bscscan.com/address/0x212c61b9b72c95d95bf29cf032f5e5635629aed5#writeContract`,
            `Or submit on DoraHacks: https://dorahacks.io/hackathon/bnbhack-twt-cmc/detail`,
        ].join('\n');

        console.log('[TWAK] Competition registration requires manual action:\n' + instructions);
        return address; // return wallet address as "proof"
    }

    // ─── x402 per-request payment ─────────────────────────────────────────────

    async x402Request(url: string, maxPaymentUsdc = '1000'): Promise<any> {
        const result = await this.run([
            'x402', 'request', url,
            '--max-payment', maxPaymentUsdc,
            '--yes',
        ]);
        return result;
    }
}
