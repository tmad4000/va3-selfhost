// Stuck-queue handoff files. When Paseo holds messages in an idle agent's
// queue (the agent is "stuck"), the queued work must not be lost or silently
// absorbed: it is written to DATA_DIR/handoffs/<agent-id>-<timestamp>.md plus
// a JSON twin, so Jacob can read it and a fresh agent can take it over.
//
// Pure builders (buildHandoff, renderHandoffMarkdown, selectHandoffMessages,
// handoffBrief) plus one writer (writeHandoffFiles). agents.js owns when a
// handoff is written and spawns the successor; this module owns the format.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { DATA_DIR } from "./env.js";

export const HANDOFF_KIND = "va3-stuck-agent-handoff";
export const HANDOFF_SCOPES = Object.freeze(["first", "all"]);

export function handoffDir(dataDir = DATA_DIR) {
  return join(dataDir, "handoffs");
}

function firstLine(text) {
  return String(text || "").trim().split("\n")[0].replace(/\s+/g, " ").slice(0, 80);
}

// The episode identity: the same oldest queued message means the same stuck
// episode, however many messages pile up behind it. A drained queue that
// sticks again later starts a new episode.
export function stuckEpisodeKey(record, queued) {
  const first = (queued || [])[0];
  if (!first) return null;
  return `${record.external_id || record.id}:${first.id || first.created_at || firstLine(first.text)}`;
}

// Match queued messages to what VA3 sent (record.sent_log) to recover the
// conversation and checklist ask each one came from.
export function originFor(message, sentLog = []) {
  const want = firstLine(message.text);
  if (!want) return null;
  for (let i = sentLog.length - 1; i >= 0; i--) {
    if (firstLine(sentLog[i].text) === want) return sentLog[i];
  }
  return null;
}

export function buildHandoff({ record, queued = [], asks = [], now = new Date(), stuck = {} }) {
  const at = now instanceof Date ? now : new Date(now);
  const messages = queued.map((m, index) => {
    const origin = originFor(m, record.sent_log);
    return {
      index: index + 1,
      id: m.id || null,
      text: String(m.text || ""),
      queued_at: m.created_at || origin?.sent_at || null,
      ask_id: origin?.ask_id || null,
      session_id: origin?.session_id || record.session_id || null,
    };
  });
  return {
    kind: HANDOFF_KIND,
    version: 1,
    written_at: at.toISOString(),
    agent: {
      id: record.id,
      external_id: record.external_id || null,
      title: record.title || "",
      host: record.host || null,
      host_id: record.host_id || null,
      agent_provider: record.agent_provider || null,
      model: record.model || null,
      cwd: record.cwd || null,
      role: record.role || null,
      session_id: record.session_id || null,
      attach_command: record.attach_command || null,
    },
    stuck: {
      episode: stuck.episode || stuckEpisodeKey(record, queued),
      detected_at: stuck.detected_at || at.toISOString(),
      queued_messages: messages.length,
      oldest_queued_at: messages.map((m) => m.queued_at).filter(Boolean).sort()[0] || null,
    },
    messages,
    open_asks: asks.map((a) => ({
      id: a.id,
      session_id: a.session_id || null,
      text: String(a.text || "").slice(0, 600),
      state: a.state || null,
      remaining: a.remaining || null,
    })),
    taken: [],
  };
}

function quoteBlock(text) {
  return String(text || "").split("\n").map((l) => `> ${l}`).join("\n");
}

export function renderHandoffMarkdown(h) {
  const a = h.agent;
  const lines = [
    `# Stuck agent handoff: ${a.id}`,
    "",
    `Written ${h.written_at}. Paseo is holding ${h.stuck.queued_messages} message(s) in the queue of agent ${a.id}${a.external_id ? ` (Paseo ${a.external_id})` : ""} while it sits idle, so nobody is working on them. This file is the durable copy of that queue.`,
    "",
    "## Agent",
    "",
    `- Title: ${a.title || "(none)"}`,
    `- Host: ${a.host || "?"} · Provider: ${a.agent_provider || "?"} · Model: ${a.model || "provider default"}`,
    `- Working directory: ${a.cwd || "?"}`,
    ...(a.role ? [`- Role: ${a.role === "session" ? "prime (session) agent" : a.role}`] : []),
    ...(a.session_id ? [`- Conversation: ${a.session_id}`] : []),
    ...(a.attach_command ? [`- Attach: \`${a.attach_command}\``] : []),
    `- Stuck since: ${h.stuck.oldest_queued_at || "unknown"} (episode ${h.stuck.episode || "?"})`,
    "",
    `## Queued messages (${h.messages.length}, oldest first)`,
    "",
  ];
  if (!h.messages.length) lines.push("(The queue could not be read or is empty.)", "");
  for (const m of h.messages) {
    const meta = [m.queued_at && `queued ${m.queued_at}`, m.ask_id && `ask ${m.ask_id}`, m.session_id && `conversation ${m.session_id}`, m.id && `queue id ${m.id}`].filter(Boolean).join(" · ");
    const taken = (h.taken || []).find((t) => (t.message_ids || []).includes(m.id ?? `#${m.index}`));
    lines.push(`### ${m.index}.${taken ? ` (handed to ${taken.agent_id})` : ""}`, "", meta ? `_${meta}_` : "", "", quoteBlock(m.text), "");
  }
  if (h.open_asks?.length) {
    lines.push("## Open checklist asks owned by this agent", "");
    for (const ask of h.open_asks) lines.push(`- ${ask.id} [${ask.state || "?"}] ${ask.text}${ask.remaining ? ` — remaining: ${ask.remaining}` : ""}`);
    lines.push("");
  }
  if (h.taken?.length) {
    lines.push("## Handed off", "");
    for (const t of h.taken) lines.push(`- ${t.at}: ${t.scope === "first" ? "first message" : `${t.message_ids.length} message(s)`} to ${t.agent_id}`);
    lines.push("");
  }
  return lines.filter((l, i, all) => !(l === "" && all[i - 1] === "")).join("\n");
}

function stamp(iso) {
  return String(iso).replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

function atomicWrite(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, file);
}

// Write (or rewrite, when `path` is given) the markdown file and its JSON
// twin. Returns { path, json_path }.
export function writeHandoffFiles(handoff, { dataDir = DATA_DIR, path = null } = {}) {
  const dir = handoffDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const safeId = String(handoff.agent.id).replace(/[^A-Za-z0-9_-]/g, "_");
  const md = path && isHandoffPath(path, dataDir) ? path : join(dir, `${safeId}-${stamp(handoff.written_at)}.md`);
  const jsonPath = md.replace(/\.md$/, ".json");
  const full = { ...handoff, path: md, json_path: jsonPath };
  atomicWrite(jsonPath, `${JSON.stringify(full, null, 2)}\n`);
  atomicWrite(md, `${renderHandoffMarkdown(full)}\n`);
  return { path: md, json_path: jsonPath };
}

export function isHandoffPath(path, dataDir = DATA_DIR) {
  const dir = resolve(handoffDir(dataDir));
  const full = resolve(String(path || ""));
  return full.startsWith(dir + sep) && /^[A-Za-z0-9_-]+-[0-9TZ-]+\.(md|json)$/.test(basename(full));
}

export function readHandoff(path, dataDir = DATA_DIR) {
  if (!isHandoffPath(path, dataDir)) throw new Error("Not a handoff file");
  const jsonPath = String(path).replace(/\.md$/, ".json");
  const markdown = existsSync(path) ? readFileSync(path, "utf8") : null;
  const json = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")) : null;
  if (!markdown && !json) throw new Error("Handoff file not found");
  return { path, json_path: jsonPath, markdown, json };
}

// Which messages a successor takes. "first": the oldest message not yet
// handed off. "all": every message not yet handed off (the queue that remains).
export function selectHandoffMessages(messages, scope = "all", takenIds = []) {
  if (!HANDOFF_SCOPES.includes(scope)) throw new Error(`scope must be ${HANDOFF_SCOPES.join(" or ")}`);
  const taken = new Set(takenIds);
  const remaining = (messages || []).filter((m) => !taken.has(m.id ?? `#${m.index}`));
  return scope === "first" ? remaining.slice(0, 1) : remaining;
}

// The successor's task text: the selected messages verbatim, in order, plus
// where the full handoff lives. Works for scope "first" (one task) and "all".
export function handoffBrief(handoff, { scope = "all", messages, extraMessage = "", path = handoff.path } = {}) {
  const a = handoff.agent;
  const chosen = messages || selectHandoffMessages(handoff.messages, scope, (handoff.taken || []).flatMap((t) => t.message_ids || []));
  const parts = [
    `You are taking over work from agent ${a.id}${a.external_id ? ` (Paseo ${a.external_id})` : ""}, which got stuck: Paseo held these messages in its queue while it sat idle, so none of them were worked on. Treat them as Jacob's requests to you, oldest first.`,
    `The full handoff (every queued message, origin asks and the stuck agent's details) is at ${path}. Read it if you need context.`,
    ...(scope === "first" && handoff.messages.length > 1 ? [`Do only the FIRST queued task below. The other queued messages in the handoff file are being handled separately; do not start them.`] : []),
    ...(a.cwd ? [`The stuck agent was working in ${a.cwd}.`] : []),
  ];
  chosen.forEach((m, i) => {
    parts.push(`--- Queued message ${i + 1} of ${chosen.length}${m.queued_at ? ` (queued ${m.queued_at})` : ""}${m.ask_id ? ` [checklist ask ${m.ask_id}]` : ""} ---\n${m.text}`);
  });
  if (!chosen.length) parts.push("(No queued messages remained; check the handoff file and report what, if anything, is still open.)");
  if (extraMessage) parts.push(`--- New message from Jacob (sent after the agent was already stuck) ---\n${extraMessage}`);
  parts.push("When done, reply with the outcome of each task in plain words; your reply is read aloud.");
  return { text: parts.join("\n\n"), messages: chosen };
}
