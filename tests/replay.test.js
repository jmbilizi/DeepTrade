// Tests for tools/replay. Run with: node tests/replay.test.js
// Synthetic bars only, so it runs without broker data.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const R = require("../tools/replay/lib");
const { STRATEGIES } = require("../tools/replay/strategies");
const { simulate, replay } = require("../tools/replay/run");
const bars = require("../tools/replay/bars");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || detail === undefined ? "" : `\n      ${detail}`}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- time ----
check("New York time in EDT", R.nyTime("2026-10-30T13:30:00Z").m === 9 * 60 + 30);
check("New York time in EST", R.nyTime("2026-11-03T14:30:00Z").m === 9 * 60 + 30 && R.nyTime("2026-11-03T14:30:00Z").day === "2026-11-03");
check("parseHHMM", R.parseHHMM("11:30") === 690 && R.parseHHMM("bad") === null);

// ---- options ----
const S = 500, K = 500, T = 200, iv = 0.1;
const c = R.optPrice("C", S, K, T, iv), p = R.optPrice("P", S, K, T, iv);
check("put-call parity at the money (no rates)", near(c - p, S - K, 1e-6), `${c} ${p}`);
check("at-the-money call delta near 0.5", near(R.optDelta("C", S, K, T, iv), 0.5, 0.02));
check("put delta is call delta minus 1", near(R.optDelta("P", S, K, T, iv), R.optDelta("C", S, K, T, iv) - 1, 1e-9));
check("price falls as time passes", R.optPrice("C", S, K, 30, iv) < c);
check("price is at least intrinsic", R.optPrice("C", 510, 500, 1, iv) >= 10);
const solved = R.solveIV("C", S, K, T, c);
check("solveIV recovers the volatility", near(solved, iv, 1e-4), `${solved}`);
check("journal quote calibrates near 8.8%", near(R.solveIV("C", 766.5, 767, 335, 1.335), 0.088, 0.002));

// ---- synthetic sessions ----
// Bars at 5-minute steps from 09:30 New York (14:30Z in November).
function session(day, closes, { spread = 0.3, startUtcHour = 14 } = {}) {
  return closes.map((cl, i) => {
    const t = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), startUtcHour, 30 + i * 5)).toISOString();
    const o = i ? closes[i - 1] : cl;
    return { t, m: 570 + i * 5, o, h: Math.max(o, cl) + spread, l: Math.min(o, cl) - spread, c: cl, v: 1000 };
  });
}
const flat = (n, px) => Array.from({ length: n }, () => px);

// ---- level map ----
{
  const prev = session("2026-11-02", flat(78, 100));
  prev[10].h = 103; prev[20].l = 97; prev[77].c = 101;
  const today = session("2026-11-03", flat(10, 100));
  today[1].h = 100.9; today[2].l = 99.2;
  R.addIndicators({ "2026-11-02": prev, "2026-11-03": today });
  const L = Object.fromEntries(R.levelMap(today, prev, 5).map((x) => [x.name, x.px]));
  check("level map: prior-day high, low, close", L.PDH === 103 && L.PDL === 97 && L.PDC === 101);
  check("level map: opening range from the first three bars", L.ORH === 100.9 && L.ORL === 99.2);
  check("level map: no opening range before 09:45", !R.levelMap(today, prev, 2).some((x) => x.name === "ORH"));
  check("level map: session high excludes the signal bar", (() => { today[5].h = 120; return R.levelMap(today, prev, 5).find((x) => x.name === "HOD").px === 100.9; })());
  check("level map: order follows key-levels", R.levelMap(today, prev, 5).map((x) => x.name).join(",") === "PDH,PDL,PDC,ORH,ORL,HOD,LOD,OPEN,VWAP");
}

// ---- index-level-scalp setups ----
function levelCase(mutate) {
  const prev = session("2026-11-02", flat(78, 100), { spread: 0.1 });
  prev[40].h = 105; // PDH 105, PDL 99.9, PDC 100
  const today = session("2026-11-03", [100, 100.5, 101, 101.5, 102, 102.5, 103, 103.5, 104, 104.5, 105.5, 105.4], { spread: 0.1 });
  R.addIndicators({ "2026-11-02": prev, "2026-11-03": today });
  mutate(today);
  return STRATEGIES["index-level-scalp"].signal({ today, prevDay: prev, i: today.length - 1 });
}
{
  // Bearish rejection of PDH 105: previous close below, signal bar high above, close back below near its low.
  const sig = levelCase((d) => { const b = d[11]; d[10].c = 104.8; b.o = 104.9; b.h = 105.6; b.l = 104.7; b.c = 104.75; });
  check("setup R: bearish rejection of PDH", sig && sig.dir === -1 && sig.tag === "R PDH", JSON.stringify(sig));
  check("setup R: stop above the signal bar's high", sig && sig.stop > 105.6);
  const none = levelCase((d) => { const b = d[11]; d[10].c = 104.8; b.o = 104.9; b.h = 105.6; b.l = 104.7; b.c = 105.2; });
  check("setup R: a close above the level is no rejection", !none || none.tag !== "R PDH", JSON.stringify(none));
  const weak = levelCase((d) => { const b = d[11]; d[10].c = 104.8; b.o = 104.9; b.h = 105.6; b.l = 103.5; b.c = 104.98; });
  check("setup R: the close must be at least 0.4 x range from the extreme", !weak || weak.tag !== "R PDH", JSON.stringify(weak));
}
{
  // Long break and retest of PDH 105: two bars back closed below, previous closed above, this bar tests and holds.
  const sig = levelCase((d) => { d[9].c = 104.6; d[10].c = 105.4; const b = d[11]; b.o = 105.2; b.l = 105.05; b.h = 105.9; b.c = 105.8; });
  check("setup T: long break and retest of PDH", sig && sig.dir === 1 && sig.tag === "T PDH", JSON.stringify(sig));
  check("setup T: stop below the level and the bar's low", sig && sig.stop < 105);
  const red = levelCase((d) => { d[9].c = 104.6; d[10].c = 105.4; const b = d[11]; b.o = 105.8; b.l = 105.05; b.h = 105.9; b.c = 105.3; });
  check("setup T: a red signal bar is no retest", !red || red.tag !== "T PDH", JSON.stringify(red));
}
check("index-level-scalp: no signal before 3 bars", STRATEGIES["index-level-scalp"].signal({ today: session("2026-11-03", flat(3, 100)), prevDay: null, i: 2 }) === null);
check("index-level-scalp: window 09:50 to 11:30", STRATEGIES["index-level-scalp"].window.from === "09:50" && STRATEGIES["index-level-scalp"].window.to === "11:30");

// ---- simulate the bracket ----
function minuteBars(path1) {
  return path1.map((px, i) => ({ m: 600 + i, o: i ? path1[i - 1] : px, h: Math.max(px, i ? path1[i - 1] : px) + 0.02, l: Math.min(px, i ? path1[i - 1] : px) - 0.02, c: px }));
}
const exits = { bankAtr: 0.8, stopAtr: 0.8, stopMult: 0.75, timeMin: 30, underlyingStop: true };
const up = minuteBars(Array.from({ length: 40 }, (_, i) => 500 + i * 0.1));
const win = simulate({ one: up, entryMin: 600, sig: { dir: 1, stop: 499, atr: 1, tag: "t" }, iv: 0.1, cap: 1000, cost: 0.03, exits });
check("bracket: a steady rise fills the bank order", win && win.why === "bank order" && win.pnl > 0, JSON.stringify(win));
check("bracket: bank price is entry + delta x 0.8 x ATR", win && near(win.exit - win.P, 0.8 * R.optDelta("C", 500, win.strike, 360, 0.1), 0.02), JSON.stringify(win));
const down = minuteBars(Array.from({ length: 40 }, (_, i) => 500 - i * 0.15));
const loss = simulate({ one: down, entryMin: 600, sig: { dir: 1, stop: 495, atr: 1, tag: "t" }, iv: 0.1, cap: 1000, cost: 0.03, exits });
check("bracket: a fall hits the premium stop", loss && loss.why === "premium stop" && loss.pnl < 0, JSON.stringify(loss));
check("bracket: the loss is near the tighter stop", loss && loss.exit >= loss.P * 0.75 - 0.2);
const dull = minuteBars(Array.from({ length: 40 }, () => 500));
const slow = simulate({ one: dull, entryMin: 600, sig: { dir: 1, stop: 495, atr: 1, tag: "t" }, iv: 0.1, cap: 1000, cost: 0.03, exits });
check("bracket: no move ends at the time stop", slow && slow.why === "time stop" && slow.hold === 29, JSON.stringify(slow));
const ustop = simulate({ one: minuteBars([500, 499.8, 499.6, 499.5, 499.4]), entryMin: 600, sig: { dir: 1, stop: 499.7, atr: 1, tag: "t" }, iv: 0.1, cap: 1000, cost: 0.03, exits: { ...exits, stopAtr: 0, stopMult: 0.01 } });
check("bracket: a 1-minute close past the strategy stop exits", ustop && ustop.why === "strategy stop", JSON.stringify(ustop));
check("strike walk: nothing fits a tiny cap", simulate({ one: up, entryMin: 600, sig: { dir: 1, stop: 499, atr: 1, tag: "t" }, iv: 0.1, cap: 10, cost: 0.03, exits }) === null);

// ---- bars.js and a full replay on synthetic files ----
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deeptrade-replay-"));
  const mk = (interval, step, n, day) => ({
    data: { results: ["SPY", "QQQ"].map((symbol) => ({ symbol, interval, bars: Array.from({ length: n }, (_, i) => {
      const t = new Date(Date.UTC(2026, 10, day, 14, 30 + i * step)).toISOString();
      const px = (symbol === "SPY" ? 500 : 400) + Math.sin(i / 7) * 2;
      return { begins_at: t, open_price: String(px), high_price: String(px + 0.3), low_price: String(px - 0.3), close_price: String(px + 0.05), volume: 1000, interpolated: i === 5 };
    }) })) },
  });
  const files = [];
  for (const [interval, step, n] of [["5minute", 5, 78], ["minute", 1, 390]]) for (const day of [2, 3, 4]) {
    const f = path.join(dir, `${interval}-${day}.json`);
    fs.writeFileSync(f, JSON.stringify(mk(interval, step, n, day)));
    files.push(f);
  }
  const quiet = console.log;
  console.log = () => {};
  bars.main([dir, ...files]);
  bars.main([dir, files[0]]); // merging again adds no duplicates
  console.log = quiet;
  const five = fs.readFileSync(path.join(dir, "5minute.csv"), "utf8").trim().split("\n");
  check("bars.js: one row per bar, interpolated dropped, no duplicates", five.length === 1 + 2 * 3 * 77, `${five.length}`);
  check("bars.js: minute file written", fs.existsSync(path.join(dir, "minute.csv")));
  let res = null, err = null;
  try {
    res = replay({ data: dir, strategies: ["index-level-scalp", "random"], symbols: ["SPY", "QQQ"], iv: { SPY: 0.09, QQQ: 0.13 }, cap: 250, cost: 0.03, exits: {} });
  } catch (e) { err = e; }
  check("replay runs end to end on synthetic files", res && Array.isArray(res.trades), err && err.message);
  check("replay: day one only warms up", res && res.days.length === 2 && !res.trades.some((t) => t.day === "2026-11-02"));
  check("replay: entries stay inside the strategy window", res && res.trades.every((t) => t.entryMin >= 591 && t.entryMin <= 691), res && JSON.stringify(res.trades.map((t) => t.entryMin)));
  check("replay: one position at a time", res && res.trades.every((t, i, a) => i === 0 || a[i - 1].day !== t.day || t.entryMin >= a[i - 1].entryMin + a[i - 1].hold));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
