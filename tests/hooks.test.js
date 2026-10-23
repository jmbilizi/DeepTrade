// Regression suite for DeepTrade hooks. Run with: node tests/hooks.test.js
// Each case spawns a hook exactly as Claude Code would, with a synthetic payload
// and a throwaway project directory, and checks the decision it emits.
"use strict";
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOOKS = path.join(__dirname, "..", ".claude", "hooks");
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "deeptrade-hooktest-"));
fs.mkdirSync(path.join(ROOT, "journal"), { recursive: true });
fs.mkdirSync(path.join(ROOT, "config"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "config", "day-trader.md"), "# plan\n");

let pass = 0;
let fail = 0;
const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 30 * 3600e3).toISOString();

function setEnv(obj) {
  fs.writeFileSync(path.join(ROOT, ".env"), Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
}
function setState(s) {
  const f = path.join(ROOT, "journal", "session-state.json");
  if (s === null) {
    try { fs.unlinkSync(f); } catch { /* absent */ }
    return;
  }
  fs.writeFileSync(f, JSON.stringify(s));
}
function clearJournal() {
  for (const f of ["orders.jsonl", "tools-seen.txt"]) {
    try { fs.unlinkSync(path.join(ROOT, "journal", f)); } catch { /* absent */ }
  }
}
function run(hook, payload) {
  const r = spawnSync("node", [path.join(HOOKS, hook)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT },
    encoding: "utf8",
  });
  let out = null;
  try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch { out = { raw: r.stdout }; }
  return { code: r.status, out, stderr: r.stderr };
}
function gate(tool, toolInput) {
  return run("risk-gate.js", { tool_name: `mcp__robinhood-trading__${tool}`, tool_input: toolInput, cwd: ROOT });
}
function decision(r) {
  const h = r.out && r.out.hookSpecificOutput;
  if (!h) return r.out === null ? "silent" : "other";
  if (h.permissionDecision === "deny") return "deny";
  if (h.additionalContext) return "context";
  return "other";
}
function expect(name, r, want, containing) {
  const got = decision(r);
  const h = (r.out && r.out.hookSpecificOutput) || {};
  const text = (h.permissionDecisionReason || "") + " " + (h.additionalContext || "");
  const ok = got === want && r.code === 0 && (!containing || text.includes(containing));
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      want=${want}${containing ? ` ~"${containing}"` : ""} got=${got} exit=${r.code}\n      ${text.trim() || r.stderr}`}`);
}
function check(name, cond) {
  if (cond) pass++; else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
}

const BASE = { DEEPTRADE_MAX_ORDER_USD: 500, DEEPTRADE_MAX_ORDER_PCT: 10, DEEPTRADE_MAX_ORDERS_PER_DAY: 3, DEEPTRADE_ALLOWED_SYMBOLS: "QQQ,SPY,NVDA,BTC", DEEPTRADE_ALLOWED_ASSET_CLASSES: "equity" };

// ---- classification ----
setEnv(BASE); setState({ equity: 4000, cash: 3000, updated_at: NOW }); clearJournal();
expect("read tool get_equity_quotes is silent", gate("get_equity_quotes", { symbols: ["NVDA"] }), "silent");
expect("camelCase getOrders is silent", gate("getOrders", {}), "silent");
expect("review_equity_order (preview) is silent", gate("review_equity_order", { symbol: "NVDA", side: "buy", quantity: 100, limit_price: 130 }), "silent");
expect("cancel_equity_order is silent", gate("cancel_equity_order", { order_id: "x" }), "silent");
expect("create_watchlist is silent", gate("create_watchlist", { name: "a" }), "silent");
expect("orderbook is silent", gate("get_orderbook", { symbol: "BTC-USD" }), "silent");
expect("unknown tool gets 'did not recognize' note", gate("do_thing", {}), "context", "did not recognize");
expect("buy_crypto_with_quote is gated (asset class)", gate("buy_crypto_with_quote", { symbol: "BTC-USD", quote_amount: 50 }), "deny", "crypto order");
expect("transfer_funds is gated as order", gate("transfer_funds", { amount: 50 }), "deny", "could not find a symbol");

// ---- exits bypass ----
expect("sell exit over cap passes", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 10, limit_price: 134 }), "context", "position-reducing");
expect("sell exit on non-allowed symbol passes", gate("place_equity_order", { symbol: "TSLA", side: "sell", quantity: 1, type: "market" }), "context", "position-reducing");
expect("close_position tool passes", gate("close_position", { symbol: "TSLA" }), "context", "position-reducing");
expect("sell_to_open option is NOT reducing", gate("place_option_order", { symbol: "NVDA", side: "sell_to_open", contracts: 1, limit_price: 1 }), "deny", "option order");

// ---- entries ----
expect("buy within both caps passes (pct 400 binding)", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 2, limit_price: 130 }), "context", "within the $400.00 cap");
expect("buy over pct cap denied", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 4, limit_price: 130 }), "deny", "exceeds the per-order cap of $400.00");
expect("buy non-allowed symbol denied", gate("place_equity_order", { symbol: "AAPL", side: "buy", quantity: 1, limit_price: 1 }), "deny", "not in DEEPTRADE_ALLOWED_SYMBOLS");
expect("buy with no symbol and allowlist set denied", gate("place_equity_order", { side: "buy", quantity: 1, limit_price: 1 }), "deny", "could not find a symbol");
expect("nested trailing.value does not shrink estimate", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 100, limit_price: 130, trailing: { value: 2, unit: "percent" } }), "deny", "exceeds");
expect("market order with bogus price is unknown value", gate("place_equity_order", { symbol: "NVDA", side: "buy", type: "market", quantity: 1000, price: 0.01 }), "context", "could not estimate");
expect("market order with notional uses notional", gate("place_equity_order", { symbol: "NVDA", side: "buy", type: "market", notional: 450 }), "deny", "exceeds the per-order cap of $400.00");
expect("asset_quantity key recognized", gate("place_equity_order", { symbol: "NVDA", side: "buy", asset_quantity: 5, limit_price: 130 }), "deny", "exceeds");

// ---- options multiplier ----
setEnv({ ...BASE, DEEPTRADE_ALLOWED_ASSET_CLASSES: "equity,option" });
expect("option via quantity+strike uses x100", gate("place_option_order", { symbol: "NVDA", side: "buy_to_open", quantity: 5, limit_price: 3.2, strike: 130, expiration: "2026-11-20" }), "deny", "x 100");
expect("option via OCC symbol uses x100 and matches underlying allowlist", gate("place_order", { symbol: "NVDA261120C00130000", side: "buy", quantity: 5, limit_price: 3.2 }), "deny", "x 100");

// ---- require known value ----
setEnv({ ...BASE, DEEPTRADE_REQUIRE_KNOWN_VALUE: "true" });
expect("REQUIRE_KNOWN_VALUE denies market entry without notional", gate("place_equity_order", { symbol: "NVDA", side: "buy", type: "market", quantity: 1 }), "deny", "REQUIRE_KNOWN_VALUE");

// ---- pct cap with missing / stale state ----
setEnv({ DEEPTRADE_MAX_ORDER_PCT: 10 }); setState(null);
expect("pct only + no state -> deny entry", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "no usable equity");
setState({ equity: 4000, updated_at: OLD });
expect("pct only + stale state -> deny entry", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "30h old");
expect("pct only + stale state -> exit still passes", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 1, type: "market" }), "context", "position-reducing");
setEnv({ DEEPTRADE_MAX_ORDER_USD: 500, DEEPTRADE_MAX_ORDER_PCT: 10 });
expect("usd+pct + stale state -> deny entry", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "cannot be computed");
setEnv({ DEEPTRADE_MAX_ORDER_USD: 500 }); setState(null);
expect("usd only, no state -> fine", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 100 }), "context", "DEEPTRADE_MAX_ORDER_USD");
setEnv({ DEEPTRADE_HALT: "false" });
expect("no caps -> note", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 100 }), "context", "No per-order value cap");

// ---- halt semantics ----
setEnv({ DEEPTRADE_HALT: "true" });
expect("HALT denies entry", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "New entries are blocked");
expect("HALT allows exit", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 1, type: "market" }), "context", "position-reducing");
setEnv({ DEEPTRADE_HALT_ALL: "true" });
expect("HALT_ALL denies exit", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 1, type: "market" }), "deny", "including exits");
expect("HALT_ALL still silent on cancel", gate("cancel_equity_order", { id: "x" }), "silent");

// ---- gate sells ----
setEnv({ DEEPTRADE_GATE_SELLS: "true", DEEPTRADE_MAX_ORDER_USD: 100 });
expect("GATE_SELLS: plain sell is capped", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 10, limit_price: 130 }), "deny", "exceeds");
expect("GATE_SELLS: reduce_only still bypasses", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 10, limit_price: 130, reduce_only: true }), "context", "position-reducing");

// ---- time window (relative to now in market time) ----
const tzNow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
const hh = Number(tzNow.find((p) => p.type === "hour").value) % 24;
const mm = Number(tzNow.find((p) => p.type === "minute").value);
const plus = (m) => { const t = (hh * 60 + mm + m + 1440) % 1440; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
setEnv({ DEEPTRADE_NO_NEW_ENTRIES_AFTER: plus(-5) });
expect("NO_NEW_ENTRIES_AFTER in the past denies entry", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "NO_NEW_ENTRIES_AFTER");
setEnv({ DEEPTRADE_NO_NEW_ENTRIES_AFTER: plus(5), DEEPTRADE_NO_NEW_ENTRIES_BEFORE: plus(-5) });
expect("inside window passes", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "context", "No per-order value cap");
setEnv({ DEEPTRADE_NO_NEW_ENTRIES_BEFORE: plus(5) });
expect("NO_NEW_ENTRIES_BEFORE in the future denies entry", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "NO_NEW_ENTRIES_BEFORE");

// ---- journal + daily count (entries only, local date) ----
setEnv({ DEEPTRADE_MAX_ORDERS_PER_DAY: 2 }); clearJournal();
const j = (tool, ti, resp) => run("journal.js", { tool_name: `mcp__robinhood-trading__${tool}`, tool_input: ti, tool_response: resp, session_id: "s", cwd: ROOT });
j("get_equity_quotes", { symbols: ["NVDA"] }, { price: 1 });
j("review_equity_order", { symbol: "NVDA", side: "buy", quantity: 1 }, { ok: true });
j("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 130, account_number: "123456789012" }, { id: "o1", account_number: "123456789012", status: "filled" });
j("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 1, type: "market" }, { id: "o2" });
j("cancel_equity_order", { order_id: "o2" }, "ok");
const lines = fs.readFileSync(path.join(ROOT, "journal", "orders.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
const seen = fs.readFileSync(path.join(ROOT, "journal", "tools-seen.txt"), "utf8").trim().split("\n");
check("journal has 3 records (buy, sell, cancel), not the read or preview", lines.length === 3);
check("buy record gated=true, sell record gated=false and reducing", lines[0].gated === true && lines[1].gated === false && lines[1].reducing === true);
check("account numbers redacted in input and response", JSON.stringify(lines[0]).indexOf("123456789012") === -1 && lines[0].input.account_number === "…9012");
check("date_local present", /^\d{4}-\d{2}-\d{2}$/.test(lines[0].date_local));
check("tools-seen lists all 4 distinct tools", seen.length === 4 && seen.includes("mcp__robinhood-trading__review_equity_order"));
expect("1 opening order so far, cap 2 -> entry passes with 1/2", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "context", "1/2");
j("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 130 }, { id: "o3" });
expect("2 opening orders, cap 2 -> entry denied", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "Daily entry cap reached: 2/2");
expect("2 opening orders, cap 2 -> exit still passes", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 1, type: "market" }), "context", "position-reducing");

// ---- robustness ----
expect("garbage stdin silent", run("risk-gate.js", "not json"), "silent");
clearJournal(); setEnv({ DEEPTRADE_MAX_ORDER_USD: 500 });
expect("null tool_input on order", gate("place_equity_order", null), "context", "could not find a symbol");
const ss = run("session-start.js", { hook_event_name: "SessionStart", source: "startup", cwd: ROOT });
check("session-start emits context with opening order count", decision(ss) === "context" && /Opening orders already journaled/.test(ss.out.hookSpecificOutput.additionalContext));
check("session-start says holidays are not checked", /holidays are not checked/i.test(ss.out.hookSpecificOutput.additionalContext));

// ---- file guard (agent-scoped protect-files.js) ----
const guard = (tool, ti) => run("protect-files.js", { tool_name: tool, tool_input: ti, cwd: ROOT });
const abs = (p) => path.join(ROOT, p);
expect("guard: Write to .env denied", guard("Write", { file_path: abs(".env"), content: "x" }), "deny", "protected guardrail file");
expect("guard: Edit to .env.local denied", guard("Edit", { file_path: abs(".env.local"), old_string: "a", new_string: "b" }), "deny", "protected");
expect("guard: Write to .claude/hooks/risk-gate.js denied", guard("Write", { file_path: abs(".claude/hooks/risk-gate.js"), content: "x" }), "deny", "protected");
expect("guard: Edit to .claude/agents/day-trader.md denied", guard("Edit", { file_path: abs(".claude/agents/day-trader.md"), old_string: "a", new_string: "b" }), "deny", "protected");
expect("guard: Edit to .claude/settings.json denied", guard("Edit", { file_path: abs(".claude/settings.json"), old_string: "a", new_string: "b" }), "deny", "protected");
expect("guard: Write to journal/orders.jsonl denied", guard("Write", { file_path: abs("journal/orders.jsonl"), content: "x" }), "deny", "protected");
expect("guard: Write to CLAUDE.md denied (case-insensitive)", guard("Write", { file_path: abs("Claude.md"), content: "x" }), "deny", "protected");
expect("guard: relative path .env denied", guard("Write", { file_path: ".env", content: "x" }), "deny", "protected");
expect("guard: Write to journal/session-state.json allowed", guard("Write", { file_path: abs("journal/session-state.json"), content: "{}" }), "silent");
expect("guard: Write to journal/2026-10-23.md allowed", guard("Write", { file_path: abs("journal/2026-10-23.md"), content: "# day" }), "silent");
expect("guard: Edit to a skill allowed", guard("Edit", { file_path: abs(".claude/skills/opening-range-breakout/SKILL.md"), old_string: "a", new_string: "b" }), "silent");
expect("guard: Edit to config/day-trader.md allowed", guard("Edit", { file_path: abs("config/day-trader.md"), old_string: "a", new_string: "b" }), "silent");
expect("guard: path outside project ignored", guard("Write", { file_path: path.join(os.tmpdir(), "elsewhere", ".env"), content: "x" }), "silent");
expect("guard: Bash sleep allowed", guard("Bash", { command: "sleep 240" }), "silent");
expect("guard: Bash cat .env allowed (read)", guard("Bash", { command: "cat .env" }), "silent");
expect("guard: Bash grep piped to wc on hooks allowed (reads only)", guard("Bash", { command: "grep -c deny .claude/hooks/risk-gate.js | wc -l" }), "silent");
expect("guard: Bash git diff on .env allowed", guard("Bash", { command: "git diff -- .env" }), "silent");
expect("guard: Bash redirect into .env denied", guard("Bash", { command: "echo DEEPTRADE_HALT=false > .env" }), "deny", "not a plain read");
expect("guard: Bash in-place edit of a hook denied", guard("Bash", { command: "sed -i 's/deny/allow/' .claude/hooks/risk-gate.js" }), "deny", "not a plain read");
expect("guard: Bash rename of orders.jsonl denied", guard("Bash", { command: "mv journal/orders.jsonl journal/old.jsonl" }), "deny", "not a plain read");
expect("guard: Bash node one-liner touching settings denied", guard("Bash", { command: "node -e \"require('fs').writeFileSync('.claude/settings.json','{}')\"" }), "deny", "not a plain read");
expect("guard: Bash read chained with unknown program denied", guard("Bash", { command: "cat .env && tee .env" }), "deny", "not a plain read");
expect("guard: Bash unrelated command untouched", guard("Bash", { command: "node tests/hooks.test.js" }), "silent");

// Tidy the temp project by name, no recursive delete: unlink known files, then
// remove the now-empty directories.
for (const f of [".env", "config/day-trader.md", "journal/orders.jsonl", "journal/tools-seen.txt", "journal/session-state.json"]) {
  try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* absent */ }
}
for (const d of ["config", "journal", ""]) {
  try { fs.rmdirSync(path.join(ROOT, d)); } catch { /* leave it */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
