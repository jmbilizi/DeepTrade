// Tests for tools/clock.js. Run with: node tests/clock.test.js
"use strict";
const C = require("../tools/clock.js");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || detail === undefined ? "" : `\n      ${detail}`}`);
}
const at = (d, t) => C.nyInstant(d, t.split(":").reduce((a, x, i) => a + Number(x) * [3600, 60, 1][i], 0));
const idx = (d, t, every = "5m", env = {}) => C.status({ agent: "index-0dte-trader", env, nowMs: at(d, t), every });

// ---- New York time, both sides of the DST change ----
check("nyInstant: EDT 09:30 is 13:30Z", new Date(at("2026-10-30", "09:30:00")).toISOString() === "2026-10-30T13:30:00.000Z");
check("nyInstant: EST 09:30 is 14:30Z", new Date(at("2026-11-05", "09:30:00")).toISOString() === "2026-11-05T14:30:00.000Z");
check("nyParts round trip", C.nyParts(at("2026-11-05", "10:02:10")).sec === 10 * 3600 + 2 * 60 + 10);

// ---- phases ----
let s = idx("2026-11-05", "06:30:00");
check("before the open: phase before-open", s.phase === "before-open", JSON.stringify(s));
check("before the open: wakes 5 min before the first check", s.nextCheck === "2026-11-05 09:45:00 ET" && s.secondsToNextCheck === 11700, JSON.stringify(s));
check("before the open: window from the profile's strategies", s.window === "09:50-11:30");
s = idx("2026-11-05", "03:00:00");
check("before 04:00 on a trading day is still before-open", s.phase === "before-open");
s = idx("2026-11-05", "09:47:00");
check("just before the first check: next check 09:50:05", s.nextCheck === "2026-11-05 09:50:05 ET" && s.secondsToNextCheck === 185, JSON.stringify(s));
s = idx("2026-11-05", "10:02:10");
check("trading: next completed 5-minute bar", s.phase === "trading" && s.nextCheck === "2026-11-05 10:05:05 ET", JSON.stringify(s));
s = idx("2026-11-05", "10:05:02");
check("trading: a bar boundary not yet complete waits for the lag", s.nextCheck === "2026-11-05 10:05:05 ET", JSON.stringify(s));
s = idx("2026-11-05", "10:02:10", "1m");
check("trading: position checks every minute", s.nextCheck === "2026-11-05 10:03:05 ET", JSON.stringify(s));
s = idx("2026-11-05", "11:33:00");
check("the bar closing 11:35 is past the cutoff: late", s.phase === "late" && !s.nextCheck, JSON.stringify(s));
s = idx("2026-11-05", "11:28:00");
check("the last check is the bar closing at the cutoff", s.phase === "trading" && s.nextCheck === "2026-11-05 11:30:05 ET", JSON.stringify(s));
s = idx("2026-11-05", "11:30:06");
check("after the last check: late", s.phase === "late" && !s.nextCheck, JSON.stringify(s));
s = idx("2026-11-05", "12:10:00", "1m");
check("late with a position: still a position check each minute", s.phase === "late" && s.nextCheck === "2026-11-05 12:11:02 ET", JSON.stringify(s));
s = idx("2026-11-05", "16:30:00");
check("after the close: closed, next session tomorrow", s.phase === "closed" && /Friday 2026-11-06/.test(s.nextSession), JSON.stringify(s));
s = idx("2026-11-07", "10:00:00");
check("weekend: closed, next session Monday", s.phase === "closed" && /Monday 2026-11-09/.test(s.nextSession), JSON.stringify(s));
s = idx("2026-11-26", "08:00:00");
check("holiday: closed with its name, next session Friday", s.phase === "closed" && s.dayName === "Thanksgiving Day" && /Friday 2026-11-27/.test(s.nextSession), JSON.stringify(s));
s = idx("2026-11-27", "12:00:00");
check("early close: close 13:00 is reported", s.close === "13:00", JSON.stringify(s));
s = C.status({ agent: "no-profile-agent", env: { DEEPTRADE_STRATEGIES: "opening-range-breakout", DEEPTRADE_NO_NEW_ENTRIES_BEFORE: "09:35", DEEPTRADE_NO_NEW_ENTRIES_AFTER: "15:00" }, nowMs: at("2026-11-05", "08:00:00"), every: "5m" });
check("no profile, strategy without a code window: uses the gate window and says so", s.window === "09:35-15:00" && /No window in code/.test(s.note || ""), JSON.stringify(s));
s = C.status({ agent: "index-0dte-trader", env: { DEEPTRADE_NO_NEW_ENTRIES_AFTER: "10:00", DEEPTRADE_STRATEGIES: "x" }, nowMs: at("2026-11-05", "08:00:00"), every: "5m" });
check("profile: .env cannot change the window", s.window === "09:50-11:30", JSON.stringify(s));

// ---- waiting ----
(async () => {
  let fake = at("2026-11-05", "10:02:10");
  const quiet = () => {};
  let slept = 0;
  let r = await C.main(["--agent", "index-0dte-trader", "--wait"], { nowFn: () => fake, sleepFn: async (ms) => { slept = ms; fake += ms; }, log: quiet });
  check("wait: sleeps exactly to the next check", slept === 175000 && r.secondsToNextCheck === 300, `${slept} ${JSON.stringify(r)}`);
  check("wait: on time is not flagged late", !r.lateBySeconds);
  fake = at("2026-11-05", "10:02:10");
  r = await C.main(["--agent", "index-0dte-trader", "--wait"], { nowFn: () => fake, sleepFn: async (ms) => { fake += ms + 20 * 60e3; }, log: quiet });
  check("wait: a machine that slept is flagged late", r.lateBySeconds === 1200, JSON.stringify(r));
  fake = at("2026-11-05", "06:30:00");
  r = await C.main(["--agent", "index-0dte-trader", "--wait"], { nowFn: () => fake, sleepFn: async (ms) => { slept = ms; fake += ms; }, log: quiet });
  check("wait: a long wait is capped at 590 s by default", slept === 590000 && r.waitCappedAt === 590 && !r.lateBySeconds, JSON.stringify(r));
  fake = at("2026-11-05", "06:30:00");
  r = await C.main(["--agent", "index-0dte-trader", "--wait", "--max", "20000"], { nowFn: () => fake, sleepFn: async (ms) => { slept = ms; fake += ms; }, log: quiet });
  check("wait: --max lets a background wait run to the target", slept === 11700000 && r.phase === "before-open" && r.secondsToNextCheck === 305, JSON.stringify(r));
  fake = at("2026-11-07", "10:00:00");
  r = await C.main(["--agent", "index-0dte-trader", "--wait", "--max", "999999"], { nowFn: () => fake, sleepFn: async (ms) => { slept = ms; fake += ms; }, log: quiet });
  check("wait: closed waits for the next session's prep time", r.phase === "before-open" && r.nextCheck === "2026-11-09 09:50:05 ET", JSON.stringify(r));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
