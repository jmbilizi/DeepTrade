---
name: position-sizing
description: Fixed-fractional risk sizing. Turns account equity, risk percent, entry, and stop into a share, fractional share, or contract count that also respects the .env per-order cap. Load whenever a trading agent is about to size an order.
user-invocable: false
---

# Position sizing

Risk is decided first, size falls out of it. Size never comes from conviction.

## Inputs

- `equity`: agentic account equity from the broker, fetched this session.
- `risk_pct`: risk per trade from `config/day-trader.md`. Default 0.5%.
- `entry`: planned entry price.
- `stop`: planned stop price, from the strategy.
- `max_order_usd`: `DEEPTRADE_MAX_ORDER_USD` from `.env`, as reported at session start. May be unset.
- `max_order_pct`: `DEEPTRADE_MAX_ORDER_PCT` from `.env`. May be unset.
- `cash`: available cash in the agentic account.

## Effective per-order cap

```text
cap_usd = max_order_usd                    if set
cap_pct = equity * max_order_pct / 100     if set
cap     = min(cap_usd, cap_pct)            using whichever are set; no cap if neither
```

The percent cap scales with the account. A 1,000 dollar account with a 500 dollar cap and a 10% cap gets 100 per order. A 50,000 dollar account with the same settings gets 500. The hook applies the same rule, but it can only see equity if `journal/session-state.json` is current, so write that file before sizing.

## Shares

```text
risk_dollars   = equity * risk_pct / 100
risk_per_share = abs(entry - stop)
shares         = risk_dollars / risk_per_share
notional       = shares * entry
```

Then clamp, in order:

1. If `notional > cap`, set `shares = cap / entry` and note that the cap, not risk, set the size.
2. If `notional > cash`, set `shares = cash / entry`.
3. If fractional shares are not allowed by the plan, round down to a whole number. If that gives zero, skip the trade.
4. If `risk_per_share` is less than 0.1% of entry, the stop is too tight to be meaningful. Skip or ask the strategy for a wider structural stop. Never size up into a tiny stop.

Round fractional shares to 4 decimal places or whatever the broker accepts.

## Options contracts

Only if the plan enables options.

```text
risk_dollars  = equity * risk_pct / 100
risk_per_ctr  = (premium_paid - stop_premium) * 100    for debit positions
contracts     = floor(risk_dollars / risk_per_ctr)
notional      = contracts * premium_paid * 100
```

If a premium stop is not defined, treat the full premium as the risk. Clamp to `cap` and cash as above. If `contracts` is zero, skip.

## Crypto

Same as shares with fractional units allowed. Use the plan's risk percent. Spreads and fees are larger, so add them to `risk_per_share` before dividing.

## Sanity checks before sending

- Dollar risk at the stop is at or below `risk_dollars`. State it.
- Notional is at or below `cap`. State the cap and which setting produced it.
- Opening this position does not exceed the plan's maximum concurrent positions.
- Total open risk across positions does not exceed 2x the single-trade risk unless the plan says otherwise.

## Worked example

Equity 4,000. Risk 0.5% = 20 dollars. Entry 52.40, stop 51.90, risk per share 0.50. Shares = 40. Notional 2,096. Dollar cap 500, percent cap 10% of 4,000 = 400, so cap = 400 and shares = 400 / 52.40 = 7.63. Actual risk at stop = 7.63 * 0.50 = 3.82 dollars. The percent cap, not the risk budget, is the binding limit. Report both numbers to the user so they can decide whether to change the caps.
