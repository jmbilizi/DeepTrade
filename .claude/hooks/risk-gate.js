#!/usr/bin/env node
// PreToolUse hook: deterministic guardrail for Robinhood order tools.
//
// Reads .env limits, inspects the pending tool call, and denies it when a limit
// is breached. Says nothing when it has no objection, so Claude Code's normal
// permission prompt still applies. Orders that reduce exposure (sells and
// closes in a long-only setup) bypass the caps so the agent can always get flat.
//
// Fails closed on breached limits. Option orders can be allowed without a
// prompt, so if the gate itself crashes it refuses entries and lets exits and
// reads through with a warning.

"use strict";
const L = require("./lib");

function main() {
  const input = L.readStdinJson();
  if (!input) return;
  lastInput = input;

  const toolName = String(input.tool_name || "");
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const kind = L.classifyTool(toolName);
  if (kind === "read" || kind === "cancel") return;

  const dir = L.projectDir(input);
  // An agent with a profile (lib.js AGENT_PROFILES) gets the profile's values in place of those .env keys.
  const env = L.effectiveEnv(L.loadEnv(L.path.join(dir, ".env")), input.agent_type);
  // Names a setting in a denial: the .env key, or the agent profile that owns it.
  const src = (k) => (env.__PROFILE && L.agentProfile(env.__PROFILE).settings[k] !== undefined ? `the ${env.__PROFILE} profile (${k.replace(/^DEEPTRADE_/, "").toLowerCase()}=${env[k]})` : `${k}=${env[k]}`);
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
    notes.push(`Risk gate treated this as a position-reducing order${symbol ? ` on ${symbol}` : ""} and did not apply the entry caps.`);
    return L.emit(ctx(notes));
  }

  // Opening order from here on.
  if (halt) return deny("DEEPTRADE_HALT is true in .env. New entries are blocked. Exits and cancels still work. Ask the user to set it to false to resume.");

  // Only a trading agent with a profile may open positions; a parked one may not.
  const prof = L.agentProfile(input.agent_type);
  if (!prof) return deny(`This session has no agent profile${input.agent_type ? ` (agent_type ${input.agent_type})` : ""}. Only a trading agent with a profile in AGENT_PROFILES in .claude/hooks/lib.js may open positions, for example claude --agent index-0dte-trader. Exits and cancels still work.`);
  if (prof.parked) return deny(`${input.agent_type} is parked: ${prof.parked} It may do research but not open positions. Exits and cancels still work.`);

  // Settings edited in .env since the agent was briefed: refuse this entry once
  // and list the new values, so the agent re-plans with them before retrying.
  const snapFile = L.path.join(dir, "journal", L.SETTINGS_SNAPSHOT_FILE);
  const snapNow = L.settingsSnapshot(env);
  const snapOld = L.readSnapshot(snapFile, env);
  const changed = snapOld ? L.settingsChanges(snapOld, snapNow) : [];
  try {
    if (!snapOld || changed.length) L.writeSnapshot(snapFile, env, snapNow);
  } catch {
    /* if it cannot be saved the next entry reports the change again */
  }
  if (changed.length) {
    return deny(`The user changed .env since this session was briefed: ${changed.join("; ")}. These values now apply. Tell the user in one line, re-check this trade against the new values (size, strategy, symbols, times), then submit again if it still fits.`);
  }

  // Market calendar: no entries on a market holiday; on an early-close day the
  // entry cutoff moves earlier by as much as the close does.
  const day = now.ok ? L.marketDay(now.date, now.weekday) : { status: "unchecked", shiftMin: 0 };
  if (day.status === "holiday") return deny(`${now.date} is a US market holiday (${day.name}). New entries are blocked.`);
  if (day.status === "early" && now.minutes >= day.closeMin) return deny(`The market closed early today at ${L.fmtHHMM(day.closeMin)}. New entries are blocked.`);

  // Time window.
  const notBefore = L.parseHHMM(env.DEEPTRADE_NO_NEW_ENTRIES_BEFORE);
  const notAfterSet = L.parseHHMM(env.DEEPTRADE_NO_NEW_ENTRIES_AFTER);
  const notAfter = notAfterSet !== null && day.shiftMin ? notAfterSet - day.shiftMin : notAfterSet;
  if (now.ok && notBefore !== null && now.minutes < notBefore) {
    return deny(`It is ${now.text} ${tz}, before ${src("DEEPTRADE_NO_NEW_ENTRIES_BEFORE")}. New entries are blocked.`);
  }
  if (now.ok && notAfter !== null && now.minutes >= notAfter) {
    const why = day.shiftMin ? `${L.fmtHHMM(notAfter)}, today's entry cutoff (${src("DEEPTRADE_NO_NEW_ENTRIES_AFTER")} moved ${day.shiftMin} minutes earlier for the ${L.fmtHHMM(day.closeMin)} early close)` : `${src("DEEPTRADE_NO_NEW_ENTRIES_AFTER")}`;
    return deny(`It is ${now.text} ${tz}, at or after ${why}. New entries are blocked. Exits still work.`);
  }

  // Asset class.
  const classes = L.csv(env.DEEPTRADE_ALLOWED_ASSET_CLASSES).map((c) => c.toLowerCase());
  if (classes.length) {
    if (cls === "unknown") notes.push("Risk gate could not tell the asset class of this order, so DEEPTRADE_ALLOWED_ASSET_CLASSES was not enforced. Confirm it is an allowed class.");
    else if (!classes.includes(cls)) return deny(`This looks like a ${cls} order and ${src("DEEPTRADE_ALLOWED_ASSET_CLASSES")}. Order refused.`);
  }

  // Symbol lists.
  const blocked = L.csv(env.DEEPTRADE_BLOCKED_SYMBOLS);
  const allowed = L.csv(env.DEEPTRADE_ALLOWED_SYMBOLS);
  if (!symbol && resolved.unresolved.length && blocked.length) return deny(`DEEPTRADE_BLOCKED_SYMBOLS is set but the risk gate could not tell the underlying of this option order (${resolved.unresolved.join(", ")}). Look the contract up with get_option_instruments in this session so its underlying is recorded, then retry.`);
  if (symbol && blocked.length && L.symbolAllowed(symbol, blocked)) return deny(`${symbol} is in DEEPTRADE_BLOCKED_SYMBOLS. Order refused.`);
  if (allowed.length) {
    if (!symbol && resolved.unresolved.length) return deny(`DEEPTRADE_ALLOWED_SYMBOLS is set but the risk gate could not tell the underlying of this option order (${resolved.unresolved.join(", ")}). Look the contract up with get_option_instruments in this session so its underlying is recorded, then retry.`);
    if (!symbol) return deny("DEEPTRADE_ALLOWED_SYMBOLS is set but the risk gate could not find a symbol in this order request, so it cannot verify the symbol. Order refused. Include the symbol in a standard field.");
    if (!L.symbolAllowed(symbol, allowed)) return deny(`${symbol} is not in ${src("DEEPTRADE_ALLOWED_SYMBOLS")}. Order refused.`);
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
      // Option orders can be allowed without a prompt, so an option entry the
      // gate cannot value is refused whatever DEEPTRADE_REQUIRE_KNOWN_VALUE says.
      if (L.truthy(env.DEEPTRADE_REQUIRE_KNOWN_VALUE) || cls === "option") {
        return deny(`Risk gate could not estimate this order's value (${est.how}) and DEEPTRADE_REQUIRE_KNOWN_VALUE is true. Use a limit order or a dollar amount so the cap can be checked.`);
      }
      notes.push(`Risk gate could not estimate order value (${est.how}), so the $${cap.value.toFixed(2)} cap was not checked. Confirm the size is within the cap before approving.`);
    } else {
      notes.push(`Estimated order value $${est.value.toFixed(2)} (${est.how}), within the $${cap.value.toFixed(2)} cap (${cap.how}).`);
    }
  }

  // Team exposure under the account-wide order lock. The lock comes first so
  // no other entry can pass between the check and this order being recorded.
  if (L.truthy(env.DEEPTRADE_EXPOSURE_GUARD) && cls === "option") {
    const jdir = L.path.join(dir, "journal");
    const owner = L.lockOwner(input);
    const lock = L.takeOrderLock(jdir, owner);
    if (lock.reason) return deny(`Order lock: ${lock.reason}. Wait a few seconds, read positions and open orders again (they show that order), re-check the plan, then retry.`);
    const reason = exposureCheck(jdir, env, toolInput, lock.staleTs);
    if (reason) {
      L.releaseOrderLock(jdir, owner);
      return deny(reason);
    }
    notes.push("Exposure guard passed. The order lock is held until this order is recorded.");
  }

  L.emit(ctx(notes));
}

// DEEPTRADE_EXPOSURE_GUARD: DEEPTRADE_MAX_POSITIONS and one open or pending
// long position per direction (call or put) across every agent on the account.
function exposureCheck(jdir, env, toolInput, notBefore) {
  const legs = L.optionLegs(toolInput);
  if (String(toolInput.time_in_force || "gfd").toLowerCase() !== "gfd") return "DEEPTRADE_EXPOSURE_GUARD is on and this entry is not a day order. The guard reads only today's orders, so entries must use time_in_force gfd. Entry refused.";
  if (legs.length !== 1) return "DEEPTRADE_EXPOSURE_GUARD is on and this entry has more than one leg. The guard checks single-leg entries only, which is all the shipped strategies trade. Entry refused.";
  const ex = L.optionExposure(jdir, toolInput.account_number, notBefore);
  if (ex.error) return `DEEPTRADE_EXPOSURE_GUARD is on and the gate cannot see current option exposure: ${ex.error}. Call get_option_positions (account_number and nonzero: true) and get_option_orders (account_number and created_at_gte = today's date) for this account, in one message, then retry.`;
  const unknown = ex.exposures.filter((e) => !e.direction).map((e) => e.option_id);
  if (unknown.length) return `DEEPTRADE_EXPOSURE_GUARD is on and the gate does not know whether open contract(s) ${unknown.join(", ")} are calls or puts. Look them up with get_option_instruments, then retry.`;
  const maxPos = L.num(L.planSettings(env).DEEPTRADE_MAX_POSITIONS.value);
  const open = ex.exposures.length;
  if (maxPos !== null && open + 1 > maxPos) return `DEEPTRADE_MAX_POSITIONS=${maxPos} and the account already has ${open} open or pending option position(s) across all agents. Entry refused. Exits still work.`;
  const dir1 = ex.types[String(legs[0].option_id || "")];
  if (!dir1) return "DEEPTRADE_EXPOSURE_GUARD is on and the gate does not know whether this contract is a call or a put. Look it up with get_option_instruments, then retry.";
  const same = ex.exposures.filter((e) => e.direction === dir1);
  if (same.length) return `DEEPTRADE_EXPOSURE_GUARD: the account already has an open or pending ${dir1} position (${same.map((e) => e.symbol || e.option_id).join(", ")}), held by this or another agent. One position per direction. Entry refused; a ${dir1 === "call" ? "put" : "call"} entry or an exit is still possible.`;
  return null;
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

// The order tools can be allowed without a prompt, so a crash must not let an
// unchecked entry through: refuse anything that is not clearly an exit.
let lastInput = null;
try {
  main();
} catch (err) {
  let opening = true;
  try {
    const name = String((lastInput && lastInput.tool_name) || "");
    const ti = lastInput && lastInput.tool_input && typeof lastInput.tool_input === "object" ? lastInput.tool_input : {};
    const kind = L.classifyTool(name);
    if (kind === "read" || kind === "cancel") opening = false;
    else if (kind === "order" && L.isReducing(name, ti, true)) opening = false;
  } catch {
    /* classify failed: stay closed */
  }
  L.emit({
    hookSpecificOutput: opening
      ? { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `DeepTrade risk gate crashed and could not check this order's limits: ${err && err.message}. Entry refused. Exits and cancels still work. Tell the user.` }
      : { hookEventName: "PreToolUse", additionalContext: `DeepTrade risk gate crashed: ${err && err.message}. This looked like an exit or a read and was not blocked. Tell the user.` },
  });
}
