---
name: trade-management
description: Every exit rule for an open position, in one place. The position check procedure, resting orders (premium stop and bank order), the profit ladder, the reversal exit, the counter-trend exit, the momentum bank, time stops, and how to exit. Load whenever a trading agent holds a position.
user-invocable: false
---

# Trade management

Terms are defined in trading-terms. The strategy sets the entry, the strategy stop, the target, and its invalidation. This skill holds every other exit rule. Strategies link here and do not repeat these rules.

The strategy's exits always apply. This skill adds exits. It never removes or loosens one.

## Evidence

No published study tests these rules on long same-day options. The evidence supports two points: trail the main stop on the underlying, and have a defined exit. The ladder, the bank order, and the giveback are practitioner rules, untested here. Each exit costs a spread. Do not add exits. Sources: `docs/research/index-0dte-trade-management.md`.

## Before the entry

Write these on the trade card:

```text
R          = entry - premium stop        options (shares: abs(entry - strategy stop))
bank price = entry + 1 x R               unless the strategy sets another
```

## Right after the fill

| Size | Resting order |
| --- | --- |
| 1 contract | Rest the premium stop as a `stop_market` sell. Before 09:45 the broker refuses it: your position checks enforce the premium stop until then. |
| 2 or more | Rest a bank order for half, rounded down. Rest the premium stop as a `stop_market` on the rest. |
| Shares | Rest a bank order for half if the size allows it. Your position checks enforce the strategy stop. |

Use `time_in_force: gfd`. Write on the trade card which order rests.

**The swap (1 contract).** When the bid first reaches `entry + 0.75 × R`:

1. Cancel the premium stop. Confirm the cancel.
2. Rest the bank order at the bank price.
3. From now on, your position checks enforce the breakeven stop.

Reason: same-day option spikes last 2 to 4 minutes, and a resting bank order catches them. If you lose contact after the swap, the loss is capped by the premium paid, and the broker's sellout closes the position.

## The position check

Run it every `MANAGE_EVERY_MIN` minutes, aligned to the minute, while a position is open.

1. Read the option quote (or share quote), the underlying's last price, and the 1-minute bars since the last check. Update the peak.
2. Run the exits table below, top to bottom. Act on the first that is true.
3. If no exit fires, move the stage forward if its trigger is met (the ladder below).
4. Write one status line. Journal only a stage change or an exit.

If a check ran more than 1 minute late, rebuild the bars you missed before step 2.

## Exits, in order

| # | Exit | Applies | Condition |
| --- | --- | --- | --- |
| 1 | flat time | Always | The effective flat time is reached. |
| 2 | strategy stop | Always | The underlying crosses the strategy stop, as the strategy defines the cross. |
| 3 | reversal exit | Always | A confirmed reversal (below). |
| 4 | premium stop | Always | The bid reaches the premium stop. |
| 5 | target | Always | The underlying reaches the strategy's target. |
| 6 | bank order | Always | The bank order fills. Then the position is at stage 1. |
| 7 | momentum bank | Stage 0 | The bid is at least `entry + 0.5 × R`, and the counter-trend condition (below) is true. |
| 8 | counter-trend exit | Stage 1 and later | The counter-trend condition is true. |
| 9 | breakeven stop | Stage 1, and stage 0 after the 1-contract swap | The bid falls to entry. |
| 10 | giveback | Stage 2, and stage 3 (which can start from stage 1) | The bid falls below `peak − g × (peak − entry)`. `g` is 0.4, or 0.25 in stage 3. |
| 11 | time stop | Stage 0, options | After 13:00, the bid made no new peak for 30 minutes. Reason: time decay is about 15% of an at-the-money same-day option's value per hour at midday, more after 14:30. |

A strategy can make the time stop and bank price earlier late in the day (index-trend-scalp, Late session). Use the strategy's values when it does.

### The loss ceiling is not a target

The loss ceiling is the most to lose while the setup still looks valid. Do not wait for it. When the setup breaks, exit at once, at any stage, in profit or in loss.

### Confirmed reversal

Any one of these is a confirmed reversal:

1. **Invalidation.** The strategy's invalidation fires.
2. **Opposite signal.** An enabled strategy signals an entry in the opposite direction. In team mode, a partner's `FLIP` line counts.
3. **Structure break.** A completed 5-minute bar of the underlying closes beyond the last 5-minute swing point against the trade. The same bar closes on the wrong side of VWAP.

These are not reversals: one 1-minute bar, a wick, or the premium falling on its own. Reason: a same-day option can fall 30% on noise right after entry.

After a reversal exit, the strategy's re-entry and flip rules decide the next trade, in either direction.

### Counter-trend condition

For a long (mirror it for a bearish trade), on the underlying, both are true:

1. Two consecutive completed 1-minute bars close below the 1-minute EMA(9).
2. The second close is below the low of the last completed 5-minute bar.

It needs two closes, not touches. Reason: one bar is noise.

## The ladder

Stages only move forward. A stop only moves toward the price.

| Stage | Trigger | Exits that start |
| --- | --- | --- |
| 0. Open | The fill | Momentum bank, time stop. Breakeven stop after the 1-contract swap |
| 1. Banked | The bid reaches the bank price once, or the bank order fills | Counter-trend exit, breakeven stop |
| 2. Running | The bid reaches `entry + 1.5 × R` | Giveback, 60% of the best open gain kept |
| 3. Late | Under 60 minutes to the contract's sellout (shares: to the effective flat time), in stage 1 or later | Giveback, 75% of the best open gain kept |

With 2 or more contracts, when the ladder raises the stop, replace the resting `stop_market`: cancel, confirm the cancel, place the new one.

## Broker rules for resting orders

Robinhood option orders (observed 2026-11-03): `limit`, `market`, `stop_limit`, `stop_market`. There is no trailing stop and no one-cancels-other order.

- `stop_market` is sell-to-close only, regular hours only, and refused from 09:30 to 09:45. It can fill far below the stop on a fast move.
- One contract can carry only one resting sell. Expect the broker to refuse a second.
- The first time in a session that two orders rest on one position, confirm both are open with `get_option_orders`. If the broker refused one, journal its message and use the 1-contract rule.

## How to exit

1. Cancel every resting order on the contracts. Confirm the cancel.
2. Sell with a limit at the bid. If the bid moves away, use one tick under it.
3. If it is not filled in 1 minute, re-price to the new bid once, then tell the user.

Do not use a market order in the last hour of a same-day contract. The risk gate never blocks an exit.

## Journal

Write on the trade card: R, the bank price, the resting order and its id ending, each stage change with time and bid, the peak, and the exit by its name from trading-terms.

## Example

Illustrative only: made-up contract, made-up numbers.

**Winning case.** Bought 1 call at 1.00. Loss ceiling 25%, so the premium stop is 0.75, R = 0.25, and the bank price is 1.25. A `stop_market` rests at 0.75. The bid falls to 0.80: no exit condition, hold. The bid reaches 1.19 (+0.75 R): cancel the stop, rest the bank order at 1.25. The bid spikes to 1.30, and the bank order fills: +0.25, +1 R.

**Two contracts.** One sells at 1.25 (stage 1, breakeven stop at 1.00). The bid reaches 1.38 (+1.5 R, stage 2) and peaks at 1.80. The giveback floor is 1.80 − 0.4 × 0.80 = 1.48. The bid falls to 1.46: sell the second at about 1.46.

**Losing case.** Bought at 1.00, premium stop 0.75. The bid is 0.88 when a 5-minute bar closes below the last swing low and below VWAP. That is a structure break: sell at about 0.88 (−0.12, not −0.25). Then wait for the next signal, in either direction.
