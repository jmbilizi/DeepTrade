#!/usr/bin/env node
// Replay a strategy over saved bars and print the results.
//   node tools/replay/run.js --strategy index-level-scalp
//   node tools/replay/run.js --strategy index-level-scalp,index-trend-scalp --to 15:25 --hours
//   node tools/replay/run.js --calibrate C 766.5 767 335 1.335   (type, underlying, strike, minutes to 16:00, mid)
// Options: --data DIR (default journal/replay), --symbols SPY,QQQ, --iv SPY=0.09,QQQ=0.13,
//   --cap 250, --cost 0.03, --from HH:MM, --to HH:MM, --bank-atr 0.8, --stop-atr 0.8, --time 30,
//   --bank 1.3 (percent bank price instead of ATR), --stop 0.75 (loss ceiling as a share of premium),
//   --no-ustop, --profit-target USD, --daily-loss USD, --trades, --hours, --json
"use strict";
const path = require("path");
const R = require("./lib");
const { STRATEGIES } = require("./strategies");

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) a._.push(argv[i]);
    else if (["--trades", "--hours", "--json", "--no-ustop"].includes(argv[i])) a[argv[i].slice(2)] = true;
    else a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

const FLAT = 15 * 60 + 35;

// Simulate one option trade on 1-minute bars. Returns null when no contract qualifies.
function simulate({ one, entryMin, sig, iv, cap, cost, exits }) {
  const k = one.findIndex((b) => b.m === entryMin);
  if (k < 0) return null;
  const S0 = one[k].o;
  const type = sig.dir === 1 ? "C" : "P";
  let K = sig.dir === 1 ? Math.ceil(S0) : Math.floor(S0);
  let P = null;
  // Strike walk (position-sizing): step out of the money until one contract fits the cap; stop below delta 0.35.
  for (let step = 0; step < 10; step++) {
    const px = R.optPrice(type, S0, K, 960 - entryMin, iv);
    if (Math.abs(R.optDelta(type, S0, K, 960 - entryMin, iv)) < 0.35) return null;
    if (px * 100 <= cap) { P = px; break; }
    K += sig.dir;
  }
  if (P === null) return null;
  const n = Math.floor(cap / (P * 100));
  // Bank price and premium stop: a fixed share of the premium, or an underlying move in ATR turned into premium with delta.
  const d0 = Math.abs(R.optDelta(type, S0, K, 960 - entryMin, iv));
  const bank = exits.bankAtr ? P + d0 * exits.bankAtr * sig.atr : P * exits.bankMult;
  const stop = Math.max(exits.stopAtr ? P - d0 * exits.stopAtr * sig.atr : 0, P * exits.stopMult);
  for (let j = k; j < one.length; j++) {
    const b = one[j];
    const left = 960 - b.m - 1;
    const worstS = sig.dir === 1 ? b.l : b.h, bestS = sig.dir === 1 ? b.h : b.l;
    const at = (S) => R.optPrice(type, S, K, left, iv);
    const done = (px, why) => ({ entryMin, dir: sig.dir, tag: sig.tag, strike: K, n, P, exit: px, why, hold: b.m - entryMin, pnl: n * 100 * (px - P - cost) });
    // Conservative order inside a bar: the stop is tested before the bank order.
    if (at(worstS) <= stop) return done(Math.min(stop, at(b.o)) - 0.01, "premium stop");
    if (exits.underlyingStop && (sig.dir === 1 ? b.c < sig.stop : b.c > sig.stop)) return done(at(b.c), "strategy stop");
    if (at(bestS) >= bank) return done(Math.max(bank, at(b.o)), "bank order");
    if (exits.timeMin && b.m - entryMin + 1 >= exits.timeMin) return done(at(b.c), "time stop");
    if (b.m >= FLAT) return done(at(b.c), "flat time");
  }
  return done0();
  function done0() { return { entryMin, dir: sig.dir, tag: sig.tag, strike: K, n, P, exit: 0, why: "no bars", hold: 0, pnl: -n * 100 * P }; }
}

function replay(opts) {
  const m5 = R.loadCsv(path.join(opts.data, "5minute.csv"));
  const m1 = R.loadCsv(path.join(opts.data, "minute.csv"));
  const syms = opts.symbols.filter((s) => m5[s] && m1[s]);
  if (!syms.length) throw new Error(`no 5minute and minute bars for ${opts.symbols.join(",")} in ${opts.data}`);
  for (const s of syms) R.addIndicators(m5[s]);
  const days = Object.keys(m5[syms[0]]).sort().filter((d) => syms.every((s) => m5[s][d] && m1[s][d] && m5[s][d].length >= 70));
  const strategies = opts.strategies.map((n) => {
    if (!STRATEGIES[n]) throw new Error(`unknown strategy ${n}; known: ${Object.keys(STRATEGIES).join(", ")}`);
    return { name: n, ...STRATEGIES[n] };
  });
  const trades = [];
  for (let di = 1; di < days.length; di++) { // day 0 only warms up indicators and gives the prior-day levels
    const day = days[di];
    let busyUntil = 0, pnl = 0;
    const ref = m5[syms[0]][day];
    for (let i = 0; i < ref.length; i++) {
      const closeMin = ref[i].m + 5;
      if (closeMin + 1 <= busyUntil) continue;
      if (opts.profitTarget != null && pnl >= opts.profitTarget) break;
      if (opts.dailyLoss != null && pnl <= -opts.dailyLoss) break;
      let taken = null;
      for (const st of strategies) {
        const from = R.parseHHMM(opts.from || st.window.from), to = R.parseHHMM(opts.to || st.window.to);
        if (closeMin < from || closeMin > to) continue;
        for (const s of syms) { // first symbol with a signal wins: one position at a time
          const today = m5[s][day];
          if (!today[i] || today[i].m !== ref[i].m) continue;
          const witnessSym = syms.find((x) => x !== s);
          const sig = st.signal({ sym: s, today, prevDay: m5[s][days[di - 1]], i, dayIndex: di, witness: witnessSym ? m5[witnessSym][day] : null });
          if (!sig) continue;
          sig.atr = today[i].atr;
          const exits = { ...st.exits, ...(opts.exits || {}) };
          const t = simulate({ one: m1[s][day], entryMin: closeMin + 1, sig, iv: opts.iv[s] ?? 0.1, cap: opts.cap, cost: opts.cost, exits });
          if (!t) continue;
          taken = { ...t, day, sym: s, strategy: st.name };
          break;
        }
        if (taken) break;
      }
      if (taken) {
        trades.push(taken);
        pnl += taken.pnl;
        busyUntil = taken.entryMin + taken.hold;
      }
    }
  }
  return { trades, days: days.slice(1) };
}

function summary(trades, days, label) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  const byDay = {};
  for (const d of days) byDay[d] = 0;
  for (const t of trades) byDay[t.day] += t.pnl;
  const half = days[Math.floor(days.length / 2)];
  const first = trades.filter((t) => t.day < half).reduce((a, t) => a + t.pnl, 0);
  const net = gw - gl;
  return {
    label, trades: n, perDay: n / days.length, winPct: n ? (100 * wins.length) / n : 0,
    avgWin: wins.length ? gw / wins.length : 0, avgLoss: n - wins.length ? gl / (n - wins.length) : 0,
    profitFactor: gl ? gw / gl : null, net, firstHalf: first, secondHalf: net - first,
    greenDays: Object.values(byDay).filter((x) => x > 0).length, days: days.length,
    worstDay: Math.min(...Object.values(byDay)),
  };
}
const fmt = (s) => `${s.label.padEnd(24)} trades ${String(s.trades).padStart(4)} (${s.perDay.toFixed(1)}/day)  win ${s.winPct.toFixed(0).padStart(3)}%  avg win ${s.avgWin.toFixed(0).padStart(4)}  avg loss ${s.avgLoss.toFixed(0).padStart(4)}  PF ${s.profitFactor === null ? "  - " : s.profitFactor.toFixed(2)}  net ${s.net.toFixed(0).padStart(6)}  halves ${s.firstHalf.toFixed(0)} | ${s.secondHalf.toFixed(0)}  green days ${s.greenDays}/${s.days}  worst day ${s.worstDay.toFixed(0)}`;

function main(argv) {
  const a = parseArgs(argv);
  if (a.calibrate) {
    const [type, S, K, minutes, mid] = [a.calibrate, ...a._];
    const iv = R.solveIV(type, +S, +K, +minutes, +mid);
    console.log(`implied vol ${(iv * 100).toFixed(1)}% (trading-minute year), model delta ${R.optDelta(type, +S, +K, +minutes, iv).toFixed(2)}`);
    return 0;
  }
  const iv = { SPY: 0.09, QQQ: 0.13 };
  for (const kv of String(a.iv || "").split(",").filter(Boolean)) { const [k, v] = kv.split("="); iv[k] = Number(v); }
  const exits = {};
  if (a.bank) Object.assign(exits, { bankMult: Number(a.bank), bankAtr: 0 }); // a percent bank price replaces the ATR one
  if (a.stop) exits.stopMult = Number(a.stop);
  if (a.time) exits.timeMin = Number(a.time);
  if (a["bank-atr"]) exits.bankAtr = Number(a["bank-atr"]);
  if (a["stop-atr"] != null) exits.stopAtr = Number(a["stop-atr"]);
  if (a["no-ustop"]) exits.underlyingStop = false;
  const opts = {
    data: path.resolve(a.data || path.join(__dirname, "..", "..", "journal", "replay")),
    strategies: String(a.strategy || "index-level-scalp").split(","),
    symbols: String(a.symbols || "SPY,QQQ").split(","),
    iv, cap: Number(a.cap || 250), cost: Number(a.cost || 0.03), from: a.from, to: a.to, exits,
    profitTarget: a["profit-target"] != null ? Number(a["profit-target"]) : null,
    dailyLoss: a["daily-loss"] != null ? Number(a["daily-loss"]) : null,
  };
  const { trades, days } = replay(opts);
  const all = summary(trades, days, opts.strategies.join("+"));
  if (a.json) { console.log(JSON.stringify({ summary: all, trades }, null, 1)); return 0; }
  console.log(`${days.length} sessions ${days[0]} to ${days[days.length - 1]}, symbols ${opts.symbols.join(",")}, cap ${opts.cap}, cost ${opts.cost}/contract`);
  console.log(fmt(all));
  if (a.hours) {
    for (const [lo, hi] of [[570, 630], [630, 690], [690, 810], [810, 870], [870, 960]]) {
      const t = trades.filter((x) => x.entryMin >= lo && x.entryMin < hi);
      if (t.length) console.log(fmt(summary(t, days, `  ${R.hhmm(lo)}-${R.hhmm(hi)}`)));
    }
  }
  if (a.trades) for (const t of trades) console.log(`${t.day} ${R.hhmm(t.entryMin)} ${t.sym} ${t.dir > 0 ? "call" : "put "} ${t.strike} ${t.tag.padEnd(7)} x${t.n} ${t.P.toFixed(2)} -> ${t.exit.toFixed(2)} ${t.why.padEnd(13)} ${String(t.hold).padStart(3)}m ${t.pnl.toFixed(0).padStart(5)}`);
  return 0;
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
module.exports = { replay, summary, simulate };
