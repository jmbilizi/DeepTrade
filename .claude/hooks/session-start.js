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
  try {
    L.fs.mkdirSync(L.path.join(dir, "journal"), { recursive: true });
    L.fs.writeFileSync(L.path.join(dir, "journal", L.SETTINGS_SNAPSHOT_FILE), JSON.stringify(L.settingsSnapshot(env)), "utf8");
  } catch {
    /* the gate takes a snapshot itself if this is missing */
  }
  lines.push(marketStatus(now, L.fs.existsSync(L.path.join(dir, ".env")) ? env : {}));

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
    g.push(`exposure_guard=${L.truthy(env.DEEPTRADE_EXPOSURE_GUARD)}`);
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
  const state = L.readState(L.path.join(dir, "journal", L.ACCOUNT_STATE_FILE));
  lines.push(`Account state for the cap is recorded by a hook from get_portfolio responses${state.equity !== null ? ` (last: equity ${state.equity}, buying power ${state.buyingPower === null ? "unknown" : state.buyingPower}, ${state.ageMin === null ? "age unknown" : Math.round(state.ageMin) + " min old"})` : ""}. Before every entry, call get_portfolio for the agentic account (get_accounts once per session first). The gate refuses an entry when that read is over ${L.STATE_MAX_AGE_MIN} minutes old or older than the last order.`);

  const count = L.countOpeningOrders(L.path.join(dir, "journal", "orders.jsonl"), now.date);
  lines.push(`Opening orders already journaled for ${now.date}: ${count}.`);
  lines.push("Option orders and cancels are allowed without a permission prompt by .claude/settings.json unless the user added an ask rule; other order tools prompt the user. The risk gate hook may deny entries that breach .env limits. Exits and cancels are not capped.");

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
  for (const k of ["DEEPTRADE_RISK_PER_TRADE_PCT", "DEEPTRADE_MAX_POSITIONS", "DEEPTRADE_DAILY_LOSS_PCT", "DEEPTRADE_CHECK_EVERY_MIN", "DEEPTRADE_MANAGE_EVERY_MIN", "DEEPTRADE_TEAM_SIZE", "DEEPTRADE_SCAN_MIN_PRICE", "DEEPTRADE_SCAN_MIN_AVG_VOLUME"]) {
    const n = L.num(plan[k].value);
    if (n === null || n <= 0) out.push(`${k}=${plan[k].value} must be a positive number.`);
  }
  // RISK_PER_TRADE_PCT is the most one trade may lose, in percent of what the
  // trade cost. It used to mean percent of equity, where values like 0.5 to 5
  // were normal; as a percent of the trade they put the stop inside the noise.
  const risk = L.num(plan.DEEPTRADE_RISK_PER_TRADE_PCT.value);
  if (risk !== null && risk > 100) out.push(`DEEPTRADE_RISK_PER_TRADE_PCT=${risk} is over 100. It is the most one trade may lose, in percent of what the trade cost.`);
  else if (risk !== null && risk > 0 && risk < 15) out.push(`DEEPTRADE_RISK_PER_TRADE_PCT=${risk} now means the most one trade may lose in percent of the trade's own cost, not of equity. ${risk}% of a same-day option is inside its normal noise, so stops would be hit almost at once. If this was set under the old equity meaning, ask the user to change it (default 25).`);
  // One full loss (the per-order cap times the ceiling) must fit in the daily
  // loss limit, or position-sizing shrinks every trade to nothing.
  const daily = L.num(plan.DEEPTRADE_DAILY_LOSS_PCT.value);
  if (risk !== null && risk > 0 && risk <= 100 && daily !== null && daily > 0) {
    const st = L.readState(L.path.join(dir, "journal", L.ACCOUNT_STATE_FILE));
    const usd = L.num(env.DEEPTRADE_MAX_ORDER_USD);
    const pctSet = L.num(env.DEEPTRADE_MAX_ORDER_PCT);
    const capPct = usd !== null && st.equity ? Math.min(usd / st.equity * 100, pctSet !== null ? pctSet : usd / st.equity * 100) : pctSet !== null ? pctSet : usd === null ? 10 : null;
    if (capPct !== null) {
      const full = (capPct * risk) / 100;
      if (daily < full) out.push(`DEEPTRADE_DAILY_LOSS_PCT=${daily} is less than one full loss: a trade at the per-order cap (about ${capPct.toFixed(1)}% of equity) can lose ${risk}% of itself, ${full.toFixed(1)}% of equity. Position-sizing would shrink every trade to fit, so few or none would be placed. Raise the daily limit or lower the cap.`);
    }
  }
  const team = L.num(plan.DEEPTRADE_TEAM_SIZE.value);
  if (team !== null && team > 1) {
    if (!L.truthy(env.DEEPTRADE_EXPOSURE_GUARD)) out.push(`DEEPTRADE_TEAM_SIZE=${team} needs DEEPTRADE_EXPOSURE_GUARD=true, or two agents could open the same position twice.`);
    const classes = L.csv(env.DEEPTRADE_ALLOWED_ASSET_CLASSES).map((c) => c.toLowerCase());
    if (classes.length !== 1 || classes[0] !== "option") out.push(`DEEPTRADE_TEAM_SIZE=${team} needs DEEPTRADE_ALLOWED_ASSET_CLASSES=option. The exposure guard that keeps two agents from doubling a position covers option entries only.`);
    // The order lock is taken before any permission prompt and expires after
    // 15 s, so a manual approval step on option orders can let both members in.
    for (const f of ["settings.json", "settings.local.json"]) {
      try {
        const ask = (JSON.parse(L.fs.readFileSync(L.path.join(dir, ".claude", f), "utf8")).permissions || {}).ask || [];
        if (ask.some((r) => /place_option_order|^mcp__robinhood-trading(__\*)?$/.test(String(r)))) out.push(`DEEPTRADE_TEAM_SIZE=${team} cannot be used while .claude/${f} asks for approval of option orders: an approval that takes more than a few seconds lets the second member enter past the order lock. Run one agent, or remove that ask rule.`);
      } catch {
        /* no file or not JSON */
      }
    }
    const mp = L.num(plan.DEEPTRADE_MAX_POSITIONS.value);
    if (mp !== null && mp < 2) out.push(`DEEPTRADE_TEAM_SIZE=${team} needs DEEPTRADE_MAX_POSITIONS of at least 2, so the hunter can flip while the holder exits.`);
  }
  return out;
}

function marketStatus(now, env) {
  if (!now.ok) return "Market status unknown: timezone could not be resolved.";
  const day = L.marketDay(now.date, now.weekday);
  if (day.status === "weekend") return "US equity market: closed (weekend). Crypto trades around the clock.";
  if (day.status === "holiday") return `US equity market: closed today, ${now.date}, for ${day.name} (NYSE calendar). No entries; the risk gate blocks them. Crypto trades around the clock.`;
  const open = 9 * 60 + 30;
  const close = day.closeMin;
  let s;
  if (now.minutes < 4 * 60) s = "US equity market: closed. Pre-market opens 04:00 local market time.";
  else if (now.minutes < open) s = "US equity market: pre-market session. Regular hours open at 09:30.";
  else if (now.minutes < close) s = `US equity market: regular hours open. ${close - now.minutes} minutes until the ${L.fmtHHMM(close)} close.`;
  else if (now.minutes < 20 * 60) s = `US equity market: after-hours session. Regular hours closed at ${L.fmtHHMM(close)}.`;
  else s = "US equity market: closed for the day.";
  if (day.status === "early") {
    const after = L.parseHHMM((env || {}).DEEPTRADE_NO_NEW_ENTRIES_AFTER);
    const flat = L.parseHHMM(L.planSettings(env || {}).DEEPTRADE_FLAT_BY.value);
    s += ` Today is an early-close day (NYSE calendar): stocks close at ${L.fmtHHMM(close)}, and same-day options stop earlier. The risk gate moves the entry cutoff ${day.shiftMin} minutes earlier${after !== null ? `, to ${L.fmtHHMM(after - day.shiftMin)}` : ""}. Move the flat-by time the same way${flat !== null ? `, to ${L.fmtHHMM(flat - day.shiftMin)}` : ""}, and use each contract's sellout time if earlier.`;
  } else if (day.status === "unchecked") {
    s += ` The hooks' market calendar ends ${L.MARKET_CALENDAR.coveredThrough}, so holidays and early closes are not checked today: verify with the broker, and ask the user to update MARKET_CALENDAR in .claude/hooks/lib.js.`;
  }
  const ahead = [];
  for (let k = 1; k <= 7; k++) {
    const d = new Date(Date.parse(now.date + "T12:00:00Z") + k * 86400e3);
    const ds = d.toISOString().slice(0, 10);
    const wd = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const md = L.marketDay(ds, wd);
    if (md.status === "holiday") ahead.push(`${ds} closed (${md.name})`);
    if (md.status === "early") ahead.push(`${ds} closes early at ${L.fmtHHMM(md.closeMin)}`);
  }
  if (ahead.length) s += ` Coming up: ${ahead.join("; ")}.`;
  return s;
}

try {
  main();
} catch {
  process.exitCode = 0;
}
