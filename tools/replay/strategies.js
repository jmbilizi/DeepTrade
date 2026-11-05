// Strategy rules for the replay. Each one mirrors its skill in .claude/skills/.
// When you change a skill's entry or exit rules, change the matching code here
// and run the replay before trading the change.
"use strict";
const { levelMap } = require("./lib");

const trendState = (b) => (b.c > b.vwap && b.e9 > b.e20 && b.st === 1 ? 1 : b.c < b.vwap && b.e9 < b.e20 && b.st === -1 ? -1 : 0);
function chopFlag(day, i) {
  const w = day.slice(Math.max(0, i - 11), i + 1);
  let x = 0;
  for (let k = 1; k < w.length; k++) if (Math.sign(w[k].c - w[k].vwap) !== Math.sign(w[k - 1].c - w[k - 1].vwap)) x++;
  const range = Math.max(...w.map((b) => b.h)) - Math.min(...w.map((b) => b.l));
  return x >= 4 || range < 1.5 * day[i].atr;
}
const BRACKET = { bankAtr: 0.8, stopAtr: 0.8, stopMult: 0.75, timeMin: 30, underlyingStop: true }; // trade-management, Bracket; stopMult is the 25% loss ceiling

const STRATEGIES = {
  // .claude/skills/index-level-scalp/SKILL.md
  "index-level-scalp": {
    window: { from: "09:50", to: "11:30" },
    exits: BRACKET,
    signal({ today, prevDay, i }) {
      if (i < 3) return null;
      const b = today[i], p = today[i - 1], q = today[i - 2];
      const range = b.h - b.l;
      for (const lv of levelMap(today, prevDay, i)) {
        const x = lv.px;
        // Setup R, rejection: the bar pierces the level and closes back on the side it came from.
        if (p.c > x && b.l < x && b.c > x && b.c - b.l >= 0.4 * range) return { dir: 1, stop: b.l - 0.1 * b.atr, tag: `R ${lv.name}` };
        if (p.c < x && b.h > x && b.c < x && b.h - b.c >= 0.4 * range) return { dir: -1, stop: b.h + 0.1 * b.atr, tag: `R ${lv.name}` };
        // Setup T, break and retest: the previous bar closed through the level, this bar tests it and holds.
        if (q.c < x && p.c > x && b.l <= x + 0.15 * b.atr && b.c > x && b.c > b.o) return { dir: 1, stop: Math.min(b.l, x) - 0.1 * b.atr, tag: `T ${lv.name}` };
        if (q.c > x && p.c < x && b.h >= x - 0.15 * b.atr && b.c < x && b.c < b.o) return { dir: -1, stop: Math.max(b.h, x) + 0.1 * b.atr, tag: `T ${lv.name}` };
      }
      return null;
    },
  },
  // .claude/skills/index-trend-scalp/SKILL.md (setups A and B with every filter)
  "index-trend-scalp": {
    window: { from: "09:50", to: "11:30" },
    exits: BRACKET,
    signal({ today, i, witness }) {
      if (i < 3) return null;
      const b = today[i], p = today[i - 1];
      if (chopFlag(today, i) || b.tr > 2.5 * b.atr) return null;
      const ext = (b.c - b.vwap) / b.atr;
      for (const dir of [1, -1]) {
        if (dir * ext > 2) continue;
        const prior3 = today.slice(i - 3, i);
        const nearAnchor = prior3.some((x) => (dir === 1 ? x.l <= Math.max(x.e20, x.vwap) + 0.25 * b.atr : x.h >= Math.min(x.e20, x.vwap) - 0.25 * b.atr));
        const noCross = today.slice(i - 3, i + 1).every((x) => (dir === 1 ? x.c >= x.vwap : x.c <= x.vwap));
        const a = trendState(b) === dir && nearAnchor && noCross && (dir === 1 ? b.c > b.e9 && b.c > p.h : b.c < b.e9 && b.c < p.l);
        const wrongSide = today.slice(Math.max(0, i - 6), i).filter((x) => (dir === 1 ? x.c < x.vwap : x.c > x.vwap)).length;
        const bSetup = wrongSide >= 2 && (dir === 1 ? b.c > b.vwap && b.c > Math.max(...prior3.map((x) => x.h)) && b.e9 > b.e20 : b.c < b.vwap && b.c < Math.min(...prior3.map((x) => x.l)) && b.e9 < b.e20);
        if (!a && !bSetup) continue;
        const stop = dir === 1 ? b.l - 0.1 * b.atr : b.h + 0.1 * b.atr;
        const dist = Math.abs(b.c - stop);
        if (dist < 0.3 * b.atr || dist > 1.0 * b.atr) continue;
        if (witness) {
          const w = witness[i];
          const wt = trendState(w);
          if (dir === 1 ? w.c < w.vwap || wt === -1 : w.c > w.vwap || wt === 1) continue; // index-pair-read: disagrees
        }
        return { dir, stop, tag: a ? "A" : "B" };
      }
      return null;
    },
  },
  // Baseline: an entry every 30 minutes, direction from a fixed pseudo-random sequence.
  // A strategy that cannot beat this has no edge in the replay.
  random: {
    window: { from: "09:50", to: "11:30" },
    exits: BRACKET,
    signal({ today, i, dayIndex, sym }) {
      if (i % 6 !== 3) return null;
      const r = Math.sin(dayIndex * 97 + i * 13 + sym.length * 7 + sym.charCodeAt(0)) * 1e4;
      const dir = r - Math.floor(r) < 0.5 ? 1 : -1;
      return { dir, stop: today[i].c - dir * 0.7 * today[i].atr, tag: "rand" };
    },
  },
};

module.exports = { STRATEGIES, trendState, chopFlag, BRACKET };
