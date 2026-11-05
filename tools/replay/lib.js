// Replay engine for DeepTrade strategies on index ETFs. Plain Node, no dependencies.
// Bars come from tools/replay/bars.js. Option prices are modeled with
// Black-Scholes at a fixed implied volatility per symbol, so results are
// estimates: no IV change, fills at the bank price assumed, a fixed cost.
"use strict";
const fs = require("fs");
const path = require("path");

// ---------- time ----------
const NY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit" });
function nyTime(iso) {
  const p = Object.fromEntries(NY.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, m: Number(p.hour) * 60 + Number(p.minute) };
}
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const parseHHMM = (s) => {
  const x = /^(\d{1,2}):(\d{2})$/.exec(String(s || ""));
  return x ? Number(x[1]) * 60 + Number(x[2]) : null;
};

// ---------- data ----------
// Returns { SYM: { "YYYY-MM-DD": [bar, ...] } } with bar.m = minutes after midnight, New York time.
function loadCsv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n").slice(1)) {
    const [sym, t, o, h, l, c, v] = line.split(",");
    if (!sym || !t) continue;
    const { day, m } = nyTime(t);
    if (m < 570 || m >= 960) continue; // regular session only
    ((out[sym] ??= {})[day] ??= []).push({ t, m, o: +o, h: +h, l: +l, c: +c, v: +v });
  }
  for (const s of Object.values(out)) for (const d of Object.values(s)) d.sort((a, b) => a.m - b.m);
  return out;
}

// 5-minute indicators, continuous across sessions (as the broker warms them up);
// VWAP restarts each session. Matches intraday-technicals.
function addIndicators(days) {
  const keys = Object.keys(days).sort();
  let e9 = null, e20 = null, atr = null, prevC = null, st = null;
  for (const k of keys) {
    let pv = 0, vv = 0;
    for (const b of days[k]) {
      const tp = (b.h + b.l + b.c) / 3;
      pv += tp * b.v;
      vv += b.v;
      b.vwap = vv ? pv / vv : b.c;
      e9 = e9 === null ? b.c : e9 + (2 / 10) * (b.c - e9);
      e20 = e20 === null ? b.c : e20 + (2 / 21) * (b.c - e20);
      b.e9 = e9;
      b.e20 = e20;
      b.tr = prevC === null ? b.h - b.l : Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC));
      atr = atr === null ? b.tr : (atr * 13 + b.tr) / 14;
      b.atr = atr;
      // Supertrend(10, 3), approximated with a Wilder ATR(10).
      const a10 = st ? st.a10 * 0.9 + b.tr * 0.1 : b.tr;
      const mid = (b.h + b.l) / 2;
      let ub = mid + 3 * a10, lb = mid - 3 * a10, dir = 1;
      if (st) {
        if (!(ub < st.ub || prevC > st.ub)) ub = st.ub;
        if (!(lb > st.lb || prevC < st.lb)) lb = st.lb;
        dir = st.dir === 1 && b.c < lb ? -1 : st.dir === -1 && b.c > ub ? 1 : st.dir;
      }
      st = { ub, lb, dir, a10 };
      b.st = dir;
      prevC = b.c;
    }
  }
  return keys;
}

// ---------- options ----------
const YEAR_MIN = 252 * 390; // implied volatility is on a trading-minute year
function ncdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function d1(S, K, minutes, iv) {
  const v = iv * Math.sqrt(Math.max(minutes, 0.5) / YEAR_MIN);
  return { d1: (Math.log(S / K) + 0.5 * v * v) / v, v };
}
function optPrice(type, S, K, minutes, iv) {
  const { d1: a, v } = d1(S, K, minutes, iv);
  const intrinsic = Math.max(type === "C" ? S - K : K - S, 0);
  const px = type === "C" ? S * ncdf(a) - K * ncdf(a - v) : K * ncdf(v - a) - S * ncdf(-a);
  return Math.max(px, intrinsic);
}
function optDelta(type, S, K, minutes, iv) {
  const { d1: a } = d1(S, K, minutes, iv);
  return type === "C" ? ncdf(a) : ncdf(a) - 1;
}
function solveIV(type, S, K, minutes, mid) {
  let lo = 0.005, hi = 3;
  for (let i = 0; i < 100; i++) {
    const m = (lo + hi) / 2;
    if (optPrice(type, S, K, minutes, m) > mid) hi = m;
    else lo = m;
  }
  return (lo + hi) / 2;
}

// ---------- key levels (key-levels skill) ----------
// Levels known when bar i of today closes. ORH/ORL need the first 15 minutes (3 bars).
function levelMap(today, prevDay, i) {
  const L = [];
  if (prevDay && prevDay.length) {
    L.push({ name: "PDH", px: Math.max(...prevDay.map((b) => b.h)) });
    L.push({ name: "PDL", px: Math.min(...prevDay.map((b) => b.l)) });
    L.push({ name: "PDC", px: prevDay[prevDay.length - 1].c });
  }
  if (i >= 3) {
    L.push({ name: "ORH", px: Math.max(today[0].h, today[1].h, today[2].h) });
    L.push({ name: "ORL", px: Math.min(today[0].l, today[1].l, today[2].l) });
  }
  if (i >= 1) {
    const before = today.slice(0, i);
    L.push({ name: "HOD", px: Math.max(...before.map((b) => b.h)) });
    L.push({ name: "LOD", px: Math.min(...before.map((b) => b.l)) });
  }
  L.push({ name: "OPEN", px: today[0].o });
  L.push({ name: "VWAP", px: today[i].vwap });
  return L;
}

module.exports = { nyTime, hhmm, parseHHMM, loadCsv, addIndicators, optPrice, optDelta, solveIV, levelMap, YEAR_MIN };
