---
name: premarket-scan
description: Build the day's trading shortlist from the plan's watchlist seeds, pre-market movers, news, and scheduled events. Produces 3 to 5 symbols with levels and a reason each. Load at the start of a trading session before the open.
user-invocable: false
---

# Pre-market scan

Goal: a short, defensible list of symbols worth watching today, plus the context that would make you skip them. Fifteen minutes of work, not an hour.

## Steps

1. **Calendar.** Check today's scheduled high-impact US releases (FOMC decisions and minutes, CPI, PCE, jobs report, GDP) and their times. Note them as no-trade windows per the plan. A quick web search for "economic calendar today" is enough.
2. **Market tone.** Pull pre-market quotes for SPY and QQQ through the Robinhood market data tools. Note direction and size of the gap versus yesterday's close. A gap over 1% either way changes how breakouts behave.
3. **Seeds.** For each symbol in the plan's core and candidate lists, fetch pre-market price, change from prior close, and pre-market volume if available. Note prior day high, low, and close.
4. **Movers.** If the broker exposes a movers or top-gainers tool, pull it. Otherwise a web search for "pre-market gainers" fills the gap. Apply the plan's filters: price floor, average volume floor.
5. **News.** For every candidate that survives, one search for news in the last 24 hours. Earnings, guidance, upgrades, FDA, legal. A symbol with a scheduled event during the session is a skip unless the strategy handles it.
6. **Levels.** For each finalist: prior day high and low, pre-market high and low, and any obvious round number nearby. These are the levels the strategies will reference.
7. **Rank and cut.** Keep 3 to 5. Prefer liquidity and a clear reason. Drop anything you cannot explain in one line.

## Output format

Write this to the journal plan section and show it to the user:

```text
Session plan for YYYY-MM-DD
Market: SPY +0.4% pre, QQQ +0.6% pre. CPI at 08:30 already out. No releases during the window.

1. NVDA  pre +1.8% on news X. PDH 131.20 PDL 127.90 PMH 132.05. Watch ORB long above PMH.
2. AAPL  pre flat. PDH 228.10 PDL 225.40. Quiet, keep as backup.
3. TSLA  pre -2.1% after downgrade. PDL 240.00 is key. ORB short only if plan allows shorts; otherwise skip.

Skipped: AMD (earnings after close today), META (range too wide pre-market).
```

## Data availability

Robinhood's Trading MCP provides quotes, positions, and orders. Pre-market volume, movers lists, and economic calendars may not be available from it. Use what the tools return, fill gaps with a web search, and label anything you could not verify as "unavailable." Do not fabricate a number to complete the format.

## Rules

- Never invent a number. Every price comes from a tool call or a cited search result. If a tool fails, say "unavailable."
- Do not add symbols outside the plan's seed list and filters without telling the user why.
- The scan is context, not a signal. A symbol being on the list is never by itself a reason to enter.
