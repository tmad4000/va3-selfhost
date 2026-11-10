import { workPhase } from "./routing.js";
// Multi-agent dispatch: one fresh worker agent per independent ask, launched
// in parallel, each with its own durable receipt and its own checklist ask.
//
// Why (2026-11-06, conversation session-b76adc83): every independent ask went
// through ask_agent into the conversation's single prime agent, so four
// unrelated asks queued behind each other in one agent and two were tracked
// but never dispatched at all. The prime agent stays the conversation's
// follow-up partner; independent work fans out here (the realtime model calls
// dispatch_agents; a prime agent calls the same tool through bin/va3-dispatch).
//
// Guarantees:
//   - Bounded: at most VA3_DISPATCH_MAX_TASKS (6) tasks per call; at most
//     VA3_LAUNCH_CONCURRENCY (3) agent launches at once SERVER-WIDE (one gate
//     shared by every call, conversation, dispatch_agents and
//     spawn_coding_agent); at most VA3_DISPATCH_MAX_PER_WINDOW (12) launch
//     attempts per conversation per VA3_DISPATCH_WINDOW_MS (10 min), counting
//     replaced attempts, checked in the same synchronous step that writes the
//     "launching" receipt.
//   - Durable receipts: DATA_DIR/dispatch/<conversation>.jsonl, append-only,
//     one full snapshot per line, folded by receipt id (last wins), single
//     writer (this module). Written as "launching" BEFORE the launch.
//   - Ownership: each task owns one ask in the conversation's ask ledger
//     (the given ask_id, a new ask in its words, or for sub-tasks of one ask
//     a child ask each). The launched agent becomes its owner.
//   - Partial failure: tasks are independent; one failure never stops or
//     discards the others. The call reports every task's own state.
//   - No duplicate launches: identity (explicit key, ask_id, or text + scope
//     + source turn within VA3_DISPATCH_DEDUPE_MS) and scope (host, cwd,
//     provider, gui, model) are separate; a repeat with a standing receipt
//     returns it, a scope mismatch is a conflict, a concurrent repeat joins
//     the in-flight launch. Only a launch with positive evidence that nothing
//     ran is "failed" and retried; anything that may have started an agent
//     is "unknown", a permission/trust rejection is "blocked", and neither is
//     relaunched without replace: true.
//   - Same safety as spawn_coding_agent: agents go through spawnAgent (host
//     allowlist, default permission mode, Downloads-cwd redirect, one-shot
//     tmux fallback only when Paseo definitely started nothing, never after an
//     ambiguous or gated Paseo failure; trust prompts are never answered).
//     This tool takes no mode, so it can never widen permissions.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, env } from "./env.js";
import { loadAgentDb, spawnAgent } from "./agents.js";
import { createAsk, getAsk, isPlanning, linkDelegation, resolveSourceRow, updateAsk } from "./asks.js";
import { localHost } from "./host.js";

const SESSION_RE = /^[A-Za-z0-9_-]{8,100}$/;
export const DISPATCH_STATES = Object.freeze(["launching", "launched", "failed", "unknown", "blocked", "stubbed"]);
// Receipts that mean "an agent exists or may exist, or a gate stopped it":
// never launch over them without replace. Only "failed" (definitely nothing
// running, no gate) is retried automatically.
const STANDING = new Set(["launching", "launched", "unknown", "blocked", "stubbed"]);

const num = (name, fallback) => {
  const n = Number(env(name, String(fallback)));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};
export function dispatchLimits() {
  return {
    maxTasks: Math.max(1, num("VA3_DISPATCH_MAX_TASKS", 6)),
    // Server-wide: agent launches from every call and conversation share it
    // (the M4 has 16 GB; each launch starts a heavy CLI).
    launchConcurrency: Math.max(1, num("VA3_LAUNCH_CONCURRENCY", 3)),
    maxPerWindow: Math.max(1, num("VA3_DISPATCH_MAX_PER_WINDOW", 12)),
    windowMs: num("VA3_DISPATCH_WINDOW_MS", 600_000),
    dedupeMs: num("VA3_DISPATCH_DEDUPE_MS", 1_800_000),
    // spawn_coding_agent's guard only catches retries, so its window is short.
    spawnDedupeMs: num("VA3_SPAWN_DEDUPE_MS", 300_000),
    // A "launching" receipt older than this with no launch in flight in this
    // process was interrupted (server restart mid-launch).
    launchStaleMs: num("VA3_DISPATCH_LAUNCH_STALE_MS", 180_000),
    // replace: true within this long of the receipt it would supersede is a
    // retry of the same replace, not a new request.
    replaceSettleMs: num("VA3_DISPATCH_REPLACE_SETTLE_MS", 60_000),
  };
}

// ---------- server-wide launch gate ----------
// One FIFO gate for every worker launch (dispatch_agents and
// spawn_coding_agent, any conversation): at most launchConcurrency spawnAgent
// calls at once. Receipts are written before waiting, so a queued launch
// already deduplicates.
const gate = { active: 0, waiters: [] };
export async function withLaunchSlot(fn) {
  while (gate.active >= dispatchLimits().launchConcurrency) await new Promise((resolve) => gate.waiters.push(resolve));
  gate.active += 1;
  try {
    return await fn();
  } finally {
    gate.active -= 1;
    gate.waiters.shift()?.();
  }
}
export function launchGateStats() {
  return { active: gate.active, waiting: gate.waiters.length, limit: dispatchLimits().launchConcurrency };
}

// ---------- ledger ----------
function ledgerPath(sessionId) {
  const id = String(sessionId || "");
  if (!SESSION_RE.test(id)) throw new Error("Invalid conversation session id");
  return join(DATA_DIR, "dispatch", `${id}.jsonl`);
}

function readReceipts(sessionId) {
  const file = ledgerPath(sessionId);
  if (!existsSync(file)) return [];
  const byId = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; } // a torn last line costs one update
    if (row?.id) byId.set(row.id, row);
  }
  return [...byId.values()];
}

function writeReceipt(sessionId, receipt) {
  mkdirSync(join(DATA_DIR, "dispatch"), { recursive: true });
  const row = { ...receipt, updated_at: new Date().toISOString() };
  appendFileSync(ledgerPath(sessionId), `${JSON.stringify(row)}\n`);
  return row;
}

// Receipts for a conversation, newest first.
export function listDispatches(sessionId, { limit = 50 } = {}) {
  if (!SESSION_RE.test(String(sessionId || ""))) return [];
  return readReceipts(sessionId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, limit);
}

// ---------- identity ----------
// A task's identity is WHICH request it is; its scope is WHERE and HOW it
// runs. Identity, most stable first:
//   explicit key  k:<ask_id>:<key>   (sub-tasks of one ask)
//   ask_id        ask:<ask_id>       (a rephrased retry of the same ask is
//                                     the same task)
//   text          h:<text+scope+source turn>  (only within the dedupe
//                                     window; Jacob repeating himself in a
//                                     new turn is a new request)
// A retry whose identity matches but whose scope differs is a conflict,
// reported and never launched without replace.
function normalizedText(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function taskScope(task) {
  return hash([
    task.host || localHost().id,
    task.cwd || "",
    task.provider || "",
    task.gui === undefined ? "" : String(task.gui),
    task.model || "",
    task.mode || "",
    ...(task.phase === "planning" ? ["planning"] : []),
  ]).slice(0, 16);
}
export function dispatchKey(task, { sourceRowId = null } = {}) {
  const scope = taskScope(task);
  if (task.key) return { key: `k:${task.ask_id || task.parent_ask_id || ""}:${task.key}`, kind: "explicit", scope };
  if (task.ask_id) return { key: `ask:${task.ask_id}`, kind: "ask", scope };
  return { key: `h:${hash([normalizedText(task.task), scope, sourceRowId || ""]).slice(0, 24)}`, kind: "text", scope };
}
function currentSourceRow(sessionId) {
  try { return resolveSourceRow(sessionId)?.id || null; } catch { return null; }
}

function newest(receipts, key, pred) {
  return receipts
    .filter((r) => r.key === key && !r.superseded_by && pred(r))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
}
// The receipt that answers a repeat of this key, or null to launch: the
// newest standing one. A failed launch never answers (nothing is running
// from it), and never hides an older live agent.
function standingReceipt(receipts, keyInfo, now, windowMs) {
  const live = newest(receipts, keyInfo.key, (r) => STANDING.has(r.state));
  if (!live) return null;
  if (keyInfo.kind === "text" && ["launched", "stubbed"].includes(live.state)
    && now - Date.parse(live.created_at) > windowMs) return null;
  return live;
}
function latestFailed(receipts, key) {
  return newest(receipts, key, (r) => r.state === "failed");
}

// Launch attempts counted against the per-conversation window: every receipt
// (dispatch or spawn, superseded or not) except launches that definitely
// started nothing.
function launchesInWindow(receipts, now, windowMs) {
  return receipts.filter((r) => r.state !== "failed" && now - Date.parse(r.created_at) < windowMs).length;
}

// ---------- launch outcome ----------
// spawnAgent's record -> receipt.
//   launched / stubbed
//   unknown - may have created an agent: Paseo's outcome was ambiguous
//             (timeout, accepted but unconfirmed), or the agent exists in
//             Paseo without having been seen in its error state. Never
//             retried automatically.
//   blocked - a permission or trust rejection: Jacob's gate, not retried.
//   failed  - definitely nothing running: retried on the next call.
export { launchedPatch as receiptFromLaunch };
function launchedPatch(receipt, record) {
  const failed = record.status === "failed";
  const gated = failed && record.launch_outcome === "gated";
  const maybeCreated = failed && !gated && (record.launch_outcome === "ambiguous"
    || /timed out|timeout/i.test(`${record.launch_error || ""} ${record.error || ""}`)
    || (Boolean(record.external_id || record.paseo_failed_agent) && !record.paseo_error_state));
  const state = !failed ? (record.status === "stubbed" ? "stubbed" : "launched") : gated ? "blocked" : maybeCreated ? "unknown" : "failed";
  return {
    ...receipt,
    state,
    agent_id: record.id || null,
    paseo_agent: record.provider === "paseo" ? record.external_id || null : null,
    transport: record.provider || null,
    provider: record.agent_provider || null,
    model: record.model || null,
    host: record.host || null,
    launched_at: failed ? null : new Date().toISOString(),
    ...(failed ? { error: String(record.error || "launch failed").slice(0, 600) } : {}),
    ...(maybeCreated ? { note: "Paseo may have started this agent even though the launch reported an error. Not retried automatically." } : {}),
    ...(gated ? { note: "A permission or trust rejection stopped this launch. It is Jacob's decision; not retried automatically." } : {}),
    ...(record.warning ? { warning: String(record.warning).slice(0, 300) } : {}),
  };
}
// A throw out of spawnAgent: "failed" only with positive evidence that
// nothing ran (tagged prelaunch); anything else may follow a real launch.
function thrownOutcome(receipt, error) {
  const message = String(error?.message || error).slice(0, 600);
  if (error?.prelaunch) return { ...receipt, state: "failed", error: message };
  const rec = error?.launchRecord || {};
  return {
    ...receipt,
    state: "unknown",
    agent_id: rec.id || null,
    paseo_agent: rec.provider === "paseo" ? rec.external_id || null : null,
    host: rec.host || null,
    error: `The launch threw after it may have started an agent: ${message}`,
    note: "Not retried automatically. Check check_agents; if nothing is running, dispatch it again with replace: true.",
  };
}

// Point the receipt's ask at its outcome. `previousLive`: an older agent for
// this ask may still be running (a failed replace must not fail the ask).
function settleAsk(sessionId, receipt, { previousLive = false } = {}) {
  if (!receipt.ask_id) return receipt;
  try {
    const ask = getAsk(sessionId, receipt.ask_id);
    if (!ask) return receipt;
    if (receipt.state === "launched" || receipt.state === "stubbed") {
      linkDelegation(sessionId, { askId: receipt.ask_id, agentId: receipt.agent_id, externalId: receipt.paseo_agent, label: receipt.title });
      if (["failed", "blocked", "open"].includes(getAsk(sessionId, receipt.ask_id).state) || ask.remaining === "Dispatching an agent.") {
        updateAsk(sessionId, receipt.ask_id, { state: "in_progress", remaining: `Agent ${receipt.agent_id} is working on it.` }, { origin: "dispatch" });
      }
    } else if (previousLive) {
      // A failed or unclear replacement: the earlier agent may still work.
    } else if (receipt.state === "unknown") {
      updateAsk(sessionId, receipt.ask_id, { state: "blocked", remaining: `The launch outcome is unknown (${String(receipt.error || "interrupted").slice(0, 200)}). Check check_agents; if nothing is running, dispatch it again with replace: true.` }, { origin: "dispatch" });
    } else if (receipt.state === "blocked") {
      updateAsk(sessionId, receipt.ask_id, { state: "blocked", remaining: `Stopped by a permission or trust gate: ${String(receipt.error || "").slice(0, 200)}. Jacob decides; after that, dispatch it again with replace: true.` }, { origin: "dispatch" });
    } else if (receipt.state === "failed") {
      updateAsk(sessionId, receipt.ask_id, { state: "failed", evidence: `Agent launch failed: ${receipt.error}`, remaining: "Retry the dispatch (safe: nothing is running) or reassign." }, { origin: "dispatch" });
    }
  } catch (error) {
    return writeReceipt(sessionId, { ...receipt, ask_error: String(error.message || error).slice(0, 300) });
  }
  return receipt;
}

// A "launching" receipt with no launch in flight here: find the agent by its
// dispatch label (spawnAgent saved the record) or, once stale, call it
// unknown. Either way its ask is brought up to date.
function reconcile(sessionId, receipt, now, limits) {
  if (receipt.state !== "launching") return receipt;
  const record = (loadAgentDb().sessions || []).find((r) => (r.labels || []).includes(`va3_dispatch=${receipt.id}`));
  if (record) return settleAsk(sessionId, writeReceipt(sessionId, launchedPatch(receipt, record)));
  if (now - Date.parse(receipt.started_at || receipt.created_at) < limits.launchStaleMs) return receipt;
  return settleAsk(sessionId, writeReceipt(sessionId, {
    ...receipt,
    state: "unknown",
    error: "The launch was interrupted (the server restarted mid-launch); an agent may or may not be running.",
  }));
}

// ---------- input ----------
const TASK_FIELDS = ["task", "title", "host", "cwd", "provider", "model", "phase", "gui", "ask_id", "key", "replace"];

// Throws a retry-safe input error (the caller's ToolInputError) on any bad
// task, before anything runs. Nothing is guessed or repaired: a malformed
// task refuses the whole call.
export function validateDispatchTasks(args, { InputError = Error, hosts = null, maxChars = 20_000 } = {}) {
  const limits = dispatchLimits();
  const tasks = args.tasks;
  const tool = "dispatch_agents";
  if (!Array.isArray(tasks) || !tasks.length) {
    throw new InputError(`${tool}: "tasks" is required, as a non-empty array of {task, title} objects, one per independent ask.`);
  }
  if (tasks.length > limits.maxTasks) {
    throw new InputError(`${tool}: ${tasks.length} tasks; the limit is ${limits.maxTasks} per call. Send the most important ${limits.maxTasks} first and the rest in a second call.`);
  }
  const out = tasks.map((item, i) => {
    const at = `${tool}: tasks[${i}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new InputError(`${at} must be an object with a "task" string.`);
    if (Object.hasOwn(item, "mode")) throw new InputError(`${at}: dispatch_agents does not take a permission mode; agents start in the default mode. Use spawn_coding_agent when Jacob asks for a specific mode.`);
    const unknown = Object.keys(item).filter((k) => !TASK_FIELDS.includes(k));
    if (unknown.length) throw new InputError(`${at}: unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}.`);
    const text = typeof item.task === "string" ? item.task.trim() : "";
    if (!text) throw new InputError(`${at}: "task" is required, as a non-empty string.`);
    if (text.length > maxChars) throw new InputError(`${at}: "task" is ${text.length} characters; the limit is ${maxChars}.`);
    for (const f of ["title", "host", "cwd", "provider", "model", "ask_id", "key"]) {
      if (item[f] !== undefined && item[f] !== null && typeof item[f] !== "string") throw new InputError(`${at}: "${f}" must be a string.`);
    }
    for (const f of ["gui", "replace"]) {
      if (item[f] !== undefined && item[f] !== null && typeof item[f] !== "boolean") throw new InputError(`${at}: "${f}" must be true or false.`);
    }
    const provider = item.provider ? item.provider.toLowerCase() : undefined;
    if (provider && !["claude", "codex"].includes(provider)) throw new InputError(`${at}: "provider" must be claude or codex.`);
    if (item.host && hosts && !hosts.includes(item.host)) throw new InputError(`${at}: unknown host ${item.host}; use one of ${hosts.join(", ")}.`);
    if (item.key && item.key.length > 120) throw new InputError(`${at}: "key" is at most 120 characters.`);
    return {
      task: text,
      title: item.title?.trim() || undefined,
      host: item.host || undefined,
      cwd: item.cwd || undefined,
      provider,
      model: item.model || undefined,
      phase: workPhase(item.phase),
      gui: typeof item.gui === "boolean" ? item.gui : undefined,
      ask_id: item.ask_id || undefined,
      key: item.key || undefined,
      replace: item.replace === true,
    };
  });
  // One ask_id on several tasks: they are sub-tasks. Each needs its own key
  // (its retry identity) and gets its own ask; the given ask is their parent.
  const byAsk = new Map();
  out.forEach((t, i) => { if (t.ask_id) byAsk.set(t.ask_id, [...(byAsk.get(t.ask_id) || []), i]); });
  for (const [askId, idx] of byAsk) {
    if (idx.length < 2) continue;
    const keys = idx.map((i) => out[i].key);
    if (keys.some((k) => !k) || new Set(keys).size !== keys.length) {
      throw new InputError(`${tool}: tasks ${idx.map((i) => `[${i}]`).join(", ")} share ask_id ${askId}. Give each sub-task its own ask (track_ask) or its own distinct "key"; nothing ran.`);
    }
    for (const i of idx) { out[i].parent_ask_id = askId; out[i].ask_id = undefined; }
  }
  return out;
}

// ---------- launching ----------
const inflight = new Map(); // `${session}|${key}` -> Promise<receipt>

// Start `launch` as the one in-flight launch for this key; the map entry is
// removed only by the launch that owns it.
function fly(flightKey, launch) {
  const p = launch.finally(() => { if (inflight.get(flightKey) === p) inflight.delete(flightKey); });
  inflight.set(flightKey, p);
  return p;
}

function askTextFor(task) {
  return task.title && task.title.length >= 12 ? task.title : task.task.split("\n")[0].slice(0, 300);
}

// Find or create the ask this task owns. Never fails the launch: a ledger
// problem is recorded on the receipt instead.
function ownAsk(sessionId, task) {
  try {
    if (task.ask_id && getAsk(sessionId, task.ask_id)) return { ask_id: task.ask_id };
    const parent = task.parent_ask_id ? getAsk(sessionId, task.parent_ask_id) : null;
    const text = parent ? `${parent.text} — ${askTextFor(task)}`.slice(0, 2_000) : askTextFor(task);
    const ask = createAsk(sessionId, {
      text, origin: "dispatch", remaining: "Dispatching an agent.",
      ...(parent ? { sourceRowId: parent.source_row_id } : {}),
    });
    return {
      ask_id: ask.id,
      ...(parent ? { parent_ask_id: parent.id } : {}),
      ...(task.ask_id ? { ask_error: `No ask ${task.ask_id} in this conversation; created a new one.` } : {}),
    };
  } catch (error) {
    return { ask_error: String(error.message || error).slice(0, 300) };
  }
}

// Synchronous up to the gate: the "launching" receipt exists before any
// other call can look at this key again.
async function launchTask(sessionId, task, keyInfo, { transport, previous }) {
  const now = new Date().toISOString();
  const replacing = previous && previous.state !== "failed";
  let receipt = writeReceipt(sessionId, {
    id: `dsp-${randomUUID().slice(0, 8)}`,
    session_id: sessionId,
    key: keyInfo.key,
    key_kind: keyInfo.kind,
    scope: keyInfo.scope,
    title: String(task.title || task.task.split("\n")[0]).slice(0, 120),
    task_chars: task.task.length,
    state: "launching",
    attempt: (previous?.state === "failed" ? Number(previous.attempt || 1) : 0) + 1,
    ...(replacing ? { replaces: previous.id } : {}),
    ...(previous?.state === "failed" ? { retry_of: previous.id } : {}),
    created_at: now,
    started_at: now,
  });
  receipt = writeReceipt(sessionId, { ...receipt, ...ownAsk(sessionId, { ...task, ask_id: task.ask_id || previous?.ask_id }) });

  let outcome;
  try {
    const record = await withLaunchSlot(() => {
      const planning = planningAskIds(sessionId, [{ ask_id: receipt.ask_id, parent_ask_id: receipt.parent_ask_id || task.parent_ask_id || previous?.parent_ask_id }]);
      if (planning.length) throw Object.assign(new Error(`Ask ${planning.join(", ")} is saved as planning; nothing ran.`), { prelaunch: true, planning: true });
      return spawnAgent({
      task: task.task,
      title: task.title,
      host: task.host,
      cwd: task.cwd,
      provider: task.provider,
      model: task.model,
      phase: task.phase,
      gui: task.gui,
      sessionId,
      labels: [`va3_dispatch=${receipt.id}`],
      transport,
      });
    });
    outcome = launchedPatch(receipt, record);
  } catch (error) {
    outcome = thrownOutcome(receipt, error);
    if (error?.planning) outcome = { ...outcome, prelaunch: true, nothing_ran: true, retry_safe: true };
  }
  // From here an agent may exist: a ledger failure must not turn into
  // "failed" (which invites a retry). The label lets reconcile recover it.
  try {
    receipt = writeReceipt(sessionId, outcome);
    // A replacement supersedes the old receipt only once it exists (or may):
    // a definitely failed replace leaves the old agent's receipt standing.
    if (replacing && outcome.state !== "failed") {
      const current = readReceipts(sessionId).find((r) => r.id === previous.id) || previous;
      writeReceipt(sessionId, { ...current, superseded_by: receipt.id });
    }
  } catch (error) {
    return { ...outcome, ledger_error: String(error.message || error).slice(0, 300) };
  }
  return receipt.prelaunch ? receipt : settleAsk(sessionId, receipt, { previousLive: replacing });
}

function present(index, receipt, extra = {}) {
  return {
    index,
    receipt_id: receipt.id,
    key: receipt.key,
    state: receipt.state,
    title: receipt.title,
    ...(receipt.agent_id ? { agent_id: receipt.agent_id } : {}),
    ...(receipt.paseo_agent ? { paseo_agent: receipt.paseo_agent } : {}),
    ...(receipt.host ? { host: receipt.host } : {}),
    ...(receipt.provider ? { provider: receipt.provider } : {}),
    ...(receipt.ask_id ? { ask_id: receipt.ask_id } : {}),
    ...(receipt.parent_ask_id ? { parent_ask_id: receipt.parent_ask_id } : {}),
    attempt: receipt.attempt || 1,
    ...(receipt.error ? { error: receipt.error } : {}),
    ...(receipt.prelaunch ? { prelaunch: true, nothing_ran: true, retry_safe: true } : {}),
    ...(receipt.note && !extra.note ? { note: receipt.note } : {}),
    ...(receipt.warning ? { warning: receipt.warning } : {}),
    ...(receipt.ask_error ? { ask_error: receipt.ask_error } : {}),
    ...(receipt.ledger_error ? { ledger_error: receipt.ledger_error } : {}),
    ...extra,
  };
}

const DUPLICATE_NOTES = {
  launching: "A launch for this task started moments ago; not launched again. Check list_asks shortly.",
  unknown: "An earlier launch of this task may already have created an agent, so it was not relaunched. Check check_agents; if nothing is running, dispatch it again with replace: true.",
  blocked: "The last launch of this task was stopped by a permission or trust gate. It is not retried automatically; once Jacob has decided, dispatch it again with replace: true.",
};

// One task: answer from a standing receipt, join an in-flight launch, or
// launch. Everything from the checks to the "launching" receipt runs in one
// synchronous step, so overlapping calls cannot both launch or both spend
// the last rate-window slot.
async function dispatchOne(sessionId, task, index, { transport, limits, sourceRowId }) {
  const keyInfo = dispatchKey(task, { sourceRowId });
  const flightKey = `${sessionId}|${keyInfo.key}`;
  const flying = inflight.get(flightKey);
  if (flying) return present(index, await flying, { duplicate: true, note: "Already being launched by an earlier call; not launched again." });

  const now = Date.now();
  const receipts = readReceipts(sessionId);
  let standing = standingReceipt(receipts, keyInfo, now, limits.dedupeMs);
  if (standing) standing = reconcile(sessionId, standing, now, limits);
  if (standing && !task.replace && standing.scope && standing.scope !== keyInfo.scope) {
    return { ...present(index, standing), state: "conflict", nothing_ran: true,
      error: `This ask is already dispatched (receipt ${standing.id}, ${standing.state}) with a different host, directory, provider or model. Not launched. To run it there instead, send it again with replace: true; for an additional sub-task, give it its own ask or key.` };
  }
  if (standing && task.replace && now - Date.parse(standing.created_at) < limits.replaceSettleMs) {
    return present(index, standing, { duplicate: true, note: "This task was launched less than a minute ago; replace was not applied again." });
  }
  if (standing && !task.replace) {
    return present(index, standing, { duplicate: true, note: DUPLICATE_NOTES[standing.state] || `Already dispatched (receipt ${standing.id}); not launched again.` });
  }
  if (launchesInWindow(receipts, now, limits.windowMs) >= limits.maxPerWindow) {
    return { index, state: "not_launched", title: String(task.title || task.task).slice(0, 120), key: keyInfo.key, nothing_ran: true,
      error: `Rate limit: at most ${limits.maxPerWindow} launches per conversation in ${Math.round(limits.windowMs / 60_000)} minutes. Nothing ran for this task; send it again later.` };
  }
  // replace supersedes the standing receipt; a definitely failed launch is
  // retried as its next attempt.
  const previous = standing && task.replace ? standing : (!standing && latestFailed(receipts, keyInfo.key)) || null;
  return present(index, await fly(flightKey, launchTask(sessionId, task, keyInfo, { transport, previous })));
}

// The dispatch_agents tool. `tasks` must already be validated.
// Planning asks are saved ideas, not work: dispatch never launches for one
// (directly or as the parent of sub-tasks). Returns the offending ask ids.
export function planningAskIds(sessionId, tasks = []) {
  const ids = new Set();
  for (const t of tasks) {
    for (const id of [t.ask_id, t.parent_ask_id]) {
      if (!id) continue;
      try { if (isPlanning(getAsk(sessionId, id))) ids.add(id); } catch { /* not a ledger id */ }
    }
  }
  return [...ids];
}

export async function dispatchAgents({ sessionId, tasks, transport }) {
  if (!SESSION_RE.test(String(sessionId || ""))) throw new Error("No conversation is active; dispatch receipts need a conversation.");
  const planning = planningAskIds(sessionId, tasks);
  if (planning.length) throw Object.assign(new Error(`Ask ${planning.join(", ")} is saved as planning (not actionable); nothing ran. If Jacob wants it worked on now, update_ask it to open first.`), { retry_safe: true, planning });
  const limits = dispatchLimits();
  const sourceRowId = currentSourceRow(sessionId);

  // The same key twice in one call is one task.
  const seen = new Map();
  const unique = [];
  const aliasOf = [];
  tasks.forEach((task, i) => {
    const { key } = dispatchKey(task, { sourceRowId });
    if (seen.has(key)) { aliasOf[i] = seen.get(key); return; }
    seen.set(key, i);
    unique.push(i);
  });
  // All tasks start together; the server-wide launch gate bounds how many
  // agents actually launch at once.
  const settled = await Promise.allSettled(unique.map((i) => dispatchOne(sessionId, tasks[i], i, { transport, limits, sourceRowId })));
  const rows = new Array(tasks.length);
  unique.forEach((i, n) => {
    const r = settled[n];
    // An unexpected throw after the receipt was written may have launched an
    // agent: "unknown" (the label lets a later call reconcile it).
    rows[i] = r.status === "fulfilled" ? r.value : { index: i, state: "unknown", title: String(tasks[i].title || tasks[i].task).slice(0, 120), error: String(r.reason?.message || r.reason).slice(0, 600) };
  });
  aliasOf.forEach((first, i) => {
    if (first === undefined) return;
    const { receipt_id, agent_id, ask_id, state, title } = rows[first];
    rows[i] = { index: i, duplicate_of: first, state, title, ...(receipt_id ? { receipt_id } : {}), ...(agent_id ? { agent_id } : {}), ...(ask_id ? { ask_id } : {}), note: `Same task as tasks[${first}] in this call; handled once.` };
  });

  // Sub-tasks of one ask: the parent says what it was split into.
  const parents = new Map();
  for (const i of unique) if (rows[i].parent_ask_id && rows[i].ask_id) parents.set(rows[i].parent_ask_id, [...(parents.get(rows[i].parent_ask_id) || []), rows[i].ask_id]);
  for (const [parentId, children] of parents) {
    try {
      const parent = getAsk(sessionId, parentId);
      if (parent && parent.state !== "done" && !isPlanning(parent)) updateAsk(sessionId, parentId, { state: "in_progress", remaining: `Split into sub-tasks: ${children.join(", ")}.` }, { origin: "dispatch" });
    } catch { /* the sub-tasks still own their own asks */ }
  }

  const own = unique.map((i) => rows[i]);
  const count = (pred) => own.filter(pred).length;
  const summary = {
    launched: count((r) => ["launched", "stubbed"].includes(r.state) && !r.duplicate),
    already_running: count((r) => r.duplicate && ["launching", "launched", "stubbed"].includes(r.state)),
    failed: count((r) => r.state === "failed"),
    unknown: count((r) => r.state === "unknown"),
    blocked: count((r) => r.state === "blocked"),
    not_launched: count((r) => ["not_launched", "conflict"].includes(r.state)),
  };
  return {
    ok: true,
    partial: summary.failed + summary.unknown + summary.blocked + summary.not_launched > 0 && summary.launched + summary.already_running > 0,
    ...summary,
    tasks: rows,
    note: "Each launched agent works independently and reports its own [Agent update]; its ask on the checklist is owned by it. A launch is not a result.",
  };
}

// spawn_coding_agent's retry guard, on the same ledger, in-flight map and
// launch gate: the same launch (text, scope incl. mode, source turn) in the
// same conversation within VA3_SPAWN_DEDUPE_MS returns the agent already
// started (or joins its in-flight launch) instead of a second one. `launch`
// runs spawnAgent with the given labels. Returns { record } for a new launch
// or { duplicate, receipt }.
export async function spawnOnce(sessionId, input, launch) {
  if (!SESSION_RE.test(String(sessionId || ""))) return { record: await withLaunchSlot(() => launch([])) };
  const limits = dispatchLimits();
  const keyInfo = dispatchKey({ ...input, key: undefined, ask_id: undefined }, { sourceRowId: currentSourceRow(sessionId) });
  const flightKey = `${sessionId}|${keyInfo.key}`;
  const flying = inflight.get(flightKey);
  if (flying) return { duplicate: true, receipt: await flying };
  const now = Date.now();
  let standing = standingReceipt(readReceipts(sessionId), keyInfo, now, limits.spawnDedupeMs);
  if (standing) standing = reconcile(sessionId, standing, now, limits);
  if (standing) return { duplicate: true, receipt: standing };
  const started = new Date().toISOString();
  const receipt = writeReceipt(sessionId, {
    id: `dsp-${randomUUID().slice(0, 8)}`, session_id: sessionId, key: keyInfo.key, key_kind: keyInfo.kind, scope: keyInfo.scope, via: "spawn_coding_agent",
    title: String(input.title || input.task).slice(0, 120), task_chars: input.task.length, state: "launching", attempt: 1, created_at: started, started_at: started,
  });
  let record;
  const done = fly(flightKey, (async () => {
    try {
      record = await withLaunchSlot(() => launch([`va3_dispatch=${receipt.id}`]));
    } catch (error) {
      const outcome = thrownOutcome(receipt, error);
      try { writeReceipt(sessionId, outcome); } catch { /* reconcile finds it by label */ }
      throw error;
    }
    try { return writeReceipt(sessionId, launchedPatch(receipt, record)); } catch { return launchedPatch(receipt, record); }
  })());
  await done;
  return { record };
}
