# Implementation Plan - Smarter Dynamic Stop Loss (SL) and Take Profit (TP) with LLM

Improve the trading engine's profitability by making SL/TP calculations adaptive, resolving conflicts in the execution loop, and empowering the LLM Quant Operator to dynamically manage open positions in real-time.

## User Review Required

### 1. Phân Tích: Có nên dời SL về hòa vốn (100% risk reduction) ngay khi lãi đạt 30%?
> [!WARNING]
> **Rủi ro quét lệnh hòa vốn (Wick-outs/Shake-outs)**:
> Trong giao dịch tiền điện tử (BTC, ETH, SOL, BNB, DOGE), giá biến động cực kỳ mạnh. 
> - Nếu dời SL về Entry ngay khi lãi mới đạt 30% mục tiêu, vị thế của bạn sẽ bị quét dừng hòa vốn rất thường xuyên bởi các nhịp điều chỉnh nhỏ (pullbacks) trước khi giá có thể tiếp tục tăng chạm tới TP.
> - Việc giảm 50% rủi ro ở 30% tiến trình (Tier 0) và chỉ khóa hòa vốn hoàn toàn ở 50% tiến trình (Tier 1) là một điểm cân bằng tối ưu hơn để bảo vệ tài khoản mà vẫn cho lệnh "không gian thở".
> - **Giải pháp đề xuất**: Chúng tôi sẽ giữ cấu hình mặc định (30% -> giảm 50% risk, 50% -> dời về Entry). Tuy nhiên, chúng tôi sẽ thêm cấu hình `riskReduction30ToEntry` (mặc định là `false`) vào cài đặt để bạn có thể bật/tắt hành vi này linh hoạt.

### 2. Sử dụng LLM để quản lý chốt lời/cắt lỗ động cho từng vị thế mở
> [!IMPORTANT]
> **Nâng cấp LLM Quant Operator quản lý vị thế chủ động**:
> Hiện tại LLM chỉ điều chỉnh tham số cho lệnh mới (scale SL/TP). Chúng tôi đề xuất mở rộng schema đầu ra của LLM để cho phép nó trực tiếp can thiệp vào các vị thế đang chạy mỗi 30 giây:
> - **EXIT**: Đóng vị thế khẩn cấp hoặc đóng non khi phát hiện rủi ro đảo chiều sớm trên nến nhỏ.
> - **TIGHTEN_SL**: Chủ động thu hẹp Stop Loss của vị thế để khóa thêm lãi hoặc giảm rủi ro khi thị trường biến động xấu.
> - **EXTEND_TP**: Chủ động nới rộng TP khi thấy lực mua/bán tăng vọt (xu hướng cực mạnh).
> - **MOVE_TO_ENTRY**: Ép buộc dời SL về Entry sớm nếu phát hiện dấu hiệu cạn kiệt lực xu hướng.

---

## Open Questions

> [!NOTE]
> None. We will implement these upgrades in a fully backward-compatible way.

---

## Proposed Changes

We will modify the core bot code in [bot-engine.ts](file:///e:/cursor/projects-source/trade-app/src/lib/bot-engine.ts) and the LLM structures in [market-context.ts](file:///e:/cursor/projects-source/trade-app/src/lib/market-context.ts).

### 1. LLM Context and Decision Schema Upgrades

#### [MODIFY] [market-context.ts](file:///e:/cursor/projects-source/trade-app/src/lib/market-context.ts)
- Extend `QuantOperatorDecision` interface to support dynamic active position controls:
  ```typescript
  export interface PositionAdjustment {
      symbol: string;
      action: 'HOLD' | 'EXIT' | 'TIGHTEN_SL' | 'EXTEND_TP' | 'MOVE_TO_ENTRY';
      reason: string;
      customSlPrice?: number; // Price suggested by LLM
      customTpPrice?: number; // Price suggested by LLM
  }
  
  export interface QuantOperatorDecision {
      // ... existing fields ...
      positionAdjustments?: PositionAdjustment[];
  }
  ```
- Update `QUANT_OPERATOR_SYSTEM_PROMPT` to guide the LLM on how and when to fill the `positionAdjustments` array. Guide it to tighten SL on specific open trades or exit early when market indicators look weak, or extend TP when momentum is high.

### 2. Live Bot Execution Updates

#### [MODIFY] [bot-engine.ts](file:///e:/cursor/projects-source/trade-app/src/lib/bot-engine.ts)
- **Implement `riskReduction30ToEntry` setting**:
  - Add property `public riskReduction30ToEntry = false;` (configurable via API and state-persistence).
  - In `updatePositionsLivePnL`, if `riskReduction30ToEntry` is true, Tier 0 will move SL directly to `entryPrice` instead of 50% risk.
- **Support LLM Active Position Actions**:
  - In `tryLlmDecision`, validate and parse the new `positionAdjustments` field returned by the LLM.
  - In `runQuantOperator`, after receiving a valid LLM decision:
    - Loop through `positionAdjustments` suggestions.
    - If `EXIT` -> call position close sequence (`market close` + cancel resting SL).
    - If `TIGHTEN_SL` or `MOVE_TO_ENTRY` -> update position's `sl` price and sync to Binance via `updateBinanceStopLoss`.
    - If `EXTEND_TP` -> update position's `tp` price.
- **Swing High/Low Support & Resistance Protection**:
  - Add `calculateSwingPrice(symbol, type, lookback)`: returns highest high or lowest low.
  - Use it when opening trades to set protective SL behind swing levels, clamped to max `2.5 * ATR`.
- **Resolve Partial TP / Trailing Stop Conflict**:
  - Hold back Trailing Tier 4 (100% progress check) if the trade is not yet partially closed.
  - Let Partial TP trigger first at 100% progress: close 50%, set `partialClosed = true`, set SL to Entry, and set TP to TP2 (`entry + direction * originalTargetPriceDiff * 2.0`).
  - Introduce new trailing tiers (Tier 4 at 125%, Tier 5 at 150%, Tier 6 at 175%) once `partialClosed` is true.

### 3. Backtest Synchronization

#### [MODIFY] [bot-engine.ts](file:///e:/cursor/projects-source/trade-app/src/lib/bot-engine.ts)
- Update the simulation loop in `runBacktest` to use the same logic:
  - Dynamic SL based on swing highs/lows.
  - The parameter `riskReduction30ToEntry`.
  - The conflict-resolved Partial TP and trailing tiers.
- Note: Fast backtest is synchronous and won't make LLM calls per step, but implementing the rules guarantees no train/serve skew for the base indicators.

---

## Verification Plan

### Automated Tests
- Run backtests via Web UI or endpoint `POST /api/bot/backtest` to verify that the core adjustments build and execute without errors.
- Confirm stats like Profit Factor and Drawdown to measure strategy improvements.

### Manual Verification
- Launch the bot in simulated mode. Enable the LLM Quant Operator.
- Watch logs when a trade is open: verify if the LLM output shows `positionAdjustments` and see if the bot successfully applies it to the active position.
