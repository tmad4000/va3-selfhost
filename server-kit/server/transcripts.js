// Durable, file-backed conversation sessions. Transcript entries remain JSONL
// for cheap append/replay; a small manifest adds names and archive state.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR } from "./env.js";
import "../public/muted-review.js";

const TRANSCRIPTS_DIR = join(DATA_DIR, "transcripts");
const SESSIONS_FILE = join(TRANSCRIPTS_DIR, "sessions.json");
const ROLES = new Set(["user", "assistant", "tool", "system"]);
const SESSION_RE = /^[A-Za-z0-9_-]{8,100}$/;

function transcriptPath(sessionId) {
  const id = String(sessionId || "");
  if (!SESSION_RE.test(id)) throw new Error("Invalid transcript session id");
  return join(TRANSCRIPTS_DIR, `${id}.jsonl`);
}

function ensure() {
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

function cleanTitle(value) {
  const firstLine = String(value || "").trim().split(/\n+/)[0].replace(/\s+/g, " ");
  if (!firstLine) return "";
  return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 69)}…`;
}

function isMeaningfulUserText(text) {
  const normalized = String(text || "").trim();
  return [...normalized].length >= 12 || normalized.split(/\s+/).filter(Boolean).length >= 3;
}

function fallbackTitle(iso) {
  const date = new Date(iso || Date.now());
  const label = Number.isNaN(date.valueOf())
    ? new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `Conversation · ${label}`;
}

function readRows(sessionId, limit = 10_000) {
  const file = transcriptPath(sessionId);
  if (!existsSync(file)) return [];
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean);
  return (limit === Infinity ? rows : rows.slice(-Math.max(1, Math.min(Number(limit) || 2_000, 10_000)))).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function metadataFromRows(id, rows, fallbackTimestamp) {
  const createdAt = rows[0]?.ts || fallbackTimestamp || new Date().toISOString();
  const updatedAt = rows.at(-1)?.ts || createdAt;
  const meaningfulUser = rows.find((row) => row.role === "user" && isMeaningfulUserText(row.text));
  const firstUser = rows.find((row) => row.role === "user");
  const titleText = meaningfulUser?.text || firstUser?.text || "";
  const previewEntry = [...rows].reverse().find((row) => ["user", "assistant"].includes(row.role));
  return {
    id,
    title: cleanTitle(titleText) || fallbackTitle(createdAt),
    title_source: titleText ? "auto" : "default",
    created_at: createdAt,
    updated_at: updatedAt,
    archived_at: null,
    preview: cleanTitle(previewEntry?.text || ""),
    entry_count: rows.length,
  };
}

function readManifest() {
  ensure();
  if (!existsSync(SESSIONS_FILE)) return { version: 1, sessions: [] };
  try {
    const parsed = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
    return {
      version: 1,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return { version: 1, sessions: [] };
  }
}

function writeManifest(manifest) {
  ensure();
  const temporary = `${SESSIONS_FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporary, SESSIONS_FILE);
}

function loadManifestWithDiscovery() {
  const manifest = readManifest();
  const known = new Set(manifest.sessions.map((session) => session.id));
  let changed = false;

  for (const name of readdirSync(TRANSCRIPTS_DIR)) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -6);
    if (!SESSION_RE.test(id) || known.has(id)) continue;
    const file = transcriptPath(id);
    const fallbackTimestamp = statSync(file).mtime.toISOString();
    manifest.sessions.push(metadataFromRows(id, readRows(id), fallbackTimestamp));
    known.add(id);
    changed = true;
  }

  if (changed) writeManifest(manifest);
  return manifest;
}

function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    created_at: session.created_at,
    updated_at: session.updated_at,
    archived_at: session.archived_at || null,
    preview: session.preview || "",
    entry_count: Number(session.entry_count) || 0,
  };
}

export function listSessions({ includeArchived = false } = {}) {
  return loadManifestWithDiscovery().sessions
    .filter((session) => includeArchived || !session.archived_at)
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .map(publicSession);
}

export function createSession({ title } = {}) {
  const manifest = loadManifestWithDiscovery();
  const now = new Date().toISOString();
  const manualTitle = cleanTitle(title);
  const session = {
    id: `session-${randomUUID()}`,
    title: manualTitle || fallbackTitle(now),
    title_source: manualTitle ? "manual" : "default",
    created_at: now,
    updated_at: now,
    archived_at: null,
    preview: "",
    entry_count: 0,
  };
  manifest.sessions.push(session);
  writeManifest(manifest);
  return publicSession(session);
}

export function updateSession(sessionId, { title, archived } = {}) {
  const manifest = loadManifestWithDiscovery();
  const session = manifest.sessions.find((item) => item.id === String(sessionId || ""));
  if (!session) throw new Error("Conversation session not found");

  if (title !== undefined) {
    const normalized = cleanTitle(title);
    if (!normalized) throw new Error("Conversation title is required");
    session.title = normalized;
    session.title_source = "manual";
  }
  if (archived !== undefined) {
    session.archived_at = archived ? new Date().toISOString() : null;
  }
  session.updated_at = new Date().toISOString();
  writeManifest(manifest);
  return publicSession(session);
}

// Idempotent writes. A browser row carries a stable client_key (e.g.
// "user:<realtime item id>", "tool-call:<call id>"). The same key written
// twice to one session returns the first row instead of appending another:
// browsers re-send in-flight POSTs after a stalled connection (seen
// 2026-11-01 12:52Z: six rows re-recorded ~50s later), and a reloaded page
// forgets which rows it already wrote. Keys are cached per session, loaded
// lazily from the file the first time a keyed write arrives.
const CLIENT_KEY_RE = /^[\x21-\x7e]{1,300}$/;
const KEY_CACHE_SESSIONS = 32;
const KEY_CACHE_PER_SESSION = 20_000;
const keyCache = new Map(); // sessionId -> Map(clientKey -> entry)

export function normalizeClientKey(value) {
  const key = String(value ?? "").trim();
  return CLIENT_KEY_RE.test(key) ? key : "";
}

function sessionKeys(sessionId) {
  let keys = keyCache.get(sessionId);
  if (keys) {
    keyCache.delete(sessionId); // LRU: move to the end
    keyCache.set(sessionId, keys);
    return keys;
  }
  keys = new Map();
  for (const row of readRows(sessionId, 10_000)) {
    if (row.client_key) keys.set(row.client_key, row);
  }
  keyCache.set(sessionId, keys);
  while (keyCache.size > KEY_CACHE_SESSIONS) keyCache.delete(keyCache.keys().next().value);
  return keys;
}

function rememberKey(keys, clientKey, entry) {
  keys.set(clientKey, entry);
  while (keys.size > KEY_CACHE_PER_SESSION) keys.delete(keys.keys().next().value);
}

export function appendTranscript(sessionId, { role, text, metadata = {}, clientKey = "" }) {
  const normalizedRole = String(role || "");
  if (!ROLES.has(normalizedRole)) throw new Error(`Invalid transcript role: ${normalizedRole}`);
  const normalizedText = String(text ?? "").trim();
  if (!normalizedText) throw new Error("Transcript text is required");

  ensure();
  const id = String(sessionId || "");
  transcriptPath(id);
  const key = normalizeClientKey(clientKey);
  const keys = key ? sessionKeys(id) : null;
  if (keys?.has(key)) return { ...keys.get(key), duplicate: true };
  const manifest = loadManifestWithDiscovery();
  let session = manifest.sessions.find((item) => item.id === id);
  const entry = {
    id: `tr_${randomUUID()}`,
    ts: new Date().toISOString(),
    role: normalizedRole,
    text: normalizedText.slice(0, 100_000),
    metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
    ...(key ? { client_key: key } : {}),
  };
  appendFileSync(transcriptPath(id), `${JSON.stringify(entry)}\n`);
  if (keys) rememberKey(keys, key, entry);

  if (!session) {
    session = metadataFromRows(id, [entry], entry.ts);
    manifest.sessions.push(session);
  } else {
    session.updated_at = entry.ts;
    session.entry_count = (Number(session.entry_count) || 0) + 1;
    if (["user", "assistant"].includes(normalizedRole)) session.preview = cleanTitle(normalizedText);
    if (
      normalizedRole === "user"
      && session.title_source !== "manual"
      && (session.title_source === "default" || isMeaningfulUserText(normalizedText))
    ) {
      session.title = cleanTitle(normalizedText);
      session.title_source = isMeaningfulUserText(normalizedText) ? "auto" : session.title_source;
    }
  }
  writeManifest(manifest);
  return entry;
}

export function readTranscript(sessionId, { limit = 2_000 } = {}) {
  ensure();
  return readRows(sessionId, limit);
}

export function transcriptTail(sessionId, { entries = 16, maxChars = 6_000 } = {}) {
  if (!sessionId) return "";
  const rendered = readTranscript(sessionId, { limit: entries }).map((row) => {
    const stamp = row.ts ? new Date(row.ts).toISOString() : "";
    return `[${stamp}] ${row.role}: ${row.text}`;
  }).join("\n");
  return rendered.slice(-maxChars);
}

export function transcriptContext(sessionId, { entries = 32, maxChars = 10_000 } = {}) {
  if (!sessionId) return "";
  const rows = readTranscript(sessionId, { limit: entries + 16 });
  // Input queued while offline is only context once it was actually sent;
  // otherwise a reconnect would show the model unsent text as already said.
  const sent = new Set(rows.map((row) => row.metadata?.sent_outbox_id).filter(Boolean));
  const rendered = rows
    .filter((row) => ["user", "assistant", "tool"].includes(row.role))
    .filter((row) => !(row.metadata?.queued && row.metadata?.outbox_id && !sent.has(row.metadata.outbox_id)))
    .slice(-entries)
    .map((row) => `${row.role}: ${row.text}`)
    .join("\n");
  return rendered.slice(-maxChars);
}

// On-demand history for the conversation's prime (session) agent. Rows are
// numbered from 1 in file order; negative `from` counts from the end, so
// from=-50 is "the last 50 rows". Text is bounded per row and per response.
const HISTORY_ROW_CHARS = 2_000;
const HISTORY_MAX_ROWS = 500;

function presentRow(row, index, sessionId) {
  const text = String(row.text || "");
  return {
    ...(sessionId ? { session_id: sessionId } : {}),
    row: index + 1,
    ts: row.ts || null,
    role: row.role,
    text: text.length > HISTORY_ROW_CHARS ? `${text.slice(0, HISTORY_ROW_CHARS)}…` : text,
    ...(row.metadata?.voice_session ? { voice_session: row.metadata.voice_session } : {}),
  };
}

export function transcriptRange(sessionId, { from = -50, to = null } = {}) {
  const rows = readRows(sessionId, 10_000);
  const total = rows.length;
  let start = Number(from);
  if (!Number.isFinite(start) || start === 0) start = -50;
  start = start < 0 ? Math.max(0, total + start) : start - 1;
  let end = to === null || to === undefined || to === "" ? total : Math.min(total, Number(to));
  if (!Number.isFinite(end)) end = total;
  end = Math.min(end, start + HISTORY_MAX_ROWS);
  return {
    session_id: sessionId,
    total_rows: total,
    from: start + 1,
    to: Math.max(start, end),
    rows: rows.slice(start, end).map((row, i) => presentRow(row, start + i)),
  };
}

// Case-insensitive search across every conversation (or one), newest match
// first, bounded. Archived conversations are included: this is history.
export function searchTranscripts(query, { sessionId = null, limit = 30 } = {}) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) throw new Error("query is required");
  ensure();
  const ids = sessionId ? [String(sessionId)] : readdirSync(TRANSCRIPTS_DIR)
    .filter((n) => n.endsWith(".jsonl")).map((n) => n.slice(0, -6)).filter((id) => SESSION_RE.test(id));
  const titles = new Map(readManifest().sessions.map((x) => [x.id, x.title]));
  const max = Math.max(1, Math.min(Number(limit) || 30, 200));
  const hits = [];
  for (const id of ids) {
    const rows = readRows(id, 10_000);
    rows.forEach((row, i) => {
      if (String(row.text || "").toLowerCase().includes(q)) hits.push({ ...presentRow(row, i, id), title: titles.get(id) || null });
    });
  }
  hits.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  return { query: String(query), searched_conversations: ids.length, total_matches: hits.length, matches: hits.slice(0, max) };
}

// Voice sessions: each Start Voice (not a reconnect) opens a numbered voice
// session inside the conversation. The marker is an ordinary transcript row, so
// the timeline divider, the checklist scoping and the model context all read
// the same record.
export const VOICE_SESSION_EVENT = "voice_session_start";

export function listVoiceSessions(sessionId) {
  if (!sessionId) return [];
  return readTranscript(sessionId, { limit: 10_000 })
    .filter((row) => row.metadata?.event === VOICE_SESSION_EVENT)
    .map((row) => ({
      id: row.metadata.voice_session_id,
      n: Number(row.metadata.n) || 0,
      started_at: row.ts,
      row_id: row.id,
    }));
}

export function currentVoiceSession(sessionId) {
  return listVoiceSessions(sessionId).at(-1) || null;
}

export function startVoiceSession(sessionId, { clientKey = "" } = {}) {
  const n = (listVoiceSessions(sessionId).at(-1)?.n || 0) + 1;
  const voiceSessionId = `vs-${n}-${randomUUID().slice(0, 8)}`;
  const entry = appendTranscript(sessionId, {
    role: "system",
    text: `Voice session ${n} started`,
    metadata: { event: VOICE_SESSION_EVENT, voice_session_id: voiceSessionId, n },
    clientKey,
  });
  // A replayed request returns the session the first request opened.
  if (entry.duplicate) return { id: entry.metadata.voice_session_id, n: entry.metadata.n, started_at: entry.ts, row_id: entry.id };
  return { id: voiceSessionId, n, started_at: entry.ts, row_id: entry.id };
}

// Mic mute changes become ordinary system rows so "what did you say since I
// muted?" has a timestamp to work from (public/muted-review.js reads them).
// Repeated states are skipped unless a mute begins a different period.
const MutedReview = globalThis.VA3MutedReview;
export const MIC_EVENT = MutedReview.MIC_EVENT;
const MIC_SOURCES = new Set(["button", "voice", "wake", "listen", "sleep", "reconnect", "start", "stop", "app"]);

export function recordMicState(sessionId, { muted, listening = false, source = "app", mute_period_id = null, overlapping_row_ids = [] } = {}) {
  if (!SESSION_RE.test(String(sessionId || ""))) throw new Error("Invalid session id");
  if (typeof muted !== "boolean") throw new Error("muted must be true or false");
  if (mute_period_id != null && (typeof mute_period_id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(mute_period_id))) throw new Error("Invalid mute period id");
  if (!Array.isArray(overlapping_row_ids) || overlapping_row_ids.length > 50 || overlapping_row_ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(id))) throw new Error("Invalid overlapping row ids");
  const rows = readRows(sessionId, Infinity);
  for (let i = rows.length - 1; i >= 0; i--) {
    const change = MutedReview.micChange(rows[i], { legacy: false });
    if (!change) continue;
    if (change.muted === muted && (!muted || (rows[i].metadata?.mute_period_id || null) === mute_period_id)) return { recorded: false, entry: null };
    break;
  }
  const entry = appendTranscript(sessionId, {
    role: "system",
    text: muted ? (listening ? "Mic muted (listen mode)" : "Mic muted") : "Mic unmuted",
    metadata: { event: MIC_EVENT, muted, listening: !!(muted && listening), source: MIC_SOURCES.has(source) ? source : "app", ...(muted && mute_period_id ? { mute_period_id } : {}), ...(muted && overlapping_row_ids.length ? { overlapping_row_ids: [...new Set(overlapping_row_ids)] } : {}) },
  });
  return { recorded: true, entry };
}

export function responsesSinceMute(sessionId, { limit, duringMuteOnly, offset, row } = {}) {
  if (!SESSION_RE.test(String(sessionId || ""))) throw new Error("Invalid session id");
  return { session_id: sessionId, ...MutedReview.selectSinceMute(readRows(sessionId, Infinity), { limit, duringMuteOnly, offset, row }) };
}
