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

  if (!L.fs.existsSync(L.path.join(dir, ".env"))) {
    lines.push("No .env file found, so no settings or risk gate limits are set. A trading agent must ask the user to run `cp .env.example .env` and review it before trading.");
  } else {
    const g = [];
    const show = (label, key) => g.push(`${label}=${env[key] === undefined || env[key] === "" ? "unset" : env[key]}`);
    show("halt", "DEEPTRADE_HALT");
    show("halt_all", "DEEPTRADE_HALT_ALL");
    show("max_order_usd", "DEEPTRADE_MAX_ORDER_USD");
    show("max_order_pct", "DEEPTRADE_MAX_ORDER_PCT");
    show("max_orders_per_day", "DEEPTRADE_MAX_ORDERS_PER_DAY");
    show("allowed_asset_classes", "DEEPTRADE_ALLOWED_ASSET_CLASSES");
    show("allowed_symbols", "DEEPTRADE_ALLOWED_SYMBOLS");
    if (env.DEEPTRADE_BLOCKED_SYMBOLS) show("blocked_symbols", "DEEPTRADE_BLOCKED_SYMBOLS");
    show("no_new_entries_before", "DEEPTRADE_NO_NEW_ENTRIES_BEFORE");
    show("no_new_entries_after", "DEEPTRADE_NO_NEW_ENTRIES_AFTER");
    g.push(`allow_shorts=${L.gateSells(env)}`);
    if (env.DEEPTRADE_REQUIRE_KNOWN_VALUE) show("require_known_value", "DEEPTRADE_REQUIRE_KNOWN_VALUE");
    lines.push(`Guardrails from .env, enforced by the risk gate: ${g.join(", ")}.`);

    const plan = L.planSettings(env);
    const p = Object.entries(plan).map(([k, v]) => `${k.replace(/^DEEPTRADE_/, "").toLowerCase()}=${v.value}${v.isDefault ? " (default)" : ""}`);
    lines.push(`Trading plan from .env, followed by the agent: ${p.join(", ")}.`);
    lines.push("This context is the complete trading plan. Do not read .env directly; it may hold API keys.");
    const src = L.OPTIONAL_SOURCES.map((s) => {
      const on = Boolean((env[s.key] || "").trim() || (process.env[s.key] || "").trim());
      const tier = (env[s.planKey] || "").trim().toLowerCase();
      return on
        ? `${s.name} configured (mcp__${s.server}__* tools${tier ? `, plan ${tier}` : `, plan unknown: ask the user to set ${s.planKey}`})`
        : `${s.name} not configured (${s.key} unset; continue without it)`;
    });
    lines.push(`Optional data sources: ${src.join("; ")}.`);
    const major = Number(String(process.versions.node).split(".")[0]);
    for (const s of L.OPTIONAL_SOURCES) {
      const on = Boolean((env[s.key] || "").trim() || (process.env[s.key] || "").trim());
      if (on && s.minNode && major < s.minNode) {
        lines.push(`Node version problem. Tell the user: ${s.name} is configured but needs Node ${s.minNode} or newer, and this machine has Node ${process.versions.node}. Its tools will not load until they upgrade Node. Everything else works on this version.`);
      }
    }
    const problems = checkSettings(dir, env, plan);
    if (problems.length) lines.push(`Settings problems. Report these to the user before trading: ${problems.join(" ")}`);
  }

  lines.push(`Per-order cap: ${L.describeOrderCap(env)}.`);
  const state = L.readState(L.path.join(dir, "journal", "session-state.json"));
  if (state.equity !== null) {
    lines.push(`Last recorded equity in journal/session-state.json: ${state.equity}, buying power ${state.buyingPower === null ? "unknown" : state.buyingPower}, ${state.ageHours === null ? "age unknown" : Math.round(state.ageHours) + "h old"}. The gate uses it only when under ${L.STATE_MAX_AGE_HOURS}h old, otherwise it refuses entries until it is refreshed.`);
  } else {
    lines.push(`journal/session-state.json has no equity, so the per-order cap cannot be computed. The gate will refuse entries until a trading agent writes {"equity","buying_power","cash","updated_at"} there after fetching the account.`);
  }

  const count = L.countOpeningOrders(L.path.join(dir, "journal", "orders.jsonl"), now.date);
  lines.push(`Opening orders already journaled for ${now.date}: ${count}.`);
  lines.push("Order tool calls to Robinhood prompt the user for permission unless they have allowlisted them. The risk gate hook may deny entries that breach .env limits. Exits and cancels are not capped.");

  L.emit({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } });
}

// Catch settings that contradict each other or point at nothing.
function checkSettings(dir, env, plan) {
  const out = [];
  const known = new Set([...L.GUARDRAIL_KEYS, ...Object.keys(L.PLAN_DEFAULTS), ...L.OPTIONAL_SOURCES.map((s) => s.planKey)]);
  for (const s of L.OPTIONAL_SOURCES) {
    const tier = (env[s.planKey] || "").trim().toLowerCase();
    if (tier && !s.plans.includes(tier)) out.push(`${s.planKey}=${tier} is not one of ${s.plans.join(", ")}.`);
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith("DEEPTRADE_") && !known.has(k)) out.push(`${k} is not a known setting (typo?) and is ignored.`);
  }
  for (const c of L.csv(env.DEEPTRADE_ALLOWED_ASSET_CLASSES).map((x) => x.toLowerCase())) {
    if (!L.ASSET_CLASSES.includes(c)) out.push(`DEEPTRADE_ALLOWED_ASSET_CLASSES contains "${c}", which is not one of ${L.ASSET_CLASSES.join(", ")}.`);
  }
  const strategies = String(plan.DEEPTRADE_STRATEGIES.value).split(",").map((s) => s.trim()).filter(Boolean);
  if (!strategies.length) out.push("DEEPTRADE_STRATEGIES lists no strategy, so the agent has nothing it may trade.");
  for (const s of strategies) {
    if (!L.fs.existsSync(L.path.join(dir, ".claude", "skills", s, "SKILL.md"))) out.push(`Strategy "${s}" in DEEPTRADE_STRATEGIES has no skill at .claude/skills/${s}/SKILL.md.`);
  }
  for (const k of ["DEEPTRADE_NO_NEW_ENTRIES_BEFORE", "DEEPTRADE_NO_NEW_ENTRIES_AFTER"]) {
    if (env[k] && L.parseHHMM(env[k]) === null) out.push(`${k}=${env[k]} is not HH:MM, so the gate ignores it.`);
  }
  const flat = L.parseHHMM(plan.DEEPTRADE_FLAT_BY.value);
  const after = L.parseHHMM(env.DEEPTRADE_NO_NEW_ENTRIES_AFTER);
  if (flat === null) out.push(`DEEPTRADE_FLAT_BY=${plan.DEEPTRADE_FLAT_BY.value} is not HH:MM.`);
  else if (after !== null && flat <= after) out.push(`DEEPTRADE_FLAT_BY=${plan.DEEPTRADE_FLAT_BY.value} is not after DEEPTRADE_NO_NEW_ENTRIES_AFTER=${env.DEEPTRADE_NO_NEW_ENTRIES_AFTER}, so positions could be opened after the flat-by time.`);
  for (const k of ["DEEPTRADE_RISK_PER_TRADE_PCT", "DEEPTRADE_MAX_POSITIONS", "DEEPTRADE_DAILY_LOSS_PCT", "DEEPTRADE_CHECK_EVERY_MIN", "DEEPTRADE_SCAN_MIN_PRICE", "DEEPTRADE_SCAN_MIN_AVG_VOLUME"]) {
    const n = L.num(plan[k].value);
    if (n === null || n <= 0) out.push(`${k}=${plan[k].value} must be a positive number.`);
  }
  return out;
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
