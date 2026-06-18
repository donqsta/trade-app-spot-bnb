import fs from 'fs';
import path from 'path';

// Load env.local manually
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

import { TWAKBscClient } from '../src/lib/twak-bsc-client.ts';

async function main() {
    console.log("Initializing TWAKBscClient...");
    const client = new TWAKBscClient();
    
    console.log("Checking portfolio first (to see what is normally returned)...");
    const portfolio = await client.getPortfolio();
    console.log("Portfolio assets:", portfolio.map(a => `${a.symbol}: ${a.balance}`));

    console.log("\nTesting getTokenBalance('CAKE') (which should fallback to direct command if not in portfolio)...");
    const cakeBal = await client.getTokenBalance('CAKE');
    console.log("CAKE balance result:", cakeBal);

    console.log("\nTesting getTokenBalance('AAVE')...");
    const aaveBal = await client.getTokenBalance('AAVE');
    console.log("AAVE balance result:", aaveBal);
}

main().catch(err => {
    console.error("Test execution failed:", err);
});
