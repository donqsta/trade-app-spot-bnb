const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Load env.local manually
const envPath = 'e:\\cursor\\projects-source\\trade-app-spot-bnb\\.env.local';
console.log("Looking for env at:", envPath);
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const parts = trimmed.split('=');
      if (parts.length >= 2) {
        const key = parts[0].trim();
        const val = parts.slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
        process.env[key] = val;
      }
    }
  }
}

const TWAK_WALLET_PASSWORD = process.env.TWAK_WALLET_PASSWORD;
console.log("TWAK_WALLET_PASSWORD loaded:", !!TWAK_WALLET_PASSWORD);

async function run(args) {
    const fullArgs = ['@trustwallet/cli', ...args, '--json'];
    const { stdout } = await execFileAsync('npx', fullArgs, {
        timeout: 45000,
        shell: true,
        env: { ...process.env }
    });
    const output = stdout.trim();
    const firstBrace = output.search(/[{[]/);
    const lastBraceChar = output[firstBrace] === '{' ? '}' : ']';
    const lastBrace = output.lastIndexOf(lastBraceChar);
    const jsonString = output.substring(firstBrace, lastBrace + 1);
    return JSON.parse(jsonString);
}

async function getWalletAddress() {
    const result = await run(['wallet', 'address', '--chain', 'bsc']);
    return result?.address || result?.bsc || '';
}

async function getTxHistory(limit = 100) {
    const address = await getWalletAddress();
    if (!address) return [];
    const result = await run([
        'history',
        '--address', address,
        '--chain', 'bsc',
        '--limit', String(limit)
    ]);
    return Array.isArray(result) ? result : (result?.transactions ?? result?.items ?? []);
}

async function getAssetInfo(assetId) {
    try {
        const result = await run(['asset', assetId]);
        return {
            decimals: parseInt(result?.decimals ?? '18'),
            symbol: result?.symbol ?? '',
            name: result?.name ?? '',
        };
    } catch (e) {
        console.error("Asset info error:", e.message);
        return { decimals: 18, symbol: '', name: '' };
    }
}

async function getTokenEntryFromHistory(tokenSymbolOrAddress) {
    let targetAssetId = '';
    const upperSym = tokenSymbolOrAddress.toUpperCase();
    if (upperSym === 'BNB' || upperSym === 'BNBUSDT') {
        targetAssetId = 'c20000714';
    } else {
        let contractAddress = '';
        if (tokenSymbolOrAddress.startsWith('0x')) {
            contractAddress = tokenSymbolOrAddress;
        } else {
            // Hardcode mapping or query for testing
            if (upperSym === 'CAKE') contractAddress = '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82';
            else contractAddress = tokenSymbolOrAddress;
        }
        targetAssetId = `c20000714_t${contractAddress.toLowerCase()}`;
    }

    console.log(`Querying history for token asset ID: ${targetAssetId}...`);
    const txs = await getTxHistory(100);
    console.log(`Fetched ${txs.length} completed transactions.`);
    
    const walletAddress = await getWalletAddress();
    console.log(`Wallet address: ${walletAddress}`);

    for (const tx of txs) {
        if (tx.status !== 'completed') continue;
        const events = tx.events || [];

        const inTransfer = events.find(e => {
            return e.type === 'transfer' &&
                   e.data?.to?.toLowerCase() === walletAddress.toLowerCase() &&
                   e.data?.asset?.toLowerCase() === targetAssetId.toLowerCase();
        });

        if (inTransfer) {
            console.log(`Found incoming transfer event in Tx ${tx.hash}`);
            const usdtAssetId = 'c20000714_t0x55d398326f99059ff775485246999027b3197955';
            const outUsdt = events.find(e => {
                return e.type === 'transfer' &&
                       e.data?.from?.toLowerCase() === walletAddress.toLowerCase() &&
                       e.data?.asset?.toLowerCase() === usdtAssetId;
            });

            const entryTime = new Date(tx.created_at || tx.block_created_at || Date.now()).getTime();

            if (outUsdt) {
                console.log("Found matching outgoing USDT transfer (Swap trade!).");
                try {
                    const usdtDecimals = 18;
                    const tokenInfo = await getAssetInfo(targetAssetId);
                    const tokenDecimals = tokenInfo.decimals;
                    console.log(`Decimals: USDT = ${usdtDecimals}, Token = ${tokenDecimals}`);

                    const rawUsdtVal = parseFloat(outUsdt.data?.value || '0');
                    const rawTokenVal = parseFloat(inTransfer.data?.value || '0');
                    console.log(`Raw values: USDT = ${rawUsdtVal}, Token = ${rawTokenVal}`);

                    if (rawUsdtVal > 0 && rawTokenVal > 0) {
                        const usdtFloat = rawUsdtVal / Math.pow(10, usdtDecimals);
                        const tokenFloat = rawTokenVal / Math.pow(10, tokenDecimals);
                        const entryPrice = usdtFloat / tokenFloat;
                        return { entryPrice, entryTime };
                    }
                } catch (e) {
                    console.error('Error parsing swap details:', e);
                }
            }
            console.log("No outgoing USDT transfer found in this transaction (Direct deposit/transfer).");
            return { entryPrice: 0, entryTime };
        }
    }
    return null;
}

async function test() {
    // Test with the target token address we know exists in our transaction history
    const targetToken = '0x35bf15e1DC5E6d37Dcc334Ec0F577746d13e4444';
    console.log(`--- Testing with Token: ${targetToken} ---`);
    const res = await getTokenEntryFromHistory(targetToken);
    console.log("Result:", res);
}

test();
