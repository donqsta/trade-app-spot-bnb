/**
 * BNB Hack Competition Registration Helper
 *
 * Steps:
 *   1. npm install -g @trustwallet/cli
 *   2. Điền TWAK_ACCESS_ID + TWAK_HMAC_SECRET vào .env.local
 *   3. npx tsx scripts/register-competition.ts
 *
 * NOTE: "twak compete register" không tồn tại trong TWAK CLI.
 * Đăng ký on-chain thủ công qua BSCScan hoặc DoraHacks portal.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

// Load .env.local manually (no dotenv dependency needed)
const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
}

const execFileAsync = promisify(execFile);

// On Windows, .cmd binaries need shell:true so execFile can find them via PATH
const IS_WIN = process.platform === 'win32';
const run = (args: string[], opts?: { timeout?: number }) =>
    execFileAsync('twak', args, { shell: IS_WIN, timeout: opts?.timeout ?? 30_000 });

async function main() {
    console.log('🏆 BNB Hack AI Trading Agent — Setup & Registration Helper');
    console.log('='.repeat(60));

    // ── 1. Check TWAK CLI ────────────────────────────────────────────────
    console.log('\n[1/4] Kiểm tra TWAK CLI...');
    try {
        const { stdout } = await run(['--version']);
        console.log(`  ✅ TWAK CLI: ${stdout.trim()}`);
    } catch {
        console.error('  ❌ TWAK CLI chưa được cài đặt. Chạy:\n');
        console.error('     npm install -g @trustwallet/cli\n');
        console.error('  Sau đó chạy lại script này.');
        process.exit(1);
    }

    // ── 2. Auto-init credentials từ env ──────────────────────────────────
    console.log('\n[2/4] Khởi tạo credentials...');
    const accessId   = process.env.TWAK_ACCESS_ID?.trim();
    const hmacSecret = process.env.TWAK_HMAC_SECRET?.trim();

    if (accessId && hmacSecret) {
        try {
            await run(['init', '--api-key', accessId, '--api-secret', hmacSecret]);
            console.log('  ✅ twak init thành công (dùng TWAK_ACCESS_ID + TWAK_HMAC_SECRET từ .env.local)');
        } catch (e: any) {
            console.error(`  ❌ twak init thất bại: ${e.stderr || e.message}`);
            process.exit(1);
        }
    } else {
        // Kiểm tra đã auth chưa
        try {
            await run(['auth', 'status', '--json']);
            console.log('  ✅ TWAK đã xác thực (credentials được lưu trước đó)');
        } catch {
            console.error('  ❌ Chưa có credentials. Thêm vào .env.local:');
            console.error('     TWAK_ACCESS_ID=<access-id>');
            console.error('     TWAK_HMAC_SECRET=<hmac-secret>');
            console.error('  Lấy credentials tại: https://portal.trustwallet.com');
            process.exit(1);
        }
    }

    // ── 3. Lấy địa chỉ ví BSC ────────────────────────────────────────────
    console.log('\n[3/4] Lấy địa chỉ ví BSC...');
    const pw = process.env.TWAK_WALLET_PASSWORD?.trim() || '';
    let walletAddress = '';
    try {
        const args = ['wallet', 'address', '--chain', 'bsc', '--json'];
        if (pw) args.push('--password', pw);
        const { stdout } = await run(args);
        const data = JSON.parse(stdout.trim());
        walletAddress = data.address || data.bsc || '';
    } catch (e: any) {
        const msg: string = e.stderr || e.message || '';
        if (msg.includes('no wallet') || msg.includes('not found')) {
            console.log('  ⚠️  Chưa có ví. Đang tạo ví mới...');
            try {
                const createArgs = ['wallet', 'create', '--json'];
                if (pw) createArgs.push('--password', pw);
                const { stdout } = await run(createArgs, { timeout: 60_000 });
                const created = JSON.parse(stdout.trim());
                walletAddress = created.address || created.bsc || '';
                console.log(`  ✅ Ví đã tạo: ${walletAddress}`);
            } catch (ce: any) {
                console.error(`  ❌ Tạo ví thất bại: ${ce.stderr || ce.message}`);
                process.exit(1);
            }
        } else {
            console.error(`  ❌ Lỗi: ${msg}`);
            console.error('  Hãy thử: twak wallet create --password <pw>');
            process.exit(1);
        }
    }

    if (!walletAddress) {
        console.error('  ❌ Địa chỉ ví trống. Kiểm tra TWAK_WALLET_PASSWORD trong .env.local.');
        process.exit(1);
    }
    console.log(`  ✅ Agent wallet (BSC): ${walletAddress}`);

    // ── 4. Hướng dẫn đăng ký ─────────────────────────────────────────────
    console.log('\n[4/4] Đăng ký Hackathon...\n');
    console.log('  ─── Cách A: BSCScan Write Contract ─────────────────────────────────');
    console.log('  1. Truy cập:');
    console.log('     https://bscscan.com/address/0x212c61b9b72c95d95bf29cf032f5e5635629aed5#writeContract');
    console.log('  2. "Connect to Web3" → kết nối MetaMask/Trust Wallet (cần BNB làm gas)');
    console.log('  3. Gọi hàm registerAgent() với:');
    console.log(`     agentWallet = ${walletAddress}`);
    console.log('  4. Confirm → copy TX hash\n');

    console.log('  ─── Cách B: DoraHacks Portal ───────────────────────────────────────');
    console.log('  1. https://dorahacks.io/hackathon/bnbhack-twt-cmc/detail');
    console.log('  2. Submit project với:');
    console.log(`     Agent Wallet:  ${walletAddress}`);
    console.log('     Integrations:  CoinMarketCap AI Agent Hub + Trust Wallet Agent Kit');
    console.log('     Strategy:      LLM Quant Operator + CMC price feed + TWAK BSC swaps\n');

    // ── Lưu thông tin ─────────────────────────────────────────────────────
    const outPath = path.join(process.cwd(), 'competition-wallet.json');
    fs.writeFileSync(outPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        agentWallet: walletAddress,
        bscscanRegister: 'https://bscscan.com/address/0x212c61b9b72c95d95bf29cf032f5e5635629aed5#writeContract',
        dorahacks: 'https://dorahacks.io/hackathon/bnbhack-twt-cmc/detail',
        envCheck: {
            TWAK_WALLET_PASSWORD: pw ? '✅ set' : '❌ NOT SET',
            TWAK_ACCESS_ID: accessId ? '✅ set' : '❌ NOT SET',
            TWAK_HMAC_SECRET: hmacSecret ? '✅ set' : '❌ NOT SET',
        },
    }, null, 2));
    console.log(`  📄 Đã lưu: competition-wallet.json`);

    // Cập nhật TWAK_AGENT_WALLET trong .env.local nếu chưa có
    let envContent = fs.readFileSync(envPath, 'utf8');
    if (!envContent.includes(walletAddress)) {
        envContent = envContent.replace(
            /TWAK_AGENT_WALLET=.*/,
            `TWAK_AGENT_WALLET=${walletAddress}`
        );
        fs.writeFileSync(envPath, envContent);
        console.log(`  ✅ TWAK_AGENT_WALLET đã cập nhật trong .env.local`);
    }

    console.log('\n  ⏰ Live trading: 22/06/2026 00:00 UTC');
    console.log('     Nạp BNB (gas) + USDT (vốn) vào ví trước ngày đó!\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
