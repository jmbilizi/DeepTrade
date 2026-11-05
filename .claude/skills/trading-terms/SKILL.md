---
name: trading-terms
description: The defined terms every DeepTrade trading skill and agent uses, one name per concept, and the writing rules for these files. Load at the start of every trading session, before the other skills.
user-invocable: false
---

# Trading terms

Each term has one meaning. Other skills use these names and no synonyms. A setting written as `RISK_PER_TRADE_PCT` means `DEEPTRADE_RISK_PER_TRADE_PCT` from the session context. The session context gives the value that applies, from `.env` or the agent profile.

## Positions and prices

| Term | Meaning |
| --- | --- |
| underlying | The ETF or stock. For an option, the security it is on. Strategy levels (VWAP, bands, swings) are on the underlying. |
| instrument | What you buy: shares, or one option contract. |
| entry | The fill price of the instrument. |
| bid | The price an exit gets. Use the bid, not the mark, for every exit decision on an option. |
| peak | The highest bid since entry. Rebuild it from 1-minute option bars after a missed check. Bar highs are trades, so subtract the last spread. |
| key level | A price in the level map of key-levels: PDH, PDL, PDC, ORH, ORL, OPEN, HOD, LOD, or VWAP. |

## Risk

| Term | Meaning |
| --- | --- |
| per-order cap | The most one order may cost. Set by `MAX_ORDER_USD` and `MAX_ORDER_PCT`; the session context gives the active value. It sets the size. |
| loss ceiling | The most one trade may lose: `RISK_PER_TRADE_PCT` percent of what the trade cost. A limit while the setup is valid, never a level to wait for. |
| strategy stop | The stop the strategy sets on the underlying. |
| stop distance | `abs(underlying price at entry − strategy stop)`, on the underlying. Strategies size targets and filters with it. |
| premium stop | The stop on an option's price: the tighter of the strategy's premium stop and the loss ceiling. |
| R | The risk unit. For options, `R = entry − premium stop`. For shares, `R = abs(entry − strategy stop)`. |
| daily loss limit | `DAILY_LOSS_PCT` of start-of-day equity. It stops new entries for the day. |
| daily profit target | `DAILY_PROFIT_TARGET_PCT` of start-of-day equity, in realized profit today. It stops new entries for the day. 0 means no target. |

## Orders

| Term | Meaning |
| --- | --- |
| bank price | `entry + 1 × R`, unless a strategy sets another. |
| bank order | A resting limit sell at the bank price. |
| resting order | An order that waits at the broker: the premium stop as a `stop_market`, or the bank order. Each contract has at most one. |
| bracket | A fixed exit plan from trade-management: a bank order for every contract, the premium stop, the strategy stop, and a time stop. |
| fast path | The order-execution steps that send an order seconds after a signal. |

## Time

| Term | Meaning |
| --- | --- |
| strategy check | A time when a strategy tests its entry rules: :00 and :30 for index-intraday-momentum, each completed 5-minute bar for index-trend-scalp and index-level-scalp. |
| position check | A check of an open position, every `MANAGE_EVERY_MIN` minutes. |
| entry start, entry cutoff | The first and last time a strategy may enter today. Inside the gate's `NO_NEW_ENTRIES_BEFORE` to `NO_NEW_ENTRIES_AFTER` window. |
| agent profile | Settings built into an agent, in `AGENT_PROFILES` in the hooks. They replace the same `.env` keys. The session context marks them "(agent profile)". |
| phase | Where the session is in the trading day: before-open, trading, late, or closed. From session-clock. |
| sellout | A same-day contract's `sellout_datetime` from the broker. The broker closes the position then. |
| effective flat time | The earlier of `FLAT_BY` and 10 minutes before the earliest sellout of an open contract. On an early-close day, `FLAT_BY` moves earlier by as much as the close does. |

## Exits

Defined in trade-management. Names to use on the trade card:

| Exit | When |
| --- | --- |
| strategy stop | The underlying crosses the strategy stop. |
| premium stop | The bid reaches the premium stop. |
| reversal exit | A confirmed reversal, at any stage. |
| counter-trend exit | A short-term turn against the trade, from stage 1. |
| momentum bank | A counter-trend turn in stage 0, with the bid at least 0.5 R up. |
| bank order | The bank order fills. |
| breakeven stop | After the bank, the bid falls back to entry. |
| giveback | The bid falls too far from the peak. |
| time stop | A stage-0 trade makes no new peak for too long. In the bracket: the strategy's minutes since the fill have passed. |
| target | The strategy's target on the underlying. |
| flat time | The effective flat time. |

## Journal

| Term | Meaning |
| --- | --- |
| trade card | The journal entry for one trade: written before the order, completed after the exit. |
| armed card | A trade card written while a setup forms, before its trigger. |

## Writing rules for skills and agents

Based on ASD-STE100 Simplified Technical English.

- One instruction per sentence. Start with the verb: "Exit the position." not "The position should be exited."
- Procedural sentences: 20 words or fewer. Descriptive sentences: 25 words or fewer.
- Use the terms above. Do not use a synonym.
- Write each rule in one skill only. Other skills link to it.
- Give a rule its reason in one short sentence, when the reason changes how to apply it.
- Use a table for a decision with several cases. Use a numbered list for steps in order.
- Label examples "Illustrative only" and use made-up symbols.
