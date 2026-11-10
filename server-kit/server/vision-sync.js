// NotesStream Vision (https://vision.ideaflow.app) sync with a durable local
// queue. This is the ONLY module that talks to Vision; memory.js, tools.js and
// bin/vision-backfill.mjs all go through it. Verified request/response shapes
// are in docs/vision-sync.md.
//
// - The API key is read per request (VISION_API_KEY, else
//   ~/.config/notestream-vision/gmail-api-key) and is never returned, logged,
//   or stored in the queue.
// - Every real push is first written to DATA_DIR/vision-queue.json, so a
//   failure keeps the full note with diagnostics and is retried with backoff
//   when the failure was transient. The local memory item is never blocked.
// - Duplicates: one queue item per normalized note text. Saving the same words
//   again (a double tool call, memory_save + save_to_vision) returns the
//   existing Vision note. After an ambiguous attempt (timeout, 5xx) Vision is
//   searched for the exact body before posting again.
// - A Vision note id is reported only when Vision returned one.
// - Provenance: Vision itself marks API-key notes `authorship: "agent"`; the
//   body also gets a visible footer line and #via-voice-assistant.
// - VISION_PROVIDER=stub (and the default under `node --test`) never touches
//   the network; smoke and tests must never create real notes.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, env, PROJECT_ROOT, SELF_HOST } from "./env.js";
import { displayTimeZone } from "./settings.js";

const VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).version;
const DEFAULT_BASE = "https://vision.ideaflow.app/api";
const APP_URL = "https://vision.ideaflow.app";
const QUEUE_FILE = join(DATA_DIR, "vision-queue.json");
const RETRY_MINUTES = [1, 5, 15, 30, 60, 120, 240];
const MAX_AUTO_ATTEMPTS = 8;
const REQUEST_TIMEOUT_MS = 15_000;
const BODY_MAX = 20_000;
export const PROVENANCE_TAG = "via-voice-assistant";
const PROVENANCE_RE = /captured by voice|#via-voice-assistant\b|voice assistant v3/i;

export function visionProvider() {
  const explicit = env("VISION_PROVIDER");
  if (explicit) return explicit === "stub" ? "stub" : "vision";
  // Safety net: a test run that forgot to choose a provider must not post.
  return process.env.NODE_TEST_CONTEXT ? "stub" : "vision";
}

function apiBase() {
  return env("VISION_API_BASE", DEFAULT_BASE).replace(/\/+$/, "");
}

function apiKey() {
  const fromEnv = env("VISION_API_KEY");
  if (fromEnv) return { key: fromEnv, source: "env VISION_API_KEY" };
  if (SELF_HOST && !env("VISION_API_KEY_FILE")) return { error: "Set VISION_API_KEY or VISION_API_KEY_FILE explicitly for this installation" };
  const file = env("VISION_API_KEY_FILE", join(homedir(), ".config", "notestream-vision", "gmail-api-key"));
  try {
    const key = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (key) return { key, source: file.replace(homedir(), "~") };
  } catch { /* fall through */ }
  return { error: "No NotesStream Vision API key. Set VISION_API_KEY or place the key at ~/.config/notestream-vision/gmail-api-key" };
}

// ---------- provenance formatting ----------
export function normalizeTag(tag) {
  return String(tag || "").trim().replace(/^#+/, "").replace(/\s+/g, "").replace(/[^\p{L}\p{N}_-]/gu, "");
}

function hasTag(text, tag) {
  // normalizeTag leaves only letters, digits, _ and -, none special here.
  return new RegExp(`(?:^|\\s)#${tag}(?![\\p{L}\\p{N}_-])`, "iu").test(text);
}

export function hasProvenance(text) {
  return PROVENANCE_RE.test(String(text || ""));
}

// "2026-11-01 05:53 PST" in the tracked display zone (time_display; Pacific
// by default, VA3_TIMEZONE when set).
export function formatLocalTime(date = new Date(), timeZone = displayTimeZone()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

// Jacob's words stay verbatim (only surrounding whitespace is trimmed). Extra
// tags not already in the text, and the provenance footer, go on one line
// after a blank line. Text that already carries provenance gets no footer.
export function visionBody(text, { tags = [], at = new Date(), timeZone, note } = {}) {
  const words = String(text || "").trim();
  const missing = [...new Set(tags.map(normalizeTag).filter(Boolean))].filter((t) => !hasTag(words, t));
  if (hasProvenance(words)) {
    return missing.length ? `${words}\n\n${missing.map((t) => `#${t}`).join(" ")}` : words;
  }
  const extra = missing.filter((t) => t.toLowerCase() !== PROVENANCE_TAG);
  const when = formatLocalTime(at, timeZone);
  const footer = [
    `— captured by voice (Voice Assistant v3), ${when}${note ? `; ${note}` : ""}`,
    `#${PROVENANCE_TAG}`,
    ...extra.map((t) => `#${t}`),
  ].join(" ");
  return `${words}\n\n${footer}`;
}

function contentKey(text) {
  const normalized = String(text).trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ---------- durable queue ----------
function loadQueue() {
  if (!existsSync(QUEUE_FILE)) return { version: 1, items: [] };
  try { return JSON.parse(readFileSync(QUEUE_FILE, "utf8")); } catch { return { version: 1, items: [] }; }
}
function saveQueue(db) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${QUEUE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, QUEUE_FILE);
}
function patchItem(id, patch) {
  const db = loadQueue();
  const item = db.items.find((i) => i.id === id);
  if (!item) return null;
  Object.assign(item, patch, { updated_at: new Date().toISOString() });
  saveQueue(db);
  return item;
}
function claimItem(id, staleMs = 120_000) {
  const db = loadQueue();
  const item = db.items.find((i) => i.id === id);
  if (!item || item.status === "synced") return null;
  if (item.status === "sending" && Date.now() - Date.parse(item.updated_at || 0) < staleMs) return null;
  item.status = "sending";
  item.updated_at = new Date().toISOString();
  saveQueue(db);
  return item;
}

// memory.js registers here to stamp vision_note_id onto its items; keeping the
// dependency one-way avoids an import cycle.
const syncedListeners = new Set();
export function onVisionSynced(fn) {
  syncedListeners.add(fn);
  return () => syncedListeners.delete(fn);
}
function notifySynced(item) {
  for (const fn of syncedListeners) {
    try { fn(item); } catch (error) { console.warn(`[vision] synced listener: ${error.message}`); }
  }
}

// ---------- transport ----------
function classify(error, response) {
  if (response) {
    const status = response.status;
    if (status === 429 || status >= 500) return { kind: "server", transient: true, ambiguous: status >= 500, http_status: status };
    return { kind: status === 401 || status === 403 ? "auth" : "rejected", transient: false, ambiguous: false, http_status: status };
  }
  const cause = error?.cause || {};
  const code = cause.code || error?.code || (error?.name === "TimeoutError" || error?.name === "AbortError" ? "TIMEOUT" : null);
  const ambiguous = code === "TIMEOUT" || code === "UND_ERR_SOCKET" || code === "ECONNRESET";
  return { kind: "network", transient: true, ambiguous, code: code || "UNKNOWN", host: cause.hostname || null };
}

function describe(diag, detail) {
  if (diag.kind === "config") return detail;
  if (diag.kind === "network") {
    const where = diag.host ? ` for ${diag.host}` : "";
    if (diag.code === "ENOTFOUND") return `DNS lookup failed${where} (ENOTFOUND)`;
    if (diag.code === "TIMEOUT") return "NotesStream Vision did not answer in time";
    return `Network error${where} (${diag.code})`;
  }
  return `NotesStream Vision returned HTTP ${diag.http_status}${detail ? `: ${detail}` : ""}`;
}

async function visionFetch(path, { method = "GET", body, key } = {}) {
  return fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      "X-API-Key": key,
      "User-Agent": `voice-assistant-v3/${VERSION}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

// Note ids (newest first) whose text contains `text`, among Jacob's own notes.
export async function searchVision(text, { pageSize = 10 } = {}) {
  if (visionProvider() === "stub") return [];
  const cred = apiKey();
  if (cred.error) throw new Error(cred.error);
  const res = await visionFetch("/search", {
    method: "POST",
    key: cred.key,
    body: { ast: { visibility: "my-world", author: { op: "me" }, text: String(text).slice(0, 200), sortBy: "newest" }, page: 1, pageSize },
  });
  if (!res.ok) throw new Error(describe(classify(null, res)));
  const body = await res.json();
  return (body.notes || []).map((n) => n.id);
}

export async function readVisionBody(id) {
  if (visionProvider() === "stub") return null;
  const cred = apiKey();
  if (cred.error) throw new Error(cred.error);
  const res = await visionFetch(`/notes/${encodeURIComponent(id)}/body`, { key: cred.key });
  if (!res.ok) throw new Error(describe(classify(null, res)));
  return res.json();
}

// After an ambiguous attempt, find a note whose body is exactly ours.
async function findExisting(item) {
  try {
    const probe = item.body_md.split("\n")[0].slice(0, 120);
    for (const id of await searchVision(probe, { pageSize: 5 })) {
      const note = await readVisionBody(id);
      if (note && String(note.bodyMd).trim() === item.body_md.trim()) return { id, bodyVersion: note.bodyVersion };
    }
  } catch { /* fall through to a fresh post */ }
  return null;
}

async function createNote(item) {
  if (visionProvider() === "stub") {
    return { ok: true, note: { id: `vision-stub-${item.id.slice(3)}`, bodyVersion: 1 }, stub: true };
  }
  const cred = apiKey();
  if (cred.error) return { ok: false, diag: { kind: "config", transient: false, ambiguous: false }, message: cred.error };
  if (item.last_error?.ambiguous) {
    const existing = await findExisting(item);
    if (existing) return { ok: true, note: existing, recovered: true };
  }
  let response;
  try {
    response = await visionFetch("/notes/md", { method: "POST", key: cred.key, body: { bodyMd: item.body_md } });
  } catch (error) {
    const diag = classify(error);
    return { ok: false, diag, message: describe(diag) };
  }
  const body = await response.json().catch(() => ({}));
  const id = body?.note?.id;
  if (response.ok && id) return { ok: true, note: { id, bodyVersion: body.bodyVersion ?? null } };
  const diag = response.ok ? { kind: "rejected", transient: true, ambiguous: true, http_status: response.status } : classify(null, response);
  const detail = response.ok ? "response had no note id" : (body.message || body.error || "");
  return { ok: false, diag, message: describe(diag, detail) };
}

async function runItem(id) {
  const item = claimItem(id);
  if (!item) return loadQueue().items.find((i) => i.id === id);
  const result = await createNote(item);
  const attempts = (item.attempts || 0) + 1;
  if (result.ok) {
    const synced = patchItem(id, {
      status: "synced",
      attempts,
      vision_note_id: result.note.id,
      body_version: result.note.bodyVersion ?? null,
      synced_at: new Date().toISOString(),
      recovered_existing: !!result.recovered,
      stub: !!result.stub,
      next_retry_at: null,
    });
    notifySynced(synced);
    return synced;
  }
  const retryable = result.diag.transient && attempts < MAX_AUTO_ATTEMPTS;
  const wait = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
  console.warn(`[vision] ${id} not synced (attempt ${attempts}): ${result.message}`);
  return patchItem(id, {
    status: "failed",
    attempts,
    last_error: { ...result.diag, message: result.message, at: new Date().toISOString(), base: apiBase() },
    next_retry_at: retryable ? new Date(Date.now() + wait * 60_000).toISOString() : null,
  });
}

export function presentVisionItem(item) {
  if (!item) return null;
  if (item.status === "synced") {
    return {
      synced: true,
      queue_id: item.id,
      vision_note_id: item.vision_note_id,
      vision_synced_at: item.synced_at,
      app_url: APP_URL,
      attempts: item.attempts,
      ...(item.stub ? { stub: true, note: "Stub Vision provider: nothing was posted." } : {}),
      ...(item.recovered_existing ? { note: "Found the note already created by an earlier attempt; not posted twice." } : {}),
    };
  }
  const e = item.last_error;
  return {
    synced: false,
    queue_id: item.id,
    status: item.status,
    saved_locally: true,
    error: e?.message || (item.status === "sending" ? "sync to Vision is still in progress" : "not sent yet"),
    diagnostic: e ? { kind: e.kind, code: e.code, http_status: e.http_status, host: e.host } : null,
    attempts: item.attempts || 0,
    next_retry_at: item.next_retry_at || null,
    note: item.status === "sending"
      ? "Saved locally; Vision sync still in progress. No Vision note id yet."
      : item.next_retry_at
        ? "Saved locally; Vision sync pending. It will be retried automatically; no Vision note id yet."
        : "Saved locally; Vision sync failed and will not retry on its own. Use vision_sync_status with retry_id once the cause is fixed.",
  };
}

// Synchronously records the note in the durable queue (before any network),
// returning the queue item. Same text → same item.
export function queueVisionNote({ text, tags = [], memoryId, source = "app", at = new Date(), note } = {}) {
  const words = String(text || "").trim();
  if (!words) throw new Error("Note text is required");
  const id = `vs-${contentKey(words)}`;
  const db = loadQueue();
  let item = db.items.find((i) => i.id === id);
  if (item) {
    if (memoryId && !item.memory_ids.includes(memoryId)) {
      item.memory_ids.push(memoryId);
      item.updated_at = new Date().toISOString();
      saveQueue(db);
    }
    return { item, duplicate: true };
  }
  item = {
    id,
    text: words.slice(0, BODY_MAX),
    tags: tags.map(normalizeTag).filter(Boolean),
    body_md: visionBody(words, { tags, at, note }).slice(0, BODY_MAX),
    memory_ids: memoryId ? [memoryId] : [],
    source,
    provider: visionProvider(),
    status: "pending",
    attempts: 0,
    created_at: new Date().toISOString(),
  };
  db.items.push(item);
  saveQueue(db);
  return { item, duplicate: false };
}

// Queue + push. Resolves with the presented result; never throws for network
// failures (they are queued for retry).
export async function pushToVision(options = {}) {
  const { item, duplicate } = queueVisionNote(options);
  if (item.status === "synced") {
    notifySynced(item); // stamp any newly linked memory item
    return { ...presentVisionItem(item), duplicate: true };
  }
  const after = await runItem(item.id);
  return { ...presentVisionItem(after), ...(duplicate ? { duplicate: true } : {}) };
}

// Waits at most `ms` for a pending push; on timeout reports the queued state.
export async function waitForVision(promise, ms = 6_000) {
  if (!promise) return null;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  const result = await Promise.race([promise.catch((error) => ({ synced: false, error: error.message })), timeout]);
  clearTimeout(timer);
  if (result) return result;
  return { synced: false, status: "sending", saved_locally: true, note: "Saved locally; Vision sync still in progress. No Vision note id yet." };
}

export async function retryVision({ id } = {}) {
  const now = Date.now();
  const due = loadQueue().items.filter((i) => (
    i.status !== "synced"
    && (id ? i.id === id : (i.next_retry_at && Date.parse(i.next_retry_at) <= now))
  ));
  const results = [];
  for (const item of due) results.push(presentVisionItem(await runItem(item.id)));
  return results;
}

export function visionQueue({ includeSynced = false } = {}) {
  return loadQueue().items
    .filter((i) => includeSynced || i.status !== "synced")
    .map((i) => ({ ...presentVisionItem(i), text: i.text.slice(0, 200), memory_ids: i.memory_ids, created_at: i.created_at, source: i.source }));
}

export function visionSyncStatus() {
  const items = loadQueue().items;
  const count = (fn) => items.filter(fn).length;
  const cred = visionProvider() === "stub" ? { source: "stub" } : apiKey();
  return {
    provider: visionProvider(),
    base: apiBase(),
    key_configured: !cred.error,
    synced: count((i) => i.status === "synced"),
    pending: count((i) => i.status === "pending" || i.status === "sending" || (i.status === "failed" && i.next_retry_at)),
    failed: count((i) => i.status === "failed" && !i.next_retry_at),
    unsynced: visionQueue(),
  };
}

let retryTimer = null;
export function startVisionRetryLoop({ intervalMs = 60_000 } = {}) {
  if (retryTimer || visionProvider() === "stub") return;
  retryTimer = setInterval(() => {
    retryVision().catch((error) => console.warn(`[vision] retry loop: ${error.message}`));
  }, intervalMs);
  retryTimer.unref();
}
