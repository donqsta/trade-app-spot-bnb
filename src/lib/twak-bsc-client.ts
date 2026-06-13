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

// Mapping from our internal pair symbol (e.g. "BNBUSDT") to BSC token contract address or supported symbol.
// Using BEP-20 contract addresses for tokens that TWAK CLI cannot resolve by ticker symbol alone.
const PAIR_TO_BSC_TOKEN: Record<string, string> = {
    // Native / well-supported by TWAK as symbol
    BNBUSDT:   'BNB',
    // PancakeSwap CAKE — BEP-20 contract on BSC
    CAKEUSDT:  '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    // Chainlink LINK — BEP-20 on BSC
    LINKUSDT:  '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD',
    // AAVE — BEP-20 on BSC
    AAVEUSDT:  '0xfb6115445Bff7b52FeB98650c87F44907e58F802',
    // FLOKI — BEP-20 on BSC (correct address ends in 7E not 7A)
    FLOKIUSDT: '0xfb5B838b6cfEEdC2873aB27866079AC55363D37E',
    // SHIB — BEP-20 on BSC
    SHIBUSDT:  '0x2859e4544C4bbB038793e790226057B1AA79434C',
    // DOT — BEP-20 on BSC
    DOTUSDT:   '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402',
    // UNI — BEP-20 on BSC
    UNIUSDT:   '0xBf5140A22578168FD56BCbCCEE7088B935634125',
    // INJ — BEP-20 on BSC
    INJEDT:    '0xa2B726B1145A4773F68593CF171187d8EBe4d495',
    // FET — BEP-20 on BSC
    FETUSDT:   '0x031b41e504677879370e9DBcF937283A8691Fa7f',
    // PENDLE — BEP-20 on BSC
    PENDLEUSDT:'0xb3Ed0A426155B79B898849803E3B36552f7ED507',
    // STG — BEP-20 on BSC
    STGUSDT:   '0xB0D502E938ed5f4df2E681fE6E419ff29631d62b',
    // AXS — BEP-20 on BSC
    AXSUSDT:   '0x715D400F88C167884bbCc41C5FeA407ed4D2f8A0',
    // COMP — BEP-20 on BSC
    COMPUSDT:  '0x52CE071Bd9b1C4B00A0b92D298c512478CaD67e8',
    // SNX — BEP-20 on BSC
    SNXUSDT:   '0x9Ac983826058b8a9C7Aa1C9171441191232E8404',
    // LTC — BEP-20 on BSC
    LTCUSDT:   '0x4338665CBB7B2485A8855A139b75D5e34AB0DB94',
    // ADA — BEP-20 on BSC
    ADAUSDT:   '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47',
    // ETC — BEP-20 on BSC
    ETCUSDT:   '0x3d6545b08693daE087E957cb1180ee38B9e3c25E',
    // ATOM — BEP-20 on BSC
    ATOMUSDT:  '0x0Eb3a705fc54725037CC9e008bDede697f62F335',
    // FIL — BEP-20 on BSC
    FILUSDT:   '0x0D8Ce2A99Bb6e3B7Db580eD848240e4a0F9aE153',
    // LDO — BEP-20 on BSC
    LDOUSDT:   '0x986854779804799C1d68867F5E03e601E781e41b',
    // APE — BEP-20 on BSC
    APEUSDT:   '0xC762043E211571eB34f1ef377e5e8e76914962f9',
    // SUSHI — BEP-20 on BSC
    SUSHIUSDT: '0x947950BcE8Af429be11B7A4a0B6D02FA87FCCaD4',
    // BAT — BEP-20 on BSC
    BATUSDT:   '0x101d82428437127bF1608F699CD651e6Abf9766E',
    // ZRO — BEP-20 on BSC
    ZROUSDT:   '0x6985884C4392D348587B19cb9eAAf157F13271cd',
    // BONK — BEP-20 on BSC
    BONKUSDT:  '0xA697e272a73744b343528C3Bc4702F2565b2F422',
    // PENGU — BEP-20 on BSC
    PENGUUSDT: '0xaAB9F5feaA5a7F888Fc4cF6c7a64dFc047F27F47',
    // BTT — BEP-20 on BSC
    BTTUSDT:   '0x352Cb5E19b12FC216548a2677bD0fce83BaE434B',
    // NFT — BEP-20 on BSC
    NFTUSDT:   '0x20eE7B720f4E4c4FFcB00C4065cdae55271aECCa',
    // RAY — BEP-20 on BSC (wrapped)
    RAYUSDT:   '0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40',
    // YFI — BEP-20 on BSC
    YFIUSDT:   '0x88f1A5ae2A3BF98AEAF342D26B30a79438c9142e',
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

    // No walletPassword field — TWAK CLI reads TWAK_WALLET_PASSWORD from env automatically.
    // Passing --password on the CLI exposes it in shell history (TWAK's own warning).
    constructor(_unused?: string) {}

    static isRateLimited(): boolean {
        return Date.now() < TWAKBscClient._rateLimitedUntil;
    }

    private async run(args: string[]): Promise<any> {
        if (TWAKBscClient.isRateLimited()) {
            throw new Error('TWAK rate limited, retry later');
        }

        const fullArgs = [...args, '--json'];
        // NOTE: do NOT add --password here. TWAK CLI reads TWAK_WALLET_PASSWORD
        // from the environment; passing it as a CLI flag causes a deprecation
        // warning and in some versions a VALIDATION_ERROR.

        try {
            const { stdout, stderr } = await execFileAsync(TWAK_BIN, fullArgs, {
                timeout: 45_000,
                shell: TWAK_SHELL,
                // Forward the full environment so TWAK_WALLET_PASSWORD is visible
                env: { ...process.env },
            });

            // Filter stderr: "Note:" lines are advisory warnings, not errors.
            const errLines = (stderr || '').split('\n').filter(
                l => l.trim() && !l.trim().startsWith('Note:')
            );

            if (errLines.some(l => l.toLowerCase().includes('rate limit'))) {
                TWAKBscClient._rateLimitedUntil = Date.now() + 60_000;
                throw new Error('TWAK rate limited');
            }

            const output = stdout.trim();
            if (!output) throw new Error('TWAK returned empty response');
            
            // Extract the JSON object or array block if there is progress output before it
            let jsonString = output;
            const firstBrace = output.search(/[{[]/);
            if (firstBrace !== -1) {
                const lastBraceChar = output[firstBrace] === '{' ? '}' : ']';
                const lastBrace = output.lastIndexOf(lastBraceChar);
                if (lastBrace !== -1 && lastBrace > firstBrace) {
                    jsonString = output.substring(firstBrace, lastBrace + 1);
                }
            }
            return JSON.parse(jsonString);
        } catch (e: any) {
            // e.stderr may contain "Note:" advisory lines — strip them before surfacing.
            const rawErr: string = e.stderr || e.stdout || e.message || String(e);
            const cleanErr = rawErr
                .split('\n')
                .filter(l => !l.trim().startsWith('Note:'))
                .join(' ')
                .trim();
            throw new Error(`TWAK CLI error [${args.join(' ')}]: ${cleanErr.slice(0, 300)}`);
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
