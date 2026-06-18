const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Load env.local
const envPath = 'e:\\cursor\\projects-source\\trade-app-spot-bnb\\.env.local';
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

const assets = [
  'c20000714_t0x35bf15e1DC5E6d37Dcc334Ec0F577746d13e4444',
  'c20000714_t0x29406d9eafFFfbEf56924b53Cc895B2A75590695',
  'c20000714_t0xA6996aECf749FEe3369eF654e28faB89220BfeF2',
  'c20000714_t0x9eA9Ba15aBE07cd79896767E44f0BeC3Cdb81Fe1',
  'c20000714_t0x042Be8083B1D223125304E454D1a3e738FB183e6',
  'c20000714_t0x2233a653e33b5b2563cCfAD1c4A20a32DA9cA3A8',
  'c20000714_t0x25a7e75ba58Cc541c62e5Ef6dfa6F7C626D4bD3D',
  'c20000714_t0xBfbdDA1f2776BC6C086c30926977D50B51A6b7ba',
  'c20000714_t0xEc5f235Ef211e481f86F2ce7cbFC6D33CC301491',
  'c20000714_t0xAc0199711a5668706B17d5f1cE4187Dd2E121ee8',
  'c20000714_t0xB9a4B72132953585cf9370ec960D1D5D60795bfD',
  'c20000714_t0x75cb8358Cf77A71D137E89429EeCBbfF51a39D49',
  'c20000714_t0xe817F096fc3Bc82342eA6bADcf0Dc2E5E81BC3E1'
];

async function main() {
    for (const a of assets) {
        try {
            const info = await run(['asset', a]);
            console.log(`${a} => symbol: ${info.symbol}, name: ${info.name}, decimals: ${info.decimals}`);
        } catch (e) {
            console.error(`Failed for ${a}:`, e.message);
        }
    }
}

main();
