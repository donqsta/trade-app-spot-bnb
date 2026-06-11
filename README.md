# AI-QuantBot — BNB Hack AI Trading Agent Edition

**Track 1: Autonomous Trading Agents** | BNB Chain × CoinMarketCap × Trust Wallet

> An LLM-powered AI trading agent that reads multi-source market data, makes autonomous trading decisions, and executes real on-chain swaps on BSC via Trust Wallet Agent Kit — all within a strict risk framework.

---

## Architecture

```
CMC Agent Hub (Fear&Greed / Global Metrics / Trending)
        │
Grok/xAI X Sentiment (per-pair social signals)
        │
Binance WebSocket (live prices + candle data for TA)
        │
        ▼
┌──────────────────────────────────────────────┐
│         LLM Quant Operator                    │
│  (OpenAI / Anthropic / Gemini / DeepSeek)    │
│  - Reads: FG score, BTC dominance, sentiment │
│  - Outputs: regime, riskMultiplier, SL/TP    │
└──────────────────────────────────────────────┘
        │
AI Ensemble Signal (KNN + Logistic + Momentum + ONNX)
        │
Competition Guard (25% drawdown kill-switch)
        │
        ▼
Trust Wallet Agent Kit (TWAK)
  twak swap USDT → TOKEN --chain bsc
  twak automate add --condition below (stop-loss)
  twak automate add --condition above (take-profit)
        │
        ▼
BSC Mainnet (PancakeSwap routing, best execution)
```

---

## Key Features

### Signal Stack
- **Technical Analysis**: RSI, MACD, ATR, Bollinger Bands, Choppiness Index, Trend Intensity
- **CMC Agent Hub**: Fear & Greed Index, global market cap, BTC dominance, trending gainers
- **Grok X Sentiment**: Real-time X (Twitter) sentiment score per token via xAI Responses API
- **LLM Quant Operator**: GPT-4 / Claude reads all signals → outputs JSON strategy regime

### Execution Layer (BSC via TWAK)
- **Self-custody**: keys never leave the user's Trust Wallet agent wallet
- **Autonomous**: bot registers automations and executes without per-tx approval
- **x402**: CMC data payable per-request via x402 protocol on Base

### Risk Management (Competition-Grade)
- Hard **25% drawdown halt** (competition DQ threshold = 30%)
- Minimum **1 trade/day** tracker for 7-day scoring window
- Portfolio hourly guard (never let balance drop to $0)
- Eligible-token allowlist enforced (149 BEP-20 tokens from competition list)

---

## Setup

### 1. Install TWAK CLI
```bash
npm install -g @trustwallet/cli
twak init --api-key cf354cc7bfd9679a910b1fadef015870e4ab7faa69c06dec3083e2dbffc99dee --api-secret 8d41fdedef55c679dd8fc1211ed4e205a2c39044c56faf74952640ae56f33fd4
twak wallet create --password <your-password>
```

### 2. Configure `.env.local`
```bash
# Trust Wallet Agent Kit
TWAK_WALLET_PASSWORD=your-wallet-password
TWAK_AGENT_WALLET=0x...   # BSC address from: twak wallet address --chain bsc

# CoinMarketCap AI Agent Hub
CMC_API_KEY=your-cmc-pro-api-key

# LLM Brain (recommended: OpenAI GPT-4o)
LLM_PROVIDER=openai
LLM_API_KEY=sk-...
LLM_MODEL=gpt-4o

# Grok/xAI for X sentiment
XAI_API_KEY=xai-...

# Trading pairs (BSC-eligible from competition list)
PAIRS=BNBUSDT,CAKEUSDT,LINKUSDT,AAVEUSDT,FLOKIUSDT
```

### 3. Register for Competition (before June 22)
```bash
npx tsx scripts/register-competition.ts
```
This will:
- Run `twak compete register` to call the BSC competition contract
- Save proof to `competition-registration.json`
- Print your agent wallet address + tx hash for DoraHacks submission

### 4. Run the Bot
```bash
npm run dev       # development
npm run build && npm start   # production
```

The bot auto-detects `TWAK_WALLET_PASSWORD` and switches to `bsc_twak` mode.

---

## Live Trading Window (June 22–28, 2026)

The bot will:
1. Use Binance WebSocket for real-time price feeds + TA signals
2. Query CMC Agent Hub for macro context (Fear & Greed, trending)
3. Run X sentiment analysis via Grok every 30 minutes
4. Feed all signals to the LLM Quant Operator
5. Execute TWAK swaps on BSC when signal confidence ≥ 70%
6. Place TWAK automate SL/TP orders immediately after entry
7. Monitor competition drawdown (halt at 25%)

---

## Data Flow Diagram

```
Every 30s:
  CMC Fear&Greed ──┐
  Grok Sentiment ──┤──► LLM Quant Operator ──► strategy regime
  Binance TA    ──┘       (OpenAI/Claude)        riskMultiplier

Every candle close (15m default):
  AI Ensemble signal ──► evaluateLiveSignal ──► if LONG + competition guard OK
                                                   ──► TWAK swap (USDT → token)
                                                   ──► TWAK automate SL + TP

Competition Guard (continuous):
  Portfolio USD → checkTradeAllowed → halt if drawdown ≥ 25%
  Trade counter → warn if day has no trade yet
```

---

## Special Prize Eligibility

| Prize | Status |
|-------|--------|
| Best Use of Trust Wallet Agent Kit | TWAK is sole execution layer: swap + automate (SL/TP) + compete register |
| Best Use of Agent Hub | CMC Fear&Greed + global metrics + trending injected into every LLM call |
| Best Use of BNB AI Agent SDK | BNB Chain execution via TWAK (BSC PancakeSwap routing) |

---

## Submission Checklist

- [ ] Agent wallet registered on BSC (`competition-registration.json`)
- [ ] GitHub repo: public, reproducible setup
- [ ] Demo video: CMC data → LLM decision → TWAK BSC execution → BSCScan proof
- [ ] DoraHacks submission with agent wallet + strategy description

---

## Token Pairs (BSC-Eligible)

Default pairs: `BNB, CAKE, LINK, AAVE, FLOKI`

All are in the [149 eligible BEP-20 tokens](https://dorahacks.io/hackathon/bnbhack-twt-cmc/detail) list.
Configure via `PAIRS` env var — only eligible tokens are accepted.

---

Built with: Next.js 16 · TypeScript · Trust Wallet Agent Kit · CoinMarketCap AI Agent Hub · xAI Grok · BNB Chain
