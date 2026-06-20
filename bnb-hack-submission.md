# Orocle Auto Trade: AI-Powered Autonomous Spot Trading Bot on BNB Chain

This project is an automated spot trading bot running 24/7 on the BNB Chain. The bot combines fast local Machine Learning models with a Large Language Model (LLM) acting as a risk manager, executing trades directly on-chain via the **Trust Wallet Agent Kit (TWAK)**.

---

## 1. Core Concept & Operational Flow

The bot operates under a **two-layer decision engine**:
- **Local Machine Learning Layer**: Runs directly on Node.js using historical candlestick data from CoinMarketCap. The bot automatically extracts a set of **12 technical features** from the market (including RSI, MACD Histogram, distance to EMA20/EMA200, EMA20/EMA50 crossover, 3-candle price momentum, ATR-based volatility, Money Flow Index (MFI), OBV change, Bollinger Band spread, ADX trend strength, and volume spikes). Based on these features, the bot trains 3 local models: KNN (K-Nearest Neighbors), Logistic Regression, and Momentum. Each trading pair is trained and predicted independently using its own historical candles (e.g., predicting CAKE/USDT signals without relying directly on BTC price data). An Ensemble model then aggregates the predictions (using weighted voting based on recent win rates) to decide whether to trigger a Buy/Sell signal. This allows the bot to react in milliseconds without incurring continuous LLM API call costs.
- **LLM Quant Operator Layer**: Upon receiving a buy signal from the ML layer, the bot gathers structural market context (including wallet balance, active positions, Fear & Greed index from CMC, and X/Twitter sentiment score from the Grok API) and forwards it to the LLM (DeepSeek, Gemini, or OpenAI). While the local ML layer operates independently per token, the LLM Operator acts as a macro risk manager to:
  - Approve or veto the trade entry if market conditions are unfavorable (utilizing BTC Dominance and overall market trend to check if it is Altcoin season or a risk-off environment).
  - Scale up or down the risk multiplier.
  - Dynamically extend the Take Profit (TP) target for high-confidence setups, or tighten the Stop Loss (SL) to protect capital.
  - Monitor positions and make early exit decisions if it detects a trend reversal or negative news sentiment.

---

## 2. CoinMarketCap Integration as Data Oracle & Market Context Feed

The system integrates with the **CoinMarketCap REST API & Skill Hub (MCP)** to serve as the price and macro indicator oracle:
- **Real-Time Price Updates via Quotes API**: For on-chain trading on BSC, relying on Binance WebSockets is often unsuitable for smaller tokens or memecoins only traded on DEXs. The bot polls the CoinMarketCap Quotes API to retrieve the latest swap prices, constructing **synthetic candles** (OHLCV) locally to compute indicators.
- **Market Sentiment (Fear & Greed Index)**: The bot queries the real-time Fear & Greed index from CoinMarketCap to help the LLM adjust exit targets (e.g., extending TP during greed phases, or tightening SL during extreme fear).
- **Dominance & Macro Trend**: Key metrics such as BTC/ETH Dominance and the list of top gaining/trending tokens are fed into the LLM context to identify overall market regimes and optimize capital allocation.

---

## 3. Real-World On-Chain Spot Optimization

We prioritize real-world cost efficiency and slippage control when executing spot trades on-chain:

### 3.1. True Net PnL Calculation (Honest PnL)
Most trading bots only calculate returns based on theoretical buy and sell prices. On BSC, transaction gas fees, DEX swap fees, and slippage can heavily impact profits. Our system automatically computes the true Net PnL by comparing the actual USDT proceeds received after the sell swap against the initial margin spent, deducting gas fees incurred from both the buy and sell swaps. This ensures the bot operates with absolute cost awareness.

### 3.2. Automatic Break-Even TP Calibration
To guarantee that every Take Profit execution remains net-profitable after all transaction fees and slippage, the bot recalculates the break-even price immediately after the buy order fills. If the technical target TP is lower than the break-even threshold, the engine automatically adjusts the take profit price to the break-even point plus an additional volatility-based buffer (0.5x ATR).

---

## 4. Risk Management & Account Safety

To safeguard funds during autonomous trading, the bot implements several fail-safe guards:
- **Equity Protection**: The bot automatically halts all trading activities if the total account equity drops below a pre-configured minimum safety threshold to prevent further losses.
- **Daily Drawdown Limit**: Limits the maximum daily loss to a pre-defined percentage of the total portfolio value. Once hit, the bot closes all open positions and suspends entries until the next day to prevent trading in highly adverse conditions.
- **News Blackout Periods**: Integrates high-impact macroeconomic event schedules (such as CPI and FOMC releases), auto-pausing new trade entries before and after the announcement times to shield spot assets from extreme price spikes.
