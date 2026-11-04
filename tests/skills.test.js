// Lint for agent and skill instructions. Run with: node tests/skills.test.js
// Checks the writing rules in .claude/skills/trading-terms/SKILL.md: one name
// per concept, short sentences, each rule in one place, and the terms skill
// preloaded first by every trading agent.
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SKILLS = path.join(ROOT, ".claude", "skills");
const AGENTS = path.join(ROOT, ".claude", "agents");
const MAX_WORDS = 25; // descriptive sentences; procedural ones aim for 20

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || !detail ? "" : `\n      ${detail}`}`);
}

const files = [
  ...fs.readdirSync(SKILLS).map((d) => path.join(SKILLS, d, "SKILL.md")).filter((f) => fs.existsSync(f)),
  ...fs.readdirSync(AGENTS).filter((f) => f.endsWith(".md")).map((f) => path.join(AGENTS, f)),
];
const rel = (f) => path.relative(ROOT, f);

// Body text with frontmatter, code blocks, tables, headings, and example
// sections removed: what the sentence-length rule applies to.
function prose(text) {
  const lines = text.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n");
  const out = [];
  let code = false;
  let example = false;
  for (const line of lines) {
    if (line.startsWith("```")) {
      code = !code;
      continue;
    }
    if (code) continue;
    if (/^#{1,6} /.test(line)) {
      example = /^#{1,6} (Worked )?[Ee]xample/.test(line);
      continue;
    }
    if (example || line.trim().startsWith("|")) continue;
    out.push(line);
  }
  return out.join("\n");
}

function sentences(text) {
  return text
    .split(/\n\s*\n|\n(?=\s*(?:[-*]|\d+\.) )/)
    .map((p) => p.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .flatMap((p) => p.split(/(?<=[.!?])\s+(?=[A-Z`"(*])/))
    .map((s) => s.trim())
    .filter((s) => s && /[a-z]/i.test(s));
}

const words = (s) => s.replace(/`[^`]*`/g, "x").split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
// "Write on the card: a, b, c, and d." is a list, not a long sentence.
const isList = (s) => {
  const i = s.indexOf(": ");
  return i >= 0 && (s.slice(i).match(/,/g) || []).length >= 4;
};

// ---- one name per concept ----
const SYNONYMS = [
  [/take-profit|take_profit/i, "bank order / bank price"],
  [/\bR_prem\b|\bR_und\b/, "R / stop distance"],
  [/(?<!loss )\bthe ceiling\b/i, "loss ceiling"],
  [/\bbank-order\b/i, "bank order"],
];
for (const f of files) {
  if (f.includes(`${path.sep}trading-terms${path.sep}`)) continue;
  const text = fs.readFileSync(f, "utf8");
  for (const [re, use] of SYNONYMS) {
    const m = text.match(re);
    check(`${rel(f)}: no synonym "${re.source}"`, !m, m ? `found "${m[0]}"; use "${use}"` : "");
  }
}

// ---- sentence length ----
for (const f of files) {
  const long = sentences(prose(fs.readFileSync(f, "utf8"))).filter((s) => words(s) > MAX_WORDS && !isList(s));
  check(`${rel(f)}: sentences of ${MAX_WORDS} words or fewer`, !long.length, long.map((s) => `(${words(s)}) ${s}`).join("\n      "));
}

// ---- each rule in one place ----
// A defining phrase may appear only in the skill that owns the rule.
const OWNED = [
  [/Two consecutive completed 1-minute bars close/i, "trade-management"],
  [/bid first reaches `entry \+ 0\.75/i, "trade-management"],
  [/peak − g × \(peak − entry\)/, "trade-management"],
  [/closes beyond the last 5-minute swing point/i, "trade-management"],
  [/both max_order_usd|cap = min\(max_order_usd/i, "position-sizing"],
  [/earlier of `FLAT_BY` and 10 minutes before/i, "trading-terms"],
];
for (const [re, owner] of OWNED) {
  const hits = files.filter((f) => re.test(fs.readFileSync(f, "utf8"))).map(rel);
  const ok = hits.length === 1 && hits[0].includes(`${path.sep}${owner}${path.sep}`);
  check(`rule "${re.source.slice(0, 40)}" is stated only in ${owner}`, ok, `found in: ${hits.join(", ") || "nowhere"}`);
}

// ---- trading agents preload the terms first ----
for (const f of fs.readdirSync(AGENTS).filter((x) => x.endsWith(".md")).map((x) => path.join(AGENTS, x))) {
  const fm = (fs.readFileSync(f, "utf8").match(/^---\n([\s\S]*?)\n---/) || [])[1] || "";
  if (!/protect-files\.js/.test(fm)) continue;
  const first = (fm.match(/skills:\n\s*-\s*([\w-]+)/) || [])[1];
  check(`${rel(f)}: preloads trading-terms first`, first === "trading-terms", `first skill is ${first || "none"}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
