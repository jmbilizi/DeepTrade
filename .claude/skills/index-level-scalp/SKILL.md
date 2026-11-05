---
name: index-level-scalp
description: Morning scalping strategy for broad index ETFs in same-day options. Trades the reaction at a key level, a rejection or a break that holds, with a close bank price scaled to ATR and a short time stop. Checked on every completed 5-minute bar from 09:50 to 11:30. Load when a trading agent needs entry, stop, target, and invalidation rules for index level scalps.
user-invocable: false
---

# Index level scalp

Terms are defined in trading-terms. Levels are defined in key-levels. This strategy takes short trades at key levels, in either direction. It banks a small gain at a close bank price and is done by late morning. Exits after the fill follow the bracket in trade-management.

## Evidence

This is a rule set with a replay test, not a proven edge. See `docs/research/replay-2026-11.md`.

- Replay: 20 sessions (2026-10-08 to 2026-11-04), SPY and QQQ, 1-minute bars, modeled option prices.
- With index-trend-scalp: about 7 trades a morning, 56% won, profit factor 1.42, 14 of 20 days green.
- Random entries with the same exits had a profit factor of 0.74.
- The same setups after 11:30 lost in every window tested.
- Option prices in the replay are modeled, not quoted. Review the live results after every 20 trades with trade-journal.

## Applies to

- The symbols in `ALLOWED_SYMBOLS` from the session context. An agent profile sets them. If none are given, do not run this strategy.
- Symbols with a same-day expiration today. Confirm it with `get_option_chains`.

## Data

- 5-minute bars, regular hours, today and the prior session: `get_equity_historicals`.
- `get_equity_technical_indicators`, 5-minute bars: VWAP and ATR(14). See intraday-technicals.
- 1-minute bars for the strategy stop.
- A fresh quote with bid and ask. Today's chain, and contract quotes with delta, open interest, and volume.

If any input is missing or stale, do not enter.

## Strategy checks

Run a strategy check on each completed 5-minute bar from the entry start to the entry cutoff.

| Window | Rule |
| --- | --- |
| Entry start | The bar that closes at 09:50, and not before `NO_NEW_ENTRIES_BEFORE`. Reason: ORH and ORL need the first 15 minutes. |
| Entry cutoff | The bar that closes at 11:30, or `NO_NEW_ENTRIES_AFTER` if that is earlier. Reason: in the replay every setup lost after 11:30. |

1. Update the level map (key-levels).
2. For each level, in the key-levels order, test setups R and T.
3. On the first signal, follow order-execution.

## Setups

These are the long setups. For bearish setups, mirror them: calls become puts, above becomes below, highs become lows. "Range" is the signal bar's high minus its low.

**R. Rejection.** Price tests a level and is pushed back.

1. The previous 5-minute bar closed above the level.
2. The signal bar's low is below the level.
3. The signal bar closes above the level.
4. The close is at least 0.4 × range above the signal bar's low.

Strategy stop: the signal bar's low minus 0.1 × ATR.

**T. Break and retest.** Price breaks a level, comes back to it, and holds.

1. The bar two bars before the signal bar closed below the level.
2. The previous bar closed above the level.
3. The signal bar's low is at or below the level plus 0.15 × ATR.
4. The signal bar closes above the level and above its own open.

Strategy stop: the lower of the signal bar's low and the level, minus 0.1 × ATR.

## Strategy stop, invalidation, and target

| Item | Rule |
| --- | --- |
| Strategy stop crossed | A completed 1-minute bar closes beyond the strategy stop. |
| Invalidation | The strategy stop crossed. Reason: the stop is at the signal bar's extreme, so it fires before a reversal can be confirmed. |
| Target | The bank price of the bracket (trade-management). There is no target on the underlying. |
| Bracket values | Bank price: `entry + delta × 0.8 × ATR`. Strategy premium stop: `entry − delta × 0.8 × ATR`. Time stop: 30 minutes after the fill. |

Use the delta from the entry quote and ATR(14, 5-minute) at the signal bar. Reason: an ATR-scaled bank price stays in reach when option prices are high. A fixed percent did not.

## Re-entry and flips

- A new signal needs a signal bar that closes after the exit.
- A signal in the other direction is a new trade with its own trade card.
- One position at a time across the allowed symbols.

## Two symbols

When more than one symbol signals on the same bar, use index-pair-read only to pick the instrument. Its "disagrees" rule and size tiers do not apply here. Reason: a rejection often goes against the witness, and the replay took those trades at full size.

## No-trade conditions

- Before the entry start, or after the entry cutoff.
- From 30 minutes before to 10 minutes after a scheduled high-impact release (FOMC decision, CPI, jobs report).
- A market holiday, or an early-close day. Reason: the replay did not include one.
- The daily loss limit or the daily profit target is reached.

## Instruments

Supports `option` only. Buy a call for a long setup and a put for a bearish setup: debit, single leg, today's expiration.

| Rule | Value |
| --- | --- |
| Strike | The strike walk in position-sizing. Stop stepping below delta 0.35. |
| Liquidity | Open interest ≥ 1,000 and today's volume ≥ 1,000. |
| Spread | Ask minus bid ≤ 5% of mid. |
| Entry | A limit at the mid, never above the ask. Cancel it if not filled in 1 minute. Do not chase. |
| Size | position-sizing. The premium stop is the tighter of the strategy premium stop and the loss ceiling. |

## What this strategy is bad at

- Strong trend days. Price runs through levels, and rejections fail one after another. The daily loss limit ends the day.
- Expensive premium. With implied volatility well above normal, the replay's edge shrank to break even.
- Costs. The replay charged 0.03 per contract per round trip. At 0.05 the profit factor fell from 1.42 to 1.25.
- Afternoons. Do not extend the window without a new replay.
- Every threshold is judgment, then checked in one replay of 20 sessions. That is a small sample.

## Trade card

Before the order: setup letter, level name and price, the signal bar's high, low, open, and close, ATR, entry, strategy stop, contract (delta, open interest, volume, spread, sellout), premium stop, bank price, size, and the loss at the premium stop. After: the exit name and the result in R.

## Example

Illustrative only: made-up symbol XYZ, made-up numbers.

10:15. XYZ ORH is 501.00. ATR(14, 5m) is 0.90. The 10:10 bar closed 501.30. The 10:15 bar has high 501.40, low 500.80, and close 501.25. Setup R long: the low pierced ORH, the close is back above, and 501.25 − 500.80 = 0.45 is at least 0.4 × 0.60.

- Strategy stop 500.80 − 0.09 = 500.71.
- The 502 call: mid 1.20, delta 0.45. Bank price 1.20 + 0.45 × 0.72 = 1.52. Strategy premium stop 1.20 − 0.32 = 0.88.
- Loss ceiling 25%: 0.90. That is tighter, so the premium stop is 0.90.
- Per-order cap 250: 2 contracts (240). Rest the bank order for both at 1.52.
