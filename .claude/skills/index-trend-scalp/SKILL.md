---
name: index-trend-scalp
description: Morning semi-scalping strategy for broad index ETFs, in same-day options or shares. Trades with the 5-minute trend on pullbacks that hold, flips on VWAP reclaims, and re-enters when the trend resumes. Checked on every completed 5-minute bar to 11:30. Load when a trading agent needs entry, stop, target, invalidation, re-entry, and flip rules for short index trend trades.
user-invocable: false
---

# Index trend scalp

Terms are defined in trading-terms. This strategy takes short trades with the intraday trend. It banks profit early, re-enters when the trend resumes, and takes the other side when the trend turns. Option exits after the fill follow the bracket in trade-management. Share exits follow the ladder.

## Evidence

This is a rule set, not a proven edge. No published test covers these entry, re-entry, or flip rules. Retail buyers of same-day index options lose on average, mostly to spreads and fees. Each extra round trip pays another spread, so the filters require a clear trend. Review the results after every 10 trades with trade-journal. Sources: `docs/research/index-0dte-trade-management.md`.

Replay, 20 sessions to 2026-11-04 (`docs/research/replay-2026-11.md`): before 11:30, 24 trades, profit factor 1.22. All day, the same rules lost. The old pullback-low stop allowed 7 trades in 20 sessions.

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
| Entry cutoff | The bar that closes at 11:30, or `NO_NEW_ENTRIES_AFTER` if that is earlier. Reason: in the replay every setup lost after 11:30. |

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

Strategy stop: the signal bar's low minus 0.1 × ATR. Reason: on 2026-11-04 the pullback low put the stop over 1.0 × ATR away on every signal.

**B. VWAP reclaim (turn or flip).**

1. At least 2 of the last 6 completed 5-minute bars closed below VWAP.
2. The signal bar closes above VWAP and above the highest high of the 3 bars before it.
3. EMA(9) is above EMA(20) at the signal bar's close. The supertrend can still point down. Reason: it lags.

Strategy stop: the signal bar's low minus 0.1 × ATR.

**Both setups.** Skip the signal when the stop distance is under 0.3 × ATR or over 1.0 × ATR. Reason: under that, noise hits the stop; over that, the trade is not a scalp.

## Strategy stop, invalidation, and target

| Item | Rule |
| --- | --- |
| Strategy stop crossed | A completed 1-minute bar closes beyond the strategy stop. |
| Fast move | Any trade 0.5 × ATR beyond the strategy stop. Exit at once. |
| Invalidation, setup A | A 5-minute close below VWAP. |
| Invalidation, setup B | A 5-minute close back below VWAP. |
| Target, options | The bank price of the bracket (trade-management). There is no target on the underlying. |
| Bracket values | Bank price: `entry + delta × 0.8 × ATR`. Strategy premium stop: `entry − delta × 0.8 × ATR`. Time stop: 30 minutes after the fill. |
| Target, shares | `entry + 2 × stop distance` on the underlying. |

For options, the bracket's exits replace the invalidation rows. For shares, an invalidation is a reversal exit: it fires at any stage, in loss too.

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
| Strike | The strike walk in position-sizing. Stop stepping below delta 0.35. Reason: a scalp needs delta. |
| Liquidity | Open interest ≥ 1,000 and today's volume ≥ 1,000. |
| Spread | Ask minus bid ≤ 5% of mid. |
| Entry | A limit at the mid, never above the ask. Cancel it if not filled in 1 minute. Do not chase. |
| Strategy premium stop | The bracket value above. Then position-sizing applies the loss ceiling. The strategy stop on the underlying still applies. |
| Size | position-sizing, then the index-pair-read tier. |

**Equity.** Shares, sized by position-sizing. Shorts only if `ALLOW_SHORTS` is true.

## What this strategy is bad at

- Chop. The chop flag removes some of it.
- Afternoons. The replay lost in every window after 11:30. Do not extend the window without a new replay.
- Few trades. About 1 a morning. index-level-scalp adds most of the trades.
- Costs. A 0.02 spread on a 1.00 contract is 2% per round trip. Four round trips cost about 8% of the premium traded.
- V-shaped reversals. The stop fires, then the price returns. Re-entry recovers some of it, at another spread.
- News bars. The volatility-shift filter blocks the bar, not the move after it.
- Every threshold here is judgment, not fitted. Review them against the journal.

## Trade card

Before the order: setup letter, trend state, chop flag inputs, extension, ATR, pair-read scores and tier, entry, stop distance, strategy stop, contract (delta, open interest, volume, spread, sellout), premium stop, R, bank price, size, and the loss at the premium stop. After: each stage change, the exit name, the result in R, and for a re-entry, the trade it follows.

## Example

Illustrative only: made-up symbol XYZ, made-up numbers.

10:40. XYZ trend state up, ATR(14, 5m) 0.80, VWAP 500.20, EMA(20) 500.35. The 10:30 bar's low was 500.42, within 0.20 of EMA(20). The 10:35 bar closes 501.10, above EMA(9) 500.80 and the prior high 500.95. Setup A long.

- Strategy stop: the signal bar's low 500.62 − 0.08 = 500.54. Stop distance 0.56 (0.7 ATR, inside the range).
- The 501 call: mid 1.20, delta 0.50. Bank price 1.20 + 0.50 × 0.64 = 1.52. Strategy premium stop 1.20 − 0.32 = 0.88.
- Loss ceiling 25%: 0.90. That is tighter, so the premium stop is 0.90.
- Per-order cap 250: 2 contracts (240). Rest the bank order for both at 1.52.
