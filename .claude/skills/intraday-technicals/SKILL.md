---
name: intraday-technicals
description: How a trading agent reads the intraday tape with broker-computed indicators. Which indicators to request on which bar sizes (EMA, VWAP, supertrend, ATR, ADX, RSI), how to turn them into a trend state, a chop flag, an extension measure, and a volatility-shift flag, plus the time-of-day regimes. Load when a strategy or the trade-management skill needs a trend or chop read, or when the user asks for technical analysis.
user-invocable: false
---

# Intraday technicals

Indicators describe what price has done. They are inputs to a strategy's rules, never a reason to trade on their own. CLAUDE.md rule 2 still applies: every order needs a rule in an enabled strategy skill.

## Getting the data

Use `get_equity_technical_indicators` (one call per indicator type, all symbols in one call, `output: "last:N"`), and `get_equity_historicals` for raw bars. `interval` is required. Request `bounds: "regular"`. Set `start_time` early enough to warm up the indicator. For 1-minute and 5-minute bars, start at the previous session's last hour. Reason: EMA(20) needs 20 bars before its first good value.

| Read | Call | Bars |
| --- | --- | --- |
| Fast trend | `ema`, `period: 9` and `period: 20` | `minute`, `5minute` |
| Session anchor | `vwap` | `5minute` |
| Trend regime | `supertrend`, `period: 10`, `multiplier: 3` | `5minute` |
| Volatility unit | `atr`, `period: 14` | `5minute` |
| Trend strength | `adx`, `period: 14` | `5minute` |
| Stretch | `rsi`, `period: 14` | `5minute` |

Supertrend returns `value` and `direction` per bar: `1` is up, `-1` is down (observed 2026-11-03). Bar times are left-edge labeled in UTC: the bar `begins_at` 14:55 ET closes at 15:00 ET.

Check that the newest value's bar time matches the latest completed bar. Ignore bars marked `interpolated`. If a value is missing or stale, treat that read as unknown, not as neutral.

`get_legend_*` tools change the user's Robinhood charts. Use them only when the user asks to see something on their chart. `create_alert` sends the user a phone notification. Ask the user first. Alerts fire on 5-minute bars at best, so they are not faster than your own checks.

## Derived reads

Compute these on the latest completed 5-minute bar unless a rule says 1-minute.

**Trend state** (for each symbol):

```text
up    = close > VWAP and EMA9 > EMA20 and supertrend direction is up
down  = close < VWAP and EMA9 < EMA20 and supertrend direction is down
mixed = anything else
```

**Chop flag**: true when either of these holds over the last 60 minutes:
- price crossed VWAP 4 or more times (count 5-minute closes on alternating sides), or
- the 60-minute high-low range is under 1.5 × ATR(14, 5-minute).

ADX(14) is reported, not part of the flag. Reason: it lags. On 2026-11-03, 5-minute ADX stayed under 20 for both index ETFs from noon to the close. That included the afternoon's clean 3-point drop. ADX rose only after it. Use ADX above 25 as supporting context for a trend, never as a block.

**Extension**: `(close - VWAP) / ATR(14, 5-minute)`. Beyond ±2 is stretched; entries in that direction chase.

**Volatility shift**: the latest 5-minute bar's true range is above 2.5 × ATR(14, 5-minute), or 3 of the last 4 bars are above 1.5 × ATR. That is news or a regime change. Do not open a position in the bar where it fires. Tell the user in one line and re-read on the next completed bar.

**Swing points**: on 5-minute bars, a swing low is a bar whose low is below the lows of the two bars on each side. Higher lows and higher highs = up structure. A 5-minute close below the last swing low in an up structure is a structure break.

**Divergence (weak)**: price makes a new session high while RSI(14, 5-minute) makes a lower high than at the prior session high. Treat it only as a reason to tighten, never to enter.

## Time-of-day regimes

Market time, regular hours. These are tendencies, not rules by themselves. A tendency is never a reason to enter; it only says which enabled setup fits the window.

| Window | Tendency | Use |
| --- | --- | --- |
| 09:30 to 10:00 | Highest volatility, widest option spreads | Most strategies wait. Read the opening drive direction |
| 10:00 to 10:30 | Early moves tend to reverse. On 178 sessions of SPY and QQQ (2026-02 to 2026-11), every trend read here pointed the wrong way for the next hour (t −3 to −4) | Prefer rejections at key levels. Do not chase the opening drive |
| 10:30 to 11:30 | Moves tend to continue (the trend state leaned right for the next hour, t 2.3) | Main window for trend entries |
| 11:30 to 13:30 | Lowest volume and volatility; chop is common | Require the chop flag false for new entries |
| 13:30 to 15:00 | Afternoon trends start; same-day option decay speeds up | Entries only with a clean trend state |
| Last 30 to 60 min | Momentum tends to continue the day's direction (Gao et al. 2018; Baltussen et al. 2021, on futures) | Same-day options are near the broker's sellout. Whether to open is the strategy's call (the index scalps stop at 11:30); spreads widen |

## Reporting

One line per symbol per check, for example (illustrative values): `XYZ up, ext +0.8, chop no, ADX 27, vol normal`. Put the full numbers in the journal only when they decide an action.

## What this is bad at

- Every read here lags. On a same-day option, the premium can spike and fall back inside one 5-minute bar.
- Thresholds (4 VWAP crosses, 1.5 and 2.5 × ATR) are conventions, not fitted values. They are untested on this account's trades.
- More indicators do not add independent information. The trend-state rule already uses three that mostly agree.
