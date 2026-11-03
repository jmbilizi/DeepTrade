"use strict";
// Shared helpers for DeepTrade hooks. No dependencies. CommonJS on purpose so
// the scripts run on any Node 18+ without a package.json.

const fs = require("fs");
const path = require("path");

// Account state (equity, buying power) is recorded by the journal hook from
// the broker's own responses. Entries need a read this recent, and newer than
// the last order, because every fill and cancel changes buying power.
const STATE_MAX_AGE_MIN = 2;
const ACCOUNT_STATE_FILE = "account-state.json";
const AGENTIC_ACCOUNTS_FILE = "agentic-accounts.json";
const DEFAULT_TZ = "America/New_York";

// ---------- IO ----------

function readStdinJson() {
  try {
    return JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {
    return null;
  }
}

function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || (input && input.cwd) || process.cwd();
}

function emit(obj) {
  // Write then let the event loop drain. Never process.exit() right after a write.
  process.stdout.write(JSON.stringify(obj));
  process.exitCode = 0;
}

function loadEnv(file) {
  const out = {};
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

// ---------- settings ----------
// .env is the single source of truth. Guardrail keys are enforced by the risk
// gate. Plan keys guide the agent and are reported at session start. Defaults
// live here and nowhere else, so docs, hooks, and agents cannot drift apart.

const GUARDRAIL_KEYS = [
  "DEEPTRADE_HALT",
  "DEEPTRADE_HALT_ALL",
  "DEEPTRADE_ALLOWED_ASSET_CLASSES",
  "DEEPTRADE_ALLOWED_SYMBOLS",
  "DEEPTRADE_BLOCKED_SYMBOLS",
  "DEEPTRADE_NO_NEW_ENTRIES_BEFORE",
  "DEEPTRADE_NO_NEW_ENTRIES_AFTER",
  "DEEPTRADE_MAX_ORDER_USD",
  "DEEPTRADE_MAX_ORDER_PCT",
  "DEEPTRADE_MAX_ORDERS_PER_DAY",
  "DEEPTRADE_REQUIRE_KNOWN_VALUE",
  "DEEPTRADE_ALLOW_SHORTS",
  "DEEPTRADE_GATE_SELLS", // legacy alias of DEEPTRADE_ALLOW_SHORTS
  "DEEPTRADE_TIMEZONE",
];

// Per-order cap when .env sets neither DEEPTRADE_MAX_ORDER_USD nor DEEPTRADE_MAX_ORDER_PCT.
const DEFAULT_MAX_ORDER_PCT = 10;

// Per-order cap rule, shared by the risk gate and the session report.
//   neither set   -> DEFAULT_MAX_ORDER_PCT of equity
//   only USD      -> USD, or the default percent when buying power is below it
//   only percent  -> that percent of equity
//   both          -> the lower of the two
// Returns { value, how } or { value: null, missing } when the account state it
// needs is missing, stale, or older than the last order (lastOrder, ms).
function orderCap(env, state, lastOrder) {
  const usd = num(env.DEEPTRADE_MAX_ORDER_USD);
  const pctSet = num(env.DEEPTRADE_MAX_ORDER_PCT);
  const pct = pctSet !== null ? pctSet : DEFAULT_MAX_ORDER_PCT;
  const pctLabel = pctSet !== null ? "DEEPTRADE_MAX_ORDER_PCT" : "default";
  const missing = !state || state.equity === null
    ? "no account read is recorded yet"
    : state.stale
      ? `the last account read is ${state.ageMin.toFixed(1)} minutes old (limit ${STATE_MAX_AGE_MIN})`
      : lastOrder !== null && lastOrder !== undefined && state.updatedMs !== null && state.updatedMs < lastOrder
        ? "an order or cancel was sent after the last account read, so buying power has changed"
        : usd !== null && pctSet === null && state.buyingPower === null
          ? "the last account read has no buying power"
          : null;
  if (missing) return { value: null, missing };
  const pctCap = (pct / 100) * state.equity;
  const pctHow = `${pct}% of equity $${state.equity.toFixed(2)} (${pctLabel})`;
  if (usd === null) return { value: pctCap, how: pctHow };
  if (pctSet !== null) {
    return usd <= pctCap
      ? { value: usd, how: `DEEPTRADE_MAX_ORDER_USD, lower than ${pctHow}` }
      : { value: pctCap, how: `${pctHow}, lower than DEEPTRADE_MAX_ORDER_USD $${usd}` };
  }
  if (state.buyingPower >= usd) return { value: usd, how: `DEEPTRADE_MAX_ORDER_USD; buying power $${state.buyingPower.toFixed(2)} covers it` };
  return { value: pctCap, how: `${pctHow}, because buying power $${state.buyingPower.toFixed(2)} is below DEEPTRADE_MAX_ORDER_USD $${usd}` };
}

function describeOrderCap(env) {
  const usd = num(env.DEEPTRADE_MAX_ORDER_USD);
  const pctSet = num(env.DEEPTRADE_MAX_ORDER_PCT);
  if (usd !== null && pctSet !== null) return `the lower of DEEPTRADE_MAX_ORDER_USD $${usd} and ${pctSet}% of equity`;
  if (usd !== null) return `DEEPTRADE_MAX_ORDER_USD $${usd} while buying power covers it, otherwise ${DEFAULT_MAX_ORDER_PCT}% of equity (default)`;
  if (pctSet !== null) return `${pctSet}% of equity (DEEPTRADE_MAX_ORDER_PCT)`;
  return `${DEFAULT_MAX_ORDER_PCT}% of equity (default; set DEEPTRADE_MAX_ORDER_USD or DEEPTRADE_MAX_ORDER_PCT to change it)`;
}

const PLAN_DEFAULTS = {
  DEEPTRADE_STRATEGIES: "opening-range-breakout",
  DEEPTRADE_RISK_PER_TRADE_PCT: "0.5",
  DEEPTRADE_MAX_POSITIONS: "2",
  DEEPTRADE_DAILY_LOSS_PCT: "1.5",
  DEEPTRADE_FLAT_BY: "15:50",
  DEEPTRADE_CHECK_EVERY_MIN: "5",
  DEEPTRADE_FRACTIONAL_SHARES: "true",
  DEEPTRADE_SCAN_MIN_PRICE: "10",
  DEEPTRADE_SCAN_MIN_AVG_VOLUME: "2000000",
};

const ASSET_CLASSES = ["equity", "option", "crypto"];

// Optional data sources. Each is an .mcp.json server started through
// optional-mcp.js, which offers no tools unless its key is set in .env.
// planKey names the .env setting that records the user's subscription tier.
// minNode is the Node major version the server needs, checked only when the
// key is set, since the core hooks run on Node 18.
const OPTIONAL_SOURCES = [
  { name: "Unusual Whales", server: "unusual-whales", key: "UNUSUAL_WHALES_API_KEY", planKey: "DEEPTRADE_UNUSUAL_WHALES_PLAN", plans: ["starter", "basic", "advanced"], minNode: 20 },
];

// Plan settings with defaults filled in. Each value is { value, isDefault }.
// Settings the agent was told about at session start, so a mid-session .env
// edit can be surfaced before the next entry. API keys are never included.
const SETTINGS_SNAPSHOT_FILE = "settings-snapshot.json";

function settingsSnapshot(env) {
  const out = {};
  for (const k of GUARDRAIL_KEYS) out[k] = env[k] === undefined ? "" : String(env[k]).trim();
  for (const [k, v] of Object.entries(planSettings(env))) out[k] = v.value;
  for (const s of OPTIONAL_SOURCES) if (s.planKey) out[s.planKey] = env[s.planKey] === undefined ? "" : String(env[s.planKey]).trim();
  return out;
}

function settingsChanges(oldSnap, newSnap) {
  const keys = new Set([...Object.keys(oldSnap || {}), ...Object.keys(newSnap)]);
  const out = [];
  for (const k of keys) {
    const a = (oldSnap || {})[k] === undefined ? "" : oldSnap[k];
    const b = newSnap[k] === undefined ? "" : newSnap[k];
    if (a !== b) out.push(`${k}: ${a === "" ? "unset" : a} -> ${b === "" ? "unset" : b}`);
  }
  return out;
}

function planSettings(env) {
  const out = {};
  for (const [k, d] of Object.entries(PLAN_DEFAULTS)) {
    const set = env[k] !== undefined && String(env[k]).trim() !== "";
    out[k] = { value: set ? String(env[k]).trim() : d, isDefault: !set };
  }
  return out;
}

// Shorts make a plain sell an entry, so the gate must cap sells too.
function gateSells(env) {
  return truthy(env.DEEPTRADE_ALLOW_SHORTS) || truthy(env.DEEPTRADE_GATE_SELLS);
}

// ---------- scalars ----------

function truthy(v) {
  return /^(1|true|yes|on)$/i.test(String(v || "").trim());
}

function num(v) {
  if (v === undefined || v === null || String(v).trim() === "") return null;
  const n = Number(String(v).replace(/[$,_\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function csv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function parseHHMM(v) {
  const m = String(v || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// ---------- time ----------

function localParts(tz, date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "long",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    const hour = Number(get("hour")) % 24;
    const minute = Number(get("minute"));
    return {
      ok: true,
      date: `${get("year")}-${get("month")}-${get("day")}`,
      weekday: get("weekday"),
      minutes: hour * 60 + minute,
      text: `${get("weekday")} ${get("year")}-${get("month")}-${get("day")} ${String(hour).padStart(2, "0")}:${get("minute")}`,
    };
  } catch {
    return { ok: false, date: date.toISOString().slice(0, 10), weekday: "", minutes: -1, text: date.toISOString() };
  }
}

// ---------- tool classification ----------

function toolTail(name) {
  return String(name || "").replace(/^mcp__[^_]+(?:[-_][^_]+)*__/, "");
}

// Read-only or non-mutating tools, matched at the start of the tool name so
// camelCase and snake_case both work. "review_*" and "preview_*" are previews.
const SAFE_PREFIX = /^(get|list|read|fetch|search|find|describe|show|lookup|review|preview|estimate|simulate|validate|quote|orderbook|analy|check|history|screen|scan)/i;
// Anything that can change money or exposure.
const MUTATING = /(order|buy|sell|trade|execut|submit|place|create|open|close|exercise|liquidat|transfer|withdraw|deposit|roll|replace|modify|amend|assign)/i;

// Robinhood Trading MCP tools observed 2026-11-03 that change settings, not
// money or exposure: alerts, scans, chart indicators, watchlists, OAuth, and
// declining a pending trade approval. Exact names, checked before the patterns.
const NO_MONEY_TOOLS = new Set([
  "authenticate", "complete_authentication",
  "create_alert", "update_alert", "delete_alert", "mark_alerts_read",
  "create_scan", "run_scan", "update_scan_config", "update_scan_filters",
  "add_legend_indicator", "update_legend_indicator", "remove_legend_indicator", "set_legend_chart_settings",
  "decline_trade_approval",
]);

function classifyTool(name) {
  const tail = toolTail(name);
  if (NO_MONEY_TOOLS.has(tail.toLowerCase())) return "read";
  if (/cancel/i.test(tail)) return "cancel";
  if (/watchlist/i.test(tail)) return "read";
  if (SAFE_PREFIX.test(tail)) return "read";
  if (MUTATING.test(tail)) return "order";
  return "other";
}

// ---------- payload inspection ----------

function walk(obj, fn, depth = 0, keyPath = []) {
  if (!obj || typeof obj !== "object" || depth > 5) return;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    fn(k, v, depth, keyPath.concat(k));
    if (v && typeof v === "object") walk(v, fn, depth + 1, keyPath.concat(k));
  }
}

function firstString(obj, keyRe) {
  let found = null;
  walk(obj, (k, v) => {
    if (found === null && keyRe.test(k) && typeof v === "string" && v.trim()) found = v.trim();
  });
  return found;
}

function firstNumber(obj, keyRe) {
  let found = null;
  let foundKey = null;
  walk(obj, (k, v) => {
    if (found !== null || !keyRe.test(k)) return;
    const n = num(v);
    if (n !== null) {
      found = n;
      foundKey = k;
    }
  });
  return { value: found, key: foundKey };
}

function topNumber(obj, keyRe) {
  for (const k of Object.keys(obj || {})) {
    if (!keyRe.test(k)) continue;
    const n = num(obj[k]);
    if (n !== null) return { value: n, key: k };
  }
  return null;
}

function optionLegs(toolInput) {
  const legs = toolInput && toolInput.legs;
  return Array.isArray(legs) ? legs.filter((l) => l && typeof l === "object") : [];
}

// ---------- option id -> underlying ----------
// Robinhood option orders name contracts only by UUID. The journal hook records
// id -> underlying from option lookups (get_option_instruments and similar) in
// journal/option-ids.json, so the gate can check the underlying symbol.

const OPTION_IDS_MAX = 5000;

function collectOptionIds(response, out = {}, depth = 0) {
  if (depth > 8 || response === null || response === undefined) return out;
  if (typeof response === "string") {
    const s = response.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        collectOptionIds(JSON.parse(s), out, depth + 1);
      } catch {
        /* not JSON */
      }
    }
    return out;
  }
  if (typeof response !== "object") return out;
  const sym = typeof response.chain_symbol === "string" ? response.chain_symbol.trim().toUpperCase() : "";
  const id = typeof response.option_id === "string" ? response.option_id : typeof response.id === "string" ? response.id : "";
  if (sym && id) out[id] = sym;
  for (const v of Object.values(response)) collectOptionIds(v, out, depth + 1);
  return out;
}

function readOptionIds(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    return m && typeof m === "object" && !Array.isArray(m) ? m : {};
  } catch {
    return {};
  }
}

function saveOptionIds(file, found) {
  if (!Object.keys(found).length) return;
  const merged = { ...readOptionIds(file), ...found };
  const keys = Object.keys(merged);
  const kept = keys.length > OPTION_IDS_MAX ? Object.fromEntries(keys.slice(-OPTION_IDS_MAX).map((k) => [k, merged[k]])) : merged;
  fs.writeFileSync(file, JSON.stringify(kept), "utf8");
}

// Symbol of an order: a symbol field, else the underlying of its option legs.
// Returns { symbol, unresolved } where unresolved lists leg ids not yet seen,
// or legs on different underlyings (reported as a mismatch).
function orderSymbol(toolInput, optionIdsFile) {
  const direct = findSymbol(toolInput);
  if (direct) return { symbol: direct, unresolved: [] };
  const legs = optionLegs(toolInput);
  if (!legs.length) return { symbol: null, unresolved: [] };
  const map = readOptionIds(optionIdsFile);
  const syms = new Set();
  const unresolved = [];
  for (const l of legs) {
    const s = map[String(l.option_id || "")];
    if (s) syms.add(s);
    else unresolved.push(String(l.option_id || "(no option_id)"));
  }
  if (unresolved.length || syms.size !== 1) return { symbol: null, unresolved: unresolved.length ? unresolved : ["legs on different underlyings"] };
  return { symbol: [...syms][0], unresolved: [] };
}

function hasKey(obj, keyRe) {
  let hit = false;
  walk(obj, (k) => {
    if (keyRe.test(k)) hit = true;
  });
  return hit;
}

const SYMBOL_KEY = /^(symbol|ticker|instrument|asset|underlying|underlying_symbol|pair|currency_pair)$/i;

function findSymbol(toolInput) {
  const s = firstString(toolInput, SYMBOL_KEY);
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return null;
  return s.toUpperCase();
}

function normalizeSymbol(s) {
  // BTC-USD, BTC/USD, BTCUSD -> BTC. OCC option symbols -> underlying root.
  const u = String(s || "").toUpperCase().replace(/\s+/g, "");
  const occ = u.match(/^([A-Z]{1,6})\d{6}[CP]\d{8}$/);
  if (occ) return occ[1];
  return u.replace(/[-/]?(USD|USDT|USDC)$/i, "");
}

function symbolAllowed(symbol, list) {
  const n = normalizeSymbol(symbol);
  return list.includes(symbol) || list.includes(n);
}

const OPTION_KEY = /^(strike|strike_price|expiration|expiration_date|expiry|option_type|contract_type|right|legs)$/i;
const OCC = /^[A-Z]{1,6}\s?\d{6}[CP]\d{8}$/;

function assetClass(toolName, toolInput) {
  const tail = toolTail(toolName);
  const sym = findSymbol(toolInput) || "";
  const typeStr = (firstString(toolInput, /^(instrument_type|asset_type|asset_class|security_type|product)$/i) || "").toLowerCase();
  if (/option/i.test(tail) || /option/.test(typeStr) || hasKey(toolInput, OPTION_KEY) || OCC.test(sym)) return "option";
  if (/crypto/i.test(tail) || /crypto/.test(typeStr) || /[-/](USD|USDT|USDC)$/i.test(sym)) return "crypto";
  if (/equit|stock/i.test(tail) || /equit|stock/.test(typeStr)) return "equity";
  return "unknown";
}

// Is this order reducing exposure? Conservative: only when the payload or tool
// name says so. With gateSells=true, only explicit close/reduce flags count,
// because a sell can open a short.
function isReducing(toolName, toolInput, gateSells) {
  const tail = toolTail(toolName);
  // Multi-leg option orders (Robinhood place_option_order): reducing only when
  // every leg closes. A sell leg alone can open a short option.
  const legs = optionLegs(toolInput);
  if (legs.length) return legs.every((l) => /^close/i.test(String(l.position_effect || "")));
  let flag = false;
  walk(toolInput, (k, v) => {
    if (/^(reduce_only|close_position|closing|is_close)$/i.test(k) && truthy(v)) flag = true;
  });
  if (/close_position|liquidat/i.test(tail)) flag = true;
  if (flag) return true;
  if (gateSells) return false;
  if (/(^|_)sell/i.test(tail) && !/open/i.test(tail)) return true;
  const side = firstString(toolInput, /^(side|action|direction|order_side|transaction_type|position_effect)$/i) || "";
  if (/^(sell|close|exit|reduce|liquidat)/i.test(side) && !/open/i.test(side)) return true;
  return false;
}

const NOTIONAL_KEY = /^(notional|notional_value|amount|dollar_amount|amount_usd|amount_in_dollars|quote_amount|cash_amount|total|total_value|order_value)$/i;
const QTY_KEY = /(quant|qty|shares|contracts|units)/i;
const LIMIT_KEY = /^(limit_price|stop_price|trigger_price|stop_limit_price|price)$/i;

// Returns { value, how, market }. value null when unknown. Uses the largest
// defensible estimate so a nested "value" field cannot shrink it.
function estimateNotional(toolInput, cls) {
  const estimates = [];
  for (const k of Object.keys(toolInput || {})) {
    if (NOTIONAL_KEY.test(k)) {
      const n = num(toolInput[k]);
      if (n !== null) estimates.push({ value: n, how: `${k} field` });
    }
  }
  const orderType = (firstString(toolInput, /^(type|order_type|time_in_force_type)$/i) || "").toLowerCase();
  const market = /market/.test(orderType);
  // Top-level fields first, so a leg's ratio_quantity is never read as the size.
  const qty = topNumber(toolInput, QTY_KEY) || firstNumber(toolInput, QTY_KEY);
  const price = topNumber(toolInput, LIMIT_KEY) || firstNumber(toolInput, LIMIT_KEY);
  if (qty.value !== null && price.value !== null && !market) {
    const mult = cls === "option" || /contract/i.test(qty.key) ? 100 : 1;
    estimates.push({ value: qty.value * price.value * mult, how: mult === 100 ? `${qty.key} x ${price.key} x 100` : `${qty.key} x ${price.key}` });
  }
  if (!estimates.length) {
    return { value: null, market, how: market ? "market order without a dollar amount, value unknown" : "no recognizable quantity and price fields" };
  }
  estimates.sort((a, b) => b.value - a.value);
  return { value: estimates[0].value, market, how: estimates[0].how };
}

// ---------- journal ----------

function readJournal(file) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  return out;
}

// Opening orders submitted on the given local date. Older records without the
// "gated" field count if kind is order, so the cap stays conservative.
function countOpeningOrders(file, localDate) {
  let n = 0;
  for (const r of readJournal(file)) {
    const d = r.date_local || String(r.ts || "").slice(0, 10);
    if (d !== localDate) continue;
    if (r.gated === true) n++;
    else if (r.gated === undefined && r.kind === "order") n++;
  }
  return n;
}

function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    const equity = num(s.equity);
    const bp = num(s.buying_power);
    const buyingPower = bp !== null ? bp : num(s.cash);
    const updatedMs = Date.parse(s.updated_at || "");
    const ageMin = Number.isFinite(updatedMs) ? (Date.now() - updatedMs) / 6e4 : Infinity;
    return { equity, buyingPower, updatedMs: Number.isFinite(updatedMs) ? updatedMs : null, ageMin, stale: ageMin > STATE_MAX_AGE_MIN };
  } catch {
    return { equity: null, buyingPower: null, updatedMs: null, ageMin: null, stale: false };
  }
}

// Time of the most recent order or cancel in orders.jsonl, in ms, or null.
function lastOrderMs(file) {
  let last = null;
  for (const r of readJournal(file)) {
    const t = Date.parse(r.ts || "");
    if (Number.isFinite(t) && (last === null || t > last)) last = t;
  }
  return last;
}

// ---------- account state from broker responses ----------

function parseMaybeJson(v, depth, visit) {
  if (depth > 8 || v === null || v === undefined) return;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("{") || s.startsWith("[")) {
      try {
        parseMaybeJson(JSON.parse(s), depth + 1, visit);
      } catch {
        /* not JSON */
      }
    }
    return;
  }
  if (typeof v !== "object") return;
  visit(v);
  for (const x of Object.values(v)) parseMaybeJson(x, depth + 1, visit);
}

// Account numbers the broker marks as tradable by this agent (get_accounts).
function collectAgenticAccounts(response) {
  const out = new Set();
  parseMaybeJson(response, 0, (o) => {
    if (o.agentic_allowed === true && (typeof o.account_number === "string" || typeof o.account_number === "number")) out.add(String(o.account_number));
  });
  return [...out];
}

// Equity, buying power, and cash from a portfolio response (get_portfolio).
function collectPortfolio(response) {
  let found = null;
  parseMaybeJson(response, 0, (o) => {
    if (found || !("total_value" in o) || !("buying_power" in o)) return;
    const bp = o.buying_power && typeof o.buying_power === "object" ? num(o.buying_power.buying_power) : num(o.buying_power);
    const equity = num(o.total_value);
    if (equity !== null && bp !== null) found = { equity, buying_power: bp, cash: num(o.cash) };
  });
  return found;
}

// Called by the journal hook on every broker read. Records the agentic account
// list from get_accounts (agentic-accounts.json), and the portfolio only when it
// is for that account (account-state.json). Two files, each written whole, so
// parallel tool calls cannot overwrite each other's result.
function recordAccountState(file, toolTailName, toolInput, response) {
  const acctFile = path.join(path.dirname(file), AGENTIC_ACCOUNTS_FILE);
  if (/^get_accounts$/i.test(toolTailName)) {
    const accts = collectAgenticAccounts(response);
    if (accts.length) fs.writeFileSync(acctFile, JSON.stringify(accts), "utf8");
    return;
  }
  if (/^get_portfolio$/i.test(toolTailName)) {
    let known = [];
    try {
      known = JSON.parse(fs.readFileSync(acctFile, "utf8")).map(String);
    } catch {
      return; // no get_accounts yet: record nothing, the gate refuses entries
    }
    const acct = String((toolInput && toolInput.account_number) || "");
    if (!acct || !known.includes(acct)) return;
    const p = collectPortfolio(response);
    if (p) fs.writeFileSync(file, JSON.stringify({ ...p, updated_at: new Date().toISOString() }), "utf8");
  }
}

// ---------- redaction ----------

function redact(v, depth = 0) {
  if (depth > 6) return "[depth]";
  if (typeof v === "string") return v.replace(/\d{8,}/g, (m) => "…" + m.slice(-4));
  if (typeof v === "number") return String(v).length >= 8 ? "…" + String(v).slice(-4) : v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v)) {
      if (/account/i.test(k) && (typeof v[k] === "string" || typeof v[k] === "number")) {
        const s = String(v[k]);
        out[k] = s.length > 4 ? "…" + s.slice(-4) : "…";
      } else {
        out[k] = redact(v[k], depth + 1);
      }
    }
    return out;
  }
  return v;
}

module.exports = {
  STATE_MAX_AGE_MIN,
  ACCOUNT_STATE_FILE,
  SETTINGS_SNAPSHOT_FILE,
  settingsSnapshot,
  settingsChanges,
  lastOrderMs,
  recordAccountState,
  collectPortfolio,
  collectAgenticAccounts,
  DEFAULT_TZ,
  GUARDRAIL_KEYS,
  PLAN_DEFAULTS,
  DEFAULT_MAX_ORDER_PCT,
  orderCap,
  describeOrderCap,
  ASSET_CLASSES,
  OPTIONAL_SOURCES,
  planSettings,
  gateSells,
  fs,
  path,
  readStdinJson,
  projectDir,
  emit,
  loadEnv,
  truthy,
  num,
  csv,
  parseHHMM,
  localParts,
  toolTail,
  classifyTool,
  findSymbol,
  optionLegs,
  collectOptionIds,
  saveOptionIds,
  orderSymbol,
  normalizeSymbol,
  symbolAllowed,
  assetClass,
  isReducing,
  estimateNotional,
  readJournal,
  countOpeningOrders,
  readState,
  redact,
};
