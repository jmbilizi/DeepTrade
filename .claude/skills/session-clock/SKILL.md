---
name: session-clock
description: How a trading agent finds its place in the trading day from whenever it is launched, and how it waits. Run tools/clock.js for the phase, the entry window, and the next check, then sleep exactly to it. Load at the start of every trading session.
user-invocable: false
---

# Session clock

Terms are defined in trading-terms. The user can start you at any time: before dawn, mid-session, or after the close. Do not assume a start time. Ask the clock.

## Read the clock

Run `node tools/clock.js --agent <your agent name>` at launch and after every wait. One line comes back:

- The market time and the day: regular, early close, holiday, or weekend, from the NYSE calendar.
- The phase.
- The entry window: the gate window, narrowed by your strategies.
- The next check, and the seconds until it.

At the first check of the session, compare the clock with the venue time of a fresh quote. If they differ by more than 60 seconds, tell the user, and use the broker's time.

## Phases

| Phase | Do |
| --- | --- |
| before-open | Run your preparation. Then wait for the next check. Options trade only in regular hours. Pre-market is for preparation, not for orders. |
| trading | If you have not prepared, prepare at once. Run your checks. |
| late | No strategy can enter again today. Manage any position to its exit. Tell the user, and offer research mode. |
| closed | Research mode. Tell the user when the next session opens. |

## Wait

| Case | Command | Bash tool |
| --- | --- | --- |
| Under 10 minutes to the next check | `node tools/clock.js --agent <name> --wait` | Timeout 600000 ms |
| A position is open | Add `--every 1m` | Timeout 600000 ms |
| Over 10 minutes, and no position is open | Add `--max <seconds to the next check + 60>` | `run_in_background: true`. Then end your turn. |

A background wait wakes you when it exits. Do not poll it. Reason: each poll is a turn that costs tokens and adds nothing.

Never wait in the background with a position open. Reason: position checks run every minute.

## After a wait

1. Read the new line. Act on its phase.
2. If it says "WOKE ... LATE", the machine slept or the shell stopped. Rebuild the missed bars before you act. Journal it.
3. If it says "wait capped", run the wait again.

## What this is bad at

- It uses the computer's clock. The broker's time decides when they disagree.
- A background wait ends if the user closes Claude Code. Tell the user to keep the session and the computer awake.
- Strategy windows come from `tools/replay/strategies.js`. A strategy without a window there falls back to the gate window, and the clock says so.
