// Per-conversation ask ledger: DATA_DIR/transcripts/<session>.asks.jsonl.
//
// Single writer: this module. Each line is a full snapshot of one ask at a
// revision; reading folds lines by id (last wins), so history is kept and a
// torn final line costs at most one update. The ledger is the working view of
// "what Jacob asked for in this conversation" and holds what Paseo Stream does
// not: the transcript row the ask came from, the voice session it belongs to,
// the WIT issue URL when it was filed as feedback, and the owning agent.
//
// Paseo Stream stays the household checklist. When the conversation has a
// Paseo session agent, asks are mirrored to that agent's Stream (set_stream_ask)
// and Stream-side changes are pulled back (list_stream_asks). The mirror is
// best-effort: a Stream failure is recorded on the ask, never lost data here.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, env } from "./env.js";
import { currentVoiceSession, readTranscript } from "./transcripts.js";
import { publishUi } from "./ui-events.js";

const TRANSCRIPTS_DIR = join(DATA_DIR, "transcripts");
const SESSION_RE = /^[A-Za-z0-9_-]{8,100}$/;
// "planning" (2026-11-09): an idea captured on purpose but not actionable yet.
// It is kept and shown (its own Planning group) but is not open work: status
// answers, stuck/agent watchers, dispatch and dashboards skip it, and nothing
// automatic moves it out of planning; only an explicit update_ask does.
export const ASK_STATES = Object.freeze(["open", "in_progress", "blocked", "failed", "done", "planning"]);
// States that are current work. Readers that count or act on "open work" use
// this (or isActionable), never `state !== "done"`, so planning stays out.
export const ACTIONABLE_STATES = Object.freeze(["open", "in_progress", "blocked", "failed"]);
export function isActionable(ask) {
  return ACTIONABLE_STATES.includes(ask?.state);
}
export function isPlanning(ask) {
  return ask?.state === "planning";
}
// A state from older data, another tool or a newer VA3 that this build does
// not know reads as "open" (visible and actionable, never silently dropped);
// the original value is kept on the row as `unknown_state`.
export function readState(value) {
  return ASK_STATES.includes(value) ? value : "open";
}
const KINDS = new Set(["ask", "question"]);
const OWNER_KINDS = new Set(["session_agent", "agent", "assistant", "jacob"]);

function asksPath(sessionId) {
  const id = String(sessionId || "");
  if (!SESSION_RE.test(id)) throw new Error("Invalid conversation session id");
  return join(TRANSCRIPTS_DIR, `${id}.asks.jsonl`);
}

function clip(value, max) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function readLines(sessionId) {
  const file = asksPath(sessionId);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function fold(sessionId) {
  const byId = new Map();
  for (const row of readLines(sessionId)) {
    if (row.state !== undefined && !ASK_STATES.includes(row.state)) byId.set(row.id, { ...row, state: readState(row.state), unknown_state: String(row.state) });
    else byId.set(row.id, row);
  }
  return byId;
}

function persist(sessionId, ask) {
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  appendFileSync(asksPath(sessionId), `${JSON.stringify(ask)}\n`);
  publishUi({ type: "asks_changed", session_id: sessionId, ask_id: ask.id });
  scheduleStreamSync(sessionId);
  return ask;
}

function normalizeOwner(owner) {
  if (!owner) return null;
  const kind = String(owner.kind || "");
  if (!OWNER_KINDS.has(kind)) throw new Error(`owner.kind must be one of ${[...OWNER_KINDS].join(", ")}`);
  return {
    kind,
    id: owner.id ? String(owner.id) : null,
    ...(owner.external_id ? { external_id: String(owner.external_id) } : {}),
    ...(owner.label ? { label: clip(owner.label, 80) } : {}),
  };
}

function normalizeState(state, fallback = "open") {
  const value = String(state || fallback);
  if (!ASK_STATES.includes(value)) throw new Error(`state must be one of ${ASK_STATES.join(", ")}`);
  return value;
}

// The newest user row that contains the quote (or, without a quote, the newest
// user row). "Jump to turn" scrolls to this row.
export function resolveSourceRow(sessionId, quote = "") {
  const rows = readTranscript(sessionId, { limit: 400 }).filter((row) => row.role === "user");
  const needle = String(quote || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
  if (needle) {
    const hit = [...rows].reverse().find((row) => row.text.toLowerCase().replace(/\s+/g, " ").includes(needle));
    if (hit) return hit;
  }
  return rows.at(-1) || null;
}

export function listAsks(sessionId) {
  return [...fold(sessionId).values()].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export function getAsk(sessionId, id) {
  return fold(sessionId).get(String(id || "")) || null;
}

export function createAsk(sessionId, {
  text,
  kind = "ask",
  state = "open",
  sourceRowId,
  sourceQuote,
  voiceSessionId,
  owner,
  evidence = "",
  remaining = "",
  witUrl,
  feedbackId,
  origin = "assistant",
  id,
  unknownState,
} = {}) {
  asksPath(sessionId);
  const body = clip(text, 2_000);
  if (!body) throw new Error("Ask text is required");
  if (!KINDS.has(kind)) throw new Error("kind must be ask or question");
  if (kind === "question" && state === "planning") throw new Error("Questions cannot be saved as planning");
  // sourceRowId: a row id, explicit null (no source, e.g. Stream-only), or
  // undefined (resolve from the newest matching user turn).
  const source = sourceRowId === null ? null
    : sourceRowId ? { id: String(sourceRowId) } : resolveSourceRow(sessionId, sourceQuote || body);
  const now = new Date().toISOString();
  const ask = {
    id: id || `ask-${randomUUID().slice(0, 8)}`,
    session_id: sessionId,
    kind,
    state: normalizeState(state),
    text: body,
    source_row_id: source?.id || null,
    voice_session_id: voiceSessionId || currentVoiceSession(sessionId)?.id || null,
    owner: normalizeOwner(owner),
    evidence: clip(evidence, 4_000),
    remaining: clip(remaining, 4_000),
    wit_url: witUrl ? String(witUrl) : null,
    feedback_id: feedbackId ? String(feedbackId) : null,
    origin,
    created_at: now,
    updated_at: now,
    rev: 1,
    stream: null,
    ...(unknownState !== undefined ? { unknown_state: String(unknownState) } : {}),
  };
  if (ask.state === "done" && !ask.evidence) throw new Error("Marking an ask done needs evidence of the outcome");
  return persist(sessionId, ask);
}

// Patch fields; `expectedRev` guards against overwriting a newer edit.
export function updateAsk(sessionId, id, patch = {}, { expectedRev, origin = "assistant" } = {}) {
  const current = getAsk(sessionId, id);
  if (!current) throw new Error(`No ask ${id} in this conversation`);
  if (expectedRev !== undefined && Number(expectedRev) !== current.rev) {
    throw new Error(`Ask ${id} is at revision ${current.rev}, not ${expectedRev}`);
  }
  const next = { ...current };
  if (patch.state !== undefined) {
    const state = normalizeState(patch.state);
    if (current.kind === "question" && state === "planning") throw new Error("Questions cannot be saved as planning");
    if (current.state !== "planning" || ["assistant", "jacob", "migration"].includes(origin)) next.state = state;
  }
  if (patch.unknownState !== undefined) next.unknown_state = patch.unknownState || undefined;
  if (patch.witPlanning !== undefined) next.wit_planning = patch.witPlanning;
  if (patch.text !== undefined) next.text = clip(patch.text, 2_000) || current.text;
  if (patch.evidence !== undefined) next.evidence = clip(patch.evidence, 4_000);
  if (patch.remaining !== undefined) next.remaining = clip(patch.remaining, 4_000);
  if (current.state === "planning" && next.state !== "planning") {
    next.remaining = stripPlanning(next.remaining);
    if (patch.remaining === undefined && next.remaining === "Saved as planning; not actionable until Jacob asks.") next.remaining = "";
  }
  if (patch.owner !== undefined) next.owner = normalizeOwner(patch.owner);
  if (patch.witUrl !== undefined) next.wit_url = patch.witUrl ? String(patch.witUrl) : null;
  if (patch.feedbackId !== undefined) next.feedback_id = patch.feedbackId ? String(patch.feedbackId) : null;
  if (patch.stream !== undefined) next.stream = patch.stream;
  if ((current.state === "planning") !== (next.state === "planning") && (next.feedback_id || next.wit_url)) {
    next.wit_planning = { planning: next.state === "planning", ok: false, error: "Label update pending", at: new Date().toISOString() };
  }
  if (next.state === "done" && !next.evidence) throw new Error("Marking an ask done needs evidence of the outcome");
  if (next.state === "done" && patch.remaining === undefined) next.remaining = "";
  const changed = ["state", "text", "evidence", "remaining", "owner", "wit_url", "feedback_id", "stream", "unknown_state", "wit_planning"]
    .some((key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
  if (!changed) return current;
  // Stream bookkeeping alone is not a user-visible revision.
  const contentChanged = ["state", "text", "evidence", "remaining", "owner", "wit_url", "feedback_id"]
    .some((key) => JSON.stringify(next[key]) !== JSON.stringify(current[key]));
  next.rev = contentChanged ? current.rev + 1 : current.rev;
  next.updated_at = new Date().toISOString();
  next.last_origin = origin;
  return persist(sessionId, next);
}

// A delegation without an explicit ask: link the newest user turn's ask, or
// create one in Jacob's words from that turn, owned by the agent.
export function linkDelegation(sessionId, { askId, agentId, externalId, ownerKind = "agent", label } = {}) {
  if (!sessionId || !agentId) return null;
  const owner = { kind: ownerKind, id: agentId, external_id: externalId, label };
  if (askId) {
    const ask = getAsk(sessionId, askId);
    if (!ask) return null;
    // A planning ask stays planning: an agent may research it, but only an
    // explicit update_ask makes it actionable work.
    return updateAsk(sessionId, askId, { owner, state: ask.state === "open" ? "in_progress" : ask.state });
  }
  const source = resolveSourceRow(sessionId);
  if (!source) return null;
  const asks = listAsks(sessionId).filter((a) => a.kind === "ask" && a.source_row_id === source.id && !isPlanning(a));
  const unowned = asks.find((a) => !a.owner);
  if (unowned) return updateAsk(sessionId, unowned.id, { owner, state: "in_progress" });
  if (asks.some((a) => a.owner?.id === agentId)) return asks.find((a) => a.owner?.id === agentId);
  return createAsk(sessionId, { text: source.text, sourceRowId: source.id, owner, state: "in_progress", origin: "delegation" });
}

// Agent watcher results (completed / blocked / failed) move the owned asks.
// A finished agent is not a finished ask: it records the reply as evidence and
// leaves done to Jacob or the assistant after checking the outcome.
export function reflectAgentUpdates(sessionId, updates = []) {
  if (!sessionId) return [];
  const touched = [];
  for (const update of updates) {
    // Notices about approvals or a completed handoff say nothing about the
    // ask's outcome (a handoff already moved the asks to the successor).
    if (!["completed", "blocked", "failed", "stuck"].includes(update.state)) continue;
    // Planning asks are not work in flight: an agent finishing, blocking or
    // getting stuck never moves one (or raises a stuck alert for it).
    for (const ask of listAsks(sessionId).filter((a) => a.owner?.id === update.id && isActionable(a))) {
      const reply = clip(update.final_reply || update.error || update.partial_output || "", 600);
      // "blocked" (waiting on Jacob's permission — he can unblock it right
      // now) and "failed" (the agent errored out — needs a retry/reassign,
      // not an approval) used to both land here as "blocked", distinguished
      // only by free-text the UI chip never showed. Agents.js already keeps
      // these as separate states; keep that distinction instead of losing it.
      const patch = update.state === "completed"
        ? { state: "in_progress", evidence: `Agent ${update.id} finished: ${reply || "(no reply text)"}`, remaining: "Check the agent's result, then mark done." }
        : update.state === "blocked"
          ? { state: "blocked", remaining: `Agent ${update.id} is waiting for permission: ${(update.pending_permissions || []).map((p) => p.action || p.tool).join("; ") || "see Threads"}` }
          : update.state === "stuck"
            ? { state: "blocked", remaining: `Agent ${update.id} is stuck: Paseo holds ${update.queued_messages || "its"} queued message(s) while it sits idle, so nobody is doing this.${update.handoff_path ? ` Queue saved at ${update.handoff_path}.` : ""} Hand off with handoff_stuck_agent.` }
          : { state: "failed", evidence: `Agent ${update.id} failed: ${reply || "no details"}`, remaining: "Retry or reassign." };
      touched.push(updateAsk(sessionId, ask.id, patch, { origin: "agent-watcher" }));
    }
  }
  return touched;
}

// ---------- Paseo Stream mirror ----------
// The Paseo daemon's agent MCP endpoint is stateless JSON-RPC over HTTP
// (responses arrive as one SSE message). No bearer token on this daemon.
let sessionAgentResolver = () => null;
export function setSessionAgentResolver(fn) {
  sessionAgentResolver = typeof fn === "function" ? fn : () => null;
}

function streamUrl() {
  return env("VA3_STREAM_MCP_URL", "http://127.0.0.1:6767/mcp/agents");
}

export function streamEnabled() {
  return streamUrl() !== "off";
}

let rpcId = 0;
export async function streamCall(name, args) {
  const res = await fetch(streamUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(8_000),
  });
  const raw = await res.text();
  const payload = raw.trim().startsWith("{")
    ? raw
    : raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  let message;
  try { message = JSON.parse(payload); } catch { throw new Error(`Stream MCP returned HTTP ${res.status} without JSON`); }
  if (message.error) throw new Error(`Stream MCP error: ${message.error.message || message.error.code}`);
  const text = (message.result?.content || []).map((c) => c.text || "").join("\n");
  if (message.result?.isError) throw new Error(`Stream: ${clip(text, 300)}`);
  // Paseo prefixes a short summary before the JSON body.
  const start = text.indexOf("{");
  if (start < 0) return { text };
  try { return JSON.parse(text.slice(start)); } catch { return { text }; }
}

const streamMeta = new Map(); // session -> { agent_id, synced_at, error, pulled_at }
export function streamStatus(sessionId) {
  return streamMeta.get(sessionId) || null;
}

const timers = new Map();
function scheduleStreamSync(sessionId) {
  if (!streamEnabled() || syncing.has(sessionId) || timers.has(sessionId)) return;
  const timer = setTimeout(() => {
    timers.delete(sessionId);
    syncStream(sessionId).catch(() => {});
  }, 400);
  timer.unref?.();
  timers.set(sessionId, timer);
}

// Paseo Stream accepts open / in_progress / blocked / done. A local "failed"
// ask (the agent or its launch failed; it needs a retry or reassignment) is
// mirrored as "blocked" with the failure spelled out, and a Stream "blocked"
// coming back never turns a local failure into a mere block (pullStreamRow).
// Local failure semantics are unchanged. (2026-11-06: ask-a25024bc, failed
// since 2026-11-02, never synced because "failed" was sent as the state.)
// Stream has no planning state either: a planning ask is mirrored as "open"
// with remaining starting PLANNING_PREFIX, and a Stream "open" coming back
// keeps the local planning state. A Stream-only ask whose remaining starts
// with that marker (the pre-2026-11-09 workaround) is read as planning.
export function streamState(state) {
  if (state === "failed") return "blocked";
  if (state === "planning") return "open";
  return ASK_STATES.includes(state) ? state : "open";
}
const FAILED_PREFIX = "Failed in VA3:";
export const PLANNING_PREFIX = "PLANNING — NOT ACTIONABLE:";
const PLANNING_RE = /^\s*planning\s*[—–-]+\s*not actionable\b[:.\s—–-]*/i;
export function planningMarked(text) {
  return typeof text === "string" && PLANNING_RE.test(text);
}
export function stripPlanning(text) {
  return planningMarked(text) ? text.replace(PLANNING_RE, "").trim() : text;
}
// set_stream_ask is a full replacement: fields VA3 does not own (subtasks,
// linked sessions, a Stream-side source or delegation) are kept from the last
// pull (ask.stream.remote) so a push never erases them.
const REMOTE_FIELDS = ["subtasks", "sessions", "sourceMessageId", "delegatedAgentId", "expectsAnswer"];
function remoteExtras(remote = {}) {
  const out = {};
  for (const f of REMOTE_FIELDS) if (remote[f] !== undefined && remote[f] !== null) out[f] = remote[f];
  return out;
}
export function streamAskBody(ask) {
  const failed = ask.state === "failed";
  const planning = ask.state === "planning";
  const kept = ask.stream?.remote || {};
  // A real source only: the VA3 transcript row the ask came from, or the one
  // Stream already has. Never a made-up id.
  const source = ask.source_row_id ? `va3:${ask.session_id}:${ask.source_row_id}` : kept.sourceMessageId;
  const delegated = ask.owner?.kind === "agent" && ask.owner.external_id ? ask.owner.external_id : kept.delegatedAgentId;
  return {
    ...kept,
    state: streamState(ask.state),
    remaining: failed
      ? `${FAILED_PREFIX} ${ask.remaining || "retry or reassign"}`.slice(0, 4_000)
      : planning
        ? `${PLANNING_PREFIX} ${stripPlanning(ask.remaining) || "saved idea; do not work on it until Jacob asks"}`.slice(0, 4_000)
        : ask.remaining || (ask.state === "done" ? "" : "Not started"),
    evidence: ask.evidence || (ask.state === "done" ? "" : "Tracked by Voice Assistant v3"),
    ...(source ? { sourceMessageId: source } : {}),
    ...(delegated ? { delegatedAgentId: delegated } : {}),
  };
}

const syncing = new Set();
// Push local changes, then pull Stream-side edits and Stream-only asks.
export async function syncStream(sessionId) {
  if (!streamEnabled() || syncing.has(sessionId)) return streamStatus(sessionId);
  const agentId = await sessionAgentResolver(sessionId);
  if (!agentId) {
    streamMeta.set(sessionId, { agent_id: null, note: "No session agent yet; the ledger is local until one exists." });
    return streamStatus(sessionId);
  }
  syncing.add(sessionId);
  const meta = { agent_id: agentId, synced_at: null, error: null };
  try {
    for (const ask of listAsks(sessionId).filter((a) => a.kind === "ask")) {
      if (ask.stream?.agent_id === agentId && ask.stream.local_rev === ask.rev) continue;
      // A failed first push leaves { agent_id, error } with no revision: the
      // retry must send 0, not undefined (which also stored NaN on success).
      const known = ask.stream?.agent_id === agentId ? Number(ask.stream.revision) || 0 : 0;
      try {
        const result = await streamCall("set_stream_ask", {
          agentId,
          askId: ask.id,
          expectedRevision: known,
          text: ask.text,
          ask: streamAskBody(ask),
        });
        if (result.accepted === false) throw new Error(result.reason || "rejected");
        updateAsk(sessionId, ask.id, {
          stream: { agent_id: agentId, revision: known + 1, local_rev: ask.rev, synced_at: new Date().toISOString(), ...(ask.stream?.remote ? { remote: ask.stream.remote } : {}) },
        }, { origin: "stream" });
      } catch (error) {
        updateAsk(sessionId, ask.id, { stream: { ...(ask.stream || {}), agent_id: agentId, error: clip(error.message, 300) } }, { origin: "stream" });
      }
    }
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const listing = await streamCall("list_stream_asks", { agentId, limit: 100, ...(cursor ? { cursor } : {}) });
      for (const row of listing.rows || []) await pullStreamRow(sessionId, agentId, row);
      cursor = listing.nextCursor;
      if (!cursor) break;
    }
    meta.synced_at = new Date().toISOString();
  } catch (error) {
    meta.error = clip(error.message, 300);
  } finally {
    syncing.delete(sessionId);
  }
  streamMeta.set(sessionId, meta);
  return meta;
}

async function pullStreamRow(sessionId, agentId, row) {
  const knownRemote = ["open", "in_progress", "blocked", "done"];
  const entry = row.item?.entry;
  const remote = entry?.ask;
  const askId = row.askId || String(entry?.id || "").replace(/^ask:/, "");
  if (!remote || !askId) return;
  const local = getAsk(sessionId, askId);
  if (!local) {
    createAsk(sessionId, {
      id: askId,
      text: entry.text || askId,
      state: remote.state === "open" && planningMarked(remote.remaining) ? "planning"
        : remote.state === "done" && !remote.evidence ? "open"
          : knownRemote.includes(remote.state) ? remote.state : "open",
      evidence: remote.evidence || "",
      remaining: (planningMarked(remote.remaining) ? stripPlanning(remote.remaining) : remote.remaining) || "",
      sourceRowId: null, // never guess a source row for a Stream-only ask
      owner: { kind: "session_agent", id: agentId },
      origin: "stream",
      ...(!knownRemote.includes(remote.state) ? { unknownState: remote.state } : {}),
    });
    const created = getAsk(sessionId, askId);
    updateAsk(sessionId, askId, { stream: { agent_id: agentId, revision: remote.revision || 1, local_rev: created.rev, synced_at: new Date().toISOString(), remote: remoteExtras(remote) } }, { origin: "stream" });
    return;
  }
  const known = local.stream?.agent_id === agentId ? local.stream.revision || 0 : 0;
  if (!remote.revision || remote.revision <= known) return;
  // Unpushed local edits win: record Stream's revision so the next push uses
  // it, but do not overwrite the local content or mark it pushed.
  if (local.stream?.local_rev !== local.rev) {
    updateAsk(sessionId, askId, { stream: { ...(local.stream || {}), agent_id: agentId, revision: remote.revision, remote: remoteExtras(remote) } }, { origin: "stream" });
    return;
  }
  const patch = {};
  // "blocked" is how a local failure is mirrored: it never downgrades one.
  const keepFailed = local.state === "failed" && remote.state === "blocked";
  // "open" is how planning is mirrored: it never turns planning into work.
  // An "open" carrying the planning marker makes a local ask planning.
  const keepPlanning = local.state === "planning";
  const remoteState = remote.state === "open" && planningMarked(remote.remaining) ? "planning" : knownRemote.includes(remote.state) ? remote.state : "open";
  if (!knownRemote.includes(remote.state)) patch.unknownState = String(remote.state);
  else if (local.unknown_state !== undefined) patch.unknownState = null;
  if (["open", "in_progress", "blocked", "done", "planning"].includes(remoteState) && remoteState !== local.state && !keepFailed && !keepPlanning && (remoteState !== "done" || remote.evidence)) patch.state = remoteState;
  if (remote.evidence && remote.evidence !== local.evidence && remote.evidence !== "Tracked by Voice Assistant v3") patch.evidence = remote.evidence;
  const remaining = typeof remote.remaining === "string" && remote.remaining.startsWith(FAILED_PREFIX) ? remote.remaining.slice(FAILED_PREFIX.length).trim()
    : planningMarked(remote.remaining) ? stripPlanning(remote.remaining) : remote.remaining;
  if (typeof remaining === "string" && remaining !== local.remaining && remaining !== "Not started" && !(keepFailed && remaining === "retry or reassign") && !(remaining === "saved idea; do not work on it until Jacob asks" && local.state === "planning")) patch.remaining = remaining;
  const updated = Object.keys(patch).length ? updateAsk(sessionId, askId, patch, { origin: "stream" }) : local;
  updateAsk(sessionId, askId, { stream: { agent_id: agentId, revision: remote.revision, local_rev: keepPlanning && (remote.state !== "open" || !planningMarked(remote.remaining)) ? null : updated.rev, synced_at: new Date().toISOString(), remote: remoteExtras(remote) } }, { origin: "stream" });
  if ((local.state === "planning") !== (updated.state === "planning")) {
    const { reflectAskPlanning } = await import("./feedback.js");
    await reflectAskPlanning(local, updated);
  }
}

// Background pull when the pane reads the ledger and the last pull is stale.
export function maybeSyncStream(sessionId, { maxAgeMs = 15_000 } = {}) {
  const meta = streamStatus(sessionId);
  const last = Date.parse(meta?.synced_at || meta?.checked_at || 0);
  if (Date.now() - last < maxAgeMs) return;
  streamMeta.set(sessionId, { ...(meta || {}), checked_at: new Date().toISOString() });
  syncStream(sessionId).catch(() => {});
}

export function pendingPlanningLabels() {
  if (!existsSync(TRANSCRIPTS_DIR)) return [];
  return readdirSync(TRANSCRIPTS_DIR).filter((name) => name.endsWith(".asks.jsonl"))
    .flatMap((name) => listAsks(name.slice(0, -11)))
    .filter((ask) => ask.wit_planning && !ask.wit_planning.ok && (ask.feedback_id || ask.wit_url));
}
