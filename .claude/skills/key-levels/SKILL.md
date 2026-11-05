---
name: key-levels
description: The level map for an index ETF session. Prior-day high, low, and close, the opening range, today's open, the session high and low, and VWAP, with how to compute each from broker bars and keep the map current. Load when a strategy trades reactions at levels, or when premarket-scan needs levels.
user-invocable: false
---

# Key levels

Terms are defined in trading-terms. A key level is a price where many traders act. Strategies trade the reaction there: a rejection or a break that holds. A level is never a signal on its own.

## The level map

Compute the map for each allowed symbol. Use regular-session 5-minute bars from `get_equity_historicals`, with `bounds: "regular"`.

| Level | Name | Source | Known from |
| --- | --- | --- | --- |
| Prior-day high | PDH | Highest high of the prior session | Before the open |
| Prior-day low | PDL | Lowest low of the prior session | Before the open |
| Prior-day close | PDC | Close of the prior session's last bar | Before the open |
| Opening range high | ORH | Highest high of the first three 5-minute bars (09:30 to 09:45) | 09:45 |
| Opening range low | ORL | Lowest low of the same three bars | 09:45 |
| Today's open | OPEN | Open of the first 5-minute bar | 09:30 |
| Session high | HOD | Highest high of the bars before the signal bar | Each bar |
| Session low | LOD | Lowest low of the bars before the signal bar | Each bar |
| VWAP | VWAP | Session VWAP at the signal bar (intraday-technicals) | Each bar |

- Use the regular session only. Pre-market prices are context, not levels here. Reason: the replay tested regular-session levels only.
- HOD and LOD exclude the signal bar. Reason: a bar cannot reject a high it sets itself.
- Test levels in the table's order. The first level with a setup decides the signal.
- Use the prior session from the broker's bars. After a holiday, it is the last trading session.

## Before the open

1. Fetch the prior session's 5-minute bars for each allowed symbol.
2. Write PDH, PDL, and PDC in the journal plan.
3. At 09:45, add ORH and ORL.

Keep HOD, LOD, and VWAP current at each strategy check. Do not write them to the journal unless a setup uses them.

## Reporting

One line per symbol in the plan. Illustrative only: `XYZ PDH 501.20 PDL 496.40 PDC 499.10 OPEN 500.05`.

## What this is bad at

- Levels close together. Two levels within 0.25 × ATR(14, 5-minute) act as one zone. The first one in the table's order is tested.
- Trend days far from every level. Then few setups form.
- The list is fixed. Round numbers and multi-day levels are not in it. They were not tested.
