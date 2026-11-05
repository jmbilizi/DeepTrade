---
name: index-intraday-momentum
description: Intraday strategy for broad index ETFs with same-day option expirations. Trades breaks of a volatility-scaled "noise area" around the day's open, checked on the hour and half hour, with VWAP as a trailing stop and a hard flat time. Load when a trading agent needs entry, stop, target, and invalidation rules for index intraday momentum, in shares or same-day options.
user-invocable: false
---

# Index intraday momentum (noise area)

Adapted from Zarattini, Aziz, and Barbon, "Beat the Market: An Effective Intraday Momentum Strategy for S&P500 ETF (SPY)" (Swiss Finance Institute Research Paper 24-97, 2024). The paper trades shares. This skill also allows same-day options, which the paper did not test. The paper's reported results are the authors' own, after costs, on shares. They have not been independently replicated here, and they say nothing about option returns. Treat this as a rule set, not an edge.

## Idea

On most days an index ETF wanders inside a band around its open whose width is predictable from recent days. A move outside that band at a fixed check time is taken as the start of a trend for the rest of the session. The position rides with VWAP as a trailing stop and is flat before the close.

## Applies to

Broad index ETFs whose option chains list a same-day expiration every trading day. The symbols are `ALLOWED_SYMBOLS` from the session context; an agent profile can set them. If none are given, do not run this strategy. Before the first check, confirm with `get_option_chains` that today is among each symbol's expiration dates. A symbol without a same-day expiration can still be traded in shares if `equity` is allowed; otherwise drop it for the session and say so.

## Data this strategy needs

- Today's regular-session open and the prior session close: `get_equity_quotes` (`adjusted_previous_close`) and the first 5-minute bar of `get_equity_historicals`.
- 30-minute bars for the last 14 complete sessions: `get_equity_historicals` with `interval: 30minute`, `bounds: regular`. About 182 bars per symbol.
- Session VWAP: `get_equity_technical_indicators` with `type: vwap`, `interval: 5minute`.
- A fresh quote with bid and ask.
- For options: today's expiration from `get_option_chains`, contracts from `get_option_instruments`, and bid, ask, delta, open interest, and volume from `get_option_quotes`.

Ignore bars marked `interpolated`. If any of this is missing or stale, do not trade this strategy and tell the user.

## The noise area

Compute once per check time `t`, where `t` is a half-hour mark (10:00, 10:30, ... through the entry cutoff, America/New_York).

```text
for each of the last 14 sessions d:
    move_d(t) = abs( close of the 30-minute bar ending at t on day d / open of day d - 1 )
sigma(t)  = mean of move_d(t) over the 14 sessions

upper(t)  = max(open_today, prev_close) * (1 + sigma(t))
lower(t)  = min(open_today, prev_close) * (1 - sigma(t))
```

The `max` and `min` with the prior close widen the band on the gap side, as in the paper. Reason: a gap alone is not a break.

## Parameters

| Parameter | Default | Notes |
| --- | --- | --- |
| Check times | :00 and :30, from 10:00 to the entry cutoff | Act only on these. Between them, manage only |
| Lookback | 14 sessions | |
| Entry window | 10:00 to the entry cutoff: the earlier of `NO_NEW_ENTRIES_AFTER` and 20 minutes before the contract's sellout | No other clock cutoff |
| Max entries per symbol per day | 2 | Stops churn on two-way days |
| Max open positions from this strategy | 1 | Index ETFs move together; one exposure at a time |
| Target (underlying) | Boundary ± 1 × sigma(t) × open | Not from the paper, which has no target; required by CLAUDE.md. 2 × sigma proved out of reach on 2026-11-03 (needed more than the day's whole range) |
| Decision price | Close of the latest completed 5-minute bar at the check | Not the last trade. On 2026-11-03 the two disagreed at 14:00 by 0.01 |

## Entry rules

**Long** (shares or calls), at a check time `t`:

1. The decision price is above `upper(t)`.
2. The decision price is above session VWAP.
3. No position in this strategy is open, and the per-symbol entry count is under the limit.
4. No no-trade condition is active.

**Bearish** (puts, or short shares only if `DEEPTRADE_ALLOW_SHORTS` is true): mirror below `lower(t)` and below VWAP.

Enter with a limit order (see Instruments). If it does not fill before the next check time, cancel it. Do not chase.

## Stop, target, and exit

Measured on the underlying, whatever the instrument.

- **Initial stop (long):** `max(upper(t), VWAP)` at entry. **Bearish:** `min(lower(t), VWAP)`.
- **Trailing:** at each later check time, recompute the boundary and VWAP. The stop moves to `max(upper, VWAP)` for longs, `min(lower, VWAP)` for bearish positions, **only if that is in the position's favor**. Never widen.
- **Options: profit protection.** For option positions, also apply the trade-management skill (bank order, ladder, counter-trend exit, time stops), checked every `DEEPTRADE_MANAGE_EVERY_MIN`. The paper did not test options, and on 2026-11-03 the half-hour trail alone turned a +66% premium peak into +9%. For shares, the paper's trail is the only stop adjustment.
- **Target:** long `upper(t_entry) + 1 × sigma(t_entry) × open_today`; bearish mirrors it.
- **Reward-to-risk:** if the target distance divided by the stop distance at the planned entry is below 1.2, skip.
- **Exit** at the first of: the stop crossed on a check, the target hit at any time, the option premium stop, the time exit below, or a no-trade condition arriving.
- The paper checks stops only at the half-hour marks. Between checks, still exit at once if price crosses the stop by more than `0.5 × sigma(t) × open`. That guards against fast moves; it is not a second strategy.

## Instruments

Supports `equity` and `option`. Use the first class in `DEEPTRADE_ALLOWED_ASSET_CLASSES` the account can trade.

**Equity.** Shares, sized by the position-sizing skill. Shorts only as allowed above.

**Option.** Buy calls for a long signal, puts for a bearish one. Debit only, single leg.

| Rule | Default |
| --- | --- |
| Expiration | Today (same day) |
| Strike | The strike walk in position-sizing, down to delta 0.20 |
| Liquidity | Open interest ≥ 1,000 and today's volume ≥ 1,000 |
| Spread | Ask minus bid ≤ 5% of the mid |
| Entry | Limit at the mid, never above the ask |
| Premium stop | The loss ceiling from position-sizing: `premium × (1 − DEEPTRADE_RISK_PER_TRADE_PCT / 100)`, a hard backstop. The underlying stop usually exits first |
| Size | Usually 1 contract. More only if position-sizing allows it and the cost still fits the cap |
| Time exit | Close by the effective flat time |

The broker force-closes same-day contracts at the contract's `sellout_datetime` from `get_option_instruments`, which can be earlier than `DEEPTRADE_FLAT_BY`. Always read it at entry and record it on the trade card.

Size with position-sizing. The per-order cap sets the contract count. The premium stop is the tighter of this table's stop and the loss ceiling.

### Choosing the strike

Use the strike walk in position-sizing. This strategy stops stepping below delta 0.20.

## No-trade conditions

- Before 10:00 and after the entry cutoff for entries.
- Within 30 minutes before, and 10 minutes after, a scheduled high-impact release (FOMC decision, CPI, jobs report). On an FOMC decision day, no option entries after 13:30.
- `sigma(t)` cannot be computed from 14 clean sessions (missing bars, a holiday-shortened day in the window is fine, missing data is not).
- The day is an early-close day. The noise band is built from full sessions, so its half-hour sigmas do not fit a session that ends at 13:00. Other strategies may still trade it.

## What this strategy is bad at

- Range days. The paper's edge comes from trend days; most days produce no signal or a small loss.
- Late reversals. VWAP trailing gives back gains when the afternoon reverses.
- Same-day options in particular: time decay is steepest in the afternoon, and a correct direction can still lose if the move is slow. Implied volatility often falls after a move. Spreads widen near the close.
- Event days. The noise area is built from ordinary days and understates the move around a release.
- Small accounts with a tight per-order cap: near-the-money same-day contracts on large index ETFs can cost more than the cap early in the day. The strike walk then lands further out of the money, where the contract needs a bigger, faster move to pay and decays faster. Some signals will still be skipped at the delta floor.
- Gap and trend days. The target is measured from the boundary, so it can be behind the price before entry. On 2026-11-04 that skipped every signal.
- Few trades. Two live sessions (2026-11-03 and 11-04) gave one trade. For small accounts, index-level-scalp and index-trend-scalp fit better.

## Recording the setup

Before the order: open, prior close, sigma(t), upper and lower, VWAP, last price, check time, instrument and contract (with delta, OI, volume, spread, sellout time), entry, stop, target, reward-to-risk, size, risk in dollars. After: fill, each stop trail, exit reason, result in R.

## Example

Illustrative only: made-up symbol XYZ, made-up numbers.

Open 500.00, prior close 499.00. At 10:30, sigma = 0.0030. Upper = 500.00 × 1.003 = 501.50. Lower = 499.00 × 0.997 = 497.50. Last 501.80, VWAP 500.90. Long signal. Stop = max(501.50, 500.90) = 501.50, risk 0.30. Target = 501.50 + 1 × 0.0030 × 500 = 503.00, reward 1.20. R:R 4.0, passes. Per-order cap 200. The 502 call asks 1.60, so one contract costs 160 and fits. If it had asked 2.40, the walk would try 503, then 504, and so on, until one fit or delta fell below 0.20. Say 502 at mid 1.60, delta 0.45, spread 0.02, OI 8,000, volume 20,000: buy 1 at a 1.60 limit (2 would cost 320, over the cap). With a 25% loss ceiling the premium stop is 1.20, so 40 at risk.
