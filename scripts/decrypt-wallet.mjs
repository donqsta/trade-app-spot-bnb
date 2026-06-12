import { createDecipheriv, scryptSync } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Đọc wallet.json
const walletPath = join(homedir(), '.twak', 'wallet.json');
const wallet = JSON.parse(readFileSync(walletPath, 'utf8'));

// Mật khẩu ví
const password = process.argv[2] || process.env.TWAK_WALLET_PASSWORD;

if (!password) {
  console.error('❌ Cần nhập mật khẩu: node decrypt-wallet.mjs <password>');
  process.exit(1);
}

console.log('🔑 Đang decrypt mnemonic seed phrase...\n');

try {
  const salt = Buffer.from(wallet.salt, 'hex');
  const iv = Buffer.from(wallet.iv, 'hex');
  const authTag = Buffer.from(wallet.authTag, 'hex');
  const encryptedData = Buffer.from(wallet.encryptedMnemonic, 'hex');

  // Derive key bằng scrypt (giống cách TWAK mã hóa)
  const key = scryptSync(password, salt, 32);

  // Decrypt bằng AES-256-GCM
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encryptedData),
    decipher.final()
  ]);

  const mnemonic = decrypted.toString('utf8');
  
  console.log('✅ SEED PHRASE (Mnemonic) của bạn là:');
  console.log('━'.repeat(60));
  console.log(mnemonic);
  console.log('━'.repeat(60));
  console.log('\n📋 Cách import vào MetaMask:');
  console.log('   1. Mở MetaMask → nhấn vào biểu tượng tài khoản (góc trên phải)');
  console.log('   2. Chọn "Add account or hardware wallet"');
  console.log('   3. Chọn "Import account" → chọn "Secret Recovery Phrase"');
  console.log('   4. Dán 12/24 từ ở trên vào');
  console.log('\n⚠️  XÓA TERMINAL HISTORY sau khi đã lưu seed phrase!');
} catch (err) {
  console.error('❌ Lỗi decrypt:', err.message);
  console.error('   Có thể mật khẩu sai hoặc TWAK dùng thuật toán khác.');
}
