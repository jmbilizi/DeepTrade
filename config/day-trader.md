# Day Trader plan

The Day Trader agent reads this file at the start of every session and follows it. Edit freely. Numbers that must be enforced by code live in `.env`, not here.

> Every symbol, percentage, time, and threshold in this file is a placeholder to show the format. None of it is financial or trading advice or a recommendation to trade any instrument. Replace all of it with your own decisions. See [DISCLAIMER.md](../DISCLAIMER.md).

## Account

- Broker: Robinhood agentic account via the Robinhood Trading MCP.
- Capital the agent may work with this session: the agentic account's available cash. Never touch other accounts.
- Instruments allowed: US equities. Options and crypto are off unless you list them here.

## Session

- Market timezone: America/New_York.
- Pre-session prep window: 09:00 to 09:30.
- New entries allowed: 09:35 to 15:00. Each enabled strategy may narrow this further.
- Manage only: 15:00 to 15:50. No new entries, work existing positions toward stop, target, or close.
- Flat by: 15:50. Close everything, no overnight holds.
- Check cadence while waiting for setups: every 5 minutes during the trading window.

## Watchlist

The agent builds a shortlist each morning with the premarket-scan skill, starting from these. The tickers below are format examples only, not suggestions. Use your own.

- Core: SPY, QQQ
- Candidates: AAPL, MSFT, NVDA, AMZN, TSLA, AMD, META
- Also consider: top pre-market gappers with news, price above $10, average volume above 2M shares

If `DEEPTRADE_ALLOWED_SYMBOLS` is set in `.env`, the risk gate will refuse orders for anything not on that list, whatever this file says.

Keep the final list to 3 to 5 names.

## Strategies enabled

- opening-range-breakout

List one skill name per line. The agent only takes setups defined by an enabled strategy.

## Risk

- Risk per trade: 0.5% of agentic account equity, measured from entry to stop.
- Maximum concurrent positions: 2.
- Maximum trades per session: 4. The hook's `DEEPTRADE_MAX_ORDERS_PER_DAY` counts opening orders only, so it can match this number directly. Exits never count.
- Daily stop: if realized losses reach 1.5% of equity, stop trading for the day and write the review.
- Position sizing: use the position-sizing skill. Fractional shares are allowed.

## No-trade conditions

- First 5 minutes after the open.
- Within 10 minutes before or after a scheduled high-impact release (FOMC, CPI, jobs report).
- Spread wider than 0.1% of price.
- Robinhood MCP returning errors or stale quotes.
- Any day the user says "no trading today."

## Communication

- One or two lines per status update. Report: time, symbol, what you see, what you will do.
- Before each order: symbol, side, size, entry, stop, target, risk in dollars, and the strategy rule that justifies it.
- End of session: a short review using the trade-journal skill.
