# DeepTrade

Claude Code for trading. Open-source agents, strategies, and guardrails that turn Claude into a trader working in your own brokerage account.

You bring a Claude account and a Robinhood account. The repo brings the agents, the skills they use, the hooks that help keep them inside your limits, and a journal of everything they do. One command launches an agent. Everything it does is yours to read, change, or delete.

> **Read [DISCLAIMER.md](DISCLAIMER.md) first.** This software places real orders with real money. It is not financial advice. The authors are not responsible for your trades, your losses, or your account. Use only money you can afford to lose.
>
> The defaults in `.env.example` are conservative risk limits that let the repo run without edits. They are not recommendations. No ticker is set by default. Any ticker or number in an example exists only to show the format.

## How it works

```text
you ──► claude --agent day-trader
            │
            ├── reads .env (via session hook)      your limits and plan, one file
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
- Node.js 18 or newer on your PATH. The hooks are plain Node scripts. The optional Unusual Whales server needs Node 20; the agent tells you if you configure it on an older version. If Node is missing, the risk gate cannot run and order calls are blocked rather than allowed.
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
3. **Create your settings.** Copy the example file. It works as shipped. Review it and change only what you want different, such as the dollar cap, allowed symbols, or asset classes. `.env` is the only settings file: guardrails the hook enforces and the plan the agent follows.
   ```bash
   cp .env.example .env        # macOS, Linux, Git Bash
   copy .env.example .env      # Windows cmd or PowerShell
   ```
4. **Launch.**
   ```bash
   claude --agent day-trader
   ```
   The agent runs its pre-session checklist, builds a watchlist, and starts working. It will ask before placing each order.

## Optional: Unusual Whales

Robinhood is the only required connection. If you have an [Unusual Whales API](https://unusualwhales.com/public-api) plan, the agent can also use its options flow, dark pool, gamma exposure, market tide, and economic calendar. Robinhood alone covers what the shipped strategy needs.

1. Buy an API plan at [unusualwhales.com/pricing?product=api](https://unusualwhales.com/pricing?product=api) and copy your key from the [API dashboard](https://unusualwhales.com/dashboard/api). `.env.example` explains each plan and what the data adds for the agents.
2. Put your key and plan in `.env`:
   ```bash
   UNUSUAL_WHALES_API_KEY=your-key
   DEEPTRADE_UNUSUAL_WHALES_PLAN=basic      # starter, basic, or advanced
   ```
3. Restart Claude Code. The `unusual-whales` server in `.mcp.json` picks up the key. Node 20 or newer is needed for it.

Without a key, the server still starts but offers no tools, so nothing errors. Claude Code asks once to approve each project MCP server; approving `unusual-whales` without a key is harmless. The key never appears in `.mcp.json` or on a command line, and trading agents are blocked from reading `.env`.

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
| `DEEPTRADE_MAX_ORDER_USD` | Estimated order value exceeds this. Empty by default. Alone, it is the cap while buying power covers it, otherwise 10% of equity. |
| `DEEPTRADE_MAX_ORDER_PCT` | Estimated order value exceeds this percent of equity. Empty by default, which means 10%. With both set, the lower cap wins. |
| `DEEPTRADE_MAX_ORDERS_PER_DAY` | This many opening orders were already submitted today, market time. |
| `DEEPTRADE_ALLOWED_SYMBOLS` | The symbol is not on this list. Options match by underlying, crypto by base asset. |
| `DEEPTRADE_BLOCKED_SYMBOLS` | The symbol is on this list. |
| `DEEPTRADE_ALLOWED_ASSET_CLASSES` | The order looks like a class not listed, out of `equity`, `option`, `crypto`. |
| `DEEPTRADE_NO_NEW_ENTRIES_BEFORE` / `_AFTER` | Current market time is outside the window, `HH:MM`. |
| `DEEPTRADE_REQUIRE_KNOWN_VALUE=true` | The gate cannot estimate the order's value, for example a market order with no dollar amount. |
| `DEEPTRADE_ALLOW_SHORTS=true` | Not a refusal by itself: lets strategies short and makes the gate cap plain sells as entries. `DEEPTRADE_GATE_SELLS` still works as an alias. |
| `DEEPTRADE_TIMEZONE` | Not a limit. Market timezone for the time rules, default `America/New_York`. |

The per-order cap needs your equity and buying power. A hook records them from Robinhood's own `get_portfolio` response for your agentic account, so the agent cannot misstate them. The gate refuses an entry when that read is over 2 minutes old or older than the last order, since every fill changes buying power. If you edit `.env` during a session, the gate refuses the next entry once and tells the agent the new values.

**Trading plan settings.** Also in `.env`, followed by the agent rather than the hook: `DEEPTRADE_STRATEGIES`, `DEEPTRADE_RISK_PER_TRADE_PCT`, `DEEPTRADE_MAX_POSITIONS`, `DEEPTRADE_DAILY_LOSS_PCT`, `DEEPTRADE_FLAT_BY`, `DEEPTRADE_CHECK_EVERY_MIN`, `DEEPTRADE_FRACTIONAL_SHARES`, and the scan filters. `DEEPTRADE_ALLOWED_ASSET_CLASSES` is in order of preference: for each signal the agent uses the first class that both the strategy and your account support. If your account cannot trade a class you allowed, for example no options approval, the agent tells you at session start and skips it. At session start the hook reports every setting with defaults filled in, and flags typos and contradictions such as a flat-by time before the last entry time.

**File guard.** Trading agents carry a hook in their own definition that denies them write access to `.env`, `.mcp.json`, `CLAUDE.md`, the settings files, the hooks, the agent definitions, and the hook-written journal files. A normal `claude` session in the repo is not restricted, so you can still ask Claude to improve the hooks or skills. The guard only applies after you accept the workspace trust dialog the first time you open the repo.

**What the gate cannot do.** It estimates value from the fields it recognizes in the request, so an unfamiliar payload shape can make the estimate unknown. It never sees fills, so it does not enforce stop losses, the daily loss limit, or position counts. Those live in the agent's instructions and the `.env` plan settings. Treat the gate as a seat belt, not a cage.

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
| `.mcp.json` | Declares the Robinhood Trading MCP server and optional data servers. No secrets inside. |
| `.claude/hooks/optional-mcp.js` | Starts an optional MCP server only when its key is set in `.env`. |

## Customize

Everything is plain markdown and small scripts.

- **Change the strategy.** Edit a skill under `.claude/skills/`, or copy one to a new folder and add its name to `DEEPTRADE_STRATEGIES`.
- **Change the agent.** Edit `.claude/agents/day-trader.md`. The body is its system prompt.
- **Add an agent.** Drop a new `.md` in `.claude/agents/`. A swing trader, an options income agent, a research-only analyst.
- **Add a tool.** Add an optional data server to `.mcp.json`. See the Unusual Whales entry and the steps in `CLAUDE.md`.
- **Remove anything.** Delete the file. Nothing else depends on it.

## Known limits

- Claude Code must stay open for the agent to work. Close the terminal and it stops.
- Robinhood's agentic trading is in beta and its tools can change. The hooks know the tool names observed on 2026-11-03, classify unknown ones by name shape, and record every name they see in `journal/tools-seen.txt`.
- Robinhood may require you to approve each order in its app, depending on your account setting. The agent cannot change that setting.
- No paper mode is known to exist for Robinhood agentic accounts. Start with a small balance.
- US market holidays are not detected by the session hook.
- The file guard blocks trading agents from reading `.env` by name through Read, Grep, and the shell. A shell command that hides the name, such as a wildcard, is not caught by the guard and relies on Claude Code's permission prompt, which asks before every shell command except `sleep`.

## Contributing

Agents, strategies, hooks, and broker adapters are all welcome. Keep strategies honest about what they are and are not, and state the data they need. Keep hooks deterministic and covered by the regression script. Never commit credentials or journals.

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Robinhood or Anthropic.
