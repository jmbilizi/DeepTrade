#!/usr/bin/env node
// Market clock for trading agents. Tells an agent where it is in the trading
// day, from whenever it was launched, and sleeps until its next check.
//
//   node tools/clock.js --agent index-0dte-trader            status now
//   node tools/clock.js --agent index-0dte-trader --wait     sleep to the next check, then status
//   node tools/clock.js --agent index-0dte-trader --wait --every 1m   position checks
//   options: --every 5m|1m, --max SECONDS (cap one wait; default 590), --json
//
// Phases: before-open (a trading day before the first check), trading (between
// the first check and the last entry cutoff), late (after it, market still open),
// closed (after the close, weekend, holiday). Times are New York market time.
// Plain Node, no dependencies. Reads the market calendar and agent profiles
// from the hooks, and strategy windows from tools/replay/strategies.js.
"use strict";
const path = require("path");
const L = require(path.join(__dirname, "..", ".claude", "hooks", "lib.js"));
const { STRATEGIES } = require(path.join(__dirname, "replay", "strategies.js"));

const TZ = "America/New_York";
const OPEN = 9 * 60 + 30;
const BAR_LAG_S = 5; // a 5-minute bar is complete a few seconds after its boundary
const PREP_MIN = 5; // wake this long before the first strategy check

// New York wall time for an instant.
const NY = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "long" });
function nyParts(ms) {
  const p = Object.fromEntries(NY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, sec: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}
// The instant of a New York wall time (date YYYY-MM-DD, seconds after midnight).
function nyInstant(date, sec) {
  const guess = Date.parse(`${date}T00:00:00Z`) + sec * 1000;
  let ms = guess;
  for (let i = 0; i < 3; i++) {
    const p = nyParts(ms);
    const shown = Date.parse(`${p.date}T00:00:00Z`) + p.sec * 1000;
    ms += guess - shown;
  }
  return ms;
}
const hhmm = (sec) => `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`;
const hhmmss = (sec) => `${hhmm(sec)}:${String(sec % 60).padStart(2, "0")}`;
const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const weekdayOf = (date) => new Date(Date.parse(`${date}T12:00:00Z`)).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

// The agent's entry window for a day: the gate window, narrowed by the strategies' own windows.
function windowFor(agent, env, day) {
  const eff = L.effectiveEnv(env, agent);
  const shift = day.shiftMin || 0;
  const gateFrom = L.parseHHMM(eff.DEEPTRADE_NO_NEW_ENTRIES_BEFORE) ?? OPEN;
  const gateToRaw = L.parseHHMM(eff.DEEPTRADE_NO_NEW_ENTRIES_AFTER);
  const close = day.closeMin ?? 16 * 60;
  const gateTo = gateToRaw === null ? close : Math.min(gateToRaw - shift, close);
  const names = String(L.planSettings(eff).DEEPTRADE_STRATEGIES.value).split(",").map((s) => s.trim()).filter(Boolean);
  const known = names.filter((n) => STRATEGIES[n] && STRATEGIES[n].window);
  const unknown = names.filter((n) => !known.includes(n));
  let from = gateFrom, to = gateTo;
  if (known.length && !unknown.length) {
    from = Math.max(gateFrom, Math.min(...known.map((n) => L.parseHHMM(STRATEGIES[n].window.from))));
    to = Math.min(gateTo, Math.max(...known.map((n) => L.parseHHMM(STRATEGIES[n].window.to))));
  }
  return { from, to, close, strategies: names, unknownWindows: unknown, profile: Boolean(L.agentProfile(agent)) };
}

function nextTradingDay(date) {
  for (let k = 1; k <= 10; k++) {
    const d = addDays(date, k);
    const md = L.marketDay(d, weekdayOf(d));
    if (md.status === "regular" || md.status === "early") return d;
  }
  return null;
}

// Where the agent is now and when it should next look.
function status({ agent, env, nowMs, every }) {
  const now = nyParts(nowMs);
  const day = L.marketDay(now.date, now.weekday);
  const trading = day.status === "regular" || day.status === "early" || day.status === "unchecked";
  const out = { now: `${now.weekday} ${now.date} ${hhmmss(now.sec)} ET`, day: day.status, dayName: day.name || null };
  const stepS = every === "1m" ? 60 : 300;
  if (trading) {
    const w = windowFor(agent, env, day);
    Object.assign(out, { window: `${hhmm(w.from * 60)}-${hhmm(w.to * 60)}`, close: hhmm(w.close * 60), strategies: w.strategies });
    if (w.unknownWindows.length) out.note = `No window in code for ${w.unknownWindows.join(", ")}; using the gate window. Each strategy skill still states its own window.`;
    const firstS = w.from * 60, lastS = w.to * 60, closeS = w.close * 60;
    let targetS = null;
    if (now.sec < firstS - PREP_MIN * 60) {
      out.phase = "before-open";
      targetS = firstS - PREP_MIN * 60;
      out.nextCheckReason = `prepare ${PREP_MIN} min before the first strategy check at ${hhmm(firstS)}`;
    } else if (now.sec < lastS + BAR_LAG_S) {
      // Up to the check of the bar that closes at the last entry cutoff.
      out.phase = now.sec < firstS ? "before-open" : "trading";
      // Next bar boundary (or minute) after now, plus the bar lag.
      targetS = Math.floor((now.sec - BAR_LAG_S) / stepS) * stepS + stepS + BAR_LAG_S;
      if (targetS < firstS + BAR_LAG_S) targetS = firstS + BAR_LAG_S;
      if (every !== "1m" && targetS > lastS + BAR_LAG_S) targetS = lastS + BAR_LAG_S;
      out.nextCheckReason = every === "1m" ? "position check" : "next completed 5-minute bar";
    } else if (now.sec < closeS) {
      out.phase = "late";
      if (every === "1m") {
        targetS = Math.floor(now.sec / 60) * 60 + 60 + 2;
        out.nextCheckReason = "position check";
      } else out.nextCheckReason = "no strategy can enter again today";
    } else {
      out.phase = "closed";
    }
    if (targetS !== null) {
      out.nextCheck = `${now.date} ${hhmmss(targetS)} ET`;
      out.secondsToNextCheck = Math.max(0, targetS - now.sec);
      out._targetMs = nyInstant(now.date, targetS);
    }
  } else {
    out.phase = "closed";
  }
  if (out.phase === "closed") {
    const nd = now.sec < OPEN * 60 && trading ? now.date : nextTradingDay(now.date);
    if (nd) {
      const ndDay = L.marketDay(nd, weekdayOf(nd));
      const w = windowFor(agent, env, ndDay);
      out.nextSession = `${weekdayOf(nd)} ${nd}, first strategy check ${hhmm(w.from * 60)} ET`;
      out.secondsToNextSession = Math.round((nyInstant(nd, (w.from - PREP_MIN) * 60) - nowMs) / 1000);
    }
  }
  return out;
}

function line(s) {
  const bits = [`${s.now}`, `day ${s.day}${s.dayName ? ` (${s.dayName})` : ""}`, `phase ${s.phase}`];
  if (s.window) bits.push(`entry window ${s.window}, close ${s.close}`);
  if (s.nextCheck) bits.push(`next check ${s.nextCheck.slice(11)} in ${s.secondsToNextCheck}s (${s.nextCheckReason})`);
  else if (s.nextCheckReason) bits.push(s.nextCheckReason);
  if (s.nextSession) bits.push(`next session ${s.nextSession}`);
  if (s.lateBySeconds) bits.push(`WOKE ${s.lateBySeconds}s LATE: rebuild the missed bars before acting`);
  if (s.waitCappedAt) bits.push(`wait capped at ${s.waitCappedAt}s; run --wait again`);
  if (s.note) bits.push(s.note);
  return bits.join(" | ");
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    if (["--wait", "--json"].includes(argv[i])) a[argv[i].slice(2)] = true;
    else if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[++i];
  }
  return a;
}

async function main(argv, { nowFn = Date.now, sleepFn = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = {}) {
  const a = parseArgs(argv);
  const agent = a.agent || "";
  const env = L.loadEnv(path.join(__dirname, "..", ".env"));
  const every = a.every === "1m" ? "1m" : "5m";
  let s = status({ agent, env, nowMs: nowFn(), every });
  if (a.wait) {
    const cap = Math.max(1, Number(a.max || 590));
    const targetMs = s._targetMs ?? (s.secondsToNextSession != null ? nowFn() + s.secondsToNextSession * 1000 : null);
    if (targetMs !== null) {
      const waitMs = Math.max(0, targetMs - nowFn());
      const capped = waitMs > cap * 1000;
      await sleepFn(Math.min(waitMs, cap * 1000));
      const expected = capped ? nowFn() : targetMs; // a capped wait has no target to be late for
      const lateBy = Math.round((nowFn() - expected) / 1000);
      s = status({ agent, env, nowMs: nowFn(), every });
      if (capped) s.waitCappedAt = cap;
      // A machine that slept, or a suspended shell, wakes long after the target.
      if (lateBy > 60) s.lateBySeconds = lateBy;
    }
  }
  delete s._targetMs;
  log(a.json ? JSON.stringify(s) : line(s));
  return s;
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { status, main, nyInstant, nyParts, windowFor };
