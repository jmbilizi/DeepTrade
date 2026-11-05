---
name: order-execution
description: How any trading agent turns a strategy signal into a broker order, fast and safely. The checks before an entry, the fast path, sending and confirming orders, the reads the risk gate needs, gate denials, and when to stop trading. Load whenever a trading agent is about to enter or exit.
user-invocable: false
---

# Order execution

Terms are defined in trading-terms. The strategy decides what to trade. This skill decides how the order goes out. After the fill, trade-management decides every exit.

## Checks before an entry

1. **Account read.** Call `get_portfolio` for the agentic account. The gate refuses an entry when that read is over 2 minutes old. It also refuses one older than any agent's last order.
2. **Exposure reads.** With `exposure_guard=true`, make these reads in the same message as step 1:
   - `get_option_positions` with `account_number` and `nonzero: true`.
   - `get_option_orders` with `account_number` and `created_at_gte` = today's date.
   - If a read returns a `next` cursor, read each next page at once with `cursor`. The gate counts only a complete run of pages.
3. **Market data.** In regular hours, the quote's venue time must be within 60 seconds. The latest completed bar must exist and must not be `interpolated`. If either fails, do not enter. If it fails on two checks in a row, stop and tell the user.
4. **Spread.** Shares: skip a spread over 0.1% of the price. Options: use the strategy's spread limit.
5. **Limits.** Count your entries against `MAX_ORDERS_PER_DAY` and open positions against `MAX_POSITIONS`. Do not rely on the gate alone.
6. **Instrument.** Use the first class in `ALLOWED_ASSET_CLASSES` that the strategy and the account support. Say which. Shorts only when `ALLOW_SHORTS` is true.
7. **Size** with position-sizing.
8. **Trade card.** Write it before you send anything (trade-journal).

## Fast path

Send an order seconds after the signal. Reason: on 2026-11-03 an entry took 80 seconds and an exit took 22. Do the slow work before the trigger.

1. **Arm.** When a setup forms, write an armed card. Example: the price is within 0.5 × ATR of a trigger. The card holds: trigger, direction, strategy stop, target, premium stop rule, and size. The armed card is the trade card the rules require before an order. Look up the contract for each armed direction with `get_option_instruments`, so the gate knows its id.
2. **Read in parallel.** Put every independent read in one message: indicators, quotes for each symbol, option quotes, and `get_portfolio`.
3. **Fire.** On the trigger, in one message: the option quote, `get_portfolio`, and the exposure reads if the guard is on. Then call `review_option_order`. If it raises no alert, call `place_option_order` at once. Add one line to the armed card: trigger time, quote, and limit. Do not recalculate the plan.
4. **Disarm** when the setup fails or its check time passes. Add one line saying why. An armed card that never fired is a skipped-signal card.

Speed does not replace a check. It removes the wait between checks.

## Sending an order

- Every order traces to one rule of an enabled strategy and to the `.env` settings. Write which on the card.
- Preview an entry first with `review_equity_order` or `review_option_order`. Exits skip the preview.
- Send a form the gate can value: a limit order for whole shares or options, or a market order with `dollar_amount` for fractional shares. Never a market entry sized only by quantity.
- Under the exposure guard, option entries are single-leg day orders (`time_in_force: gfd`) with a limit price.
- Look up each option contract with `get_option_instruments` in this session first. Reason: option orders name contracts by id, and the gate learns each id's underlying from that lookup.
- Use a new `ref_id` for each new order. Reuse the same `ref_id` on a retry after a transport error. Reason: the retry then cannot double the order.
- Tell the user what you did, in two lines.

## After sending

1. Confirm the fill and the position with the broker. Do not assume a fill.
2. Place the resting order that trade-management gives for the size. A position without a resting order must not be left unwatched.
3. Before the next entry, read `get_portfolio` again. Reason: a fill changes buying power.

## A new trade after an exit

An entry after an exit, in either direction, is a new trade. It needs its own signal, trade card, and gate check. It is never "adding to" the closed position. Never widen a stop, add to a loser, or average down.

## Risk gate denials

Read the reason. Journal it. Tell the user. Never resubmit with different fields to get around a denial.

| Denial | Do this |
| --- | --- |
| Stale account read | Call `get_portfolio`. Resubmit unchanged. |
| Exposure reads stale, missing, or incomplete | Do the exposure reads again. Resubmit unchanged. |
| Order lock, single agent | Wait a few seconds. Do the reads again. Check the plan. Resubmit if it still fits. |
| Order lock or exposure, team mode | Your partner got there first. Do not retry that entry. Read the board (team-play). |
| `.env` changed | Tell the user the new values in one line. Check the trade against them. Resubmit only if it still fits. |
| Anything else | Do not resubmit. |

If the user declines a permission prompt, treat it as a no.

## Stop trading and ask the user

- Equity, cash, or positions do not match what you expect.
- A tool returns an error twice in a row.
- Quotes stop updating or disagree with each other.
- The daily loss limit is reached. Stop for the day and write the review.
- The daily profit target is reached. Open no new position. Manage open ones to their exits, then write the review. In team mode, count the team's realized profit.
- The user asks for something outside the plan. Explain the rule, and name the `.env` setting they can change.
