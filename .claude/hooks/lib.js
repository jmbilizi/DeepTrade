"use strict";
// Shared helpers for DeepTrade hooks. No dependencies. CommonJS on purpose so
// the scripts run on any Node 18+ without a package.json.

const fs = require("fs");
const path = require("path");

const STATE_MAX_AGE_HOURS = 20;
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

function classifyTool(name) {
  const tail = toolTail(name);
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
  const qty = firstNumber(toolInput, QTY_KEY);
  const price = firstNumber(toolInput, LIMIT_KEY);
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
    const updated = Date.parse(s.updated_at || "");
    const ageHours = Number.isFinite(updated) ? (Date.now() - updated) / 36e5 : Infinity;
    return { equity, stale: ageHours > STATE_MAX_AGE_HOURS, ageHours };
  } catch {
    return { equity: null, stale: false, ageHours: null };
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
  STATE_MAX_AGE_HOURS,
  DEFAULT_TZ,
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
