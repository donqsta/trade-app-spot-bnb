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

import { getBotEngine } from '../src/lib/bot-engine.ts';

async function main() {
    console.log("Initializing BotEngine...");
    const bot = getBotEngine();
    
    // Set live trading mode to bsc_twak
    bot.liveTradingMode = 'bsc_twak';
    bot.activePairs = ['BNBUSDT', 'CAKEUSDT', 'LINKUSDT', 'AAVEUSDT', 'FLOKIUSDT'];

    console.log("Current openPositions in memory before sync:", bot.openPositions);

    console.log("\nExecuting syncLiveBinanceState(true)...");
    try {
        await bot.syncLiveBinanceState(true);
        console.log("Sync finished successfully.");
    } catch (e) {
        console.error("Sync failed with error:", e);
    }

    console.log("\nCurrent openPositions in memory after sync:", bot.openPositions);
    console.log("\nBot logs during execution:");
    console.log(bot.logs.slice(-10));
}

main().catch(err => {
    console.error("Execution failed:", err);
});
