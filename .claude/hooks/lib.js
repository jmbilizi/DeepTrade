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
const OPTION_TYPES_FILE = "option-types.json";
const OPTION_POSITIONS_FILE = "option-positions.json";
const OPTION_OPEN_ORDERS_FILE = "option-open-orders.json";
const ORDER_LOCK_FILE = "order-lock.json";
// An order lock older than this is stale: its order was never recorded, for
// example because the call failed. Short, so a failed call does not hold up the
// partner's flip. Team mode refuses manual approval, which could outlast it.
const ORDER_LOCK_TTL_MS = 15000;
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
  "DEEPTRADE_EXPOSURE_GUARD",
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
  DEEPTRADE_MANAGE_EVERY_MIN: "1",
  DEEPTRADE_TEAM_SIZE: "1",
  DEEPTRADE_FRACTIONAL_SHARES: "true",
  DEEPTRADE_SCAN_MIN_PRICE: "10",
  DEEPTRADE_SCAN_MIN_AVG_VOLUME: "2000000",
};

const ASSET_CLASSES = ["equity", "option", "crypto"];

// US equity market calendar, from NYSE Group's published holiday and early
// closings calendar (checked 2026-11-03 at ir.theice.com and nyse.com). Update
// it when NYSE publishes the next year; past COVERED_THROUGH the hooks say the
// day is unchecked. Early closes are 13:00 ET for stocks (options 13:15).
const MARKET_CALENDAR = {
  coveredThrough: "2027-12-31",
  holidays: {
    "2026-01-01": "New Year's Day", "2026-01-19": "Martin Luther King Jr. Day", "2026-02-16": "Washington's Birthday",
    "2026-04-03": "Good Friday", "2026-05-25": "Memorial Day", "2026-06-19": "Juneteenth", "2026-07-03": "Independence Day (observed)",
    "2026-09-07": "Labor Day", "2026-11-26": "Thanksgiving Day", "2026-12-25": "Christmas Day",
    "2027-01-01": "New Year's Day", "2027-01-18": "Martin Luther King Jr. Day", "2027-02-15": "Washington's Birthday",
    "2027-03-26": "Good Friday", "2027-05-31": "Memorial Day", "2027-06-18": "Juneteenth (observed)", "2027-07-05": "Independence Day (observed)",
    "2027-09-06": "Labor Day", "2027-11-25": "Thanksgiving Day", "2027-12-24": "Christmas Day (observed)",
  },
  earlyCloses: { "2026-11-27": "13:00", "2026-12-24": "13:00", "2027-11-26": "13:00" },
};
const REGULAR_CLOSE_MIN = 16 * 60;

// { status: "holiday" | "early" | "regular" | "weekend" | "unchecked", name, closeMin, shiftMin }
// shiftMin is how many minutes earlier than 16:00 the market closes.
function marketDay(date, weekday) {
  if (weekday === "Saturday" || weekday === "Sunday") return { status: "weekend", closeMin: null, shiftMin: 0 };
  if (MARKET_CALENDAR.holidays[date]) return { status: "holiday", name: MARKET_CALENDAR.holidays[date], closeMin: null, shiftMin: 0 };
  if (MARKET_CALENDAR.earlyCloses[date]) {
    const closeMin = parseHHMM(MARKET_CALENDAR.earlyCloses[date]);
    return { status: "early", closeMin, shiftMin: REGULAR_CLOSE_MIN - closeMin };
  }
  if (date > MARKET_CALENDAR.coveredThrough) return { status: "unchecked", closeMin: REGULAR_CLOSE_MIN, shiftMin: 0 };
  return { status: "regular", closeMin: REGULAR_CLOSE_MIN, shiftMin: 0 };
}

function fmtHHMM(min) {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

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
  saveIdMap(file, found);
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

// ---------- team exposure (DEEPTRADE_EXPOSURE_GUARD) ----------
// Several agents can trade one account. With the guard on, an option entry
// needs two fresh, complete broker reads for the order's account: positions
// (get_option_positions) and open orders (get_option_orders). From them the
// gate enforces DEEPTRADE_MAX_POSITIONS and at most one open or pending long
// position per direction (call, put) across every agent, and an account-wide
// lock lets one entry through at a time. Anything it cannot read fails closed.

// Broker order states that can still fill. pending_cancelled is a cancel in
// flight; the order can fill before it lands, so it still counts.
const OPEN_ORDER_STATES = new Set(["unconfirmed", "queued", "confirmed", "partially_filled", "pending_cancelled"]);

const walkJson = (v, visit) => parseMaybeJson(v, 0, visit);

function collectOptionTypes(response) {
  const out = {};
  walkJson(response, (o) => {
    const id = typeof o.option_id === "string" ? o.option_id : typeof o.id === "string" ? o.id : "";
    const raw = String(o.option_type || o.type || "").toLowerCase();
    if (id && (raw === "call" || raw === "put")) out[id] = raw;
  });
  return out;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

// Merge id -> value maps into a hook-written file, newest entries kept.
function saveIdMap(file, found, max = OPTION_IDS_MAX) {
  if (!Object.keys(found).length) return;
  const cur = readJsonFile(file);
  const base = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
  for (const k of Object.keys(found)) delete base[k];
  const merged = { ...base, ...found };
  const keys = Object.keys(merged);
  const kept = keys.length > max ? Object.fromEntries(keys.slice(-max).map((k) => [k, merged[k]])) : merged;
  fs.writeFileSync(file, JSON.stringify(kept), "utf8");
}

// Accounts are compared by their last 4 characters so no full number is stored.
const acctKey = (a) => (a === undefined || a === null || a === "" ? "" : "…" + String(a).slice(-4));

function isKnownAgentic(jdir, account) {
  const known = readJsonFile(path.join(jdir, AGENTIC_ACCOUNTS_FILE));
  return Array.isArray(known) && known.map(String).includes(String(account || ""));
}

// The `next` cursor of a paged response, or "".
function nextCursor(response) {
  let next = "";
  walkJson(response, (o) => {
    if (!next && !Array.isArray(o) && typeof o.next === "string" && o.next.trim()) next = o.next.trim();
  });
  return next;
}

// Rows of the first `positions` array found, or null when there is none
// (an error or an unexpected shape). bad counts rows the gate cannot identify.
function positionRows(response) {
  let rows = null;
  let bad = 0;
  walkJson(response, (o) => {
    if (rows || !Array.isArray(o.positions)) return;
    rows = [];
    for (const r of o.positions) {
      if (!r || typeof r !== "object") continue;
      const qty = num(r.quantity) || 0;
      if (typeof r.option_id !== "string" || !r.option_id) {
        if (qty !== 0) bad++;
        continue;
      }
      rows.push({ option_id: r.option_id, symbol: typeof r.chain_symbol === "string" ? r.chain_symbol.toUpperCase() : null, side: String(r.type || "").toLowerCase(), quantity: qty });
    }
  });
  return { rows, bad };
}

// Open opening orders from a get_option_orders response, or null.
function openEntryOrders(response) {
  let list = null;
  let bad = 0;
  walkJson(response, (o) => {
    if (list || !Array.isArray(o.orders)) return;
    list = [];
    for (const ord of o.orders) {
      if (!ord || typeof ord !== "object") continue;
      if (!OPEN_ORDER_STATES.has(String(ord.state || "").toLowerCase())) continue;
      const legs = Array.isArray(ord.legs) ? ord.legs.filter((l) => l && String(l.position_effect).toLowerCase() === "open") : [];
      if (!legs.length) continue;
      if (legs.some((l) => typeof l.option_id !== "string" || !l.option_id)) {
        bad++;
        continue;
      }
      list.push({
        order_id: typeof ord.id === "string" ? ord.id : null,
        symbol: typeof ord.chain_symbol === "string" ? ord.chain_symbol.toUpperCase() : null,
        legs: legs.map((l) => ({ option_id: l.option_id, direction: ["call", "put"].includes(String(l.option_type).toLowerCase()) ? String(l.option_type).toLowerCase() : null })),
      });
    }
  });
  return { rows: list, bad };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// A paged read is complete once every page has been read in a row: page 1
// (no cursor), then each `next` cursor, within this window.
const PAGE_CHAIN_MS = 60000;

// Called by the journal hook on every read. Writes option-positions.json and
// option-open-orders.json for the agentic account the read was for. The read
// time is when the call started (now minus its duration), so a read that was
// in flight while another agent's order landed counts as older than that order.
function recordExposureReads(jdir, toolTailName, toolInput, response, tz, durationMs) {
  const isPos = /^get_option_positions$/i.test(toolTailName);
  const isOrd = /^get_option_orders$/i.test(toolTailName);
  if (!isPos && !isOrd) return;
  const ti = toolInput && typeof toolInput === "object" ? toolInput : {};
  if (!isKnownAgentic(jdir, ti.account_number)) return;
  const file = path.join(jdir, isPos ? OPTION_POSITIONS_FILE : OPTION_OPEN_ORDERS_FILE);
  const now = Date.now();
  const started = now - (Number.isFinite(Number(durationMs)) && Number(durationMs) >= 0 ? Number(durationMs) : 5000);
  const isSet = (k) => ti[k] !== undefined && ti[k] !== null && ti[k] !== "";
  const allowed = isPos ? ["account_number", "nonzero", "cursor"] : ["account_number", "created_at_gte", "cursor"];
  const extra = Object.keys(ti).filter((k) => isSet(k) && !allowed.includes(k));
  const got = isPos ? positionRows(response) : openEntryOrders(response);
  const next = nextCursor(response);
  const account = acctKey(ti.account_number);
  const today = localParts(tz).date;
  const since = isSet("created_at_gte") ? String(ti.created_at_gte) : "";
  let why =
    got.rows === null ? `the response had no ${isPos ? "positions" : "orders"} list (an error or a new format)`
    : got.bad ? `${got.bad} ${isPos ? "position(s)" : "open entry order(s)"} had no contract id`
    : extra.length ? `it was filtered by ${extra.join(", ")}`
    : !isPos && !(ISO_DATE.test(since) && since <= today) ? `created_at_gte must be a date on or before today (${today})`
    : "";
  let items = got.rows || [];
  let updatedAt = started;
  if (!why && isSet("cursor")) {
    const prev = readJsonFile(file);
    const ok = prev && prev.account === account && prev.next_cursor && prev.next_cursor === String(ti.cursor) && now - Date.parse(prev.updated_at || "") < PAGE_CHAIN_MS;
    if (!ok) why = "a later page was read without the pages before it; start again from the first page";
    else {
      items = [...(prev.items || []), ...items];
      updatedAt = Date.parse(prev.updated_at);
    }
  }
  const pending = !why && next ? next : "";
  if (!why && next) why = `more pages remain; read the next page with cursor = the response's next value`;
  fs.writeFileSync(file, JSON.stringify({ updated_at: new Date(updatedAt).toISOString(), account, complete: !why, why, next_cursor: pending, items }), "utf8");
}

// Open or pending long-option exposure on `account` across all agents.
// Returns { exposures: [{ option_id, symbol, direction }], types } or { error }.
// `notBefore` (ms) requires both reads to be newer than that time too.
function optionExposure(jdir, account, notBefore = null, now = Date.now()) {
  const last = lastOrderMs(path.join(jdir, "orders.jsonl"));
  const reads = [
    ["get_option_positions (only account_number and nonzero: true)", readJsonFile(path.join(jdir, OPTION_POSITIONS_FILE))],
    ["get_option_orders (only account_number and created_at_gte = today's date)", readJsonFile(path.join(jdir, OPTION_OPEN_ORDERS_FILE))],
  ];
  for (const [name, r] of reads) {
    if (!r) return { error: `no ${name} read is recorded` };
    const at = Date.parse(r.updated_at || "");
    if (!Number.isFinite(at)) return { error: `the ${name} read has no time` };
    if (!r.complete) return { error: `the last ${name} read is not complete: ${r.why}` };
    if (r.account !== acctKey(account)) return { error: `the last ${name} read was for a different account than this order` };
    if ((now - at) / 60000 > STATE_MAX_AGE_MIN) return { error: `the last ${name} read is ${Math.round((now - at) / 1000)} s old (limit ${STATE_MAX_AGE_MIN} min)` };
    if (last !== null && last >= at) return { error: `an order or cancel (by this or another agent) came after the last ${name} read` };
    if (notBefore !== null && notBefore >= at) return { error: `an earlier entry went through the gate but was never recorded, so the last ${name} read may not show it` };
  }
  const [pos, ord] = [{ rows: reads[0][1].items || [] }, { orders: reads[1][1].items || [] }];
  const types = readJsonFile(path.join(jdir, OPTION_TYPES_FILE)) || {};
  const exposures = [];
  const seen = new Set();
  for (const r of pos.rows) {
    if (r.side === "short" || !(r.quantity > 0) || seen.has(r.option_id)) continue;
    seen.add(r.option_id);
    exposures.push({ option_id: r.option_id, symbol: r.symbol, direction: types[r.option_id] || null });
  }
  for (const o of ord.orders) {
    for (const l of o.legs) {
      if (!l.option_id || seen.has(l.option_id)) continue;
      seen.add(l.option_id);
      exposures.push({ option_id: l.option_id, symbol: o.symbol, direction: l.direction || types[l.option_id] || null, pending: true });
    }
  }
  return { exposures, types };
}

function orderLockPath(jdir) {
  return path.join(jdir, ORDER_LOCK_FILE);
}

// Who holds a lock: the tool call if Claude Code names it, else the agent or
// session. A subagent can share its parent's session id, so the tool call id
// is what separates two team members in one session.
function lockOwner(input) {
  const i = input || {};
  return String(i.tool_use_id || i.agent_id || i.session_id || "unknown");
}

// Take the account-wide entry lock: one opening order in flight at a time,
// whoever sends it. Returns { staleTs } on success (the time of a stale lock
// it replaced, or null), else { reason }.
function takeOrderLock(jdir, owner, now = Date.now()) {
  const file = orderLockPath(jdir);
  let staleTs = null;
  let raw = null;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    /* no lock */
  }
  if (raw !== null) {
    let cur = null;
    try {
      cur = JSON.parse(raw);
    } catch {
      /* unreadable lock: treat as stale */
    }
    let t = cur ? Date.parse(cur.ts || "") : NaN;
    if (!Number.isFinite(t)) {
      // Empty or unreadable: judge it by the file's age, never as free.
      try {
        t = fs.statSync(file).mtimeMs;
      } catch {
        t = now;
      }
    }
    const age = now - t;
    if (cur && cur.owner === owner) return { staleTs: null };
    if (Number.isFinite(age) && age < ORDER_LOCK_TTL_MS) return { reason: `another entry went through the gate ${Math.round(age / 1000)} s ago and has not been recorded yet` };
    // Replace a stale lock atomically: move it aside, and if what was moved is
    // not the lock we judged stale, put it back and give up.
    const aside = `${file}.${process.pid}.${now}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      return { reason: "another entry is replacing a stale order lock at the same moment" };
    }
    let moved = null;
    try {
      moved = fs.readFileSync(aside, "utf8");
    } catch {
      /* vanished */
    }
    if (moved !== raw) {
      try {
        fs.linkSync(aside, file);
      } catch {
        /* someone else holds it now */
      }
      try {
        fs.unlinkSync(aside);
      } catch {
        /* gone */
      }
      return { reason: "another entry took the order lock at the same moment" };
    }
    try {
      fs.unlinkSync(aside);
    } catch {
      /* gone */
    }
    staleTs = t;
  }
  // Write the lock in full first, then link it into place: link fails if the
  // lock exists, and the lock never appears empty to another process.
  const tmp = `${file}.${process.pid}.${now}.new`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ owner, ts: new Date(now).toISOString() }), "utf8");
    fs.linkSync(tmp, file);
    return { staleTs };
  } catch {
    return { reason: "another entry took the order lock at the same moment" };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* gone */
    }
  }
}

// Release only the lock this tool call took.
function releaseOrderLock(jdir, owner) {
  const file = orderLockPath(jdir);
  const cur = readJsonFile(file);
  if (cur && cur.owner === owner) {
    try {
      fs.unlinkSync(file);
    } catch {
      /* gone already */
    }
  }
}

module.exports = {
  MARKET_CALENDAR,
  marketDay,
  fmtHHMM,
  STATE_MAX_AGE_MIN,
  ACCOUNT_STATE_FILE,
  SETTINGS_SNAPSHOT_FILE,
  settingsSnapshot,
  settingsChanges,
  lastOrderMs,
  OPTION_TYPES_FILE,
  OPTION_POSITIONS_FILE,
  OPTION_OPEN_ORDERS_FILE,
  ORDER_LOCK_FILE,
  collectOptionTypes,
  saveIdMap,
  recordExposureReads,
  optionExposure,
  lockOwner,
  takeOrderLock,
  releaseOrderLock,
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
