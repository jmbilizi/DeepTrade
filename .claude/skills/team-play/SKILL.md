---
name: team-play
description: How two trading agents share one account as a team. Launch from one main session, the shared team board, the WATCH, HOLD, and HUNT roles, the reversal handoff, ownership of positions, team limits, and the team review. Load when DEEPTRADE_TEAM_SIZE is above 1.
user-invocable: false
---

# Team play

Terms are defined in trading-terms. Two agents trade one account. One may hold a position and protect it. The other hunts for the reversal. When the hunter catches a confirmed reversal, it takes the other side, the holder exits, and the roles swap. The team is judged on the account's total for the day. Each member's stats are for learning, not for competition.

## Safety

The risk gate keeps two members from doubling a position. With `DEEPTRADE_EXPOSURE_GUARD=true`, it allows on the whole account:

- at most `MAX_POSITIONS` option positions,
- one open or pending call and one put,
- one entry at a time.

- Team mode needs the guard and trades options only. If the session context shows `exposure_guard=false`, stop and tell the user.
- A denial that names another agent's position, or the order lock, means your partner got there first. Do not retry that entry. Read the board.

## The board

`journal/YYYY-MM-DD-team.md` is shared by both members. It is append-only, one line per event:

```text
HH:MM:SS | MEMBER | EVENT | details
```

To add a line:

1. Read the file.
2. With the Edit tool, replace the last line with that same line plus your new line.
3. If Edit says the file changed since you read it, your partner just wrote. Read it again and retry.

Never change or delete another line. Create the file with Write only if it does not exist. Do not use a shell append (`>>`). Reason: it asks for permission, and a background partner cannot answer.

| Event | When | Details |
| --- | --- | --- |
| `JOIN` | Session start | Your letter, start equity from `get_portfolio` |
| `ARM` | A setup forms | Symbol, direction, trigger, strategy |
| `ENTRY` | Right after your entry order is sent | Symbol, contract, direction, size, strategy stop, target, strategy |
| `FILL` | Fill confirmed | Price, resting order id ending |
| `FLIP` | Right before an entry opposite to your partner's position | Direction, the signal that confirmed the reversal |
| `EXIT` | Position closed | Price, result in dollars and R, exit name |
| `HALT` | Team daily loss limit reached, or the user stopped trading | Reason |
| `NOTE` | Your partner must know something now | One line |

Read the whole board at the start of each check. The board records who holds what. The broker records what exists. When they disagree, trust the broker and post a `NOTE`.

## Launch from one main session

The user starts one session. It is member `A`. After preflight and the plan, A starts the partner:

1. Add the `JOIN` line for A.
2. Start one partner with the Agent tool: `subagent_type: index-0dte-trader`, in the background. Its prompt starts "Team member B. Do not start other agents." Then give: today's date, the board path, the effective flat time, the symbols, and the plan section of your journal note. Say that preflight is done, so B makes only its own `get_accounts` and `get_portfolio` reads.
3. B adds its `JOIN` line and starts in `WATCH`.

- Only A starts a partner, up to `TEAM_SIZE` members in total. A member whose prompt says "Team member" never starts an agent.
- If B stops or fails, A posts a `NOTE`, trades alone, and tells the user. A may restart B once.
- A user may run members in separate terminals. A session that finds `A` already on today's board joins as the next letter and starts no partner.

Use your letter on every board line. Write your own journal note, `journal/YYYY-MM-DD-<letter>.md`.

## Roles

Find your role from the board and the broker at each check:

| Account state | Your role | What you may open |
| --- | --- | --- |
| The team holds nothing | `WATCH` | Any strategy signal, either direction |
| You hold a position | `HOLD` | Nothing. Manage it with trade-management |
| Your partner holds a position | `HUNT` | Only the opposite direction, only on a flip (below) |

In `WATCH`, both members test every setup. The first entry through the gate takes it. The gate refuses the other, which stands down.

## HUNT

Catch the confirmed reversal early.

1. Read the board and the tape every `MANAGE_EVERY_MIN` minutes, not only at strategy checks.
2. Test for a flip: an opposite entry signal that passes the strategy's flip rules. For index-trend-scalp, that is setup B only, once per symbol per hour for the team, never on an exit bar. "It looks toppy" is not a signal.
3. When your partner's trade-management exits fire (counter-trend exit, giveback), post a `NOTE`.
4. On a flip: add the `FLIP` line, then enter by the order-execution fast path. You now `HOLD`.
5. An opposite signal that fails the flip rules is not a flip. It is still a reversal exit for the holder: post a `NOTE`.

## HOLD and the flip

- A `FLIP` line newer than your entry is a reversal exit. Exit at once by trade-management "How to exit".
- Your own exits work as usual. When you exit first, add `EXIT`. The team is back in `WATCH`.
- After your exit, you `HUNT`.

## Ownership

Close and change only the positions and orders you opened. Two exceptions:

1. A `FLIP` is on the board. The partner's position is still open 2 minutes later, with no partner post since. Close it, and post a `NOTE`.
2. At the effective flat time, each member closes every position and cancels every order on the account. Then confirm the account is flat.

## Team limits

- The daily loss limit is the team's. Measure it from the first `JOIN` line's start equity to the current equity from `get_portfolio`. When it is reached, add `HALT`. After `HALT`, neither member opens a position. Open positions are still managed and closed.
- The gate counts `MAX_ORDERS_PER_DAY` across both members.
- Loss-streak pauses in a strategy count the team's consecutive losses.

## Direct messages

A knows B from the Agent tool, and B can find A with `ListAgents`. If you have `SendMessage`, also send `FLIP`, `HALT`, and urgent `NOTE` lines as messages. Reason: messages can arrive before the next check. The board is still the record.

## Review

Each member writes its review in its own note. Member `A` adds the team review to the board as `NOTE` lines: team net in dollars and R, trades per member, each flip and its result, late handoffs (a holder exit more than 1 minute after a `FLIP`), and one question for the user.

## What this is bad at

- A flip pays two spreads at once. A false reversal costs both.
- Two sessions use about twice the Claude usage of one.
- The board is read at each check, so a handoff can wait up to one check interval.
