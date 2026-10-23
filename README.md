# DeepTrade

Claude Code for trading. Open-source agents, strategies, and guardrails that turn Claude into a trader working in your own brokerage account.

You bring a Claude account and a Robinhood account. The repo brings the agents, the skills they use, the hooks that help keep them inside your limits, and a journal of everything they do. One command launches an agent. Everything it does is yours to read, change, or delete.

> **Read [DISCLAIMER.md](DISCLAIMER.md) first.** This software places real orders with real money. It is not financial advice. The authors are not responsible for your trades, your losses, or your account. Use only money you can afford to lose.
>
> Any ticker symbol, dollar amount, percentage, or strategy that appears in this repo's examples, templates, or config files exists only to show the format. None of it is a recommendation to buy, sell, or trade anything.

## How it works

```text
you ──► claude --agent day-trader
            │
            ├── reads config/day-trader.md         your trading plan
            ├── loads skills/                      strategies and procedures
            ├── calls Robinhood Trading MCP        market data, account, orders
            │       │
            │       └── .claude/hooks/risk-gate.js  denies entries outside .env limits
            │
            └── writes journal/                    every order and every decision
```

The model decides. Code checks. Every opening order passes through a deterministic hook that compares it to your limits before it reaches the broker, and Claude Code's own permission prompt asks you before each order unless you choose to allow it. Exits are never blocked by the hook, so the agent can always get flat.

## Prerequisites

- [Claude Code](https://code.claude.com) 2.1.295 or newer, signed in.
- Node.js 18 or newer on your PATH. The hooks are plain Node scripts. If Node is missing, the risk gate cannot run and order calls are blocked rather than allowed.
- A Robinhood individual account in good standing that has access to Agentic Trading. It is rolling out gradually, so not every account is eligible yet.
- A desktop. Robinhood's agent authentication flow has been reported to work only from a desktop browser, not a phone.

## Quick start

1. **Clone and open.**
   ```bash
   git clone https://github.com/jmbilizi/DeepTrade.git
   cd DeepTrade
   claude
   ```
   Accept the workspace trust dialog and approve the project's MCP server when Claude Code asks. Both are needed for the hooks and permission rules in this repo to take effect.
2. **Connect Robinhood.** Inside Claude Code run `/mcp`, pick `robinhood-trading`, and sign in. Robinhood walks you through opening a dedicated agentic account, agreeing to its terms, and funding it. Only that account can be traded by the agent.
3. **Set your limits.** Copy the example file and edit the numbers. These are hard caps enforced by the risk gate hook.
   ```bash
   cp .env.example .env        # macOS, Linux, Git Bash
   copy .env.example .env      # Windows cmd or PowerShell
   ```
4. **Write your plan.** Edit `config/day-trader.md` with your watchlist, session hours, risk per trade, and which strategies to enable.
5. **Launch.**
   ```bash
   claude --agent day-trader
   ```
   The agent runs its pre-session checklist, builds a watchlist, and starts working. It will ask before placing each order.

## Three layers of control

**Robinhood's own agent settings.** In the agentic account's settings Robinhood offers a trade-approval option. When it is on, the agent can only propose orders and you place them yourself in the app. It is reported to be off by default for external agents. Turn it on if you want the strongest form of advisory mode.

**Claude Code permissions.** By default every Robinhood order tool call prompts you in the terminal. That is advisory mode. To let the agent place orders without asking, create `.claude/settings.local.json` with an allow rule. The risk gate still runs.

```json
{
  "permissions": {
    "allow": ["mcp__robinhood-trading__place_equity_order"]
  }
}
```

`mcp__robinhood-trading__*` allows every tool from the server, including options and crypto orders. Do not allowlist anything until you have watched the agent trade in advisory mode and trust its behavior with your limits.

**Risk gate hook.** Reads `.env` and refuses an opening order when any of these is true:

| Setting | Refuses when |
| --- | --- |
| `DEEPTRADE_HALT=true` | Any new entry. Exits and cancels still work. |
| `DEEPTRADE_HALT_ALL=true` | Any order including exits. Only cancels work. |
| `DEEPTRADE_MAX_ORDER_USD` | Estimated order value exceeds this. |
| `DEEPTRADE_MAX_ORDER_PCT` | Estimated order value exceeds this percent of equity. The lower of the two caps wins. |
| `DEEPTRADE_MAX_ORDERS_PER_DAY` | This many opening orders were already submitted today, market time. |
| `DEEPTRADE_ALLOWED_SYMBOLS` | The symbol is not on this list. Options match by underlying, crypto by base asset. |
| `DEEPTRADE_BLOCKED_SYMBOLS` | The symbol is on this list. |
| `DEEPTRADE_ALLOWED_ASSET_CLASSES` | The order looks like a class not listed, out of `equity`, `option`, `crypto`. |
| `DEEPTRADE_NO_NEW_ENTRIES_BEFORE` / `_AFTER` | Current market time is outside the window, `HH:MM`. |
| `DEEPTRADE_REQUIRE_KNOWN_VALUE=true` | The gate cannot estimate the order's value, for example a market order with no dollar amount. |
| `DEEPTRADE_GATE_SELLS=true` | Treat plain sells as entries too. Set this if your account can short. |
| `DEEPTRADE_TIMEZONE` | Not a limit. Market timezone for the time rules, default `America/New_York`. |

The percent cap needs to know your equity. The agent writes it to `journal/session-state.json` at the start of each session, and the gate refuses entries if that file is missing or more than 20 hours old.

**File guard.** Trading agents carry a hook in their own definition that denies them write access to `.env`, `.mcp.json`, `CLAUDE.md`, the settings files, the hooks, the agent definitions, and the hook-written journal files. A normal `claude` session in the repo is not restricted, so you can still ask Claude to improve the hooks or the plan. The guard only applies after you accept the workspace trust dialog the first time you open the repo.

**What the gate cannot do.** It estimates value from the fields it recognizes in the request, so an unfamiliar payload shape can make the estimate unknown. It never sees fills, so it does not enforce stop losses, the daily loss limit, or position counts. Those live in the agent's instructions and the plan. Treat the gate as a seat belt, not a cage.

## What's in the box

| Path | What it is |
| --- | --- |
| `.claude/agents/day-trader.md` | The first agent. Intraday entries and exits on a watchlist, flat by close. |
| `.claude/skills/opening-range-breakout/` | The first strategy. Rules, filters, stop and target logic, data it needs. |
| `.claude/skills/position-sizing/` | Fixed-fractional risk sizing for shares, fractional shares, and contracts. |
| `.claude/skills/premarket-scan/` | How the agent builds the day's watchlist. |
| `.claude/skills/trade-journal/` | How the agent records plans, trades, and end-of-day reviews. |
| `.claude/hooks/risk-gate.js` | PreToolUse hook. Denies opening orders that breach `.env` limits. |
| `.claude/hooks/journal.js` | PostToolUse hook. Appends every order and cancel to `journal/orders.jsonl`, account numbers redacted. |
| `.claude/hooks/session-start.js` | Injects date, market status, and your limits at session start. |
| `.claude/hooks/protect-files.js` | Agent-scoped PreToolUse hook. Stops trading agents from editing guardrail files. |
| `.claude/hooks/lib.js` | Shared classifier and parsers used by the hooks. |
| `.claude/settings.json` | Wires the project-wide hooks and allows `sleep`, journal writes, and web search without prompts. |
| `tests/hooks.test.js` | Regression suite for the hooks. Run with `node tests/hooks.test.js`. |
| `config/day-trader.md` | Your trading plan. The agent reads it every session. |
| `.mcp.json` | Declares the Robinhood Trading MCP server. No secrets inside. |

## Customize

Everything is plain markdown and small scripts.

- **Change the strategy.** Edit a skill under `.claude/skills/`, or copy one to a new folder and list it in your plan.
- **Change the agent.** Edit `.claude/agents/day-trader.md`. The body is its system prompt.
- **Add an agent.** Drop a new `.md` in `.claude/agents/`. A swing trader, an options income agent, a research-only analyst.
- **Add a tool.** Add an MCP server to `.mcp.json`, for example a market data server that provides intraday bars, which the first strategy needs and Robinhood's server is not known to provide.
- **Remove anything.** Delete the file. Nothing else depends on it.

## Known limits

- Claude Code must stay open for the agent to work. Close the terminal and it stops.
- Robinhood's agentic trading is in beta. Tool names are not in Robinhood's documentation. The hooks classify tools by name shape and record every name they see in `journal/tools-seen.txt`, so you can check what your account exposes.
- The opening range breakout strategy needs 5-minute bars and VWAP. If no connected tool provides them, the agent is instructed to say so and not trade it.
- No paper mode is known to exist for Robinhood agentic accounts. Start with a small balance.
- US market holidays are not detected by the session hook.

## Contributing

Agents, strategies, hooks, and broker adapters are all welcome. Keep strategies honest about what they are and are not, and state the data they need. Keep hooks deterministic and covered by the regression script. Never commit credentials or journals.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Robinhood or Anthropic.
