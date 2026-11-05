#!/usr/bin/env node
// Turns saved get_equity_historicals responses into compact CSV files.
// Usage: node tools/replay/bars.js <out-dir> <saved-response.json|txt> [...]
// Writes <out-dir>/<interval>.csv (for example 5minute.csv and minute.csv),
// merging with rows already there. Interpolated bars are dropped.
"use strict";
const fs = require("fs");
const path = require("path");

function main(argv) {
  const [outDir, ...files] = argv;
  if (!outDir || !files.length) {
    console.error("usage: node tools/replay/bars.js <out-dir> <saved-response> [...]");
    return 1;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const byInterval = {};
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch (e) {
      console.error(`skip ${f}: not JSON (${e.message})`);
      continue;
    }
    for (const r of (j.data && j.data.results) || []) {
      const rows = (byInterval[r.interval] ??= readCsv(path.join(outDir, `${r.interval}.csv`)));
      for (const b of r.bars || []) {
        if (b.interpolated) continue;
        rows.set(`${r.symbol},${b.begins_at}`, [r.symbol, b.begins_at, +b.open_price, +b.high_price, +b.low_price, +b.close_price, b.volume].join(","));
      }
    }
  }
  for (const [interval, rows] of Object.entries(byInterval)) {
    const out = path.join(outDir, `${interval}.csv`);
    const lines = [...rows.keys()].sort().map((k) => rows.get(k));
    fs.writeFileSync(out, "sym,t,o,h,l,c,v\n" + lines.join("\n") + "\n");
    console.log(`${out}: ${lines.length} bars`);
  }
  return 0;
}

function readCsv(file) {
  const rows = new Map();
  if (!fs.existsSync(file)) return rows;
  for (const line of fs.readFileSync(file, "utf8").trim().split("\n").slice(1)) {
    const [sym, t] = line.split(",");
    if (sym && t) rows.set(`${sym},${t}`, line);
  }
  return rows;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };
