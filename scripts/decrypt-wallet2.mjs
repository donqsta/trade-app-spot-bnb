import { createDecipheriv, pbkdf2Sync, scryptSync } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const walletPath = join(homedir(), '.twak', 'wallet.json');
const wallet = JSON.parse(readFileSync(walletPath, 'utf8'));
const password = process.argv[2] || process.env.TWAK_WALLET_PASSWORD;

if (!password) {
  console.error('❌ Cần nhập mật khẩu: node decrypt-wallet2.mjs <password>');
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

// Thử 1: scrypt N=16384
const key1 = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
let result = tryDecrypt(key1, 'scrypt N=16384');
if (result) { console.log('✅ scrypt N=16384 thành công!\nMnemonic:', result); process.exit(0); }

// Thử 2: scrypt N=32768
const key2 = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1 });
result = tryDecrypt(key2, 'scrypt N=32768');
if (result) { console.log('✅ scrypt N=32768 thành công!\nMnemonic:', result); process.exit(0); }

// Thử 3: scrypt N=65536
const key3 = scryptSync(password, salt, 32, { N: 65536, r: 8, p: 1 });
result = tryDecrypt(key3, 'scrypt N=65536');
if (result) { console.log('✅ scrypt N=65536 thành công!\nMnemonic:', result); process.exit(0); }

// Thử 4: pbkdf2 SHA-256, 100000 iterations
const key4 = pbkdf2Sync(password, salt, 100000, 32, 'sha256');
result = tryDecrypt(key4, 'pbkdf2-sha256-100k');
if (result) { console.log('✅ pbkdf2-sha256-100k thành công!\nMnemonic:', result); process.exit(0); }

// Thử 5: pbkdf2 SHA-512, 100000 iterations
const key5 = pbkdf2Sync(password, salt, 100000, 32, 'sha512');
result = tryDecrypt(key5, 'pbkdf2-sha512-100k');
if (result) { console.log('✅ pbkdf2-sha512-100k thành công!\nMnemonic:', result); process.exit(0); }

// Thử 6: pbkdf2 SHA-256, 10000 iterations
const key6 = pbkdf2Sync(password, salt, 10000, 32, 'sha256');
result = tryDecrypt(key6, 'pbkdf2-sha256-10k');
if (result) { console.log('✅ pbkdf2-sha256-10k thành công!\nMnemonic:', result); process.exit(0); }

// Thử 7: scrypt default (N=16384) với password dạng Buffer UTF-8
const key7 = scryptSync(Buffer.from(password, 'utf8'), salt, 32);
result = tryDecrypt(key7, 'scrypt-buffer');
if (result) { console.log('✅ scrypt-buffer thành công!\nMnemonic:', result); process.exit(0); }

console.log('❌ Tất cả phương pháp đều thất bại.');
console.log('   TWAK có thể dùng thuật toán tùy chỉnh.');
console.log('\n💡 Giải pháp thay thế: Dùng lệnh twak transfer trực tiếp để chuyển tiền.');
