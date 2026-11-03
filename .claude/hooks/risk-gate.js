#!/usr/bin/env node
// PreToolUse hook: deterministic guardrail for Robinhood order tools.
//
// Reads .env limits, inspects the pending tool call, and denies it when a limit
// is breached. Says nothing when it has no objection, so Claude Code's normal
// permission prompt still applies. Orders that reduce exposure (sells and
// closes in a long-only setup) bypass the caps so the agent can always get flat.
//
// Fails closed on breached limits. On its own bugs it warns the model and
// defers to the permission prompt rather than silently approving.

"use strict";
const L = require("./lib");

function main() {
  const input = L.readStdinJson();
  if (!input) return;

  const toolName = String(input.tool_name || "");
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const kind = L.classifyTool(toolName);
  if (kind === "read" || kind === "cancel") return;

  const dir = L.projectDir(input);
  const env = L.loadEnv(L.path.join(dir, ".env"));
  const tz = env.DEEPTRADE_TIMEZONE || L.DEFAULT_TZ;
  const now = L.localParts(tz);
  const notes = [];

  if (kind === "other") {
    notes.push(`Risk gate did not recognize the tool "${L.toolTail(toolName)}" as read-only or as an order, so no limits were checked. If it can move money, treat it as an order and confirm it against the plan.`);
    return L.emit(ctx(notes));
  }

  // Everything below is an order-like call.
  const haltAll = L.truthy(env.DEEPTRADE_HALT_ALL);
  const halt = L.truthy(env.DEEPTRADE_HALT);
  const gateSells = L.gateSells(env);
  const reducing = L.isReducing(toolName, toolInput, gateSells);
  const cls = L.assetClass(toolName, toolInput);
  const resolved = L.orderSymbol(toolInput, L.path.join(dir, "journal", "option-ids.json"));
  const symbol = resolved.symbol;

  if (haltAll) return deny("DEEPTRADE_HALT_ALL is true in .env. Every order tool is blocked, including exits. Only cancels work. Ask the user to change it.");

  if (reducing) {
    notes.push(`Risk gate treated this as a position-reducing order${symbol ? ` on ${symbol}` : ""} and did not apply the entry caps. It is still subject to the user's permission prompt.`);
    return L.emit(ctx(notes));
  }

  // Opening order from here on.
  if (halt) return deny("DEEPTRADE_HALT is true in .env. New entries are blocked. Exits and cancels still work. Ask the user to set it to false to resume.");

  // Settings edited in .env since the agent was briefed: refuse this entry once
  // and list the new values, so the agent re-plans with them before retrying.
  const snapFile = L.path.join(dir, "journal", L.SETTINGS_SNAPSHOT_FILE);
  const snapNow = L.settingsSnapshot(env);
  let snapOld = null;
  try {
    snapOld = JSON.parse(L.fs.readFileSync(snapFile, "utf8"));
  } catch {
    /* none yet */
  }
  const changed = snapOld ? L.settingsChanges(snapOld, snapNow) : [];
  try {
    if (!snapOld || changed.length) L.fs.writeFileSync(snapFile, JSON.stringify(snapNow), "utf8");
  } catch {
    /* if it cannot be saved the next entry reports the change again */
  }
  if (changed.length) {
    return deny(`The user changed .env since this session was briefed: ${changed.join("; ")}. These values now apply. Tell the user in one line, re-check this trade against the new values (size, strategy, symbols, times), then submit again if it still fits.`);
  }

  // Time window.
  const notBefore = L.parseHHMM(env.DEEPTRADE_NO_NEW_ENTRIES_BEFORE);
  const notAfter = L.parseHHMM(env.DEEPTRADE_NO_NEW_ENTRIES_AFTER);
  if (now.ok && notBefore !== null && now.minutes < notBefore) {
    return deny(`It is ${now.text} ${tz}, before DEEPTRADE_NO_NEW_ENTRIES_BEFORE=${env.DEEPTRADE_NO_NEW_ENTRIES_BEFORE}. New entries are blocked.`);
  }
  if (now.ok && notAfter !== null && now.minutes >= notAfter) {
    return deny(`It is ${now.text} ${tz}, at or after DEEPTRADE_NO_NEW_ENTRIES_AFTER=${env.DEEPTRADE_NO_NEW_ENTRIES_AFTER}. New entries are blocked. Exits still work.`);
  }

  // Asset class.
  const classes = L.csv(env.DEEPTRADE_ALLOWED_ASSET_CLASSES).map((c) => c.toLowerCase());
  if (classes.length) {
    if (cls === "unknown") notes.push("Risk gate could not tell the asset class of this order, so DEEPTRADE_ALLOWED_ASSET_CLASSES was not enforced. Confirm it is an allowed class.");
    else if (!classes.includes(cls)) return deny(`This looks like a ${cls} order and DEEPTRADE_ALLOWED_ASSET_CLASSES=${env.DEEPTRADE_ALLOWED_ASSET_CLASSES}. Order refused.`);
  }

  // Symbol lists.
  const blocked = L.csv(env.DEEPTRADE_BLOCKED_SYMBOLS);
  const allowed = L.csv(env.DEEPTRADE_ALLOWED_SYMBOLS);
  if (!symbol && resolved.unresolved.length && blocked.length) return deny(`DEEPTRADE_BLOCKED_SYMBOLS is set but the risk gate could not tell the underlying of this option order (${resolved.unresolved.join(", ")}). Look the contract up with get_option_instruments in this session so its underlying is recorded, then retry.`);
  if (symbol && blocked.length && L.symbolAllowed(symbol, blocked)) return deny(`${symbol} is in DEEPTRADE_BLOCKED_SYMBOLS. Order refused.`);
  if (allowed.length) {
    if (!symbol && resolved.unresolved.length) return deny(`DEEPTRADE_ALLOWED_SYMBOLS is set but the risk gate could not tell the underlying of this option order (${resolved.unresolved.join(", ")}). Look the contract up with get_option_instruments in this session so its underlying is recorded, then retry.`);
    if (!symbol) return deny("DEEPTRADE_ALLOWED_SYMBOLS is set but the risk gate could not find a symbol in this order request, so it cannot verify the symbol. Order refused. Include the symbol in a standard field.");
    if (!L.symbolAllowed(symbol, allowed)) return deny(`${symbol} is not in DEEPTRADE_ALLOWED_SYMBOLS (${allowed.join(",")}). Order refused.`);
  } else if (!symbol) {
    notes.push("Risk gate could not find a symbol field in this order request.");
  }

  // Daily opening-order count.
  const maxOrders = L.num(env.DEEPTRADE_MAX_ORDERS_PER_DAY);
  if (maxOrders !== null) {
    const todayCount = L.countOpeningOrders(L.path.join(dir, "journal", "orders.jsonl"), now.date);
    if (todayCount >= maxOrders) {
      return deny(`Daily entry cap reached: ${todayCount}/${maxOrders} opening orders already submitted on ${now.date} (DEEPTRADE_MAX_ORDERS_PER_DAY). Order refused. Exits still work.`);
    }
    notes.push(`Opening orders submitted today before this one: ${todayCount}/${maxOrders}.`);
  }

  // Per-order value cap: see effectiveCap.
  const cap = effectiveCap(env, L.path.join(dir, "journal", L.ACCOUNT_STATE_FILE), L.path.join(dir, "journal", "orders.jsonl"));
  if (cap.denyReason) return deny(cap.denyReason);
  if (cap.note) notes.push(cap.note);
  if (cap.value !== null) {
    const est = L.estimateNotional(toolInput, cls);
    if (est.value !== null && est.value > cap.value) {
      return deny(`Estimated order value $${est.value.toFixed(2)} (${est.how}) exceeds the per-order cap of $${cap.value.toFixed(2)} (${cap.how}). Reduce size or ask the user to change the cap in .env.`);
    }
    if (est.value === null) {
      if (L.truthy(env.DEEPTRADE_REQUIRE_KNOWN_VALUE)) {
        return deny(`Risk gate could not estimate this order's value (${est.how}) and DEEPTRADE_REQUIRE_KNOWN_VALUE is true. Use a limit order or a dollar amount so the cap can be checked.`);
      }
      notes.push(`Risk gate could not estimate order value (${est.how}), so the $${cap.value.toFixed(2)} cap was not checked. Confirm the size is within the cap before approving.`);
    } else {
      notes.push(`Estimated order value $${est.value.toFixed(2)} (${est.how}), within the $${cap.value.toFixed(2)} cap (${cap.how}).`);
    }
  }

  L.emit(ctx(notes));
}

function effectiveCap(env, stateFile, ordersFile) {
  const cap = L.orderCap(env, L.readState(stateFile), L.lastOrderMs(ordersFile));
  if (cap.value === null) {
    // Blocking is the gate's job, so refuse until the agent refreshes the account.
    return { value: null, how: "none", denyReason: `The per-order cap cannot be computed: ${cap.missing}. Call get_portfolio for the agentic account (after get_accounts at least once this session), then retry. The hook records equity and buying power from that response.` };
  }
  return cap;
}

function ctx(notes) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notes.join(" ") } };
}

function deny(reason) {
  L.emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `DeepTrade risk gate: ${reason}`,
    },
  });
}

try {
  main();
} catch (err) {
  L.emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: `DeepTrade risk gate crashed and did not check limits: ${err && err.message}. Treat this order with extra care and tell the user.`,
    },
  });
}
