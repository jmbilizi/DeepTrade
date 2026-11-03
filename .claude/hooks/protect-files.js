#!/usr/bin/env node
// PreToolUse hook attached to trading agents through their frontmatter.
// Denies writes to the files that define or enforce the guardrails, so a
// trading agent cannot loosen its own limits. A normal `claude` session in the
// repo is not affected, which keeps the hooks and config editable by people.
//
// Matches Edit, Write, NotebookEdit, Read, Grep, Glob, and Bash. Reads are
// refused only for secret files (.env and variants, not .env.example).
// For Bash the rule is simple:
// a command that mentions a protected path is allowed only when every part of
// it is a known read-only program and nothing is redirected. Anything else
// touching those paths is refused. Claude Code's own permission prompt remains
// the primary control for Bash, since only `sleep` is allowlisted for traders.

"use strict";
const L = require("./lib");

// Relative to the project root, forward slashes, lower case for matching.
const PROTECTED = [
  /^\.env($|\.)/, // .env, .env.local, .env.example
  /^\.mcp\.json$/,
  /^claude\.md$/,
  /^\.claude\/settings(\.local)?\.json$/,
  /^\.claude\/hooks\//,
  /^\.claude\/agents\//,
  /^journal\/orders\.jsonl$/,
  /^journal\/tools-seen\.txt$/,
  /^journal\/option-ids\.json$/,
];

// Files that hold secrets. Trading agents may not even read them; the session
// context already gives them every setting they need.
const SECRET = /^\.env($|\.(?!example$))/;
const SECRET_HINT = /\.env(?:\.[A-Za-z0-9_-]+)?(?![A-Za-z0-9_])/g;

function mentionsSecret(cmd) {
  const hits = String(cmd).match(SECRET_HINT) || [];
  return hits.some((h) => h.toLowerCase() !== ".env.example");
}

const PATH_HINT = /(\.env\b|\.mcp\.json|claude\.md|\.claude[\\/]+(settings|hooks|agents)|journal[\\/]+(orders\.jsonl|tools-seen\.txt|option-ids\.json))/i;

// Programs that only read. A command segment must start with one of these.
const READ_ONLY = new Set(["cat", "head", "tail", "less", "more", "grep", "egrep", "fgrep", "rg", "wc", "diff", "type", "get-content", "gc", "select-string", "ls", "dir", "stat", "file", "find", "sleep", "echo", "printf", "pwd", "date", "test", "true"]);
// Git subcommands that only read.
const GIT_READ_ONLY = new Set(["status", "log", "diff", "show", "blame", "ls-files"]);

function readOnlyCommand(cmd) {
  if (/[<>]/.test(cmd)) return false; // any redirection
  const segments = cmd.split(/\s*(?:&&|\|\||;|\|)\s*/).filter(Boolean);
  if (!segments.length) return false;
  return segments.every((seg) => {
    const words = seg.trim().split(/\s+/);
    const prog = (words[0] || "").toLowerCase().replace(/^.*[\\/]/, "");
    if (prog === "git") return GIT_READ_ONLY.has((words[1] || "").toLowerCase());
    // find can delete or run programs on what it matches.
    if (prog === "find" && words.some((w) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/i.test(w))) return false;
    return READ_ONLY.has(prog);
  });
}

function main() {
  const input = L.readStdinJson();
  if (!input) return;
  const tool = String(input.tool_name || "");
  const ti = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const root = L.projectDir(input);

  if (tool === "Bash") {
    const cmd = String(ti.command || "");
    if (mentionsSecret(cmd)) {
      return deny("This shell command touches .env, which holds API keys. Trading agents may not read or change it. Every setting is already in the session context.");
    }
    if (PATH_HINT.test(cmd) && !readOnlyCommand(cmd)) {
      return deny("This shell command touches a protected guardrail file and is not a plain read. Trading agents may only read .mcp.json, CLAUDE.md, .claude/settings*.json, .claude/hooks/, .claude/agents/, and the hook-written journal files. Tell the user what you wanted to change and why.");
    }
    return;
  }

  const raw = ti.file_path || ti.notebook_path || ti.path || "";
  const reading = tool === "Read" || tool === "Grep" || tool === "Glob";
  if (reading && ti.glob && mentionsSecret(ti.glob)) {
    return deny("Searching .env is not allowed: it holds API keys. Every setting is already in the session context.");
  }
  if (!raw) return;
  const rel = relPath(root, String(raw));
  if (rel === null) return; // outside the project, not our concern
  if (SECRET.test(rel)) {
    return deny(`"${rel}" is a protected guardrail file and holds API keys. Trading agents may not read or edit it. Every setting is already in the session context.`);
  }
  if (reading) return;
  if (PROTECTED.some((re) => re.test(rel))) {
    return deny(`"${rel}" is a protected guardrail file. Trading agents may not edit .env, .mcp.json, CLAUDE.md, .claude/settings*.json, .claude/hooks/, .claude/agents/, or the hook-written journal files. Ask the user to make the change.`);
  }
}

function relPath(root, p) {
  const norm = (s) => L.path.resolve(s).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const r = norm(root);
  const f = norm(L.path.isAbsolute(p) ? p : L.path.join(root, p));
  if (f === r) return "";
  if (!f.startsWith(r + "/")) return null;
  return f.slice(r.length + 1);
}

function deny(reason) {
  L.emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `DeepTrade file guard: ${reason}`,
    },
  });
}

try {
  main();
} catch (err) {
  // A guard that crashes must not open the door. Refuse and explain.
  deny(`guard crashed (${err && err.message}); refusing the write to be safe.`);
}
