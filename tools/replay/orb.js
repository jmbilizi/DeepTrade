#!/usr/bin/env node
// Replay of opening-range-breakout (.claude/skills/opening-range-breakout/SKILL.md)
// on stocks, with weekly options (1 to 7 days left, never same-day) or shares.
//
//   node tools/replay/orb.js                         options, every symbol in the data
//   node tools/replay/orb.js --instrument equity     shares instead
//   node tools/replay/orb.js --baseline random       random entries, same exits and costs
//   node tools/replay/orb.js --trades --by-symbol
// Options: --data DIR (default journal/replay-stocks), --cap 250, --ceiling 0.25,
//   --max-positions 2, --symbols A,B, --strict (only the day's first break, valid or not),
//   --no-chase (diagnostic: ignore the 0.1% entry limit)
//
// Costs: each symbol's measured spread per round trip (calibration.json), plus fees.
// Option prices: Black-Scholes at each symbol's calibrated implied volatility.
"use strict";
const fs = require("fs");
const path = require("path");
const R = require("./lib");
const L = require(path.join(__dirname, "..", "..", ".claude", "hooks", "lib.js"));

const RULES = {
  rangeBars: 3, // 09:30 to 09:45
  lastEntryClose: 11 * 60, // entry window ends 11:00
  minRangePct: 0.3,
  maxRangePct: 2.0,
  volumeMult: 1.5,
  gapPct: 3, // skip when already 3% from the prior close at 09:45
  chaseLimitPct: 0.1,
  targetMult: 1.5,
  minRR: 1.2,
  midStopAbovePct: 1.0,
  flatBy: 15 * 60 + 50,
  deltaMin: 0.4,
  deltaMax: 0.6,
};
const FEE = 0.0004; // about $0.04 per contract round trip, per share of premium

const weekdayOf = (date) => new Date(Date.parse(`${date}T12:00:00Z`)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const isTradingDay = (d) => ["regular", "early", "unchecked"].includes(L.marketDay(d, weekdayOf(d)).status);

// Nearest weekly expiry with 1 to 7 days left: this Friday, or next Friday on a Friday.
// A Friday holiday moves the expiry to the trading day before it.
function weeklyExpiry(date) {
  const wd = new Date(Date.parse(`${date}T12:00:00Z`)).getUTCDay(); // 5 = Friday
  let fri = addDays(date, wd === 5 ? 7 : (5 - wd + 7) % 7 || 7);
  while (!isTradingDay(fri)) fri = addDays(fri, -1);
  return fri;
}
// Trading minutes from a minute of `date` to the 16:00 close on `expiry`.
function minutesToExpiry(date, minute, expiry) {
  let n = 0;
  for (let d = addDays(date, 1); d <= expiry; d = addDays(d, 1)) if (isTradingDay(d)) n++;
  return Math.max(960 - minute, 0.5) + 390 * n;
}
const strikeStep = (px) => (px < 25 ? 0.5 : 1);

// The contract closest to delta 0.5 inside the skill's delta band.
function pickContract(type, S, minutes, iv) {
  const step = strikeStep(S);
  const base = Math.round(S / step) * step;
  let best = null;
  for (let k = -6; k <= 6; k++) {
    const K = +(base + k * step).toFixed(2);
    if (K <= 0) continue;
    const d = Math.abs(R.optDelta(type, S, K, minutes, iv));
    if (d < RULES.deltaMin || d > RULES.deltaMax) continue;
    if (!best || Math.abs(d - 0.5) < Math.abs(best.d - 0.5)) best = { K, d };
  }
  return best;
}

// ---------- signal: the skill's entry rules ----------
function orbSignal(today, prevDay, opts) {
  if (!prevDay || today.length < RULES.rangeBars + 2) return null;
  const rb = today.slice(0, RULES.rangeBars);
  const orh = Math.max(...rb.map((b) => b.h)), orl = Math.min(...rb.map((b) => b.l));
  const ref = rb[rb.length - 1].c;
  const range = orh - orl;
  const rangePct = (100 * range) / ref;
  const prevClose = prevDay[prevDay.length - 1].c;
  if (rangePct < RULES.minRangePct || rangePct > RULES.maxRangePct) return { skip: "range size" };
  if (Math.abs(ref / prevClose - 1) * 100 > RULES.gapPct) return { skip: "gap over 3%" };
  const avgVol = rb.reduce((a, b) => a + b.v, 0) / rb.length;
  for (let i = RULES.rangeBars; i < today.length; i++) {
    const b = today[i];
    const closeMin = b.m + 5;
    if (closeMin > RULES.lastEntryClose) break;
    const up = b.c > orh, down = b.c < orl;
    if (!up && !down) continue;
    const dir = up ? 1 : -1;
    const valid = b.v >= RULES.volumeMult * avgVol && (dir === 1 ? b.c > b.vwap : b.c < b.vwap);
    if (!valid) {
      if (opts.strict) return { skip: "first break failed the filters" };
      continue;
    }
    const level = dir === 1 ? orh : orl;
    const stop = rangePct > RULES.midStopAbovePct ? (orh + orl) / 2 : dir === 1 ? orl : orh;
    const target = level + dir * RULES.targetMult * range;
    return { dir, level, stop, target, range, orh, orl, signalIndex: i, entryMin: closeMin, tag: `ORB ${dir > 0 ? "long" : "bear"}` };
  }
  return null;
}

// Baseline: same days, symbols, stop and target sizes; random time and direction.
function randomSignal(today, prevDay, opts, seed) {
  const s = orbSignal(today, prevDay, { strict: false });
  if (!s || s.skip) return s;
  const rnd = (k) => { const x = Math.sin(seed * 9301 + k * 49297) * 233280; return x - Math.floor(x); };
  const i = RULES.rangeBars + Math.floor(rnd(1) * 12); // bars closing 09:50 to 10:45
  const b = today[i];
  const dir = rnd(2) < 0.5 ? 1 : -1;
  const stopDist = Math.abs(s.level - s.stop);
  return { dir, level: b.c, stop: b.c - dir * stopDist, target: b.c + dir * RULES.targetMult * s.range, range: s.range, orh: Infinity * -dir, orl: Infinity * dir, signalIndex: i, entryMin: b.m + 5, tag: "random", noInvalidation: true };
}

// ---------- one trade, on 1-minute bars ----------
function simulate({ sig, one, five, day, iv, spread, cap, ceiling, instrument, noChaseCheck = false }) {
  const k = one.findIndex((b) => b.m >= sig.entryMin);
  if (k < 0) return null;
  const S0 = one[k].o;
  if (sig.tag !== "random" && !noChaseCheck && (sig.dir === 1 ? S0 > sig.level * (1 + RULES.chaseLimitPct / 100) : S0 < sig.level * (1 - RULES.chaseLimitPct / 100))) return { skip: "opened past the 0.1% chase limit" };
  const risk = Math.abs(S0 - sig.stop), reward = Math.abs(sig.target - S0);
  if (!(risk > 0) || reward / risk < RULES.minRR) return { skip: "reward-to-risk under 1.2" };
  const expiry = weeklyExpiry(day);
  const type = sig.dir === 1 ? "C" : "P";
  let K = null, P, n, unit;
  if (instrument === "option") {
    const c = pickContract(type, S0, minutesToExpiry(day, one[k].m, expiry), iv);
    if (!c) return { skip: "no contract in the delta band" };
    K = c.K;
    P = R.optPrice(type, S0, K, minutesToExpiry(day, one[k].m, expiry), iv);
    n = Math.floor(cap / (P * 100));
    if (n < 1) return { skip: "does not fit the cap" };
    unit = 100;
  } else {
    P = S0;
    n = cap / S0; // fractional shares
    unit = 1;
  }
  const value = (S, m) => (instrument === "option" ? R.optPrice(type, S, K, minutesToExpiry(day, m, expiry), iv) : S);
  const premiumStop = instrument === "option" ? P * (1 - ceiling) : -Infinity;
  let stop = sig.stop;
  const cost = instrument === "option" ? spread + FEE : 0.0005 * S0; // shares: about 0.05% round trip
  const done = (px, why, b) => ({ day, sym: sig.sym, tag: sig.tag, dir: sig.dir, entryMin: one[k].m, exitMin: b.m + 1, strike: K, expiry, n, P, exit: px, why, pnl: n * unit * (px - P - cost), riskUSD: n * unit * Math.abs(P - (instrument === "option" ? premiumStop : sig.stop)) });
  for (let j = k; j < one.length; j++) {
    const b = one[j];
    const worstS = sig.dir === 1 ? b.l : b.h, bestS = sig.dir === 1 ? b.h : b.l;
    if (b.m >= RULES.flatBy) return done(value(b.o, b.m), "flat time", b);
    // Stop first inside a bar.
    if (sig.dir === 1 ? worstS <= stop : worstS >= stop) return done(value(stop, b.m) - 0.01 * (instrument === "option"), stop === S0 ? "breakeven stop" : "strategy stop", b);
    if (instrument === "option" && value(worstS, b.m) <= premiumStop) return done(Math.min(premiumStop, value(b.o, b.m)) - 0.01, "premium stop", b);
    if (sig.dir === 1 ? bestS >= sig.target : bestS <= sig.target) return done(value(sig.target, b.m), "target", b);
    // Breakeven after 1 x range in profit: the only stop move the skill allows.
    if (Math.abs(bestS - S0) >= sig.range && (sig.dir === 1 ? S0 > stop : S0 < stop)) stop = S0;
    // Invalidation on completed 5-minute bars.
    if (!sig.noInvalidation && (b.m + 1) % 5 === 0) {
      const f = five.find((x) => x.m === b.m - 4);
      if (f && f.m >= sig.entryMin) {
        if (sig.dir === 1 ? f.c <= sig.orh : f.c >= sig.orl) return done(value(f.c, b.m), "back inside the range", b);
        if (sig.dir === 1 ? f.c < f.vwap : f.c > f.vwap) return done(value(f.c, b.m), "VWAP cross", b);
      }
    }
  }
  const b = one[one.length - 1];
  return done(value(b.c, b.m), "flat time", b);
}

function replay(opts) {
  const m5 = R.loadCsv(path.join(opts.data, "5minute.csv"));
  const m1 = R.loadCsv(path.join(opts.data, "minute.csv"));
  const cal = JSON.parse(fs.readFileSync(path.join(opts.data, "calibration.json"), "utf8"));
  const syms = (opts.symbols || Object.keys(m5)).filter((s) => m5[s] && m1[s] && cal[s]);
  for (const s of syms) R.addIndicators(m5[s]);
  const days = [...new Set(syms.flatMap((s) => Object.keys(m5[s])))].sort();
  const trades = [], skips = {};
  for (let di = 1; di < days.length; di++) {
    const day = days[di];
    const cands = [];
    for (const s of syms) {
      const today = m5[s][day], prev = m5[s][days[di - 1]];
      if (!today || !m1[s][day]) continue;
      const sig = opts.baseline === "random" ? randomSignal(today, prev, opts, di * 31 + s.charCodeAt(0) + s.length * 7) : orbSignal(today, prev, opts);
      if (!sig) continue;
      if (sig.skip) { skips[sig.skip] = (skips[sig.skip] || 0) + 1; continue; }
      sig.sym = s;
      const t = simulate({ sig, one: m1[s][day], five: today, day, iv: cal[s].iv, spread: cal[s].spread, cap: opts.cap, ceiling: opts.ceiling, instrument: opts.instrument, noChaseCheck: opts.noChase });
      if (!t) continue;
      if (t.skip) { skips[t.skip] = (skips[t.skip] || 0) + 1; continue; }
      cands.push(t);
    }
    // MAX_POSITIONS: take signals in time order while fewer than the limit are open.
    cands.sort((a, b) => a.entryMin - b.entryMin);
    const open = [];
    for (const t of cands) {
      for (let x = open.length - 1; x >= 0; x--) if (open[x].exitMin <= t.entryMin) open.splice(x, 1);
      if (open.length >= opts.maxPositions) { skips["max positions"] = (skips["max positions"] || 0) + 1; continue; }
      open.push(t);
      trades.push(t);
    }
  }
  return { trades, skips, days: days.slice(1), syms };
}

function summary(trades, days) {
  const w = trades.filter((t) => t.pnl > 0);
  const gw = w.reduce((a, t) => a + t.pnl, 0), gl = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  const byDay = Object.fromEntries(days.map((d) => [d, 0]));
  for (const t of trades) byDay[t.day] += t.pnl;
  const half = days[Math.floor(days.length / 2)];
  const first = trades.filter((t) => t.day < half).reduce((a, t) => a + t.pnl, 0);
  const rMult = trades.map((t) => t.pnl / (t.riskUSD || 1));
  return {
    trades: trades.length, perDay: trades.length / days.length, winPct: trades.length ? (100 * w.length) / trades.length : 0,
    profitFactor: gl ? gw / gl : null, net: gw - gl, firstHalf: first, secondHalf: gw - gl - first,
    avgR: rMult.length ? rMult.reduce((a, b) => a + b, 0) / rMult.length : 0,
    greenDays: Object.values(byDay).filter((x) => x > 0).length, days: days.length, worstDay: Math.min(...Object.values(byDay)),
  };
}
const fmt = (label, s) => `${label.padEnd(26)} trades ${String(s.trades).padStart(3)} (${s.perDay.toFixed(1)}/day)  win ${s.winPct.toFixed(0).padStart(3)}%  PF ${s.profitFactor === null ? " -  " : s.profitFactor.toFixed(2)}  avg ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(2)}R  net ${s.net.toFixed(0).padStart(6)}  halves ${s.firstHalf.toFixed(0)} | ${s.secondHalf.toFixed(0)}  green days ${s.greenDays}/${s.days}  worst day ${s.worstDay.toFixed(0)}`;

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (["--trades", "--by-symbol", "--strict", "--json", "--no-chase"].includes(argv[i])) a[argv[i].slice(2)] = true;
    else if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  }
  const opts = {
    data: path.resolve(a.data || path.join(__dirname, "..", "..", "journal", "replay-stocks")),
    cap: Number(a.cap || 250), ceiling: Number(a.ceiling || 0.25), maxPositions: Number(a["max-positions"] || 2),
    instrument: a.instrument === "equity" ? "equity" : "option", baseline: a.baseline || null, strict: Boolean(a.strict), noChase: Boolean(a["no-chase"]),
    symbols: a.symbols ? String(a.symbols).split(",") : null,
  };
  const { trades, skips, days, syms } = replay(opts);
  const s = summary(trades, days);
  if (a.json) { console.log(JSON.stringify({ summary: s, skips, trades }, null, 1)); return 0; }
  console.log(`${days.length} sessions ${days[0]} to ${days[days.length - 1]}, ${syms.length} symbols, ${opts.instrument}${opts.baseline ? `, baseline ${opts.baseline}` : ""}, cap ${opts.cap}`);
  console.log(fmt(opts.baseline ? `baseline ${opts.baseline}` : `ORB ${opts.instrument}`, s));
  console.log(`  not traded: ${Object.entries(skips).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
  if (a["by-symbol"]) for (const sym of syms) { const t = trades.filter((x) => x.sym === sym); if (t.length) console.log(fmt(`  ${sym}`, summary(t, days))); }
  if (a.trades) for (const t of trades) console.log(`${t.day} ${R.hhmm(t.entryMin)} ${t.sym.padEnd(5)} ${t.dir > 0 ? "long" : "bear"} ${t.strike ?? ""} x${typeof t.n === "number" ? +t.n.toFixed(2) : t.n} ${t.P.toFixed(2)} -> ${t.exit.toFixed(2)} ${t.why.padEnd(22)} ${String(t.exitMin - t.entryMin).padStart(3)}m ${t.pnl.toFixed(0).padStart(5)}`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { RULES, weeklyExpiry, minutesToExpiry, pickContract, orbSignal, simulate, replay, summary };
