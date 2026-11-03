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
const ORB_DIR = path.join(ROOT, ".claude", "skills", "opening-range-breakout");
fs.mkdirSync(ORB_DIR, { recursive: true });
fs.writeFileSync(path.join(ORB_DIR, "SKILL.md"), "# orb\n");

let pass = 0;
let fail = 0;
const NOW = new Date().toISOString();
const OLD = new Date(Date.now() - 30 * 3600e3).toISOString();

function setEnv(obj, { keepSnapshot = false } = {}) {
  fs.writeFileSync(path.join(ROOT, ".env"), Object.entries(obj).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
  // Each test starts as a fresh session unless it is testing a mid-session edit.
  if (!keepSnapshot) try { fs.unlinkSync(path.join(ROOT, "journal", "settings-snapshot.json")); } catch { /* absent */ }
}
function setState(s) {
  const f = path.join(ROOT, "journal", "account-state.json");
  if (s === null) {
    try { fs.unlinkSync(f); } catch { /* absent */ }
    return;
  }
  fs.writeFileSync(f, JSON.stringify(s));
}
function clearJournal() {
  for (const f of ["orders.jsonl", "tools-seen.txt", "option-ids.json"]) {
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
expect("both caps set -> lower wins (pct 400)", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 2, limit_price: 130 }), "context", "within the $400.00 cap");
expect("both caps set -> over the lower denied", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 4, limit_price: 130 }), "deny", "exceeds the per-order cap of $400.00");
expect("buy non-allowed symbol denied", gate("place_equity_order", { symbol: "AAPL", side: "buy", quantity: 1, limit_price: 1 }), "deny", "not in DEEPTRADE_ALLOWED_SYMBOLS");
expect("buy with no symbol and allowlist set denied", gate("place_equity_order", { side: "buy", quantity: 1, limit_price: 1 }), "deny", "could not find a symbol");
expect("nested trailing.value does not shrink estimate", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 100, limit_price: 130, trailing: { value: 2, unit: "percent" } }), "deny", "exceeds");
expect("market order with bogus price is unknown value", gate("place_equity_order", { symbol: "NVDA", side: "buy", type: "market", quantity: 1000, price: 0.01 }), "context", "could not estimate");
expect("market order with notional uses notional", gate("place_equity_order", { symbol: "NVDA", side: "buy", type: "market", notional: 450 }), "deny", "exceeds the per-order cap of $400.00");
setEnv({ ...BASE, DEEPTRADE_MAX_ORDER_PCT: "" });
setState({ equity: 4000, buying_power: 3000, cash: 3000, updated_at: NOW });
expect("only USD, buying power covers it -> USD", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 3, limit_price: 130 }), "context", "within the $500.00 cap (DEEPTRADE_MAX_ORDER_USD; buying power");
setState({ equity: 4000, buying_power: 300, cash: 300, updated_at: NOW });
expect("only USD, buying power below it -> default 10% of equity", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 4, limit_price: 110 }), "deny", "because buying power $300.00 is below");
setEnv({ ...BASE, DEEPTRADE_MAX_ORDER_USD: "", DEEPTRADE_MAX_ORDER_PCT: 5 });
expect("only PCT -> that percent", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 2, limit_price: 110 }), "deny", "cap of $200.00 (5% of equity");
setEnv({ ...BASE, DEEPTRADE_MAX_ORDER_USD: "", DEEPTRADE_MAX_ORDER_PCT: "" });
expect("neither set -> default 10% of equity", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 3, limit_price: 130 }), "context", "within the $400.00 cap (10% of equity $4000.00 (default))");
setEnv(BASE); setState({ equity: 4000, cash: 3000, updated_at: NOW });
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
expect("pct only + no state -> deny entry", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "no account read is recorded");
setState({ equity: 4000, updated_at: OLD });
expect("pct only + stale state -> deny entry", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "minutes old (limit 2)");
expect("pct only + stale state -> exit still passes", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 1, type: "market" }), "context", "position-reducing");
setEnv({ DEEPTRADE_MAX_ORDER_USD: 500, DEEPTRADE_MAX_ORDER_PCT: 10 });
expect("usd+pct + stale state -> deny entry", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "cannot be computed");
setEnv({ DEEPTRADE_MAX_ORDER_USD: 500 }); setState(null);
expect("usd only, no state -> deny (needs buying power)", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 100 }), "deny", "no account read is recorded");
setEnv({ DEEPTRADE_HALT: "false" });
expect("no caps set, no state -> deny (default cap needs equity)", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 100 }), "deny", "no account read is recorded");
// From here on, a large fresh account so the default cap does not interfere.
setState({ equity: 1000000, buying_power: 1000000, cash: 1000000, updated_at: NOW });

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
setEnv({ DEEPTRADE_ALLOW_SHORTS: "true", DEEPTRADE_MAX_ORDER_USD: 100 });
expect("ALLOW_SHORTS: plain sell is capped", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 10, limit_price: 130 }), "deny", "exceeds");
setEnv({ DEEPTRADE_GATE_SELLS: "true", DEEPTRADE_MAX_ORDER_USD: 100 });
expect("GATE_SELLS: reduce_only still bypasses", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 10, limit_price: 130, reduce_only: true }), "context", "position-reducing");

// ---- time window (relative to now in market time) ----
const tzNow = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
const hh = Number(tzNow.find((p) => p.type === "hour").value) % 24;
const mm = Number(tzNow.find((p) => p.type === "minute").value);
const plus = (m) => { const t = (hh * 60 + mm + m + 1440) % 1440; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };
setEnv({ DEEPTRADE_NO_NEW_ENTRIES_AFTER: plus(-5) });
expect("NO_NEW_ENTRIES_AFTER in the past denies entry", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "NO_NEW_ENTRIES_AFTER");
setEnv({ DEEPTRADE_NO_NEW_ENTRIES_AFTER: plus(5), DEEPTRADE_NO_NEW_ENTRIES_BEFORE: plus(-5) });
expect("inside window passes", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "context", "within the");
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
setState({ equity: 1000000, buying_power: 1000000, cash: 1000000, updated_at: new Date().toISOString() });
expect("1 opening order so far, cap 2 -> entry passes with 1/2", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "context", "1/2");
j("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 130 }, { id: "o3" });
expect("2 opening orders, cap 2 -> entry denied", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "Daily entry cap reached: 2/2");
expect("2 opening orders, cap 2 -> exit still passes", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 1, type: "market" }), "context", "position-reducing");

// ---- account state recorded by the hook from broker responses ----
setEnv({ ...BASE, DEEPTRADE_MAX_ORDERS_PER_DAY: 99 }); clearJournal(); setState(null);
try { fs.unlinkSync(path.join(ROOT, "journal", "agentic-accounts.json")); } catch { /* absent */ }
const acctFile = path.join(ROOT, "journal", "account-state.json");
j("get_portfolio", { account_number: "A1" }, { data: { total_value: "4000", cash: "3000", buying_power: { buying_power: "3000.0000" } } });
check("portfolio ignored before get_accounts names the agentic account", !fs.existsSync(acctFile));
j("get_accounts", {}, [{ type: "text", text: JSON.stringify({ data: { accounts: [{ account_number: "MAIN", agentic_allowed: false }, { account_number: "A1", agentic_allowed: true }] } }) }]);
j("get_portfolio", { account_number: "MAIN" }, { data: { total_value: "90000", cash: "90000", buying_power: { buying_power: "90000" } } });
check("portfolio of a non-agentic account is ignored", !fs.existsSync(acctFile));
j("get_portfolio", { account_number: "A1" }, { data: { total_value: "4000", cash: "3000", buying_power: { buying_power: "3000.0000" } } });
const acct = JSON.parse(fs.readFileSync(acctFile, "utf8"));
check("agentic portfolio recorded from the response", acct.equity === 4000 && acct.buying_power === 3000);
expect("fresh hook-recorded read -> entry checked against it", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 2, limit_price: 130 }), "context", "within the $400.00 cap");
j("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 2, limit_price: 130 }, { id: "x1" });
expect("order after the last read -> next entry needs a new read", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 130 }), "deny", "sent after the last account read");
expect("exits still pass without a new read", gate("place_equity_order", { symbol: "NVDA", side: "sell", quantity: 1, type: "market" }), "context", "position-reducing");
j("get_portfolio", { account_number: "A1" }, { data: { total_value: "4000", cash: "2740", buying_power: { buying_power: "2740" } } });
expect("new read after the order -> entry passes", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 130 }), "context", "within the $400.00 cap");
expect("guard: Write to journal/account-state.json denied", run("protect-files.js", { tool_name: "Write", tool_input: { file_path: path.join(ROOT, "journal/account-state.json"), content: "{}" }, cwd: ROOT }), "deny", "protected");
setState({ equity: 1000000, buying_power: 1000000, cash: 1000000, updated_at: new Date().toISOString() });

// ---- .env edited mid-session ----
setEnv({ ...BASE, DEEPTRADE_MAX_ORDERS_PER_DAY: 99 });
expect("first entry with no snapshot passes and takes one", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "context", "within the");
setEnv({ ...BASE, DEEPTRADE_MAX_ORDERS_PER_DAY: 99, DEEPTRADE_RISK_PER_TRADE_PCT: "0.25" }, { keepSnapshot: true });
expect("plan edited mid-session -> entry refused once with the new value", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "deny", "DEEPTRADE_RISK_PER_TRADE_PCT: 0.5 -> 0.25");
expect("retry after the change was reported passes", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "context", "within the");
setEnv({ ...BASE, DEEPTRADE_MAX_ORDERS_PER_DAY: 99, DEEPTRADE_RISK_PER_TRADE_PCT: "0.25", UNUSUAL_WHALES_API_KEY: "secret-xyz" }, { keepSnapshot: true });
expect("an API key change is never reported or blocking", gate("place_equity_order", { symbol: "NVDA", side: "buy", quantity: 1, limit_price: 1 }), "context", "within the");
run("session-start.js", { source: "startup", cwd: ROOT });
check("session start snapshot holds no API key", fs.readFileSync(path.join(ROOT, "journal", "settings-snapshot.json"), "utf8").indexOf("secret-xyz") === -1);
expect("guard: Write to journal/settings-snapshot.json denied", run("protect-files.js", { tool_name: "Write", tool_input: { file_path: path.join(ROOT, "journal/settings-snapshot.json"), content: "{}" }, cwd: ROOT }), "deny", "protected");

// ---- real Robinhood tool names and option order shape (observed 2026-11-03) ----
for (const t of ["create_alert", "create_scan", "decline_trade_approval", "run_scan", "authenticate", "set_legend_chart_settings"]) {
  expect(`${t} is not an order`, gate(t, {}), "silent");
}
expect("exercise_option is still treated as an order", gate("exercise_option", { option_id: "x", quantity: 1 }), "deny");
setEnv({ ...BASE, DEEPTRADE_ALLOWED_ASSET_CLASSES: "equity,option", DEEPTRADE_MAX_ORDER_USD: 1000, DEEPTRADE_MAX_ORDER_PCT: "" });
clearJournal();
const leg = (id, side, effect) => ({ option_id: id, side, position_effect: effect, ratio_quantity: 1 });
expect("option legs with unseen id denied under allowlist", gate("place_option_order", { account_number: "1", legs: [leg("id-nv", "buy", "open")], quantity: "1", price: "3.20", type: "limit" }), "deny", "get_option_instruments");
// MCP tool responses can arrive as content blocks with JSON text.
j("get_option_instruments", { chain_symbol: "NVDA" }, [{ type: "text", text: JSON.stringify({ data: { instruments: [{ id: "id-nv", chain_symbol: "NVDA", strike_price: "130.0000" }, { id: "id-aapl", chain_symbol: "AAPL" }] } }) }]);
check("option ids recorded from get_option_instruments", JSON.parse(fs.readFileSync(path.join(ROOT, "journal", "option-ids.json"), "utf8"))["id-nv"] === "NVDA");
expect("resolved option entry within cap passes, x100, size from top-level quantity", gate("place_option_order", { account_number: "1", legs: [leg("id-nv", "buy", "open")], quantity: "2", price: "3.20", type: "limit" }), "context", "$640.00");
expect("resolved option entry over cap denied", gate("place_option_order", { account_number: "1", legs: [leg("id-nv", "buy", "open")], quantity: "4", price: "3.20", type: "limit" }), "deny", "exceeds");
expect("option on non-allowed underlying denied", gate("place_option_order", { account_number: "1", legs: [leg("id-aapl", "buy", "open")], quantity: "1", price: "1", type: "limit" }), "deny", "AAPL is not in");
expect("sell-to-open leg is an entry, not an exit", gate("place_option_order", { account_number: "1", legs: [leg("id-nv", "sell", "open")], quantity: "5", price: "3.20", type: "limit" }), "deny", "exceeds");
expect("sell-to-close leg is an exit even unresolved", gate("place_option_order", { account_number: "1", legs: [leg("id-unknown", "sell", "close")], quantity: "5", type: "market" }), "context", "position-reducing");
j("place_option_order", { account_number: "1", legs: [leg("id-nv", "buy", "open")], quantity: "1", price: "3.20" }, { id: "oo1" });
const optRec = fs.readFileSync(path.join(ROOT, "journal", "orders.jsonl"), "utf8").trim().split("\n").map(JSON.parse).pop();
check("journal records option underlying and gated entry", optRec.symbol === "NVDA" && optRec.gated === true && optRec.asset_class === "option");

// ---- robustness ----
expect("garbage stdin silent", run("risk-gate.js", "not json"), "silent");
clearJournal(); setEnv({ DEEPTRADE_MAX_ORDER_USD: 500 });
expect("null tool_input on order", gate("place_equity_order", null), "context", "could not find a symbol");
const ss = run("session-start.js", { hook_event_name: "SessionStart", source: "startup", cwd: ROOT });
check("session-start emits context with opening order count", decision(ss) === "context" && /Opening orders already journaled/.test(ss.out.hookSpecificOutput.additionalContext));
check("session-start says holidays are not checked", /holidays are not checked/i.test(ss.out.hookSpecificOutput.additionalContext));

// Settings report and consistency checks.
const ssCtx = (env) => {
  setEnv(env);
  const r = run("session-start.js", { hook_event_name: "SessionStart", source: "startup", cwd: ROOT });
  return (r.out && r.out.hookSpecificOutput && r.out.hookSpecificOutput.additionalContext) || "";
};
let c = ssCtx({ DEEPTRADE_MAX_ORDER_USD: 100, DEEPTRADE_NO_NEW_ENTRIES_AFTER: "15:00" });
check("session-start reports plan defaults", /strategies=opening-range-breakout \(default\)/.test(c) && /flat_by=15:50 \(default\)/.test(c));
check("session-start: consistent defaults raise no problems", !/Settings problems/.test(c));
check("session-start never prints non-DEEPTRADE keys", !/secret-value/.test(ssCtx({ UNUSUAL_WHALES_API_KEY: "secret-value" })));
c = ssCtx({ DEEPTRADE_FLAT_BY: "14:00", DEEPTRADE_NO_NEW_ENTRIES_AFTER: "15:00" });
check("session-start flags flat-by before last entry", /Settings problems/.test(c) && /not after DEEPTRADE_NO_NEW_ENTRIES_AFTER/.test(c));
c = ssCtx({ DEEPTRADE_STRATEGIES: "opening-range-breakout,no-such-strategy" });
check("session-start flags a strategy with no skill", /no-such-strategy/.test(c) && /has no skill/.test(c));
c = ssCtx({ DEEPTRADE_MAX_ORDR_USD: "100" });
check("session-start flags unknown DEEPTRADE_ key", /DEEPTRADE_MAX_ORDR_USD is not a known setting/.test(c));
c = ssCtx({ DEEPTRADE_ALLOWED_ASSET_CLASSES: "equity,options" });
check("session-start flags unknown asset class", /contains "options"/.test(c));
c = ssCtx({});
check("session-start: Unusual Whales not configured without key", /Unusual Whales not configured/.test(c));
c = ssCtx({ UNUSUAL_WHALES_API_KEY: "secret-value", DEEPTRADE_UNUSUAL_WHALES_PLAN: "basic" });
check("session-start: Unusual Whales configured with plan, key not shown", /Unusual Whales configured \(mcp__unusual-whales__\* tools, plan basic\)/.test(c) && !/secret-value/.test(c));
c = ssCtx({ UNUSUAL_WHALES_API_KEY: "x", DEEPTRADE_UNUSUAL_WHALES_PLAN: "pro" });
check("session-start flags unknown UW plan", /DEEPTRADE_UNUSUAL_WHALES_PLAN=pro is not one of/.test(c));
c = ssCtx({ DEEPTRADE_RISK_PER_TRADE_PCT: "abc" });
check("session-start flags non-numeric risk", /DEEPTRADE_RISK_PER_TRADE_PCT=abc must be a positive number/.test(c));

// ---- file guard (agent-scoped protect-files.js) ----
const guard = (tool, ti) => run("protect-files.js", { tool_name: tool, tool_input: ti, cwd: ROOT });
const abs = (p) => path.join(ROOT, p);
expect("guard: Write to .env denied", guard("Write", { file_path: abs(".env"), content: "x" }), "deny", "protected guardrail file");
expect("guard: Edit to .env.local denied", guard("Edit", { file_path: abs(".env.local"), old_string: "a", new_string: "b" }), "deny", "protected");
expect("guard: Write to .claude/hooks/risk-gate.js denied", guard("Write", { file_path: abs(".claude/hooks/risk-gate.js"), content: "x" }), "deny", "protected");
expect("guard: Edit to .claude/agents/day-trader.md denied", guard("Edit", { file_path: abs(".claude/agents/day-trader.md"), old_string: "a", new_string: "b" }), "deny", "protected");
expect("guard: Edit to .claude/settings.json denied", guard("Edit", { file_path: abs(".claude/settings.json"), old_string: "a", new_string: "b" }), "deny", "protected");
expect("guard: Write to journal/orders.jsonl denied", guard("Write", { file_path: abs("journal/orders.jsonl"), content: "x" }), "deny", "protected");
expect("guard: Write to journal/option-ids.json denied", guard("Write", { file_path: abs("journal/option-ids.json"), content: "{}" }), "deny", "protected");
expect("guard: shell write to journal/option-ids.json denied", guard("Bash", { command: "echo '{}' > journal/option-ids.json" }), "deny");
expect("guard: Write to CLAUDE.md denied (case-insensitive)", guard("Write", { file_path: abs("Claude.md"), content: "x" }), "deny", "protected");
expect("guard: relative path .env denied", guard("Write", { file_path: ".env", content: "x" }), "deny", "protected");
expect("guard: Write to journal/session-state.json allowed", guard("Write", { file_path: abs("journal/session-state.json"), content: "{}" }), "silent");
expect("guard: Write to journal/2026-10-23.md allowed", guard("Write", { file_path: abs("journal/2026-10-23.md"), content: "# day" }), "silent");
expect("guard: Edit to a skill allowed", guard("Edit", { file_path: abs(".claude/skills/opening-range-breakout/SKILL.md"), old_string: "a", new_string: "b" }), "silent");
expect("guard: Bash find -delete on hooks denied", guard("Bash", { command: "find .claude/hooks -name x -delete" }), "deny", "not a plain read");
expect("guard: Bash find -exec rm on .env denied", guard("Bash", { command: "find . -name .env -exec rm {} ;" }), "deny", "API keys");
expect("guard: Bash plain find on hooks allowed", guard("Bash", { command: "find .claude/hooks -name '*.js'" }), "silent");
expect("guard: path outside project ignored", guard("Write", { file_path: path.join(os.tmpdir(), "elsewhere", ".env"), content: "x" }), "silent");
expect("guard: Bash sleep allowed", guard("Bash", { command: "sleep 240" }), "silent");
expect("guard: Bash cat .env denied (secret)", guard("Bash", { command: "cat .env" }), "deny", "API keys");
expect("guard: Bash grep in .env.local denied", guard("Bash", { command: "grep KEY .env.local" }), "deny", "API keys");
expect("guard: Bash cat .env.example allowed", guard("Bash", { command: "cat .env.example" }), "silent");
expect("guard: Bash mentioning .environment untouched", guard("Bash", { command: "echo .environment" }), "silent");
expect("guard: Read .env denied", guard("Read", { file_path: abs(".env") }), "deny", "API keys");
expect("guard: Read .env.example allowed", guard("Read", { file_path: abs(".env.example") }), "silent");
expect("guard: Read a hook allowed", guard("Read", { file_path: abs(".claude/hooks/lib.js") }), "silent");
expect("guard: Grep with glob .env denied", guard("Grep", { pattern: "KEY", glob: ".env" }), "deny", "API keys");
expect("guard: Grep path .env denied", guard("Grep", { pattern: "KEY", path: abs(".env") }), "deny", "API keys");
expect("guard: Bash grep piped to wc on hooks allowed (reads only)", guard("Bash", { command: "grep -c deny .claude/hooks/risk-gate.js | wc -l" }), "silent");
expect("guard: Bash git diff on .env denied (secret)", guard("Bash", { command: "git diff -- .env" }), "deny", "API keys");
expect("guard: Bash redirect into .env denied", guard("Bash", { command: "echo DEEPTRADE_HALT=false > .env" }), "deny", "API keys");
expect("guard: Bash in-place edit of a hook denied", guard("Bash", { command: "sed -i 's/deny/allow/' .claude/hooks/risk-gate.js" }), "deny", "not a plain read");
expect("guard: Bash rename of orders.jsonl denied", guard("Bash", { command: "mv journal/orders.jsonl journal/old.jsonl" }), "deny", "not a plain read");
expect("guard: Bash node one-liner touching settings denied", guard("Bash", { command: "node -e \"require('fs').writeFileSync('.claude/settings.json','{}')\"" }), "deny", "not a plain read");
expect("guard: Bash read chained with unknown program denied", guard("Bash", { command: "cat .env && tee .env" }), "deny", "API keys");
expect("guard: Bash unrelated command untouched", guard("Bash", { command: "node tests/hooks.test.js" }), "silent");

// ---- optional MCP launcher ----
function launch(envObj, args, stdin) {
  setEnv(envObj);
  const env = { ...process.env, CLAUDE_PROJECT_DIR: ROOT };
  delete env.UNUSUAL_WHALES_API_KEY;
  delete env.UW_API_KEY;
  return spawnSync("node", [path.join(HOOKS, "optional-mcp.js"), ...args], { input: stdin, env, encoding: "utf8", timeout: 10000 });
}
const rpc = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
  { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "x" } },
].map((m) => JSON.stringify(m)).join("\n") + "\n";
let lr = launch({}, ["UNUSUAL_WHALES_API_KEY", "node", "-e", "process.exit(9)"], rpc);
const replies = lr.stdout.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
check("launcher without key serves an empty MCP server", lr.status === 0 && replies.length === 3);
check("launcher without key: initialize says not configured", replies[0] && /UNUSUAL_WHALES_API_KEY is not set/.test(replies[0].result.instructions));
check("launcher without key: no tools", replies[1] && Array.isArray(replies[1].result.tools) && replies[1].result.tools.length === 0);
check("launcher without key: tool calls error", replies[2] && replies[2].error && replies[2].error.code === -32601);
lr = launch({ UNUSUAL_WHALES_API_KEY: "k-123" }, ["UNUSUAL_WHALES_API_KEY", "node", "-e", "process.stdout.write(process.env.UNUSUAL_WHALES_API_KEY); process.exit(3)"], "");
check("launcher with key passes it to the child and keeps its exit code", lr.stdout === "k-123" && lr.status === 3);
lr = launch({ UNUSUAL_WHALES_API_KEY: "k-456" }, ["UNUSUAL_WHALES_API_KEY:UW_API_KEY", "node", "-e", "process.stdout.write(String(process.env.UW_API_KEY))"], "");
check("launcher maps the .env name to the child's variable", lr.stdout === "k-456" && lr.status === 0);
lr = launch({}, [], "");
check("launcher without arguments exits 2", lr.status === 2);

// Every trading agent (one that preloads order-execution) must carry the file
// guard and the shared skills, or it could rewrite its own limits.
const AGENTS = path.join(__dirname, "..", ".claude", "agents");
for (const f of fs.readdirSync(AGENTS).filter((n) => n.endsWith(".md"))) {
  const fm = (fs.readFileSync(path.join(AGENTS, f), "utf8").match(/^---\n([\s\S]*?)\n---/) || [, ""])[1];
  if (!/^\s+-\s+order-execution\s*$/m.test(fm)) continue;
  check(`agent ${f} carries the protect-files guard`, /PreToolUse:[\s\S]*protect-files\.js[\s\S]*onFailure:\s*block/.test(fm));
  for (const s of ["trading-preflight", "position-sizing", "trade-journal"]) {
    check(`agent ${f} preloads ${s}`, new RegExp(`^\\s+-\\s+${s}\\s*$`, "m").test(fm));
  }
  for (const s of (fm.match(/^skills:\n((?:\s+-\s+.*\n?)*)/m) || [, ""])[1].split("\n").map((l) => l.replace(/^\s+-\s+/, "").trim()).filter(Boolean)) {
    check(`agent ${f} skill ${s} exists`, fs.existsSync(path.join(__dirname, "..", ".claude", "skills", s, "SKILL.md")));
  }
}

// Tidy the temp project by name, no recursive delete: unlink known files, then
// remove the now-empty directories.
for (const f of [".env", ".claude/skills/opening-range-breakout/SKILL.md", "journal/orders.jsonl", "journal/tools-seen.txt", "journal/session-state.json", "journal/account-state.json", "journal/option-ids.json", "journal/settings-snapshot.json", "journal/agentic-accounts.json"]) {
  try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* absent */ }
}
for (const d of [".claude/skills/opening-range-breakout", ".claude/skills", ".claude", "journal", ""]) {
  try { fs.rmdirSync(path.join(ROOT, d)); } catch { /* leave it */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
