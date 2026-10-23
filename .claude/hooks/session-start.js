#!/usr/bin/env node
// SessionStart hook: give the agent factual context it would otherwise have to
// discover. Market time, whether US equity regular hours are open, the active
// .env guardrails, the state of the trading plan and equity record, and how
// many opening orders have already been journaled today. Plain statements only.

"use strict";
const L = require("./lib");

function main() {
  const input = L.readStdinJson() || {};
  const dir = L.projectDir(input);
  const env = L.loadEnv(L.path.join(dir, ".env"));
  const tz = env.DEEPTRADE_TIMEZONE || L.DEFAULT_TZ;
  const now = L.localParts(tz);
  const lines = [];

  lines.push(`DeepTrade session context. Local market time: ${now.text} (${tz}).`);
  lines.push(marketStatus(now));

  const planFile = L.path.join(dir, "config", "day-trader.md");
  lines.push(
    L.fs.existsSync(planFile)
      ? "Trading plan found at config/day-trader.md. Read it before any market action."
      : "No trading plan at config/day-trader.md. A trading agent must ask the user to create one before trading."
  );

  if (!L.fs.existsSync(L.path.join(dir, ".env"))) {
    lines.push("No .env file found, so no risk gate limits are set. A trading agent must ask the user to copy .env.example to .env and fill it in before trading.");
  } else {
    const g = [];
    const show = (label, key) => g.push(`${label}=${env[key] === undefined || env[key] === "" ? "unset" : env[key]}`);
    show("halt", "DEEPTRADE_HALT");
    show("halt_all", "DEEPTRADE_HALT_ALL");
    show("max_order_usd", "DEEPTRADE_MAX_ORDER_USD");
    show("max_order_pct", "DEEPTRADE_MAX_ORDER_PCT");
    show("max_orders_per_day", "DEEPTRADE_MAX_ORDERS_PER_DAY");
    if (env.DEEPTRADE_ALLOWED_SYMBOLS) show("allowed_symbols", "DEEPTRADE_ALLOWED_SYMBOLS");
    if (env.DEEPTRADE_BLOCKED_SYMBOLS) show("blocked_symbols", "DEEPTRADE_BLOCKED_SYMBOLS");
    if (env.DEEPTRADE_ALLOWED_ASSET_CLASSES) show("allowed_asset_classes", "DEEPTRADE_ALLOWED_ASSET_CLASSES");
    if (env.DEEPTRADE_NO_NEW_ENTRIES_BEFORE) show("no_new_entries_before", "DEEPTRADE_NO_NEW_ENTRIES_BEFORE");
    if (env.DEEPTRADE_NO_NEW_ENTRIES_AFTER) show("no_new_entries_after", "DEEPTRADE_NO_NEW_ENTRIES_AFTER");
    if (env.DEEPTRADE_GATE_SELLS) show("gate_sells", "DEEPTRADE_GATE_SELLS");
    if (env.DEEPTRADE_REQUIRE_KNOWN_VALUE) show("require_known_value", "DEEPTRADE_REQUIRE_KNOWN_VALUE");
    lines.push(`Active guardrails from .env: ${g.join(", ")}.`);
    const anyCap = env.DEEPTRADE_MAX_ORDER_USD || env.DEEPTRADE_MAX_ORDER_PCT || env.DEEPTRADE_MAX_ORDERS_PER_DAY;
    if (!anyCap) lines.push("Warning: .env exists but sets no order caps. The risk gate will only enforce the halt switch and symbol lists.");
  }

  if (env.DEEPTRADE_MAX_ORDER_PCT) {
    const state = L.readState(L.path.join(dir, "journal", "session-state.json"));
    if (state.equity !== null) {
      lines.push(`Last recorded equity in journal/session-state.json: ${state.equity}, ${state.ageHours === null ? "age unknown" : Math.round(state.ageHours) + "h old"}. The percent cap uses it only when under ${L.STATE_MAX_AGE_HOURS}h old, otherwise the gate refuses entries until it is refreshed.`);
    } else {
      lines.push(`DEEPTRADE_MAX_ORDER_PCT is set but journal/session-state.json has no equity. The gate will refuse entries until a trading agent writes {"equity","cash","updated_at"} there after fetching the account summary.`);
    }
  }

  const count = L.countOpeningOrders(L.path.join(dir, "journal", "orders.jsonl"), now.date);
  lines.push(`Opening orders already journaled for ${now.date}: ${count}.`);
  lines.push("Order tool calls to Robinhood prompt the user for permission unless they have allowlisted them. The risk gate hook may deny entries that breach .env limits. Exits and cancels are not capped.");

  L.emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } });
}

function marketStatus(now) {
  if (!now.ok) return "Market status unknown: timezone could not be resolved.";
  if (now.weekday === "Saturday" || now.weekday === "Sunday") return "US equity market: closed (weekend). Crypto trades around the clock. Market holidays are not checked by this hook.";
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  let s;
  if (now.minutes < 4 * 60) s = "US equity market: closed. Pre-market opens 04:00 local market time.";
  else if (now.minutes < open) s = "US equity market: pre-market session. Regular hours open at 09:30.";
  else if (now.minutes < close) s = `US equity market: regular hours open. ${close - now.minutes} minutes until the 16:00 close.`;
  else if (now.minutes < 20 * 60) s = "US equity market: after-hours session. Regular hours closed at 16:00.";
  else s = "US equity market: closed for the day.";
  return s + " Market holidays are not checked by this hook; verify with the broker if in doubt.";
}

try {
  main();
} catch {
  process.exitCode = 0;
}
