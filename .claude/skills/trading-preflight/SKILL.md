---
name: trading-preflight
description: Pre-session checks every trading agent runs before any market action. Confirms settings, broker connection, account state, what the account can trade per asset class, trade-approval mode, leftovers from earlier sessions, and whether each enabled strategy has the data it needs. Load at the start of every trading session, whatever the trading style.
user-invocable: false
---

# Trading preflight

Run these in order and report the result in a few lines. Stop at the first failure and tell the user what to fix. A setting written as `RISK_PER_TRADE_PCT` means `DEEPTRADE_RISK_PER_TRADE_PCT` from the session context.

## 1. Settings

Read the session context. If it says `.env` is missing or lists settings problems, report them and stop until the user fixes `.env`. Never read `.env` directly; it can hold API keys.

## 2. Broker connection and account

Call `get_accounts`. Use the one account the broker marks as tradable by you. If the call fails, tell the user to run `/mcp` and reconnect, and stop.

Then call `get_portfolio` for that account. A hook records equity, buying power, and cash from the response for the risk gate. Never write account numbers into a file yourself.

Fetch open positions and open orders. If any are left from an earlier session, ask the user what to do with them before new trades.

## 3. What the account can trade

For each class in `ALLOWED_ASSET_CLASSES`, confirm the account can trade it from what the broker reports. Never place an order to find out.

| Class | Robinhood check |
| --- | --- |
| `equity` | Account is active. Shorting only if `ALLOW_SHORTS` is true and the account supports it. |
| `option` | `option_level` from `get_accounts`. Empty or `option_level_0`: none. Level 2: buy calls and puts, covered calls, cash-secured puts. Level 3: adds spreads. |
| `crypto` | `crypto_buying_power` present in `get_portfolio`. |

If a class is allowed in `.env` but the account cannot trade it, or the tools cannot confirm it, tell the user in one line and drop it for the session. For example: "Options are allowed in .env but this account has no options approval. Trading equity only today."

Read `get_trade_approval_setting`. If approvals are on, tell the user each order will wait for their approval in the Robinhood app.

## 4. Market and day

Note the date, market status, and orders already journaled today from the session context. If the market is closed for the day, say so and offer research mode.

## 5. Strategies

For each strategy in `STRATEGIES`, load its skill and confirm:

- the connected tools return the market data it lists, and
- it supports at least one class the account can trade from step 3.

Optional data sources the session context lists as configured may fill a strategy's data needs. Ones listed as not configured are skipped without comment. If a strategy cannot run, say why and do not trade it.

## Broker specifics

Robinhood tool names were observed on 2026-11-03. If a call here returns "tool not found", list the tools you have, use the closest read-only equivalent, and tell the user the names changed.
