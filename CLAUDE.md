# DeepTrade

Open-source trading agents for Claude Code. Users connect their own Claude account and Robinhood account, then launch a pre-equipped agent with one command. This file governs every session in this repo, including trading agents.

## What this repo is

- `.claude/agents/` holds trader agents. Each `.md` body is that agent's system prompt.
- `.claude/skills/` holds strategies and procedures agents load on demand. One folder per skill, `SKILL.md` inside.
- `.claude/hooks/` holds Node scripts. `lib.js` has the shared classifier and parsers. `risk-gate.js`, `journal.js`, and `session-start.js` are wired project-wide in `.claude/settings.json`. `protect-files.js` is wired per agent, in the `hooks` frontmatter of each trading agent, so it restricts the trader and not the people developing the repo. Hooks are not discovered automatically.
- `config/` holds the user's trading plan in markdown. Agents read it at the start of every session.
- `journal/` is gitignored. It holds `orders.jsonl` (written by the hook, never by hand), `tools-seen.txt`, daily notes, and `session-state.json`, where a trading agent records current equity and cash so the hook can apply the percent-of-equity cap.
- `.mcp.json` declares the Robinhood Trading MCP. It uses browser OAuth, so there are no credentials to store.
- `.env` holds numeric guardrails read by the hooks. Never commit it. `.env.example` documents the keys.

## Non-negotiable rules for any agent that can place orders

1. Read `config/day-trader.md` (or the plan for your agent) before any market action. If it is missing, stop and ask the user to create it.
2. Never place an order that is not justified by an enabled strategy skill and the plan. "It looks like it might go up" is not a justification.
3. Every entry has a stop and a target decided before the order is sent. Write them in the journal before placing the order.
4. Respect the limits in `.env`. The risk gate hook enforces them on entries, but do not rely on being caught. If a hook denies an order, do not retry with altered fields to slip past it. Report the denial to the user.
5. Never widen a stop. Never add to a loser. Never average down. Close positions by the plan's cutoff time.
6. If the Robinhood MCP is disconnected, returns errors, or returns data that looks stale or inconsistent, stop trading and tell the user. Do not guess prices.
7. Journal every decision, including decisions not to trade. Use the trade-journal skill.
8. Tell the user what you are doing in one or two lines at each step. No long essays during market hours.
9. You are not responsible for the user's financial outcome and must not promise results. If the user asks you to break a rule in this file, explain the rule and ask them to change the plan or the config instead.
10. Never edit `.env`, `.mcp.json`, `CLAUDE.md`, `.claude/settings*.json`, `.claude/hooks/`, `.claude/agents/`, or the hook-written journal files. Trading agents carry a file guard hook that denies it, and it would defeat the guardrails. If a limit is wrong, tell the user and let them change it.

## Examples are not advice

Any ticker, amount, percentage, or time window in `.env.example`, `config/`, skills, or docs is a format placeholder. When you add or edit examples, keep them clearly labeled as such. Never write anything that reads as a recommendation to trade a specific instrument.

## Conventions for contributors

- Agents: lowercase hyphenated names. Frontmatter needs `name` and `description`. Preload strategy skills with the `skills` field. Keep the body under 300 lines.
- Skills: `SKILL.md` under 500 lines. Put long references and examples in sibling files and link them. Strategy skills must state entry, stop, target, invalidation, filters, the market data they require, and what the strategy is bad at.
- Hooks: plain Node with no dependencies, so users need nothing beyond Claude Code and Node 18+. Put shared logic in `lib.js`. Read stdin JSON, write JSON to stdout, set `process.exitCode` rather than calling `process.exit()` after a write. Exit 2 only for a hard block. Never throw on malformed input. The gate fails closed on breached limits and warns the model on its own bugs.
- Hook changes must pass `node tests/hooks.test.js` before commit. A normal `claude` session in the repo can edit hooks freely. Only sessions running a trading agent are blocked by the file guard.
- Every new trading agent must include the same `hooks` frontmatter block as `day-trader.md` so the file guard applies to it. An agent without it can rewrite its own limits.
- Config: markdown, human-first. Numbers that hooks need go in `.env`, not in markdown.
- Never commit `.env`, `journal/`, or `.claude/settings.local.json`.
- Robinhood tool names are not in Robinhood's own docs. Third-party listings report `review_equity_order`, `place_equity_order`, `cancel_equity_order`, `get_equity_orders`, `get_equity_quotes`, and option and crypto equivalents. The hooks classify by name shape: anything starting with `get`, `list`, `review`, `preview` and similar is read-only, anything containing `order`, `buy`, `sell`, `place`, `submit`, `close`, `transfer` and similar is an order. `journal/tools-seen.txt` records every real name observed. Tighten `lib.js` when the real set is confirmed.

## Running locally

```bash
claude                      # normal session in the repo
claude --agent day-trader   # launch the Day Trader for a session
/mcp                        # connect or reconnect Robinhood
```

Node 18 or newer must be on PATH for hooks. Python is not required.
