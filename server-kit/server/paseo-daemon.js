// Read-only access to this server's own Paseo daemon over its HTTP agent MCP
// endpoint (stateless JSON-RPC; the same endpoint the Stream mirror in
// asks.js uses). One HTTP request instead of one ~250 MB CLI child per call:
// measured on the M4 2026-11-01, `list_agents` answers in 30-550 ms where
// `paseo ls --json` took 3-8 s, and `get_agent_status` in ~50 ms where
// `paseo inspect` took 0.8 s+.
//
// Used only for reads against the local daemon. Remote hosts (ssh://m5) and
// every write (run, send, stop, permit, mode) stay on the CLI.
//
// VA3_PASEO_DAEMON_URL: an explicit URL, "off", or "auto" (default). "auto"
// uses VA3_STREAM_MCP_URL (default http://127.0.0.1:6767/mcp/agents) unless
// PASEO_BIN points at a different CLI (tests' fakes), Stream is off, or the
// agent transport is forced to stub/tmux: those mean "not the real daemon".
import { env } from "./env.js";
import { classifyPaseoError, recordPaseoCall } from "./paseo-health.js";

const DEFAULT_URL = "http://127.0.0.1:6767/mcp/agents";

export function daemonUrl() {
  const configured = env("VA3_PASEO_DAEMON_URL", "auto").trim();
  if (configured === "off") return null;
  if (configured && configured !== "auto") return configured;
  if (env("PASEO_BIN")) return null;
  if (["stub", "tmux"].includes(env("AGENT_PROVIDER"))) return null;
  const stream = env("VA3_STREAM_MCP_URL", DEFAULT_URL);
  return stream === "off" ? null : stream;
}

let rpcId = 0;

// Call one daemon MCP tool. Resolves to its structured content (or parsed
// JSON body). Throws with .unreachable / .timeout / .notFound set so callers
// can tell a down daemon from an app-level answer.
export async function daemonTool(name, args = {}, { timeout = 4_000 } = {}) {
  const url = daemonUrl();
  if (!url) throw Object.assign(new Error("Paseo daemon HTTP disabled"), { disabled: true });
  const started = Date.now();
  let res;
  let raw;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(timeout),
    });
    raw = await res.text();
  } catch (error) {
    const outcome = classifyPaseoError(error);
    recordPaseoCall("", { ms: Date.now() - started, outcome: outcome === "ok" ? "unreachable" : outcome, error: error.cause?.code || error.message, transport: "http" });
    throw Object.assign(new Error(`Paseo daemon HTTP ${name} failed: ${error.cause?.code || error.message}`), {
      unreachable: outcome !== "timeout",
      timeout: outcome === "timeout",
    });
  }
  recordPaseoCall("", { ms: Date.now() - started, outcome: "ok", transport: "http" });
  const payload = raw.trim().startsWith("{")
    ? raw
    : raw.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
  let message;
  try { message = JSON.parse(payload); } catch {
    throw Object.assign(new Error(`Paseo daemon HTTP ${name}: HTTP ${res.status} without JSON`), { protocol: true });
  }
  if (message.error) throw Object.assign(new Error(`Paseo daemon ${name}: ${message.error.message || message.error.code}`), { protocol: true });
  const text = (message.result?.content || []).map((c) => c.text || "").join("\n");
  if (message.result?.isError) {
    throw Object.assign(new Error(text.slice(0, 500) || `Paseo daemon ${name} error`), { notFound: /not found/i.test(text) });
  }
  if (message.result?.structuredContent) return message.result.structuredContent;
  const start = text.indexOf("{");
  if (start < 0) return { text };
  try { return JSON.parse(text.slice(start)); } catch { return { text }; }
}

// Batch state for the local daemon: status per agent and pending permissions.
// Shape matches agents.js paseoBatchState().
export async function daemonBatchState() {
  const [listing, permits] = await Promise.all([
    daemonTool("list_agents", { limit: 200, sinceHours: 720 }),
    daemonTool("list_pending_permissions", {}),
  ]);
  if (!Array.isArray(listing?.agents) || !Array.isArray(permits?.permissions)) {
    throw Object.assign(new Error("Paseo daemon returned an unexpected list shape"), { protocol: true });
  }
  const status = new Map();
  const updated = new Map();
  for (const a of listing.agents) {
    status.set(a.id, a.status);
    updated.set(a.id, a.updatedAt || a.messageActivity?.lastAssistantMessageAt || "");
  }
  const pending = new Map();
  for (const p of permits.permissions) {
    if (!pending.has(p.agentId)) pending.set(p.agentId, []);
    pending.get(p.agentId).push({ request_id: p.request?.id, tool: p.request?.name || "tool" });
  }
  return { status, pending, updated, via: "http" };
}

// When an agent was archived, or null. get_agent_status does not carry
// archivedAt (daemon 0.6.x reports an archived agent as plain "idle"), and the
// default list_agents omits archived agents, so ask list_agents with
// includeArchived, narrowed to the agent's cwd when known. Measured on the M4
// 2026-11-01: an agent archived from the Paseo app kept answering "idle", and
// VA3 kept queueing messages to it.
export async function daemonArchivedAt(agentId, { cwd = null } = {}) {
  const listing = await daemonTool("list_agents", {
    includeArchived: true, sinceHours: 720, limit: 200, ...(cwd ? { cwd } : {}),
  });
  const hit = (listing?.agents || []).find((a) => a.id === agentId);
  return hit?.archivedAt || null;
}

// One agent's status, mode and pending permissions (replaces `paseo inspect`).
// archived_at is set when the daemon says the agent was archived; an idle or
// closed agent is checked for that (an archived agent is never working).
export async function daemonInspect(agentId, { cwd = null } = {}) {
  const result = await daemonTool("get_agent_status", { agentId });
  const snap = result?.snapshot || {};
  const status = result?.status || snap.status || "unknown";
  let archivedAt = result?.archivedAt || snap.archivedAt || null;
  if (!archivedAt && ["idle", "closed"].includes(String(status).toLowerCase())) {
    archivedAt = await daemonArchivedAt(agentId, { cwd }).catch(() => null);
  }
  return {
    status,
    mode: snap.currentModeId || snap.runtimeInfo?.modeId || null,
    pending: (snap.pendingPermissions || []).map((p) => ({ request_id: p.id, tool: p.name || "tool" })),
    updated_at: snap.updatedAt || null,
    archived_at: archivedAt,
  };
}

// Cheapest liveness check: the MCP "ping" method (no tool runs).
export async function daemonPing({ timeout = 4_000 } = {}) {
  const url = daemonUrl();
  if (!url) throw Object.assign(new Error("Paseo daemon HTTP disabled"), { disabled: true });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "ping", params: {} }),
    signal: AbortSignal.timeout(timeout),
  });
  await res.text();
  return res.status < 500;
}
