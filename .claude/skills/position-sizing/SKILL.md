---
name: position-sizing
description: Position sizing from the per-order cap, with a loss ceiling measured on the trade itself. Turns the cap, cash, entry, and the strategy's stop into a share, fractional share, or contract count, and sets the stop at the tighter of the strategy's stop and the ceiling. Load whenever a trading agent is about to size an order.
user-invocable: false
---

# Position sizing

The per-order cap decides how big a position is. `DEEPTRADE_RISK_PER_TRADE_PCT` decides the most that position may lose, as a percent of **what the trade cost**, not of the account. Size never comes from conviction.

Example of the difference: a 100 trade in a 2,000 account with `RISK_PER_TRADE_PCT=25` can lose at most 25, never the whole 100. The account is protected by the cap, which limits how big any trade is, and by `DEEPTRADE_DAILY_LOSS_PCT`, which is measured on equity and stops the day.

## Inputs

- `equity`, `buying_power`, `cash`: from `get_portfolio` for the agentic account, this session.
- `ceiling_pct`: `DEEPTRADE_RISK_PER_TRADE_PCT` from the session context. The most a trade may lose, in percent of its cost.
- `entry`: planned entry price.
- `strategy_stop`: the stop the strategy sets, in the instrument's own price (for options, the strategy's premium stop).
- `max_order_usd`, `max_order_pct`: the per-order cap settings, as reported at session start.

## Effective per-order cap

```text
pct = max_order_pct if set, else 10
both set        -> cap = min(max_order_usd, equity * pct / 100)
only usd set    -> cap = max_order_usd if buying_power >= max_order_usd, else equity * 10 / 100
otherwise       -> cap = equity * pct / 100
```

The session context states which rule is active. The risk gate applies the same rule to the equity and buying power a hook records from your latest `get_portfolio` call, which must be under 2 minutes old and newer than the last order. Call it right before sizing.

## The stop: the tighter of two

```text
ceiling_stop = entry * (1 - ceiling_pct / 100)          long positions
stop         = max(strategy_stop, ceiling_stop)          the tighter one, closer to entry
```

The ceiling is the most you accept losing while the setup still looks valid. It is a limit, not a target: when the setup breaks (trade-management's reversal exit), exit at once, well before the ceiling. Exits normally come from the strategy and the trade-management ladder long before it. When the ceiling is tighter than the strategy's stop, say so on the trade card: the strategy's stop did not fit the ceiling. Never move the stop beyond the ceiling to give a trade room.

For shares, a strategy's structural stop is almost always far tighter than a percent ceiling, so the strategy's stop decides.

## Size

```text
unit_cost = entry                      shares
unit_cost = entry * 100                options (one contract)
units     = cap / unit_cost            round down to whole contracts, or to whole shares unless fractional
units     = min(units, cash / unit_cost)
```

- If `units` is zero, no contract or share fits the cap: skip, and journal "does not fit the cap".
- `DEEPTRADE_FRACTIONAL_SHARES` false: round shares down to whole. Robinhood accepts fractional shares only on market orders in regular hours, sent with `dollar_amount` = shares × price. For a limit order, round down to whole shares.
- A strategy may ask for less (for example, index-pair-read's half-size tier). Never more than the cap allows.

## What it can lose

```text
loss_at_stop = units * (entry - stop)              shares
loss_at_stop = units * (entry - stop) * 100        options
```

`loss_at_stop` is at most `ceiling_pct` of the trade's cost by construction. State it on the trade card in dollars and as a percent of equity.

## Sanity checks before sending

- Notional is at or below `cap`. State the cap and which setting produced it.
- `loss_at_stop` is at or below `ceiling_pct` of notional. State both.
- Opening this position does not exceed `DEEPTRADE_MAX_POSITIONS`.
- If `loss_at_stop` alone would exceed what is left of today's `DAILY_LOSS_PCT` budget (start equity × `DAILY_LOSS_PCT` minus today's realized loss), reduce `units` until it fits, or skip.
- If the stop is so close that it sits inside the spread or under 0.1% of entry for shares, skip; a stop that noise will hit at once is not a stop.

## Worked example

Illustrative only: made-up numbers.

Equity 1,000, buying power 1,000. Only `MAX_ORDER_USD=200` is set and buying power covers it, so cap = 200. `RISK_PER_TRADE_PCT=25`. A same-day call asks 0.99, and the strategy's premium stop is 0.50. Contracts = floor(200 / 99) = 2, notional 198. Ceiling stop = 0.99 × 0.75 = 0.7425, rounded toward the entry: 0.75. Stop = max(0.50, 0.75) = 0.75, so the ceiling decides. Loss at stop = 2 × 0.24 × 100 = 48, which is 24% of the trade and 4.8% of equity. With `DAILY_LOSS_PCT=20` (200), four full losses fit in one day.
