# Orocle Auto Trade: AI-Powered Autonomous Spot Trading Bot on BNB Chain

**Autonomous Spot Trading Agent** | BNB Chain × CoinMarketCap × Trust Wallet

> An AI-powered autonomous spot trading bot running 24/7 on the BNB Chain. The bot combines fast local Machine Learning models with a Large Language Model (LLM) acting as a risk manager, executing trades directly on-chain via the **Trust Wallet Agent Kit (TWAK)**.

---

## Vision
Autonomous AI trading bot on BNB Chain executing via TWAK. Combines fast local ML models for signal generation with LLM agents for cognitive risk management, optimizing Net PnL and trade execution costs on PancakeSwap spot pools.

---

## System Architecture

```
CoinMarketCap Quotes API (30s Polling)
         │
         ▼
Synthetic Candle Builder (OHLCV)
         │
         ├──► Local ML Ensemble (KNN + Logistic Regression + Momentum) ──► Buy/Sell Signal
         │
         ▼
Market Context Compiler (Fear & Greed, BTC Dominance, Top Gainers, X Sentiment)
         │
         ▼
┌──────────────────────────────────────────────┐
│         LLM Quant Operator                   │
│   (DeepSeek / Gemini / OpenAI)               │
│   - Acts as Cognitive Risk Manager           │
│   - Adjusts risk multipliers, TP/SL ratios   │
│   - Decides early exits / approves trades    │
└──────────────────────────────────────────────┘
         │
         ├──► Risk Safeguards (Equity Protection, Daily Drawdown, News Blackout)
         │
         ▼
Trust Wallet Agent Kit (TWAK)
  twak swap USDT → TOKEN --chain bsc
         │
         ▼
BSC Mainnet (PancakeSwap DEX spot pools routing)
```

---

## Core Features

### 1. Two-Layer Decision Engine
- **Local Machine Learning Layer**: Runs directly on Node.js using historical candlestick data from CoinMarketCap. The bot automatically extracts a set of **12 technical features** from the market (including RSI, MACD Histogram, distance to EMA20/EMA200, EMA20/EMA50 crossover, 3-candle price momentum, ATR-based volatility, Money Flow Index (MFI), OBV change, Bollinger Band spread, ADX trend strength, and volume spikes). Based on these features, the bot trains 3 local models: KNN (K-Nearest Neighbors), Logistic Regression, and Momentum. Each trading pair is trained and predicted independently using its own historical candles (e.g., predicting CAKE/USDT signals without relying directly on BTC price data). An Ensemble model then aggregates the predictions (using weighted voting based on recent win rates) to decide whether to trigger a Buy/Sell signal.
- **LLM Quant Operator Layer**: Upon receiving a buy signal from the ML layer, the bot gathers structural market context (including wallet balance, active positions, Fear & Greed index from CMC, and X/Twitter sentiment score from the Grok API) and forwards it to the LLM (DeepSeek, Gemini, or OpenAI). While the local ML layer operates independently per token, the LLM Operator acts as a macro risk manager to:
  - Approve or veto the trade entry if market conditions are unfavorable (utilizing BTC Dominance and overall market trend to check if it is Altcoin season or a risk-off environment).
  - Scale up or down the risk multiplier.
  - Dynamically extend the Take Profit (TP) target for high-confidence setups, or tighten the Stop Loss (SL) to protect capital.
  - Monitor positions and make early exit decisions if it detects a trend reversal or negative news sentiment.

### 2. CoinMarketCap Integration as Data Oracle & Market Context Feed
The system integrates with the **CoinMarketCap REST API & Skill Hub (MCP)** to serve as the price and macro indicator oracle:
- **Real-Time Price Updates via Quotes API**: For on-chain trading on BSC, relying on Binance WebSockets is often unsuitable for smaller tokens or memecoins only traded on DEXs. The bot polls the CoinMarketCap Quotes API to retrieve the latest swap prices, constructing **synthetic candles** (OHLCV) locally to compute indicators.
- **Market Sentiment (Fear & Greed Index)**: The bot queries the real-time Fear & Greed index from CoinMarketCap to help the LLM adjust exit targets (e.g., extending TP during greed phases, or tightening SL during extreme fear).
- **Dominance & Macro Trend**: Key metrics such as BTC/ETH Dominance and the list of top gaining/trending tokens are fed into the LLM context to identify overall market regimes and optimize capital allocation.

### 3. Real-World On-Chain Spot Optimization
We prioritize real-world cost efficiency and slippage control when executing spot trades on-chain:
- **True Net PnL Calculation (Honest PnL)**: Most trading bots only calculate returns based on theoretical buy and sell prices. On BSC, transaction gas fees, DEX swap fees, and slippage can heavily impact profits. Our system automatically computes the true Net PnL by comparing the actual USDT proceeds received after the sell swap against the initial margin spent, deducting gas fees incurred from both the buy and sell swaps. This ensures the bot operates with absolute cost awareness.
- **Automatic Break-Even TP Calibration**: To guarantee that every Take Profit execution remains net-profitable after all transaction fees and slippage, the bot recalculates the break-even price immediately after the buy order fills. If the technical target TP is lower than the break-even threshold, the engine automatically adjusts the take profit price to the break-even point plus an additional volatility-based buffer (0.5x ATR).

### 4. Risk Management & Account Safety
To safeguard funds during autonomous trading, the bot implements several fail-safe guards:
- **Equity Protection**: The bot automatically halts all trading activities if the total account equity drops below a pre-configured minimum safety threshold to prevent further losses.
- **Daily Drawdown Limit**: Limits the maximum daily loss to a pre-defined percentage of the total portfolio value. Once hit, the bot closes all open positions and suspends entries until the next day to prevent trading in highly adverse conditions.
- **News Blackout Periods**: Integrates high-impact macroeconomic event schedules (such as CPI and FOMC releases), auto-pausing new trade entries before and after the announcement times to shield spot assets from extreme price spikes.

---

## Setup & Configuration

### 1. Install TWAK CLI
```bash
npm install -g @trustwallet/cli
twak init --api-key your_access_id --api-secret your_hmac_secret
twak wallet create --password <your-password>
```

### 2. Configure Environment Variables (`.env.local`)
Create a `.env.local` file in the root directory:
```bash
# Trust Wallet Agent Kit
TWAK_WALLET_PASSWORD=your-wallet-password
TWAK_AGENT_WALLET=0x...   # BSC address from: twak wallet address --chain bsc

# CoinMarketCap AI Agent Hub
CMC_API_KEY=your-cmc-pro-api-key

# LLM Brain (recommended: DeepSeek or Gemini)
LLM_PROVIDER=deepseek
LLM_API_KEY=your-llm-api-key
LLM_MODEL=deepseek-chat

# Trading pairs (BSC spot pairs)
PAIRS=BNBUSDT,CAKEUSDT,LINKUSDT,FLOKIUSDT
```

### 3. Run the Bot
```bash
npm run dev                 # development mode
npm run build && npm start  # production mode
```

---

## Team Information

**Solo Builder**
I am a solo builder with over 5 years of hands-on experience in Web3, cryptocurrency, and trading. While I have a solid understanding of software development, I leveraged modern AI-assisted coding tools to accelerate the construction of this codebase. However, I didn't just copy-paste; I have personally configured, refactored, and rigorously tested every single transaction path, calculation, and loop over dozens of live on-chain runs to ensure reliability. I am deeply passionate about the intersection of Crypto and AI, as I truly believe these two technologies combined will reshape the future of the world.

---

Built with Next.js 16 · TypeScript · Trust Wallet Agent Kit · CoinMarketCap AI Agent Hub · xAI Grok · PancakeSwap · BNB Chain
