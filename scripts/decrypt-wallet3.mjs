import { createDecipheriv, pbkdf2Sync, scryptSync } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const walletPath = join(homedir(), '.twak', 'wallet.json');
const wallet = JSON.parse(readFileSync(walletPath, 'utf8'));
const password = process.argv[2] || process.env.TWAK_WALLET_PASSWORD;

if (!password) {
  console.error('❌ Cần nhập mật khẩu: node decrypt-wallet3.mjs <password>');
  process.exit(1);
}

const salt = Buffer.from(wallet.salt, 'hex');
const iv = Buffer.from(wallet.iv, 'hex');
const authTag = Buffer.from(wallet.authTag, 'hex');
const encryptedData = Buffer.from(wallet.encryptedMnemonic, 'hex');

function tryDecrypt(key, label) {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return null;
  }
}

console.log('🔍 Thử nhiều phương pháp derive key...\n');

const attempts = [
  // scrypt với các giá trị N nhỏ hơn (tránh memory limit)
  ['scrypt N=1024', () => scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 })],
  ['scrypt N=2048', () => scryptSync(password, salt, 32, { N: 2048, r: 8, p: 1 })],
  ['scrypt N=4096', () => scryptSync(password, salt, 32, { N: 4096, r: 8, p: 1 })],
  ['scrypt N=8192', () => scryptSync(password, salt, 32, { N: 8192, r: 8, p: 1 })],
  ['scrypt N=16384 r=8 p=1', () => scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 256 * 1024 * 1024 })],
  // pbkdf2 các biến thể
  ['pbkdf2-sha256-10k', () => pbkdf2Sync(password, salt, 10000, 32, 'sha256')],
  ['pbkdf2-sha256-100k', () => pbkdf2Sync(password, salt, 100000, 32, 'sha256')],
  ['pbkdf2-sha512-10k', () => pbkdf2Sync(password, salt, 10000, 32, 'sha512')],
  ['pbkdf2-sha512-100k', () => pbkdf2Sync(password, salt, 100000, 32, 'sha512')],
  ['pbkdf2-sha256-1k', () => pbkdf2Sync(password, salt, 1000, 32, 'sha256')],
  ['pbkdf2-sha256-600k', () => pbkdf2Sync(password, salt, 600000, 32, 'sha256')],
];

for (const [label, keyFn] of attempts) {
  process.stdout.write(`  Thử ${label}... `);
  try {
    const key = keyFn();
    const result = tryDecrypt(key, label);
    if (result) {
      console.log('✅ THÀNH CÔNG!\n');
      console.log('━'.repeat(60));
      console.log('SEED PHRASE:', result);
      console.log('━'.repeat(60));
      console.log('\n📋 Import vào MetaMask:');
      console.log('   1. MetaMask → tài khoản → Add account → Import account');
      console.log('   2. Chọn "Secret Recovery Phrase"');
      console.log('   3. Dán seed phrase ở trên');
      console.log('\n⚠️  XÓA TERMINAL HISTORY ngay sau khi lưu!');
      process.exit(0);
    }
    console.log('❌ sai');
  } catch(e) {
    console.log(`⚠️  lỗi: ${e.message}`);
  }
}

console.log('\n❌ Tất cả phương pháp đều thất bại.');
console.log('   TWAK dùng thuật toán tùy chỉnh không thể đoán thủ công.\n');
console.log('💡 GIẢI PHÁP THAY THẾ (100% hoạt động):');
console.log('   Dùng lệnh twak transfer để chuyển thẳng mà không cần import ví:');
console.log('');
console.log('   twak transfer --amount <số_tiền> --token BNB --to <địa_chỉ_ví_của_bạn> --chain bsc');
