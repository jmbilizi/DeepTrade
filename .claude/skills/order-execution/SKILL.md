---
name: order-execution
description: How any trading agent turns a strategy signal into a broker order safely. Fresh data checks, instrument choice, order types the risk gate can verify, handling gate denials, confirming fills, placing stops, and when to stop trading. Load whenever a trading agent is about to enter, exit, or manage a position.
user-invocable: false
---

# Order execution

The strategy skill decides what to trade. This skill decides how the order goes out. A setting written as `MAX_POSITIONS` means `DEEPTRADE_MAX_POSITIONS` from the session context.

## Before an entry

1. **Fresh account.** Call `get_portfolio` for the agentic account. The risk gate refuses an entry when the last read is over 2 minutes old or older than your last order or cancel.
2. **Fresh market data.** During regular hours, the quote's venue timestamp must be within 60 seconds. For bar-based strategies, the latest completed bar must be present and not `interpolated`. If either fails, no entry. If it fails on two checks in a row, stop and tell the user.
3. **Spread.** Shares: skip when the spread is wider than 0.1% of price. Options: use the strategy's spread limit.
4. **Limits.** Count your own entries against `MAX_ORDERS_PER_DAY` and open positions against `MAX_POSITIONS`, independent of the hook.
5. **Instrument.** `ALLOWED_ASSET_CLASSES` is in order of preference. Use the first class that both the strategy and the account support, and say which. Shorts only when `ALLOW_SHORTS` is true.
6. **Size** with the position-sizing skill.
7. **Journal** the trade card before sending anything, per the trade-journal skill.

## Sending the order

- Every order traces to one enabled strategy rule and the `.env` settings. Say which in the journal.
- Preview first: `review_equity_order` or `review_option_order`.
- Send it in a form the risk gate can value: a limit order for whole shares or options, or a market order with `dollar_amount` for fractional shares. Never a market entry sized only by quantity.
- Options: find the contract with `get_option_instruments` in this session first. Option orders name contracts only by id, and the gate learns each id's underlying from that lookup.
- Use a fresh `ref_id` per logical order and the same one on a retry after a transport error, so a retry never doubles the order.
- If the broker supports it, attach the stop and target. If not, place the stop right after the fill is confirmed.
- Tell the user in two lines what you did.

## After sending

Confirm the fill and the resulting position with the broker. Do not assume. A fill changes buying power, so the next entry needs a new `get_portfolio` read.

## Risk gate denials

Read the reason, journal it, and tell the user. Never resubmit with different fields to get around it. Two denials are expected and fixed by doing what they say:

- **Stale account read.** Call `get_portfolio`, then resubmit unchanged.
- **`.env` changed.** Tell the user the new values in one line, re-check the trade against them, and resubmit only if it still fits.

If the user declines the permission prompt, treat it as a no and move on.

## Managing a position

On every check: is the stop still valid, has the target been hit, has the strategy's invalidation triggered, is the agent's time cutoff near. Act on the first that is true. Never widen a stop, add to a loser, or average down. Trail a stop in your favor only if the strategy describes it. Exits are never blocked by the gate's entry checks.

## Stop trading and ask

- Equity, cash, or positions do not match what you expected.
- A tool returns an error twice in a row.
- Quotes stop updating or disagree with each other.
- Realized loss reaches `DAILY_LOSS_PCT` of starting equity. Stop for the day and write the review.
- The user asks for something outside the plan. Explain the rule and name the `.env` setting they would change.
