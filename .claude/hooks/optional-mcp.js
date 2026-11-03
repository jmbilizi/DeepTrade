#!/usr/bin/env node
// Launcher for optional MCP servers declared in .mcp.json.
//
//   node optional-mcp.js <ENV_KEY>[:<CHILD_VAR>] <command> [args...]
//
// Reads <ENV_KEY> from the project's .env (the shell environment wins if set).
// If the key is present, runs <command> with the value in its environment as
// <CHILD_VAR> (default: the same name), so .env can use a readable name while
// the server gets the variable it expects. Secrets never appear in .mcp.json
// or on the command line.
// If the key is missing, serves an empty MCP server over stdio: Claude Code
// connects cleanly, sees no tools, and the user sees no errors. That is what
// makes the provider optional.
//
// Adding a provider: one .mcp.json entry that calls this script, one key in
// .env.example, and one entry in OPTIONAL_SOURCES in lib.js.

"use strict";
const { spawn } = require("child_process");
const L = require("./lib");

const ROOT = process.env.CLAUDE_PROJECT_DIR || L.path.resolve(__dirname, "..", "..");

function keyValue(name) {
  const fromShell = process.env[name];
  if (fromShell && fromShell.trim()) return fromShell.trim();
  const env = L.loadEnv(L.path.join(ROOT, ".env"));
  const v = env[name];
  return v && v.trim() ? v.trim() : null;
}

function runChild(key, value, cmd, args) {
  const child = spawn(cmd, args, {
    stdio: "inherit",
    env: { ...process.env, [key]: value },
    shell: process.platform === "win32", // npx is npx.cmd on Windows
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      try { child.kill(sig); } catch { /* gone */ }
    });
  }
  child.on("error", (err) => {
    process.stderr.write(`optional-mcp: could not start ${cmd}: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code === null ? (signal ? 1 : 0) : code;
  });
}

// Minimal MCP server with no tools, newline-delimited JSON-RPC over stdio.
function serveEmpty(key) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        continue;
      }
      if (!req || req.id === undefined || req.id === null) continue; // notification
      const ok = (result) => send({ jsonrpc: "2.0", id: req.id, result });
      switch (req.method) {
        case "initialize":
          ok({
            protocolVersion: (req.params && req.params.protocolVersion) || "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "deeptrade-optional-mcp", version: "1.0.0" },
            instructions: `Not configured: ${key} is not set in .env, so this optional data source offers no tools. Agents should continue without it.`,
          });
          break;
        case "tools/list":
          ok({ tools: [] });
          break;
        case "ping":
          ok({});
          break;
        default:
          send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not available: ${key} is not set in .env.` } });
      }
    }
  });
  process.stdin.on("end", () => {
    process.exitCode = 0;
  });
}

function main() {
  const [spec, cmd, ...args] = process.argv.slice(2);
  const m = String(spec || "").match(/^([A-Za-z_][A-Za-z0-9_]*)(?::([A-Za-z_][A-Za-z0-9_]*))?$/);
  if (!m || !cmd) {
    process.stderr.write("usage: optional-mcp.js <ENV_KEY>[:<CHILD_VAR>] <command> [args...]\n");
    process.exitCode = 2;
    return;
  }
  const key = m[1];
  const childVar = m[2] || key;
  const value = keyValue(key);
  if (value) runChild(childVar, value, cmd, args);
  else serveEmpty(key);
}

main();
