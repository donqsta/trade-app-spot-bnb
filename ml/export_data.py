"""
Pull Binance candles -> compute the same 10-d feature vector the Node engine
uses -> label by forward return -> dump to CSV under ./data.

Keep this file's feature math IDENTICAL to src/lib/ai-engine.ts:extractFeatures.
If you change one, change both — otherwise training/inference will disagree.
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import requests


SPOT = "https://api.binance.com/api/v3/klines"


def fetch_klines(pair: str, interval: str, limit: int) -> pd.DataFrame:
    """Pull up to `limit` candles in pages of 1000 (Binance's max per call)."""
    out = []
    end_time = None
    remaining = limit
    while remaining > 0:
        page = min(1000, remaining)
        params = {"symbol": pair.upper(), "interval": interval, "limit": page}
        if end_time:
            params["endTime"] = end_time
        r = requests.get(SPOT, params=params, timeout=20)
        r.raise_for_status()
        rows = r.json()
        if not rows:
            break
        out = rows + out
        end_time = rows[0][0] - 1
        remaining -= len(rows)
        if len(rows) < page:
            break
    df = pd.DataFrame(out, columns=[
        "openTime", "open", "high", "low", "close", "volume",
        "closeTime", "qav", "trades", "tb_base", "tb_quote", "ignore"
    ])
    for c in ("open", "high", "low", "close", "volume"):
        df[c] = df[c].astype(float)
    df["openTime"] = df["openTime"].astype("int64")
    return df.reset_index(drop=True)


def ema(s: pd.Series, period: int) -> pd.Series:
    return s.ewm(span=period, adjust=False).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    up = delta.clip(lower=0).rolling(period).mean()
    down = (-delta.clip(upper=0)).rolling(period).mean()
    rs = up / down.replace(0, np.nan)
    return 100 - 100 / (1 + rs)


def macd_hist(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.Series:
    macd_line = ema(close, fast) - ema(close, slow)
    sig = ema(macd_line, signal)
    return macd_line - sig


def atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([
        high - low,
        (high - prev_close).abs(),
        (low - prev_close).abs()
    ], axis=1).max(axis=1)
    return tr.rolling(period).mean()


def obv(close: pd.Series, volume: pd.Series) -> pd.Series:
    direction = np.sign(close.diff().fillna(0))
    return (direction * volume).cumsum()


def mfi(high: pd.Series, low: pd.Series, close: pd.Series, volume: pd.Series, period: int = 14) -> pd.Series:
    typical = (high + low + close) / 3
    raw_mf = typical * volume
    positive = pd.Series(np.where(typical.diff() > 0, raw_mf, 0.0), index=close.index)
    negative = pd.Series(np.where(typical.diff() < 0, raw_mf, 0.0), index=close.index)
    pos_sum = positive.rolling(period).sum()
    neg_sum = negative.rolling(period).sum()
    mr = pos_sum / neg_sum.replace(0, np.nan)
    return 100 - 100 / (1 + mr)


def bb_width(close: pd.Series, period: int = 20, k: float = 2.0) -> pd.Series:
    ma = close.rolling(period).mean()
    sd = close.rolling(period).std()
    return ((ma + k * sd) - (ma - k * sd)) / ma


def adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    highs = high.values
    lows = low.values
    closes = close.values
    length = len(closes)
    
    if length < period * 2:
        return pd.Series([np.nan] * length, index=close.index)
        
    tr = []
    dmPlus = []
    dmMinus = []
    
    for i in range(1, length):
        h = highs[i]
        l = lows[i]
        prevClose = closes[i - 1]
        prevHigh = highs[i - 1]
        prevLow = lows[i - 1]
        
        trVal = max(h - l, abs(h - prevClose), abs(l - prevClose))
        tr.append(trVal)
        
        upMove = h - prevHigh
        downMove = prevLow - l
        
        dmp = 0.0
        dmm = 0.0
        if upMove > downMove and upMove > 0:
            dmp = upMove
        if downMove > upMove and downMove > 0:
            dmm = downMove
            
        dmPlus.append(dmp)
        dmMinus.append(dmm)
        
    smoothedTR = []
    smoothedDMPlus = []
    smoothedDMMinus = []
    
    trSum = sum(tr[:period])
    dmPlusSum = sum(dmPlus[:period])
    dmMinusSum = sum(dmMinus[:period])
    
    smoothedTR.append(trSum)
    smoothedDMPlus.append(dmPlusSum)
    smoothedDMMinus.append(dmMinusSum)
    
    for i in range(period, len(tr)):
        prevTR = smoothedTR[-1]
        prevDMPlus = smoothedDMPlus[-1]
        prevDMMinus = smoothedDMMinus[-1]
        
        smoothedTR.append(prevTR - prevTR / period + tr[i])
        smoothedDMPlus.append(prevDMPlus - prevDMPlus / period + dmPlus[i])
        smoothedDMMinus.append(prevDMMinus - prevDMMinus / period + dmMinus[i])
        
    dx = []
    for i in range(len(smoothedTR)):
        strVal = smoothedTR[i]
        sPlus = smoothedDMPlus[i]
        sMinus = smoothedDMMinus[i]
        
        if strVal == 0:
            dx.append(0.0)
            continue
            
        plusDI = 100.0 * (sPlus / strVal)
        minusDI = 100.0 * (sMinus / strVal)
        diff = abs(plusDI - minusDI)
        total = plusDI + minusDI
        
        dx.append(0.0 if total == 0 else 100.0 * (diff / total))
        
    adxValues = [np.nan] * (2 * period - 1)
    dxSum = sum(dx[:period])
    currentADX = dxSum / period
    adxValues.append(currentADX)
    
    for i in range(period, len(dx)):
        currentADX = (currentADX * (period - 1) + dx[i]) / period
        adxValues.append(currentADX)
        
    return pd.Series(adxValues, index=close.index)


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    c, h, l, v = df["close"], df["high"], df["low"], df["volume"]

    f = pd.DataFrame(index=df.index)
    f["price"] = c
    f["atr"] = atr(h, l, c, 14)

    rsi_v = rsi(c, 14)
    macd_v = macd_hist(c)
    e20, e50, e200 = ema(c, 20), ema(c, 50), ema(c, 200)
    obv_v = obv(c, v)
    obv_ema20 = ema(obv_v, 20)
    bb = bb_width(c, 20, 2.0)
    mfi_v = mfi(h, l, c, v, 14)
    adx_v = adx(h, l, c, 14)
    vol_ema20 = ema(v, 20)

    f["f_rsi"] = rsi_v / 100
    f["f_macd"] = macd_v / c
    f["f_ema20Dist"] = (c - e20) / c
    f["f_emaCross"] = (e20 - e50) / e50
    f["f_momentum"] = (c - c.shift(3)) / c.shift(3)
    f["f_volatility"] = f["atr"] / c
    f["f_ema200Dist"] = (c - e200) / c
    f["f_mfi"] = mfi_v / 100
    f["f_obvChange"] = (obv_v - obv_ema20) / obv_ema20.abs().replace(0, np.nan)
    f["f_bbSpread"] = bb
    f["f_adx"] = adx_v / 100
    f["f_volChange"] = (v - vol_ema20) / vol_ema20

    return f.dropna()


def label_triple_barrier(
    df_feat: pd.DataFrame,
    df_raw: pd.DataFrame,
    forward: int = 10,
    tp_atr_mult: float = 2.0,
    sl_atr_mult: float = 1.0,
) -> pd.Series:
    """Triple-barrier labeling (López de Prado).

    For each row, walk forward `forward` candles and ask:
      - did the upper barrier (price + tp_atr_mult*ATR) get touched first? -> +1
      - did the lower barrier (price - sl_atr_mult*ATR) get touched first? -> -1
      - neither within horizon -> 0

    Uses intrabar high/low so barriers can be touched within a candle, matching
    how a real TP/SL order would fill. This produces labels that answer the
    EXACT question the trading engine will execute on at inference time.
    """
    high = df_raw["high"].values
    low = df_raw["low"].values
    close = df_raw["close"].values
    atr_values = df_feat["atr"].values
    labels = []
    for k, idx in enumerate(df_feat.index):
        start = idx
        end = min(idx + forward, len(close) - 1)
        if start >= len(close) - 1 or not np.isfinite(atr_values[k]) or atr_values[k] <= 0:
            labels.append(0)
            continue
        base = close[start]
        upper = base + tp_atr_mult * atr_values[k]
        lower = base - sl_atr_mult * atr_values[k]
        label = 0
        for j in range(start + 1, end + 1):
            tp_hit = high[j] >= upper
            sl_hit = low[j] <= lower
            if tp_hit and sl_hit:
                # Conservative: if both barriers touched in the same candle,
                # treat as HOLD (0) for Spot Long-Only since we do not short.
                label = 0
                break
            if tp_hit:
                label = 1
                break
            if sl_hit:
                label = 0
                break
        labels.append(label)
    return pd.Series(labels, index=df_feat.index, name="label")


# Backwards-compatible wrapper. Old callers still work but new pipelines should
# call label_triple_barrier directly.
def label_forward(df_feat: pd.DataFrame, df_raw: pd.DataFrame, forward: int = 10, **kw) -> pd.Series:
    tp = kw.get("tp_atr_mult", 2.0)
    sl = kw.get("sl_atr_mult", 1.0)
    return label_triple_barrier(df_feat, df_raw, forward=forward, tp_atr_mult=tp, sl_atr_mult=sl)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pair", required=True)
    ap.add_argument("--interval", default="15m")
    ap.add_argument("--limit", type=int, default=1500)
    ap.add_argument("--out", default=None)
    ap.add_argument("--horizon", type=int, default=10,
                    help="Triple-barrier time horizon in candles")
    ap.add_argument("--tp-atr", type=float, default=1.5,
                    help="Upper barrier = price + tp_atr * ATR14")
    ap.add_argument("--sl-atr", type=float, default=1.5,
                    help="Lower barrier = price - sl_atr * ATR14")
    args = ap.parse_args()

    raw = fetch_klines(args.pair, args.interval, args.limit)
    print(f"Fetched {len(raw)} candles for {args.pair} {args.interval}")

    feat = build_features(raw)
    label = label_triple_barrier(
        feat, raw,
        forward=args.horizon,
        tp_atr_mult=args.tp_atr,
        sl_atr_mult=args.sl_atr,
    )
    feat = feat.join(label).dropna()

    out_dir = Path(args.out or "data")
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{args.pair}_{args.interval}.csv"
    feat.to_csv(out_path, index=False)
    print(f"Saved -> {out_path}  ({len(feat)} labeled rows)")


if __name__ == "__main__":
    sys.exit(main())
