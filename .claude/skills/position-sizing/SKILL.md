---
name: position-sizing
description: Fixed-fractional risk sizing. Turns account equity, risk percent, entry, and stop into a share, fractional share, or contract count that also respects the .env per-order cap. Load whenever a trading agent is about to size an order.
user-invocable: false
---

# Position sizing

Risk is decided first, size falls out of it. Size never comes from conviction.

## Inputs

- `equity`: agentic account equity from the broker, fetched this session.
- `risk_pct`: `DEEPTRADE_RISK_PER_TRADE_PCT` from the session context.
- `entry`: planned entry price.
- `stop`: planned stop price, from the strategy.
- `max_order_usd`: `DEEPTRADE_MAX_ORDER_USD` from `.env`, as reported at session start. Empty unless the user set it.
- `max_order_pct`: `DEEPTRADE_MAX_ORDER_PCT` from `.env`. May be unset.
- `buying_power`: buying power in the agentic account, from the broker this session.
- `cash`: available cash in the agentic account.

## Effective per-order cap

```text
pct = max_order_pct if set, else 10
both set        -> cap = min(max_order_usd, equity * pct / 100)
only usd set    -> cap = max_order_usd if buying_power >= max_order_usd, else equity * 10 / 100
otherwise       -> cap = equity * pct / 100
```

The session context states which rule is active. The hook applies the same rule from `journal/session-state.json`, so write that file before sizing.

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
3. If `DEEPTRADE_FRACTIONAL_SHARES` is false, round down to a whole number. If that gives zero, skip the trade.
4. If `risk_per_share` is less than 0.1% of entry, the stop is too tight to be meaningful. Skip or ask the strategy for a wider structural stop. Never size up into a tiny stop.

Round fractional shares to 4 decimal places or whatever the broker accepts. Robinhood accepts fractional shares only on market orders in regular hours. For a fractional size, send a market order with `dollar_amount` = shares x price, so the risk gate can check its value. For a limit order, round down to whole shares; if that gives zero, skip the trade.

## Options contracts

Only if `option` is in `DEEPTRADE_ALLOWED_ASSET_CLASSES` and the account has options approval.

```text
risk_dollars  = equity * risk_pct / 100
risk_per_ctr  = (premium_paid - stop_premium) * 100    for debit positions
contracts     = floor(risk_dollars / risk_per_ctr)
notional      = contracts * premium_paid * 100
```

If a premium stop is not defined, treat the full premium as the risk. Clamp to `cap` and cash as above. If `contracts` is zero, skip.

## Crypto

Same as shares with fractional units allowed. Use the same `risk_pct`. Spreads and fees are larger, so add them to `risk_per_share` before dividing.

## Sanity checks before sending

- Dollar risk at the stop is at or below `risk_dollars`. State it.
- Notional is at or below `cap`. State the cap and which setting produced it.
- Opening this position does not exceed `DEEPTRADE_MAX_POSITIONS`.
- Total open risk across positions does not exceed 2x the single-trade risk.

## Worked example

Equity 4,000, buying power 4,000. Risk 0.5% = 20 dollars. Entry 52.40, stop 51.90, risk per share 0.50. Shares = 40. Notional 2,096. Only a dollar cap of 500 is set and buying power covers it, so cap = 500 and shares = 500 / 52.40 = 9.54. Actual risk at stop = 9.54 * 0.50 = 4.77 dollars. With a 10% cap also set, the lower cap, 400, would win. The cap, not the risk budget, is the binding limit. Report both numbers to the user so they can decide whether to change the caps.
