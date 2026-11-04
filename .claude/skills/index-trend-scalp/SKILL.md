---
name: index-trend-scalp
description: Intraday semi-scalping strategy for broad index ETFs, in same-day options or shares. Trades with the 5-minute trend on pullbacks that hold, flips on VWAP reclaims, and re-enters when the trend resumes. Checked on every completed 5-minute bar. Load when a trading agent needs entry, stop, target, invalidation, re-entry, and flip rules for short index trend trades.
user-invocable: false
---

# Index trend scalp

Terms are defined in trading-terms. This strategy takes short trades with the intraday trend. It banks profit early, re-enters when the trend resumes, and takes the other side when the trend turns. Exits after the fill follow trade-management.

## Evidence

This is a rule set, not a proven edge. No published test covers these entry, re-entry, or flip rules. Retail buyers of same-day index options lose on average, mostly to spreads and fees. Each extra round trip pays another spread, so the filters require a clear trend. Review the results after every 10 trades with trade-journal. Sources: `docs/research/index-0dte-trade-management.md`.

## Applies to

- The symbols in `DEEPTRADE_ALLOWED_SYMBOLS`. If it is unset, do not run this strategy, and tell the user it needs an explicit list.
- Confirm today's expiration for each symbol with `get_option_chains`.
- With more than one symbol, use index-pair-read to pick the instrument and the size tier.

## Data

- 1-minute and 5-minute bars, regular hours: `get_equity_historicals`.
- `get_equity_technical_indicators`, 5-minute bars: EMA(9), EMA(20), VWAP, supertrend(10, 3), ATR(14), ADX(14). 1-minute bars: EMA(9). See intraday-technicals.
- A fresh quote with bid and ask. For options: today's chain, and contract quotes with delta, open interest, and volume.

If any input is missing or stale, do not enter.

## Strategy checks

Run a strategy check on each completed 5-minute bar, from the entry start to the entry cutoff.

1. Read the trend state, chop flag, extension, and volatility shift for each symbol (intraday-technicals).
2. Test the filters. If one fails, stop here.
3. Test setups A and B.
4. On a signal, follow order-execution.

| Window | Rule |
| --- | --- |
| Entry start | `NO_NEW_ENTRIES_BEFORE`, after 3 completed 5-minute bars exist today. The filters decide whether the open is tradable. |
| Entry cutoff | The earlier of `NO_NEW_ENTRIES_AFTER` and 20 minutes before the contract's sellout. |

There is no other clock cutoff. Late in the day, trades get shorter (Late session).

## Filters

All must pass:

1. The chop flag is false.
2. No volatility shift on the signal bar.
3. Extension is within ±2.0 in the trade's direction.
4. index-pair-read does not say "disagrees".
5. No no-trade condition is active.

## Setups

These are the long setups. For bearish setups, mirror them: calls become puts, above becomes below, highs become lows.

**A. Pullback hold (continuation).**

1. The trend state is `up`.
2. In the last 3 completed 5-minute bars, a low came within 0.25 × ATR of the higher of EMA(20) and VWAP. No 5-minute bar closed below VWAP.
3. The signal bar closes above EMA(9) and above the previous bar's high.

Strategy stop: the pullback's lowest low minus 0.1 × ATR.

**B. VWAP reclaim (turn or flip).**

1. At least 2 of the last 6 completed 5-minute bars closed below VWAP.
2. The signal bar closes above VWAP and above the highest high of the 3 bars before it.
3. EMA(9) is above EMA(20) at the signal bar's close. The supertrend can still point down. Reason: it lags.

Strategy stop: the lowest low of the signal bar and the 3 bars before it, minus 0.1 × ATR.

**Both setups.** Skip the signal when the stop distance is under 0.3 × ATR or over 1.0 × ATR. Reason: under that, noise hits the stop; over that, the trade is not a scalp.

## Strategy stop, invalidation, and target

| Item | Rule |
| --- | --- |
| Strategy stop crossed | A completed 1-minute bar closes beyond the strategy stop. |
| Fast move | Any trade 0.5 × ATR beyond the strategy stop. Exit at once. |
| Invalidation, setup A | A 5-minute close below VWAP. |
| Invalidation, setup B | A 5-minute close back below VWAP. |
| Target | `entry + 2 × stop distance` on the underlying. If the session high is between `entry + 1 × stop distance` and that target, use the session high. Skip the signal if the reward-to-risk is then under 1.5. |

Every other exit is in trade-management. An invalidation is a reversal exit: it fires at any stage, in loss too.

## Re-entry and flips

The goal: bank the gain when the move pauses. Get back in when the trend resumes, or take the other side when it turns.

| After | Same direction | Other direction (flip) |
| --- | --- | --- |
| A profitable exit | A new setup A or B, signal bar closing after the exit. For setup A, the pullback forms after the exit. | Setup B in the other direction, on a later bar than the exit. |
| A losing exit | Wait 15 minutes. Then a new setup A or B. | Same as above. |

- Never re-enter or flip on the bar of the exit.
- One flip per symbol per hour.
- There is no fixed trade count. `MAX_ORDERS_PER_DAY` caps entries through the risk gate. A partial exit is not a new trade.
- After 2 losses in a row, pause entries for 30 minutes. After 4 losses in a day, stop for the day. The daily loss limit always applies.

## Late session

Less time left means a shorter trade, not a stop to trading. Reason: same-day options lose value fastest late in the day.

| Time to the contract's sellout | Target | Bank price | Time stop | Spread rule |
| --- | --- | --- | --- | --- |
| Over 120 minutes | `entry + 2 × stop distance` | `entry + 1 × R` | trade-management | 5% of mid |
| 60 to 120 minutes | `entry + 1.5 × stop distance` | `entry + 0.75 × R` | No new peak in 15 minutes | 5% of mid |
| Under 60 minutes | `entry + 1 × stop distance` | `entry + 0.5 × R` | No new peak in 10 minutes | 4% of mid |

Under 60 minutes, the giveback keeps 75% (trade-management stage 3). Skip a late entry when the target is under 0.3 × ATR away. Reason: the move cannot pay the spread.

## No-trade conditions

- Before the entry start, or after the entry cutoff.
- From 30 minutes before to 10 minutes after a scheduled high-impact release (FOMC decision, CPI, jobs report). On an FOMC decision day, no entries after 13:30.
- A market holiday. On an early-close day, use the moved times from the session context. The sellout times already reflect the early close.
- The daily loss limit or the loss-streak limit is reached.

## Instruments

Supports `option` and `equity`. Use the first class in `ALLOWED_ASSET_CLASSES` that the account can trade.

**Option.** Buy a call for a long setup and a put for a bearish setup: debit, single leg, today's expiration.

| Rule | Value |
| --- | --- |
| Strike | The strike walk in index-intraday-momentum ("Choosing the strike"). Stop stepping below delta 0.35. Reason: a scalp needs delta. |
| Liquidity | Open interest ≥ 1,000 and today's volume ≥ 1,000. |
| Spread | Ask minus bid ≤ 5% of mid (Late session can tighten it). |
| Entry | A limit at the mid, never above the ask. Cancel it if not filled in 2 minutes. Do not chase. |
| Strategy premium stop | `premium − 1.5 × delta × stop distance`, but not above `0.7 × premium`. Reason: premium noise right after entry. position-sizing then applies the loss ceiling. |
| Size | position-sizing, then the index-pair-read tier. |

**Equity.** Shares, sized by position-sizing. Shorts only if `ALLOW_SHORTS` is true.

## What this strategy is bad at

- Chop. The chop flag removes some of it. Midday (11:30 to 13:30) fails most.
- Costs. A 0.02 spread on a 1.00 contract is 2% per round trip. Four round trips cost about 8% of the premium traded.
- V-shaped reversals. The stop fires, then the price returns. Re-entry recovers some of it, at another spread.
- News bars. The volatility-shift filter blocks the bar, not the move after it.
- Every threshold here is judgment, not fitted. Review them against the journal.

## Trade card

Before the order: setup letter, trend state, chop flag inputs, extension, ATR, pair-read scores and tier, entry, stop distance, strategy stop, target, contract (delta, open interest, volume, spread, sellout), premium stop, R, bank price, size, and the loss at the premium stop. After: each stage change, the exit name, the result in R, and for a re-entry, the trade it follows.

## Example

Illustrative only: made-up symbol XYZ, made-up numbers.

10:40. XYZ trend state up, ATR(14, 5m) 0.80, VWAP 500.20, EMA(20) 500.35. The 10:30 bar's low was 500.42, within 0.20 of EMA(20). The 10:35 bar closes 501.10, above EMA(9) 500.80 and the prior high 500.95. Setup A long.

- Strategy stop 500.42 − 0.08 = 500.34. Stop distance 0.76 (0.95 ATR, inside the range). Target 502.62.
- The 501 call: mid 1.20, delta 0.50. Strategy premium stop 1.20 − 1.5 × 0.50 × 0.76 = 0.63, under the 0.84 limit, so 0.63.
- Loss ceiling 25%: 0.90. That is tighter, so the premium stop is 0.90. R = 0.30. Bank price 1.50.
- Per-order cap 200: 1 contract (2 would cost 240).
