# DeepTrade

Open-source trading agents for Claude Code. Users connect their own Claude account and Robinhood account, then launch a pre-equipped agent with one command. This file governs every session in this repo, including trading agents.

## What this repo is

- `.claude/agents/` holds trader agents. Each `.md` body is that agent's system prompt.
- `.claude/skills/` holds strategies and procedures agents load on demand. One folder per skill, `SKILL.md` inside.
- `.claude/hooks/` holds Node scripts. `lib.js` has the shared classifier and parsers. `risk-gate.js`, `journal.js`, and `session-start.js` are wired project-wide in `.claude/settings.json`. `protect-files.js` is wired per agent, in the `hooks` frontmatter of each trading agent, so it restricts the trader and not the people developing the repo. Hooks are not discovered automatically.
- `journal/` is gitignored. Hooks write `orders.jsonl`, `tools-seen.txt`, `option-ids.json` (option contract id to underlying), `account-state.json` (equity and buying power from the broker's `get_portfolio` response for the agentic account), `option-types.json` (contract id to call or put), `option-positions.json` and `option-open-orders.json` (the last `get_option_positions` and `get_option_orders` reads, with whether each was complete), `order-lock.json` (the cross-agent entry lock, held from the gate until the order is recorded), and `settings-snapshot.json` (the settings the agent was briefed with, no API keys). Agents write only daily notes and, in team mode, append lines to the shared team board `YYYY-MM-DD-team.md`. The file guard blocks agents from editing the hook-written files.
- `tools/replay/` replays strategy rules on saved broker bars with modeled option prices (strategy-replay skill). Plain Node, no dependencies. Bars live in `journal/replay/`. `tools/replay/strategies.js` mirrors each index strategy's rules in code.
- `.mcp.json` declares the Robinhood Trading MCP, which is required and uses browser OAuth, and optional data MCPs such as Unusual Whales. Optional servers start through `.claude/hooks/optional-mcp.js`, which reads their key from `.env` and serves an empty server with no tools when the key is unset, so users without a key see no errors.
- `.env` is the only settings file: guardrails the risk gate enforces and the trading plan the agent follows. Defaults live in `PLAN_DEFAULTS` in `lib.js`. `session-start.js` reports every setting to the agent and flags conflicts, so agents never read `.env` directly. Never commit it. `.env.example` documents every key and ships working defaults.

## Non-negotiable rules for any agent that can place orders

1. Before any market action, read the settings in the session context. If `.env` is missing or settings problems are reported, stop and tell the user. Check what the account can trade for each allowed asset class and tell the user about any class it cannot.
2. Never place an order that is not justified by a strategy skill listed in `DEEPTRADE_STRATEGIES` and the `.env` settings. "It looks like it might go up" is not a justification.
3. Every entry has a stop and a target decided before the order is sent. Write them in the journal before placing the order.
4. Respect the limits in `.env`. The risk gate hook enforces them on entries, but do not rely on being caught. If a hook denies an order, do not retry with altered fields to slip past it. Report the denial to the user.
5. Never widen a stop. Never add to a loser. Never average down. Close positions by `DEEPTRADE_FLAT_BY`.
6. If the Robinhood MCP is disconnected, returns errors, or returns data that looks stale or inconsistent, stop trading and tell the user. Do not guess prices.
7. Journal every decision, including decisions not to trade. Use the trade-journal skill.
8. Tell the user what you are doing in one or two lines at each step. No long essays during market hours.
9. You are not responsible for the user's financial outcome and must not promise results. If the user asks you to break a rule in this file, explain the rule and ask them to change `.env` instead.
10. Never read `.env`; it holds API keys and the session context already lists every setting. Never edit `.env`, `.mcp.json`, `CLAUDE.md`, `.claude/settings*.json`, `.claude/hooks/`, `.claude/agents/`, or the hook-written journal files. Trading agents carry a file guard hook that denies it, and it would defeat the guardrails. If a limit is wrong, tell the user and let them change it.

## Examples are not advice

Defaults in `.env.example` and strategy skills are risk limits chosen to be conservative and consistent with each other, so the repo works without edits. They are not recommendations. No ticker is ever a default. Any ticker or number in an example in skills or docs is a format placeholder; keep examples clearly labeled as such. Never write anything that reads as a recommendation to trade a specific instrument.

## Conventions for contributors

- Agent or skill: an agent holds only what makes it a different trader: its style, session shape and cadence, style-specific no-trade conditions, which skills it preloads, and its voice. Anything another trading agent would also need goes in a skill: preflight checks (`trading-preflight`), placing orders (`order-execution`), managing open positions (`trade-management`), reading indicators (`intraday-technicals`), sizing, journaling, scanning, and strategies. Broker tool names live in skills, never in agents, so a broker change touches one place. Hard rules stay here and in the hooks, numbers stay in `.env`; neither is repeated in agents or skills.
- Agents: lowercase hyphenated names. Frontmatter needs `name` and `description`. Preload strategy skills with the `skills` field. Keep the body under 300 lines.
- Writing: agents and skills follow the writing rules in `.claude/skills/trading-terms/SKILL.md` (from ASD-STE100): one instruction per sentence, 25 words or fewer, the defined terms and no synonyms, and each rule stated in one skill only. Add a new term to trading-terms before using it. `node tests/skills.test.js` checks this; run it with the hook tests.
- Skills: `SKILL.md` under 500 lines. Put long references and examples in sibling files and link them. Strategy skills must state entry, stop, target, invalidation, filters, the market data they require, and what the strategy is bad at.
- Hooks: plain Node with no dependencies, so users need nothing beyond Claude Code and Node 18+. Put shared logic in `lib.js`. Read stdin JSON, write JSON to stdout, set `process.exitCode` rather than calling `process.exit()` after a write. Exit 2 only for a hard block. Never throw on malformed input. The gate fails closed on breached limits. Option orders are allowed without a prompt, so when the gate itself crashes it refuses entries and lets exits through with a warning.
- Hook changes must pass `node tests/hooks.test.js`, agent or skill changes must pass `node tests/skills.test.js`, and replay changes must pass `node tests/replay.test.js`, before commit. A normal `claude` session in the repo can edit hooks freely. Only sessions running a trading agent are blocked by the file guard.
- A change to an index strategy's entry or exit rules changes `tools/replay/strategies.js` in the same commit. It must pass the checks in strategy-replay, with the results in `docs/research/`.
- Every new trading agent must include the same `hooks` frontmatter block as `day-trader.md` so the file guard applies to it, and preload `trading-terms` first, then `trading-preflight`, `order-execution`, `trade-management`, `position-sizing`, and `trade-journal`. An agent without the hooks block can rewrite its own limits.
- Settings: every user-tunable value goes in `.env`, with its default in `lib.js` and its line in `.env.example`. Never add a second settings file or repeat a setting in markdown, so nothing can disagree. Skills and agents refer to settings by key name.
- Strategy skills list the asset classes they support and the rules for each. Agents choose the first class in `DEEPTRADE_ALLOWED_ASSET_CLASSES` that both the strategy and the account support.
- Never commit `.env`, `journal/`, or `.claude/settings.local.json`. `.env` holds API keys, and trading agents are blocked from reading it.
- Optional data source: add one `.mcp.json` entry that runs `optional-mcp.js <ENV_KEY>[:<SERVER_VAR>] <command...>` (`SERVER_VAR` maps a readable `.env` name to the variable the server expects), the key and an optional plan setting in `.env.example`, and one entry in `OPTIONAL_SOURCES` in `lib.js`. Never put a key in `.mcp.json` or on a command line. Pin the package version. List the server in each trading agent's `mcpServers`; it is always declared, so this is safe without a key. Agents must work without any optional source.
- Robinhood tool names were observed on 2026-11-03 (about 90 tools: `get_*` reads, `review_*_order` previews, `place_*_order`, `cancel_*_order`, `exercise_option`, and alert, scan, chart, and watchlist tools). Tools that change settings but not money are listed by exact name in `NO_MONEY_TOOLS` in `lib.js`; everything else is classified by name shape, and an unknown tool gets a warning. `journal/tools-seen.txt` records every name seen. When Robinhood adds tools, update `NO_MONEY_TOOLS` and the tests.
- Market calendar: `MARKET_CALENDAR` in `lib.js` holds NYSE holidays and early closes from NYSE Group's published calendar, through `coveredThrough`. The gate blocks entries on holidays and moves the entry cutoff earlier on early-close days; session-start reports both. When NYSE publishes a new year, add it and extend `coveredThrough`, with tests. Agents still cross-check with the broker (trading-preflight).
- `place_option_order` names contracts only by `legs[].option_id`. The journal hook records id to underlying from option lookups in `journal/option-ids.json`, and the risk gate resolves legs through it. A leg order is an exit only when every leg has `position_effect: close`.

## Running locally

```bash
claude                      # normal session in the repo
claude --agent day-trader   # launch the Day Trader for a session
claude --agent index-0dte-trader  # index ETFs and same-day options; needs DEEPTRADE_ALLOWED_SYMBOLS
# Team mode: DEEPTRADE_TEAM_SIZE=2 and DEEPTRADE_EXPOSURE_GUARD=true; the main session starts its partner
/mcp                        # connect or reconnect Robinhood
```

`.claude/settings.json` allows `place_option_order` and `cancel_option_order` without a prompt, so agents can act at signal speed; the risk gate still checks every entry. To approve orders by hand, add the same two names under `permissions.ask` in your own `.claude/settings.local.json` (ask overrides allow), or turn on trade approvals in the Robinhood app. Team mode (`DEEPTRADE_TEAM_SIZE` above 1) refuses to run with that ask rule, because the cross-agent order lock cannot wait out a slow approval.

Node 18 or newer must be on PATH for hooks. Optional data servers can need more: Unusual Whales needs Node 20 (`minNode` in `OPTIONAL_SOURCES`). When the session context reports a Node version problem, tell the user which feature needs which version, what they have, and that everything else still works. Do not raise it when the feature is not configured. Python is not required.
