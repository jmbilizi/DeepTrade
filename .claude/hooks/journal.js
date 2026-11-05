#!/usr/bin/env node
// PostToolUse hook: append every Robinhood order-related call and its result to
// journal/orders.jsonl, with account numbers redacted. Also keeps
// journal/tools-seen.txt, a list of every distinct Robinhood tool name observed,
// so users can tighten the classifier once they know the real names.

"use strict";
const L = require("./lib");

const MAX_RESPONSE_CHARS = 4000;

function main() {
  const input = L.readStdinJson();
  if (!input) return;

  const toolName = String(input.tool_name || "");
  const dir = L.projectDir(input);
  const jdir = L.path.join(dir, "journal");
  const rawEnv = L.loadEnv(L.path.join(dir, ".env"));
  const env = L.effectiveEnv(rawEnv, input.agent_type);
  const tz = env.DEEPTRADE_TIMEZONE || L.DEFAULT_TZ;

  try {
    L.fs.mkdirSync(jdir, { recursive: true });
  } catch {
    /* handled below */
  }

  noteToolSeen(L.path.join(jdir, "tools-seen.txt"), toolName);

  const kind = L.classifyTool(toolName);
  const optionIdsFile = L.path.join(jdir, "option-ids.json");

  // Remember option contract id -> underlying so the risk gate can check the
  // symbol of option orders, which name contracts only by id.
  if (kind === "read" && /option/i.test(L.toolTail(toolName))) {
    try {
      L.saveOptionIds(optionIdsFile, L.collectOptionIds(input.tool_response));
    } catch {
      /* best effort; the gate refuses unresolved option orders */
    }
  }

  // Remember call or put per contract id, from lookups and order responses, for
  // the exposure guard's one-position-per-direction rule.
  if ((kind === "read" || kind === "order") && /option/i.test(L.toolTail(toolName))) {
    try {
      L.saveIdMap(L.path.join(jdir, L.OPTION_TYPES_FILE), L.collectOptionTypes(input.tool_response));
    } catch {
      /* best effort; the gate refuses entries it cannot classify */
    }
  }

  // Record equity and buying power straight from the broker's response, so the
  // risk gate never depends on numbers the agent wrote. Same for option positions.
  if (kind === "read") {
    try {
      L.recordAccountState(L.path.join(jdir, L.ACCOUNT_STATE_FILE), L.toolTail(toolName), input.tool_input, input.tool_response);
    } catch {
      /* best effort; the gate refuses entries without a fresh read */
    }
    try {
      L.recordExposureReads(jdir, L.toolTail(toolName), input.tool_input, input.tool_response, tz, input.duration_ms);
    } catch {
      /* best effort; the exposure guard refuses entries without a fresh read */
    }
  }
  if (kind !== "order" && kind !== "cancel") return;

  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const reducing = kind === "order" && L.isReducing(toolName, toolInput, L.gateSells(env));
  const record = {
    ts: new Date().toISOString(),
    date_local: L.localParts(tz).date,
    kind,
    gated: kind === "order" && !reducing,
    reducing,
    asset_class: kind === "order" ? L.assetClass(toolName, toolInput) : null,
    symbol: L.orderSymbol(toolInput, optionIdsFile).symbol,
    tool: toolName,
    session_id: input.session_id || null,
    agent_type: input.agent_type || null,
    input: L.redact(toolInput),
    response: L.redact(clip(input.tool_response)),
    duration_ms: input.duration_ms || null,
  };

  try {
    L.fs.appendFileSync(L.path.join(jdir, "orders.jsonl"), JSON.stringify(record) + "\n", "utf8");
    // The order is on record, so other agents' gates can see it: free the lock.
    L.releaseOrderLock(jdir, L.lockOwner(input));
  } catch (err) {
    L.emit({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `DeepTrade journal hook could not write journal/orders.jsonl: ${err && err.message}. Record this order manually in today's journal note and tell the user.`,
      },
    });
  }
}

function noteToolSeen(file, toolName) {
  if (!toolName) return;
  try {
    let seen = [];
    try {
      seen = L.fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    } catch {
      /* new file */
    }
    if (!seen.includes(toolName)) L.fs.appendFileSync(file, toolName + "\n", "utf8");
  } catch {
    /* best effort */
  }
}

function clip(v) {
  if (v === undefined) return null;
  let s;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s === undefined) return null;
  if (s.length <= MAX_RESPONSE_CHARS) return v;
  return s.slice(0, MAX_RESPONSE_CHARS) + `… [truncated ${s.length - MAX_RESPONSE_CHARS} chars]`;
}

try {
  main();
} catch {
  process.exitCode = 0;
}
