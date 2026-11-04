---
name: index-trend-scalp
description: Intraday semi-scalping strategy for broad index ETFs, in same-day options or shares. Trades with the 5-minute trend on pullbacks that hold, flips on VWAP reclaims, banks profit early with the trade-management ladder, and re-enters when the trend resumes. Checked on every completed 5-minute bar. Load when a trading agent needs entry, stop, target, re-entry, and flip rules for short index trend trades.
user-invocable: false
---

# Index trend scalp

Short trades in the direction of the intraday trend, taken many times a day if the tape allows. Profit is banked early and the position is re-entered when the trend resumes, or flipped when it turns. Built for the allowed index ETFs with same-day expirations.

## Evidence and honesty

This is a rule set, not a proven edge. None of these entry, re-entry, or flip rules has a published test. The measured record for retail buyers of same-day index options is negative on average, and most of the loss was spreads and fees. Each extra round trip pays another spread. The rules below limit trade count and require a clear trend for that reason. Review results after every 10 trades with the trade-journal skill before trusting it. Sources and grades: `docs/research/index-0dte-trade-management.md`.

## Applies to

The symbols in `DEEPTRADE_ALLOWED_SYMBOLS`. If unset, do not run: this strategy needs an explicit list of broad index ETFs. Confirm today's expiration with `get_option_chains` for each, as index-intraday-momentum describes. With more than one symbol, load index-pair-read; it picks the instrument and the size tier.

## Data this strategy needs

- 1-minute and 5-minute bars, regular hours, from `get_equity_historicals`.
- From `get_equity_technical_indicators` on 5-minute bars: EMA(9), EMA(20), VWAP, supertrend(10, 3), ATR(14), ADX(14). On 1-minute bars: EMA(9). See intraday-technicals.
- A fresh quote with bid and ask; for options, today's chain and contract quotes with delta, open interest, volume.

If any is missing or stale, no entry. Same rule as order-execution.

## Checks

On every completed 5-minute bar from the entry start to the entry cutoff: read the trend state, chop flag, extension, and volatility shift (intraday-technicals) for each symbol, then test the setups. While a position is open, the trade-management cadence applies.

**Entry start:** `DEEPTRADE_NO_NEW_ENTRIES_BEFORE`, once 3 completed 5-minute bars exist for today, so VWAP and ATR have data. No fixed opening wait; the spread, chop, and volatility-shift filters decide whether the open is tradable.

**Entry cutoff:** the earlier of `DEEPTRADE_NO_NEW_ENTRIES_AFTER` and 20 minutes before the contract's `sellout_datetime`, so every entry has time to be managed and closed before the agent's flat time. There is no other clock cutoff: late in the day the strategy keeps trading and trades shorter (see Late session).

## Filters (all must pass)

1. Chop flag is false.
2. No volatility shift on the signal bar.
3. Extension is within ±2.0 in the trade's direction.
4. index-pair-read does not say "disagrees".
5. No no-trade condition (below).

## Setups

Long setups below; bearish setups are the mirror (calls become puts, above becomes below, highs become lows).

**A. Pullback hold (continuation).**
1. Trend state is `up`.
2. In the last 3 completed 5-minute bars, a low came within 0.25 × ATR of the higher of EMA(20) and VWAP, and no 5-minute bar closed below VWAP.
3. The signal bar closes above EMA(9) and above the previous bar's high.

Stop: the pullback's lowest low minus 0.1 × ATR.

**B. VWAP reclaim (turn or flip).**
1. At least 2 of the last 6 completed 5-minute bars closed below VWAP.
2. The signal bar closes above VWAP and above the highest high of the 3 bars before it.
3. EMA(9) is above EMA(20) at the signal bar's close. The supertrend may still point down; it lags.

Stop: the lowest low of the signal bar and the 3 bars before it, minus 0.1 × ATR.

**For both:** skip when the stop distance `R_und` is under 0.3 × ATR (noise will take it) or over 1.0 × ATR (too far for a scalp).

## Target

On the underlying: `entry + 2 × R_und`. Reward-to-risk is 2.0 by construction. If the session high sits between `entry + 1 × R_und` and that target, use the session high instead and skip if the result is under 1.5.

The premium take-profit and the ladder come from trade-management. They usually close the trade before this target.

## Exits

At the first of:

- **Stop:** a completed 1-minute bar closes beyond the stop on the underlying.
- **Fast move:** any trade 0.5 × ATR beyond the stop. Exit at once.
- **Invalidation:** for setup A, a 5-minute close below VWAP. For setup B, a 5-minute close back below VWAP. This and the other trade-management reversal exits fire at any stage, in loss too: do not wait for the stop or the ceiling once the setup is broken.
- **Target** on the underlying.
- Any trade-management exit: premium stop, bank order, breakeven, giveback, counter-trend, time stop.
- The agent's effective flat time.

## Re-entry and flips

The user's goal: bank the gain when the move pauses, then get back in, cheaper if possible, when the trend resumes, or take the other side if it turned.

- **After a profitable exit, same direction:** allowed on a new setup A or B whose signal bar closes after the exit. The pullback for setup A must form after the exit.
- **After a losing exit, same direction:** wait 15 minutes, then only a new setup A or B. Never re-enter on the bar that stopped you.
- **Flip to the other side:** only through setup B in the other direction, on a later bar than the exit. Never reverse in the same minute as the exit. One flip per symbol per hour.
- **No fixed trade count.** `DEEPTRADE_MAX_ORDERS_PER_DAY` caps entries through the risk gate. A partial exit is not a new trade.
- **Stop the bleeding:** after 2 losses in a row, pause new entries for 30 minutes. After 4 losses in a day, stop for the day. `DEEPTRADE_DAILY_LOSS_PCT` always applies.

## Late session

Time left shortens every trade instead of stopping trading. Same-day options lose value fastest in the last hours, so the less time is left, the smaller and faster the scalp:

| Time to the contract's sellout | Target on the underlying | Trade-management changes |
| --- | --- | --- |
| More than 120 minutes | `entry + 2 × R_und` | None |
| 60 to 120 minutes | `entry + 1.5 × R_und` | Bank order at `entry_premium + 0.75 × R_prem`. Time stop: exit if no new high bid for 15 minutes |
| Under 60 minutes | `entry + 1 × R_und` | Bank order at `entry_premium + 0.5 × R_prem`. Giveback 25%. Time stop: 10 minutes. Spread rule tightens to 4% of mid |

Skip a late entry when the target would be under 0.3 × ATR away: there is no room left for the move to pay the spread.

## No-trade conditions

- Before the entry start, and after the entry cutoff.
- Within 30 minutes before and 10 minutes after a scheduled high-impact release (FOMC decision, CPI, jobs report). On an FOMC decision day, no entries after 13:30.
- A market holiday. On an early-close day, trade with the cutoff the gate and session context give; "time to the contract's sellout" in Late session already reflects the earlier close.
- The daily loss limit is reached, or the loss-streak limit above.

## Instruments

Supports `option` and `equity`. Use the first class in `DEEPTRADE_ALLOWED_ASSET_CLASSES` the account can trade.

**Option.** Buy calls for long setups, puts for bearish setups. Debit, single leg, today's expiration.

| Rule | Default |
| --- | --- |
| Strike | The strike walk in index-intraday-momentum ("Choosing the strike"), but stop stepping below delta 0.35. A scalp needs delta; far out-of-the-money contracts need a big move just to break even |
| Liquidity | Open interest ≥ 1,000 and today's volume ≥ 1,000 |
| Spread | Ask minus bid ≤ 5% of the mid |
| Entry | Limit at the mid, never above the ask. Cancel if not filled in 2 minutes. Do not chase |
| Premium stop | Structural: `premium − 1.5 × delta × R_und`, but not tighter than `0.7 × premium` (premium noise right after entry). Then position-sizing applies the loss ceiling: the stop is never looser than `premium × (1 − DEEPTRADE_RISK_PER_TRADE_PCT / 100)`. Round to the tick toward the entry |
| Size | position-sizing (contracts from the per-order cap), then the index-pair-read tier |

The premium stop tracks the underlying stop inside the ceiling. Size comes from the per-order cap, so a cheaper contract means more contracts, and with 2 or more the bank order can sell half.

**Equity.** Shares, sized by position-sizing on `R_und`. Shorts only if `DEEPTRADE_ALLOW_SHORTS` is true.

## What this strategy is bad at

- Chop. The chop flag removes some of it, not all. Midday (11:30 to 13:30) is where it fails most.
- Costs. A 0.02 spread on a 1.00 contract is 2% per round trip before fees. Four round trips a day cost about 8% of premium traded.
- V-shaped reversals: the 1-minute stop and the counter-trend exit fire, then price snaps back. Re-entry rules recover some of it, at another spread.
- News bars. The volatility-shift filter blocks entries in the bar, not the move that follows.
- All thresholds (0.25, 0.3, 1.0, 1.5 ATR, 15 minutes) are judgment, not fitted. They are starting points to review against the journal.

## Recording the setup

On the trade card, before the order: setup letter, trend state, chop flag inputs, extension, ATR, the pair-read scores and tier, entry, `R_und`, stop, target, contract (delta, OI, volume, spread, sellout), premium stop, `R_prem`, bank price, size, dollar risk. After: every ladder stage, exit reason, result in R, and for re-entries the trade it follows.

## Example

Illustrative only: made-up symbol XYZ, made-up numbers.

10:40. XYZ trend state up, ATR(14, 5m) 0.80, VWAP 500.20, EMA(20) 500.35. The 10:30 bar's low was 500.42, within 0.25 × 0.80 = 0.20 of EMA(20). The 10:35 bar closes 501.10, above EMA(9) 500.80 and the prior high 500.95. Setup A long. Stop 500.42 − 0.08 = 500.34, `R_und` 0.76 (0.95 ATR, inside the range). Target 502.62. The 501 call: mid 1.20, delta 0.50. Structural premium stop 1.20 − 1.5 × 0.50 × 0.76 = 0.63, under the 0.84 noise limit, so 0.63. A 25% ceiling gives 0.90, which is tighter, so the stop is 0.90: `R_prem` 0.30, bank at 1.50. Cap 200: 1 contract (2 would cost 240).
