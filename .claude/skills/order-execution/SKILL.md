---
name: order-execution
description: How any trading agent turns a strategy signal into a broker order safely. Fresh data checks, instrument choice, order types the risk gate can verify, handling gate denials, confirming fills, placing stops, and when to stop trading. Load whenever a trading agent is about to enter, exit, or manage a position.
user-invocable: false
---

# Order execution

The strategy skill decides what to trade. This skill decides how the order goes out. A setting written as `MAX_POSITIONS` means `DEEPTRADE_MAX_POSITIONS` from the session context.

## Before an entry

1. **Fresh account.** Call `get_portfolio` for the agentic account. The risk gate refuses an entry when the last read is over 2 minutes old or older than the last order or cancel, by any agent. With `exposure_guard=true`, also call, in the same message, `get_option_positions` (`account_number`, `nonzero: true`) and `get_option_orders` (`account_number`, `created_at_gte` = today's date) before an option entry. The gate checks positions, resting entries, direction, and `MAX_POSITIONS` from those two reads, and refuses the entry if either is missing, filtered, old, or for another account. If a read returns a `next` cursor, read every page right away with `cursor`, in order; the gate counts the pages only as a complete run. Under the guard, entries must be day orders (`time_in_force: gfd`) with a limit price.
2. **Fresh market data.** During regular hours, the quote's venue timestamp must be within 60 seconds. For bar-based strategies, the latest completed bar must be present and not `interpolated`. If either fails, no entry. If it fails on two checks in a row, stop and tell the user.
3. **Spread.** Shares: skip when the spread is wider than 0.1% of price. Options: use the strategy's spread limit.
4. **Limits.** Count your own entries against `MAX_ORDERS_PER_DAY` and open positions against `MAX_POSITIONS`, independent of the hook.
5. **Instrument.** `ALLOWED_ASSET_CLASSES` is in order of preference. Use the first class that both the strategy and the account support, and say which. Shorts only when `ALLOW_SHORTS` is true.
6. **Size** with the position-sizing skill.
7. **Journal** the trade card before sending anything, per the trade-journal skill.

## Fast path: arm before the trigger

From signal to order should take seconds, not minutes. On 2026-11-03 an entry took 80 seconds and an exit 22. Do the slow work before the trigger:

1. **Arm.** When a strategy's setup is forming (for example, price within 0.5 × ATR of a trigger level, or a pullback in progress), write an armed card in the journal: trigger condition, direction, planned stop and target on the underlying, the premium-stop rule, and size. That satisfies "stop and target in the journal before the order". Look up the contract for each direction armed with `get_option_instruments` (first strike per the strategy's walk), so the gate already knows the option ids.
2. **Read in parallel.** Every independent read goes in one message: all indicator types, both symbols' quotes, option quotes, `get_portfolio`. Never one call per turn when they do not depend on each other.
3. **Fire.** On the trigger, in one message: fresh option quote, `get_portfolio`, and, when the session context shows `exposure_guard=true`, the positions and open-orders reads from step 1 of "Before an entry". Then `review_option_order` and, if it raises no alert, `place_option_order` straight after. Append one line to the armed card with the trigger time, quote, and limit. Do not re-derive the plan.
4. **Exit fast.** Exit levels are decided in advance by the strategy and trade-management, so an exit is: cancel resting orders on the contracts, confirm the cancel, sell. Exits skip `review_option_order`; write the exit to the card after the order is sent.
5. **Disarm** when the setup fails or the check time passes, with one line on the card saying why. An armed card that never fired is a skipped-signal card.

Speed never replaces a check in "Before an entry". It removes waiting between them.

## Sending the order

- Every order traces to one enabled strategy rule and the `.env` settings. Say which in the journal.
- Preview first: `review_equity_order` or `review_option_order`.
- Send it in a form the risk gate can value: a limit order for whole shares or options, or a market order with `dollar_amount` for fractional shares. Never a market entry sized only by quantity.
- Options: find the contract with `get_option_instruments` in this session first. Option orders name contracts only by id, and the gate learns each id's underlying from that lookup.
- Use a fresh `ref_id` per logical order and the same one on a retry after a transport error, so a retry never doubles the order.
- Right after the fill is confirmed, place the resting orders trade-management describes. Every position gets a resting broker order from the fill on: the stop first, the bank order once the trade is in profit. A position with no resting order is a position you must not leave unwatched.
- Tell the user in two lines what you did.

## After sending

Confirm the fill and the resulting position with the broker. Do not assume. A fill changes buying power, so the next entry needs a new `get_portfolio` read.

## Risk gate denials

Read the reason, journal it, and tell the user. Never resubmit with different fields to get around it. Two denials are expected and fixed by doing what they say:

- **Stale account read.** Call `get_portfolio`, then resubmit unchanged.
- **`.env` changed.** Tell the user the new values in one line, re-check the trade against them, and resubmit only if it still fits.

If the user declines the permission prompt, treat it as a no and move on.

## Managing a position

Follow the trade-management skill from the fill to the exit: cadence, bank order, profit-lock ladder, and which orders can rest together at the broker. On every check: is the stop still valid, has the target been hit, has the strategy's invalidation triggered, has a trade-management exit fired, is the agent's time cutoff near. Act on the first that is true. Never widen a stop, add to a loser, or average down. Tighten a stop only as the strategy or trade-management describes. Exits are never blocked by the gate's entry checks.

A new entry after an exit, in either direction, is a new trade: it needs its own strategy signal, card, and gate check. It is never "adding to" the closed position.

## Stop trading and ask

- Equity, cash, or positions do not match what you expected.
- A tool returns an error twice in a row.
- Quotes stop updating or disagree with each other.
- Realized loss reaches `DAILY_LOSS_PCT` of starting equity. Stop for the day and write the review.
- The user asks for something outside the plan. Explain the rule and name the `.env` setting they would change.
