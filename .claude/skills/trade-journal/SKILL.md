---
name: trade-journal
description: How trading agents record the session plan, each trade card, decisions not to trade, and the end-of-day review in journal/. Load whenever something needs to be written to the journal or the user asks for a review of past sessions.
user-invocable: false
---

# Trade journal

Two records exist. The hook writes one automatically. You write the other.

## Automatic record

`journal/orders.jsonl` is appended by `.claude/hooks/journal.js` on every order and cancel tool call, with the request and response, account numbers redacted. Each record carries `gated` (true for opening orders, which count toward the daily cap) and `reducing` (true for exits). You never edit it. You may read it to reconcile fills or count today's orders. `journal/tools-seen.txt` lists every Robinhood tool name the hooks have observed.

## Your record

`journal/YYYY-MM-DD.md`, one file per session, created during the pre-session checklist. Three sections, in this order.

### Plan

Written before the open. The output of the premarket-scan skill, plus the plan's key numbers for the day: equity at start, risk per trade in dollars, max positions, flat-by time, and the guardrails reported at session start.

### Trades

One card per trade, written **before** the entry order is sent and completed after the exit. Decisions not to trade a signal also get a short card, because skipped setups are how strategies get improved.

```markdown
#### 10:05 XYZ long — opening-range-breakout

- Setup: 5m close 132.40 above ORH 132.05 (ORL 130.80, range 1.25 = 0.95%), vol 1.9x, VWAP 131.60.
- Entry limit 132.15  Stop 130.80  Target 133.93 (ORH + 1.5 x range)  Risk/sh 1.35  Reward/sh 1.78  R:R 1.32
- Size 3.02 sh. Risk budget allowed 14.8 sh; cap $400 (10% of $4,000 equity) bound it. Risk at stop $4.08.
- Plan line: "Strategies enabled: opening-range-breakout"; risk 0.5%.
- Risk gate: passed, est $399.09 within $400.00.
- Fill: 132.15 at 10:05:41.
- Exit: 133.93 target at 10:52. Result +$5.38, +1.32R.
- Notes: clean. Volume faded after 10:30; a trailing stop at 1R would have given the same result.

Symbols and numbers above are illustrative only.
```

For a skipped signal:

```markdown
#### 09:50 ABC — skipped

- ORB short triggered at 239.80 but plan allows longs only. No trade.
```

### Review

Written after flat. Keep it to ten lines.

- Trades taken, wins, losses, net result in dollars and R.
- Rules followed or broken. Be specific. "Moved stop early on AAPL" is useful. "Could be more disciplined" is not.
- One observation about the market that affected results.
- One change to consider, framed as a question for the user, never applied by you. Strategy and plan edits are the user's decision.
- Anything the user needs to act on: unsettled cash, a leftover position, a hook denial to investigate.

## Reviewing past sessions

When asked, read the last N daily notes and `orders.jsonl`, reconcile them, and report: win rate, average R, largest loss, most common rule break, and whether skipped signals would have helped or hurt. Numbers only from the files. If the files disagree, say which one you trusted and why.

## Hygiene

- Never record account numbers or anything that looks like a credential.
- Never delete or rewrite past entries. Append corrections with a timestamp.
- The journal is gitignored. Remind the user to back it up if they care about it.
