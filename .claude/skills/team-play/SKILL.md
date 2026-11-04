---
name: team-play
description: How two trading agents share one account as a team. Joining, the shared team board in journal/, the WATCH, HOLD, and HUNT roles, the reversal handoff where the hunter flips and the holder exits, ownership of positions, team-wide limits, and the team review. Load when DEEPTRADE_TEAM_SIZE is above 1.
user-invocable: false
---

# Team play

Two agents trade one account. At any moment one may hold a position and protect it; the other hunts for the reversal. When the hunter catches a confirmed reversal, it takes the other side and the holder gets out, and the roles swap. The team wins or loses on the account's total for the day. Each member's own stats are kept for learning, not to compete on.

A setting written as `TEAM_SIZE` means `DEEPTRADE_TEAM_SIZE`.

## Safety comes from the gate

With `DEEPTRADE_EXPOSURE_GUARD=true`, the risk gate checks every option entry against the broker's positions and resting orders for the whole account: `MAX_POSITIONS`, at most one open or pending call and one put, and one entry through the gate at a time. Team mode requires the guard and trades options only. If the session context shows `exposure_guard=false` with `TEAM_SIZE` above 1, stop and tell the user. A gate denial that names another agent's position or the order lock means your partner got there first. Do not retry the same entry; read the board.

## The board

`journal/YYYY-MM-DD-team.md`, shared by both members. **Append only**, one line per event. Write with the Edit tool (the project settings allow it for `journal/`): read the file, then replace its last line with that same line plus your new line. If Edit reports the file changed since you read it, your partner just wrote: read it again and retry. Never rewrite or delete other lines. A shell append (`>>`) would prompt for permission, which a background partner cannot answer. Create the file with Write only if it does not exist yet.

```text
HH:MM:SS | MEMBER | EVENT | details
```

| Event | When | Details |
| --- | --- | --- |
| `JOIN` | Session start | Your member name, start equity from `get_portfolio` |
| `ARM` | A setup is forming | Symbol, direction, trigger, strategy |
| `ENTRY` | Right after your entry order is sent | Symbol, contract, direction, size, stop, target, strategy |
| `FILL` | Fill confirmed | Price, bank order id ending |
| `FLIP` | Right before you send an entry opposite to your partner's position | Direction, the signal that confirmed the reversal |
| `EXIT` | Position closed | Price, result in dollars and R, exit reason |
| `HALT` | Team daily loss limit reached, or the user stopped trading | Reason |
| `NOTE` | Anything your partner must know now | One line |

Read the whole board at the start of every check. It is the record of who holds what. Positions and orders at the broker are the record of what exists; when they disagree, trust the broker and post a `NOTE`.

## Launching: one main session

The user starts one session. That session is member `A`, the main. After preflight and the plan, A starts the partner itself:

1. Append `JOIN` for A to the board.
2. Start one partner with the Agent tool, `subagent_type: index-0dte-trader` (the same agent type as you), in the background. Its prompt says, in this order: "Team member B. Do not start other agents." Then today's date, the board path, the effective flat time, the symbols, the plan section of your journal note to copy, and that preflight is done and settings are in force, so B skips it except for its own `get_accounts` and `get_portfolio` reads.
3. B appends its own `JOIN` and starts its loop in `WATCH`.

Only A starts partners, and only up to `TEAM_SIZE` members in total. A member started with a "Team member" prompt never starts another agent. If B stops or errors, A posts a `NOTE`, keeps trading alone, and tells the user; A may restart B once.

The user can still run members in separate terminals instead: a session that finds an `A` already joined on today's board joins as the first unused letter and does not start a partner.

## Joining

Use your letter on every line and in your journal note. Each member keeps its own journal note `journal/YYYY-MM-DD-<letter>.md`, so the two never write the same file.

## Roles

Your role follows from the board and the broker, checked every time:

| Account state | Your role | What you may open |
| --- | --- | --- |
| No position held by the team | `WATCH` | Any strategy signal, either direction |
| You hold a position | `HOLD` | Nothing. Manage it with trade-management |
| Your partner holds a position | `HUNT` | Only the opposite direction, only on a reversal signal (below) |

In `WATCH`, both members read every setup. Whoever's entry passes the gate first takes it; the other is denied by the one-per-direction rule and stands down. Never two positions in the same direction.

## Hunting the reversal

While your partner holds, your one job is to catch a confirmed reversal early.

- Read the board and the tape every `MANAGE_EVERY_MIN` minutes, not only at strategy check times.
- A confirmed reversal is an enabled strategy's entry signal in the opposite direction: for index-trend-scalp, setup B (VWAP reclaim); for index-intraday-momentum, a break of the opposite band. "It looks toppy" is not a reversal.
- Watch your partner's trade-management triggers too (counter-trend exit, giveback). When they fire, post a `NOTE` so the holder sees it at its next check.

When the reversal confirms: append `FLIP`, then send your entry by the order-execution fast path. You now `HOLD`.

## The holder's side of a flip

- On reading a `FLIP` line newer than your entry, exit at once with the trade-management exit procedure. Exit reason: `partner reversal`.
- Your own ladder exits keep working as normal. If you exit first, append `EXIT`; the team is back in `WATCH`.
- After a flip and your exit, you `HUNT`: the reversal of the reversal is now your job.

## Ownership

- You manage and close only positions you opened, with two exceptions:
  1. A `FLIP` is on the board, the partner's position is still open 2 minutes later, and the partner posted nothing since. Close it, post `NOTE` saying so.
  2. The effective flat time. Every member closes every position and cancels every order on the account, then confirms the account is flat.
- Never cancel or replace a partner's resting order, except under those two exceptions.

## Team limits

- `DAILY_LOSS_PCT` is for the team: measure it from the first `JOIN` line's start equity against current equity from `get_portfolio`. When it is reached, append `HALT`. A `HALT` line stops new entries for both members; open positions are still managed and closed.
- `MAX_ORDERS_PER_DAY` is counted by the gate across both members.
- Strategy loss-streak pauses count the team's consecutive losses, not just yours.

## Talking directly

If your tools include `SendMessage` and you can address your partner (A knows B from the Agent tool; B can use `ListAgents`), also send `FLIP`, `HALT`, and urgent `NOTE` lines as a message, for speed. The board stays the record; a message never replaces a board line.

## Review

At the end, each member writes its review in its own note. Member `A` also appends a team review to the board as `NOTE` lines: team net in dollars and R, trades per member, flips taken and how each one did, handoffs that were late (a holder exit more than 1 minute after a `FLIP`), and one question for the user.

## What this is bad at

- Each flip pays two spreads at once, the exit and the new entry. A false reversal costs both.
- Two sessions use about twice the Claude usage of one.
- The board is read on each check, so a handoff can lag by up to one check interval.
