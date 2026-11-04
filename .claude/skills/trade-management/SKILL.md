---
name: trade-management
description: How any trading agent manages an open position after the fill. Management cadence, R in premium and in underlying, a resting take-profit, scaling out, the profit-lock ladder that tightens the stop as a trade wins, short-timeframe counter-trend exits, time stops for same-day options, and which broker orders can rest together. Load whenever a trading agent holds a position.
user-invocable: false
---

# Trade management

The strategy skill decides the entry, the initial stop, and the target. This skill decides how the position is managed between entry and exit, so that open profit is protected and losers are cut. A setting written as `MANAGE_EVERY_MIN` means `DEEPTRADE_MANAGE_EVERY_MIN` from the session context.

The strategy's own exits always apply. This skill adds exits; it never removes one and never loosens one. When a strategy says a rule here does not apply to it, follow the strategy.

## Evidence

No published study tests these rules on long same-day options. What is supported: trailing on the underlying rather than the premium for the main stop, and that having a defined exit matters more than which one. Breakeven locks, giveback limits, and partial exits are practitioner rules, untested here. Every exit costs a spread, and spreads were most of retail traders' measured 0DTE losses. Do not add exits beyond these. Sources and grades: `docs/research/index-0dte-trade-management.md`.

## Cadence

- While any position is open, check it every `MANAGE_EVERY_MIN` minutes, aligned to the minute. This replaces `CHECK_EVERY_MIN` for open positions.
- Each check reads: the option quote (bid, ask, mark) or the share quote, and the underlying's last price, plus the 1-minute bars since the last check.
- Use the bid for long-premium decisions, not the mark. The bid is what an exit gets.
- Keep the running peak bid since entry (`peak`). Rebuild it from 1-minute option bars (`get_option_historicals`, `interval: minute`) if a check was missed. Bar highs are trades, not bids, so subtract the last observed spread.

## R and the levels

Define these on the trade card before entry:

```text
R_prem      = entry_premium - premium_stop         per contract, long options
R_und       = abs(entry_underlying - strategy_stop) underlying price
take_profit = entry_premium + R_prem              the bank order (+1R)
```

For shares, R is `R_und` and the take-profit is `entry + R_und`, unless the strategy's target is closer.

## The ladder

Stages only move forward. A stop only moves toward the price, never away. A strategy may set an earlier bank price late in the session; use the strategy's when it does.

| Stage | Trigger | Stop on what is left |
| --- | --- | --- |
| 0. Open | Fill | Strategy stop on the underlying, premium stop (the loss ceiling) as backstop. Do not tighten on noise: a same-day option can drop 30% right after entry. A confirmed reversal still exits at once (below). |
| 1. Banked | Bid reaches `take_profit` once, or the take-profit order fills | Breakeven: exit if the bid falls to `entry_premium` (shares: to entry). Strategy stop still applies if tighter. |
| 2. Running | Bid reaches `entry_premium + 1.5 × R_prem` | Giveback: exit if the bid falls below `peak - 0.4 × (peak - entry_premium)`, that is, keep 60% of the best open gain. |
| 3. Late | Any stage, under 60 minutes to the contract's sellout (shares: to the agent's flat time) | Giveback tightens to 25% of the best open gain. |

On top of the ladder, from stage 1 on, a short-timeframe counter-trend exit (below) closes the rest.

### The ceiling is not a target

The premium stop, `DEEPTRADE_RISK_PER_TRADE_PCT` of the trade's cost, is the most a trade may lose **while its setup still looks valid**. It is never a level to wait for. Once the setup is broken, the reason for holding is gone: exit at once, at any stage, in profit or in loss, wherever the price is.

### Reversal exit (any stage, including stage 0)

Exit the whole position as soon as any one of these is true. Each is a confirmed reversal, not noise:

1. **Invalidation.** The strategy's own invalidation fires (for example, index-trend-scalp: a 5-minute close back through VWAP).
2. **Opposite signal.** Any enabled strategy gives an entry signal in the opposite direction (for example, index-trend-scalp setup B the other way, or the opposite noise band breaking). In team mode, a partner's `FLIP` counts.
3. **Structure break.** On the underlying, a completed 5-minute bar closes beyond the last 5-minute swing point against the trade (below the last swing low for a long) **and** on the wrong side of VWAP. Two independent reads must agree.

A single 1-minute bar, a wick, or the premium dipping on its own is not a reversal; in stage 0 only the three conditions above, the strategy stop, and the ceiling close the trade. After a reversal exit, the strategy's re-entry and flip rules decide what is next, including taking the other side.

**Momentum take-profit before the bank price.** A trade does not have to reach `take_profit`. In stage 0, if the bid is at least `entry_premium + 0.5 × R_prem` and the short-timeframe counter-trend exit fires, take the profit: the move that was paying is turning. Re-entry is the strategy's call, so this is a pause, not the end of the trend.

### Bank order

- **Two or more contracts (or shares):** right after the fill, rest a limit sell for half, rounded down, at `take_profit`. The remainder is managed by the ladder.
- **One contract:** the downside comes first. Right after the fill, rest the premium stop as a `stop_market` sell (from 09:45, when the broker accepts it). When the bid first reaches `entry_premium + 0.75 × R_prem`, cancel the stop, confirm the cancel, and rest the bank order at `take_profit` in its place; from then on your checks enforce the breakeven stop. A same-day option's spikes can last only 2 to 4 minutes, and the resting bank order catches what a 1-minute check misses. If you lose contact after the swap, the loss is still capped by the premium paid and the broker's same-day sellout closes the position. Re-entry after a bank is the strategy's decision, not this skill's.
- If the strategy's target on the underlying is reached first, exit per the strategy.
- Use `time_in_force: gfd`. Cancel the bank order before any other exit of the same contracts.

### Short-timeframe counter-trend exit (stage 1 and later)

Exit the rest when, on the underlying, both are true for a long (mirror for bearish):

1. Two consecutive completed 1-minute bars close below the 1-minute EMA(9), and
2. the second of those closes is below the low of the last completed 5-minute bar.

This is the "the trend is turning against us right now" exit. It needs closes, not touches, and two of them, to avoid noise. It does not apply in stage 0, where only the strategy stop and premium stop apply.

### Time stops for same-day options

- After 13:00, if the position is in stage 0 and the bid has made no new high for 30 minutes, exit. Theta takes about 15% of an at-the-money same-day option's value per hour around midday and much more after 14:30.
- The agent's effective flat time always wins.

## Broker orders that rest together

Robinhood option orders (observed 2026-11-03): `limit`, `market`, `stop_limit`, `stop_market`. No trailing stop and no one-cancels-other. `stop_market` is sell-to-close only, regular hours only, and cannot be entered 09:30 to 09:45. It can fill well below the stop on a fast move.

- Contracts covered by a resting sell cannot also carry another resting sell. Expect the broker to reject the second. Each contract gets at most one resting order: the bank order, or the premium stop.
- **One contract:** the premium stop rests until the trade is up 0.75 R, then the bank order rests instead (see Bank order). Ladder exits are enforced by your checks, not by the broker. Before 09:45, when a `stop_market` cannot be entered, your checks enforce the premium stop. Say which order is resting on the trade card.
- **Two or more:** the bank order rests on half. A `stop_market` at the premium stop rests on the rest. When the ladder raises the stop, cancel and replace that stop order, confirm the cancel first.
- The first time in a session you rest two orders on one position, confirm both show as open with `get_option_orders`. If the broker rejected one, write down what it said and fall back to the one-contract rule.

## Exiting

- Cancel resting orders on the contracts first and confirm the cancel. Then sell with a limit at the bid, or a marketable limit one tick under it if the bid is moving away. Never a market order in the last hour of a same-day contract.
- If the limit is not filled within 1 minute, re-price to the new bid once. Then tell the user.

## Journal

On the trade card: `R_prem`, `R_und`, `take_profit`, the bank-order id ending, each stage change with the time and bid, the peak, and the exit reason by name (strategy stop, premium stop, breakeven, giveback, counter-trend, time stop, flat time).

## Example

Illustrative only: made-up contract, made-up numbers.

Bought 1 call at 1.00 with a 25% loss ceiling, premium stop 0.75, so `R_prem` = 0.25 and `take_profit` = 1.25. A stop_market rests at 0.75. The bid dips to 0.80 (stage 0; no reversal condition, hold), then reaches 1.19 (+0.75R): cancel the stop, rest a limit sell at 1.25. It spikes to 1.30 and the bank order fills at 1.25: +0.25 per contract, +1R. With 2 contracts instead: 1 sells at 1.25, stop on the other moves to 1.00. The bid reaches 1.38 (+1.5R, stage 2) and peaks at 1.80, so the giveback floor is 1.80 − 0.4 × 0.80 = 1.48. The bid falls to 1.46: sell the second at about 1.46.

Losing case: bought at 1.00, stop 0.75. The bid is 0.88 when a 5-minute bar closes below the last swing low and below VWAP. That is a structure break: sell now at about 0.88 (−0.12, not −0.25). Then wait for the next signal, either way.
