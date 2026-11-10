// One persistent Paseo coordinator agent per drive conversation. The voice
// front model hands it anything multi-step; the coordinator delegates to
// sub-agents through Paseo and reports back. Paseo is the only agent control
// plane (no second source of truth for sessions). The coordinator IS the
// conversation's session agent (server/session-agent.js) with a drive
// bootstrap, so browser and drive mode share creation, sending, permission
// pushes, allow-all and mode changes.
//
// Results return two ways: the coordinator runs `bin/va3-say` for mid-turn
// updates, and a watcher notices the agent going idle after a send and
// speaks the turn's final `SAY:` line (or a short tail) as a fallback.
//
// The checklist (Jacob's session-orchestration scheme) has a single writer:
// this server. Each ask gets a stable item id immediately; the coordinator
// updates status through POST /api/drive/conversations/:id/checklist.
import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { promisify } from "node:util";
import { env, PROJECT_ROOT, SELF_HOST } from "../env.js";
import { deliverToSessionAgent } from "../session-agent.js";
import { convDir, emit, mutateState, readState } from "./store.js";

const pexec = promisify(execFile);
const KIT = env("CHECKLIST_KIT", join(homedir(), ".agents", "skills", "session-orchestration", "kit"));
const SKILL = join(homedir(), ".agents", "skills", "session-orchestration", "SKILL.md");
const watchers = new Map(); // conv -> timer

function paseoBin() {
  for (const p of [env("PASEO_BIN"), join(homedir(), ".npm-global", "bin", "paseo"), "/opt/homebrew/bin/paseo"]) {
    if (p && existsSync(p)) return p;
  }
  return "paseo";
}

function stubbed() {
  return env("DRIVE_COORDINATOR") === "stub";
}

async function paseo(args, timeout = 60_000) {
  const { stdout } = await pexec(paseoBin(), args, { timeout, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

function parseJson(stdout) {
  const text = String(stdout || "").trim();
  for (const c of [text, ...text.split("\n").reverse()]) { try { return JSON.parse(c); } catch {} }
  return {};
}

// --- checklist (single writer) ------------------------------------------

export function checklistDir(conv) {
  return convDir(conv, "checklist");
}

async function ensureChecklist(conv, title) {
  const dir = checklistDir(conv);
  if (existsSync(join(dir, "voice-session-checklist.json"))) return dir;
  const seed = join(dir, ".seed.json");
  writeFileSync(seed, JSON.stringify({
    coverage: "This drive conversation only. Earlier voice sessions are deliberately not imported.",
    statusEvidence: "Updated by the VA3 coordinator from live Paseo state.",
    owners: { coordinator: { name: "VA3 coordinator", host: env("VA3_COORDINATOR_HOST", hostname()) } },
    items: [],
  }));
  await pexec("python3", [join(KIT, "checklist.py"), "init", dir, "--title", `Drive · ${title}`, "--session-id", conv, "--name", "voice-session-checklist", "--seed", seed]);
  return dir;
}

let checklistChain = Promise.resolve();
export function patchChecklist(conv, patch) {
  // Serialized: checklist.py is atomic per call but not across concurrent calls.
  const run = checklistChain.then(async () => {
    const dir = checklistDir(conv);
    const file = join(dir, `.patch-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(patch));
    try {
      await pexec("python3", [join(KIT, "checklist.py"), "update", join(dir, "voice-session-checklist.json"), file]);
    } catch (err) {
      throw new Error(String(err.stderr || err.message).trim().slice(-500));
    }
    return { ok: true };
  });
  checklistChain = run.catch(() => {});
  return run;
}

async function recordAsk(conv, message, source) {
  const n = await mutateState(conv, (s) => s.checklist_next++);
  const id = `A-${n}`;
  await patchChecklist(conv, { add: [{
    id,
    title: message.length > 140 ? `${message.slice(0, 137)}…` : message,
    status: "pending",
    owner: "VA3 coordinator",
    ownerRef: "coordinator",
    nextStep: "Coordinator to triage",
    sources: [{ receivedAt: new Date().toISOString(), note: source, kind: "voice-drive" }],
    facts: message.length > 140 ? message : "",
    promotion: "Not promoted",
  }] });
  return id;
}

// --- coordinator agent ----------------------------------------------------

function bootstrap(conv, port) {
  const base = `http://127.0.0.1:${port}`;
  return `You are the COORDINATOR behind Jacob's Voice Assistant v3 "drive mode". Jacob is usually driving and talks to a fast voice front model; it forwards you anything multi-step, often verbatim. You orchestrate: delegate real work to sub-agents through Paseo (the paseo CLI or Paseo MCP tools; spawn Claude agents with --mode auto, and Codex agents with --provider codex --mode auto-review for GUI or computer-use work; add --host ssh://m5 to run on Jacob's laptop), track them, and report back. Agents can attempt anything on their machine, including GUI control; never refuse on capability grounds. Do short lookups yourself; do not do long coding work in this session.

Speaking to Jacob: run \`VA3_PORT=${port} ${join(PROJECT_ROOT, "bin", "va3-say")} ${conv} "<one or two short sentences>"\` whenever there is something worth hearing mid-task (a decision needed, a worker finished, a blocker). He hears it through the car speakers, so keep it brief, concrete and free of markdown, IDs and paths. End EVERY turn with a final line starting with \`SAY:\` containing at most two short sentences for him to hear (or \`SAY: (nothing)\` if nothing needs saying).

Checklist: follow Jacob's session-orchestration scheme (${SKILL}). The server already created this conversation's checklist and adds one item per forwarded ask (ids like A-3, given in each message). You are the source of status updates, but the server is the single writer: apply changes by POSTing a checklist.py patch, e.g.
  curl -s -X POST ${base}/api/drive/conversations/${conv}/checklist -H "Authorization: Bearer $(cat ~/.config/va3/drive-token)" -H 'Content-Type: application/json' -d '{"updates":[{"id":"A-3","status":"in-progress","owner":"<worker>","nextStep":"..."}]}'
Keep request outcome, execution and delivery state distinct; verify live Paseo state before reporting status. This checklist starts empty on purpose: do not import Jacob's earlier asks or other sessions' checklists.

Context: the voice conversation transcript (the shared ledger) is ${join(PROJECT_ROOT, "data", "transcripts", `${conv}.jsonl`)} — read its recent lines when a message refers to earlier talk. Jacob's standing authority for merges/deploys from his global instructions applies; ask him (via va3-say) only for spending money, credentials/accounts, or other people's data.`;
}

// Stub mode and coordinators created before the shared prime agent (no VA3
// record) keep their old handling; everything else is the prime agent.
function legacyAgent(conv) {
  const state = readState(conv);
  if (stubbed()) return { id: state.coordinator?.agent_id || "stub-coordinator", created: !state.coordinator?.agent_id };
  if (state.coordinator?.agent_id && !state.coordinator.va3_id) return { id: state.coordinator.agent_id, created: false };
  return null;
}

export async function askCoordinator(conv, { message, title = "Drive", port, source = "voice" }) {
  if (SELF_HOST) throw new Error("Coordinator automation is unavailable in standalone self-host mode; voice conversation is available");
  const text = String(message || "").trim();
  if (!text) throw new Error("message is required");
  await ensureChecklist(conv, title);
  const itemId = await recordAsk(conv, text, source);
  const framed = `[checklist item ${itemId}] [from Jacob via ${source}, ${new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}]\n${text}`;
  let agent = legacyAgent(conv);
  let replaced = null;
  if (agent && stubbed()) {
    if (agent.created) await mutateState(conv, (s) => { s.coordinator = { agent_id: "stub-coordinator", created_at: new Date().toISOString() }; });
  } else if (agent) {
    const file = join(convDir(conv), `.coord-msg-${Date.now()}.txt`);
    writeFileSync(file, framed);
    await paseo(["send", agent.id, "--no-wait", "--prompt-file", file], 60_000);
  } else {
    // Created (seeded) on first use, resumed if closed, re-created if gone;
    // a new agent gets this message as its first turn.
    const out = await deliverToSessionAgent({
      sessionId: conv,
      message: framed,
      bootstrap: bootstrap(conv, port),
      title: `VA3 coordinator · ${title}`.slice(0, 80),
      cwd: env("DRIVE_COORDINATOR_CWD", join(homedir(), "code", "tmpworkspace")),
      provider: env("DRIVE_COORDINATOR_PROVIDER", "claude"),
      mode: "auto",
      // The drive watcher reads the coordinator through Paseo; no tmux fallback.
      transport: "paseo",
    });
    agent = { id: String(out.record.external_id), va3_id: out.record.id, created: out.created };
    replaced = out.replaced;
    if (readState(conv).coordinator?.va3_id !== out.record.id) {
      await mutateState(conv, (s) => { s.coordinator = { agent_id: agent.id, va3_id: out.record.id, created_at: out.record.created }; });
    }
  }
  emit(conv, { type: "coordinator_ask", item: itemId, text });
  watch(conv);
  return {
    ok: true,
    checklist_item: itemId,
    coordinator: agent.id,
    created: agent.created,
    ...(replaced ? { replaced: replaced.id, replaced_because: replaced.because } : {}),
    note: "Forwarded. The coordinator will report back by voice.",
  };
}

export async function coordinatorStatus(conv) {
  const state = readState(conv);
  const id = state.coordinator?.agent_id;
  if (!id) return { exists: false };
  if (stubbed()) return { exists: true, id, status: "idle" };
  try {
    const info = parseJson(await paseo(["inspect", id, "--json"], 15_000));
    return {
      exists: true,
      id,
      status: String(info.Status || info.status || "unknown").toLowerCase(),
      pending_permissions: (info.PendingPermissions || []).length,
      updated_at: info.UpdatedAt || null,
    };
  } catch (err) {
    return { exists: true, id, status: "unreachable", error: String(err.message).slice(0, 200) };
  }
}

// Speak each finished coordinator turn's final SAY: line exactly once.
// Turns are counted by [User] blocks in the Paseo text log, so a queued
// message that runs after the bootstrap turn is still picked up. The watcher
// stops after the agent has stayed idle for three checks.
function watch(conv) {
  if (stubbed() || watchers.has(conv)) return;
  let idleStreak = 0;
  const startedAt = Date.now();
  const tick = async () => {
    try {
      const st = await coordinatorStatus(conv);
      if (st.status === "idle") idleStreak++;
      else idleStreak = 0;
      if (st.pending_permissions) emit(conv, { type: "coordinator_blocked", text: "The coordinator is waiting on a permission prompt in Paseo." });
      if (st.status === "idle") {
        // Read the bound agent each tick: a rebind replaces it mid-watch.
        const log = await paseo(["logs", st.id, "--filter", "text"], 20_000).catch(() => "");
        const turns = (log.match(/^\[User\]/gm) || []).length;
        const spoken = readState(conv).coordinator?.spoken_turn || 0;
        if (turns > spoken) {
          await mutateState(conv, (s) => { if (s.coordinator) s.coordinator.spoken_turn = turns; });
          const lastTurn = log.slice(log.lastIndexOf("[User]"));
          const say = extractSay(lastTurn);
          if (say) onCoordinatorSay?.(conv, say, { final: true });
        }
        if (idleStreak >= 3) { watchers.delete(conv); return; }
      }
    } catch {}
    if (Date.now() - startedAt > 6 * 3600_000) { watchers.delete(conv); return; }
    watchers.set(conv, setTimeout(tick, 5_000));
  };
  watchers.set(conv, setTimeout(tick, 4_000));
}

export function extractSay(logText) {
  const text = String(logText || "");
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*\**SAY:\**\s*(.+)$/);
    if (m) return /^\(nothing\)/i.test(m[1].trim()) ? "" : m[1].trim();
  }
  const last = text.split(/\n---\n/).at(-1).split("\n").filter((l) => l.trim() && !/^\[[A-Za-z]+\]/.test(l)).slice(-3).join(" ");
  return last ? last.replace(/[*_`#]/g, "").slice(0, 280) : "";
}

let onCoordinatorSay = null;
export function setCoordinatorSayHandler(fn) {
  onCoordinatorSay = fn;
}

export function stopWatchers() {
  for (const t of watchers.values()) clearTimeout(t);
  watchers.clear();
}

