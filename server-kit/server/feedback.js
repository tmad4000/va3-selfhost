// World Issue Tracker feedback adapter with a durable local queue.
//
// - Credentials are read only on the server, per request, and never
//   returned, logged, or stored in the queue. A user-initiated write uses the
//   user's linked Ideaflow ID bearer when present and valid (server/accounts.js),
//   otherwise the server-held WIT agent key; retries and follow-ups (system
//   writes) always use the agent key. Results say which identity posted.
// - Destinations are a server-owned allowlist of tracker slugs.
// - Every real submission is first written to DATA_DIR/feedback-queue.json, so
//   a failure keeps the full content with diagnostics and is retried with
//   backoff when the failure was transient.
// - Duplicates are prevented by an idempotency key (target + normalized
//   message): an already-filed request returns the existing issue. When an
//   attempt may have reached WIT without a usable answer (timeout, 5xx), the
//   issue's "VA3 feedback ref" marker is searched on WIT before posting again.
// - A URL is reported only for an issue WIT actually created or returned.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, env, PROJECT_ROOT } from "./env.js";
import { defaultIdentity, markRejected, witCredential, witSystemCredential } from "./accounts.js";
import { currentVoiceSession, transcriptTail } from "./transcripts.js";
import { publishUi } from "./ui-events.js";
import { getAsk, listAsks, pendingPlanningLabels, updateAsk } from "./asks.js";

const VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).version;
// WIT moved off Supabase on 2026-10-04 (https://worldissuetracker.com/llms.txt).
// The old sthqnyjniclvnflfkyio.supabase.co project is paused and no longer
// resolves, which is what broke feedback ("fetch failed" / ENOTFOUND).
const DEFAULT_BASE = "https://api.worldissuetracker.com/functions/v1";
const SITE = "https://worldissuetracker.com";
const QUEUE_FILE = join(DATA_DIR, "feedback-queue.json");
const RETRY_MINUTES = [1, 5, 15, 30, 60, 120, 240];
const MAX_AUTO_ATTEMPTS = 8;
const REQUEST_TIMEOUT_MS = 20_000;
// WIT's create-issue sometimes 409s with one of these codes when two writes
// land close together (undocumented storage-layer optimistic-concurrency
// conflict, not an application rejection like tracker_name_exists). It
// resolves on its own almost immediately, so retry inline a few times before
// falling back to the slower queue backoff. Filed as a WIT platform issue:
// https://worldissuetracker.com/issue/create-issue-returns-undocumented-409-snapshot_conflict-storage_request_conflict-under-concurrent-writes-with-no-retry-after
const CONFLICT_CODES = new Set(["snapshot_conflict", "storage_request_conflict"]);
const CONFLICT_RETRY_DELAYS_MS = [250, 750, 2000];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TARGETS = Object.freeze({
  "voice-assistant-v3": {
    slug: "voice-assistant-v3",
    name: "Voice Assistant v3",
    labels: ["product-feedback", "voice-assistant-v3"],
  },
  paseo: {
    slug: "paseo",
    name: "Paseo",
    labels: ["product-feedback", "paseo"],
  },
  "worldissuetracker-com": {
    slug: "worldissuetracker-com",
    name: "World Issue Tracker Platform Feedback",
    labels: ["product-feedback", "worldissuetracker-com"],
  },
});
const TITLE_MAX = 200;

// Title: the model's explicit title when given; otherwise the first line of
// the message, cut at a word boundary. Never append an ellipsis — WIT shows
// the title verbatim and the slug is derived from it.
export function feedbackTitle(message, explicitTitle) {
  const explicit = String(explicitTitle || "").trim().replace(/\s+/g, " ");
  if (explicit) return explicit.length <= TITLE_MAX ? explicit : cutAtWord(explicit, TITLE_MAX);
  const first = String(message).trim().split(/\n+/)[0].replace(/\s+/g, " ");
  return first.length <= TITLE_MAX ? first : cutAtWord(first, TITLE_MAX);
}
function cutAtWord(text, max) {
  const head = text.slice(0, max);
  const cut = head.lastIndexOf(" ") > max * 0.6 ? head.slice(0, head.lastIndexOf(" ")) : head;
  return cut.replace(/[\s,;:.\-–—]+$/, "");
}

export function feedbackTargets() {
  return Object.values(TARGETS).map(({ slug, name }) => ({ slug, name }));
}

function resolveTarget(target) {
  const slug = String(target || "voice-assistant-v3").trim().toLowerCase();
  const resolved = TARGETS[slug];
  if (!resolved) {
    throw new Error(`Unknown feedback target. Choose one of: ${Object.keys(TARGETS).join(", ")}`);
  }
  return resolved;
}

// FEEDBACK_PROVIDER: "wit" (default) | "stub". Under `node --test` the default
// is stub, like VISION_PROVIDER in vision-sync.js: a test that never sets the
// variable cannot file real issues (286 tracker issues were test noise before
// this). Tests that mock fetch set FEEDBACK_PROVIDER=wit explicitly.
export function feedbackProvider() {
  const explicit = env("FEEDBACK_PROVIDER");
  if (explicit) return explicit;
  return process.env.NODE_TEST_CONTEXT ? "stub" : "wit";
}

function apiBase() {
  return env("WIT_API_BASE", DEFAULT_BASE).replace(/\/+$/, "");
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
// Synchronous claim so two overlapping callers never post the same item.
function claimItem(id, staleMs = 120_000) {
  const db = loadQueue();
  const item = db.items.find((i) => i.id === id);
  if (!item || item.status === "filed") return null;
  if (item.status === "sending" && Date.now() - Date.parse(item.updated_at || 0) < staleMs) return null;
  item.status = "sending";
  item.updated_at = new Date().toISOString();
  saveQueue(db);
  return item;
}

function idempotencyKey(target, text) {
  const normalized = String(text).trim().replace(/\s+/g, " ").toLowerCase();
  return createHash("sha256").update(`${target}\n${normalized}`).digest("hex").slice(0, 16);
}

const metadataLine = (value) => String(value || "").replace(/[\r\n\u2028\u2029]+/g, " ").trim().slice(0, 200);

export function feedbackReporter({ identity, on_behalf_of, reporter_agent, origin = "explicit", sessionId, voiceSession } = {}) {
  const login = identity || defaultIdentity();
  const author = metadataLine(on_behalf_of) || (login === "local-owner" ? "Jacob" : metadataLine(login));
  const agent = metadataLine(reporter_agent) || `Voice Assistant v3 ${VERSION}`;
  return ["---", `Reported by: ${agent} (agent) on behalf of ${author}`,
    `Reporter kind: ${origin === "automatic" ? "automatic" : "agent"}`,
    `Source conversation: ${metadataLine(sessionId) || "unknown"} · voice session ${voiceSession?.n || "unknown"}`].join("\n");
}

// Update local occurrence metadata without changing/reposting an already filed issue.
export function updateAutomaticFeedback({ signature, first_seen, last_seen, count }) {
  const item = loadQueue().items.find((i) => i.origin === "automatic" && i.signature === signature && i.first_seen === first_seen);
  if (item) patchItem(item.id, { last_seen, count });
}

// ---------- transport ----------
function classify(error, response, body) {
  if (response) {
    const status = response.status;
    if (status === 429 || status >= 500) return { kind: "server", transient: true, ambiguous: status >= 500, http_status: status };
    // WIT's store returns the code as `error` ({ error: "snapshot_conflict" }),
    // not `code`; accept either so a live conflict is retried (2026-11-09).
    const conflictCode = [body?.code, body?.error].find((c) => CONFLICT_CODES.has(c));
    if (status === 409 && conflictCode) return { kind: "conflict", transient: true, ambiguous: false, http_status: status, code: conflictCode };
    return { kind: status === 401 || status === 403 ? "auth" : "rejected", transient: false, ambiguous: false, http_status: status };
  }
  const cause = error?.cause || {};
  const code = cause.code || error?.code || (error?.name === "TimeoutError" || error?.name === "AbortError" ? "TIMEOUT" : null);
  const ambiguous = code === "TIMEOUT" || code === "UND_ERR_SOCKET" || code === "ECONNRESET";
  return { kind: "network", transient: true, ambiguous, code: code || "UNKNOWN", host: cause.hostname || null };
}

function describe(diag, message) {
  if (diag.kind === "network") {
    const where = diag.host ? ` for ${diag.host}` : "";
    if (diag.code === "ENOTFOUND") return `DNS lookup failed${where} (ENOTFOUND)`;
    if (diag.code === "TIMEOUT") return "World Issue Tracker did not answer in time";
    return `Network error${where} (${diag.code})`;
  }
  return `World Issue Tracker returned HTTP ${diag.http_status}${message ? `: ${message}` : ""}`;
}

async function witFetch(path, init = {}) {
  return fetch(`${apiBase()}${path}`, {
    ...init,
    headers: {
      // Cloudflare in front of the WIT API rejects default library agents.
      "User-Agent": `voice-assistant-v3/${VERSION}`,
      "X-WIT-Client": "api",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

function presentIssue(issue) {
  const path = issue.canonical_issue_url || (issue.slug ? `/issue/${encodeURIComponent(issue.slug)}` : "");
  return {
    id: issue.id,
    slug: issue.slug,
    title: issue.title,
    status: issue.status,
    url: path ? new URL(path, SITE).href : null,
    tracker_slug: issue.tracker_slug,
    ...(issue.reporter ? { reporter: issue.reporter } : {}),
  };
}

// After an ambiguous attempt, look for our ref marker before posting again.
async function findExisting(item) {
  try {
    const res = await witFetch(`/get-issues?tracker_slug=${encodeURIComponent(item.tracker_slug)}&limit=50`);
    if (!res.ok) return null;
    const body = await res.json();
    const hit = (body.issues || []).find((issue) => String(issue.description || "").includes(item.ref_marker));
    return hit ? presentIssue(hit) : null;
  } catch {
    return null;
  }
}

function systemCredential() {
  try { return witSystemCredential(); } catch (error) { return { error: error.message }; }
}

async function attempt(item, cred = systemCredential()) {
  if (item.last_error?.ambiguous) {
    const existing = await findExisting(item);
    if (existing) return { ok: true, issue: existing, recovered: true, cred: null };
  }
  if (cred.error) {
    return { ok: false, diag: { kind: "config", transient: false, ambiguous: false }, message: cred.error, cred };
  }
  const result = await postIssue(item, cred);
  // WIT refused the user's Ideaflow ID token: stop using it, post with the
  // agent key now, and say so in the result.
  if (!result.ok && result.diag.kind === "auth" && cred.method === "ideaflow-id") {
    markRejected(cred.identity, "wit", result.message);
    const fallback = systemCredential();
    if (fallback.error) return { ...result, cred };
    const second = await postIssue(item, fallback);
    return { ...second, cred: { ...fallback, note: `Posted with the server agent key: World Issue Tracker refused the Ideaflow ID token (${result.message}). Sign in again.` } };
  }
  return { ...result, cred };
}

async function postIssue(item, cred) {
  for (let conflictAttempt = 0; ; conflictAttempt++) {
    let response;
    try {
      response = await witFetch("/create-issue", {
        method: "POST",
        headers: { ...cred.headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: item.title,
          description: item.description,
          original_text: item.original_text || undefined,
          tracker_slug: item.tracker_slug,
          issue_type: "other",
          priority: "medium",
          labels: item.labels,
          reporter: "Voice Assistant v3",
          // An unresolvable agent key must fail loudly, not post anonymously.
          require_account: true,
        }),
      });
    } catch (error) {
      const diag = classify(error);
      return { ok: false, diag, message: describe(diag) };
    }
    const body = await response.json().catch(() => ({}));
    if (response.ok && body.success && body.issue) return { ok: true, issue: presentIssue(body.issue) };
    const diag = classify(null, response, body);
    if (diag.kind === "conflict" && conflictAttempt < CONFLICT_RETRY_DELAYS_MS.length) {
      await sleep(CONFLICT_RETRY_DELAYS_MS[conflictAttempt]);
      continue;
    }
    const detail = body.code ? `${body.code}${body.message ? ` — ${body.message}` : ""}` : (body.message || body.error || "");
    return { ok: false, diag, message: describe(diag, detail) };
  }
}

// Cross-post a filed issue onto the boards it is *about* (secondary
// attachments; the origin board stays primary). 409 already_attached counts as
// done. Failures are recorded per board and retried on the next run of the item.
async function crossPost(item, issue, cred = systemCredential()) {
  const wanted = Array.isArray(item.cross_post_slugs) ? item.cross_post_slugs : [];
  const state = { ...(item.cross_posts || {}) };
  for (const slug of wanted) {
    if (state[slug]?.attached) continue;
    try {
      if (cred.error) throw new Error(cred.error);
      const res = await witFetch("/attach-to-tracker", {
        method: "POST",
        headers: { ...cred.headers, "Content-Type": "application/json" },
        body: JSON.stringify({ issue_id: issue.id, tracker_slug: slug }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok || body.code === "already_attached") state[slug] = { attached: true, at: new Date().toISOString() };
      else state[slug] = { attached: false, error: `HTTP ${res.status}${body.code ? ` ${body.code}` : ""}${body.error ? ` — ${body.error}` : ""}` };
    } catch (error) {
      const diag = classify(error);
      state[slug] = { attached: false, error: describe(diag) };
    }
  }
  return state;
}

function postedAs(cred) {
  return cred && !cred.error ? { method: cred.method, handle: cred.handle, label: cred.label, ...(cred.note ? { note: cred.note } : {}) } : null;
}

// `cred` is the requesting user's credential for this attempt only; without
// one (retry loop, manual retry) the agent key is used.
async function runItem(id, cred) {
  const existing = loadQueue().items.find((i) => i.id === id);
  if (existing?.status === "filed") {
    // Already filed: only finish any cross-posts that failed earlier.
    const pending = (existing.cross_post_slugs || []).some((slug) => !existing.cross_posts?.[slug]?.attached);
    return pending ? patchItem(id, { cross_posts: await crossPost(existing, existing.issue) }) : existing;
  }
  const item = claimItem(id);
  if (!item) return loadQueue().items.find((i) => i.id === id);
  const result = await attempt(item, cred || systemCredential());
  const attempts = (item.attempts || 0) + 1;
  if (result.ok) {
    const cross_posts = await crossPost(item, result.issue, result.cred && !result.cred.error ? result.cred : systemCredential());
    const filed = patchItem(id, {
      posted_as: postedAs(result.cred) || item.posted_as || null,
      status: "filed",
      attempts,
      issue: result.issue,
      cross_posts,
      filed_at: new Date().toISOString(),
      recovered_existing: !!result.recovered,
      filed_labels: result.recovered ? null : item.labels || [],
      next_retry_at: null,
    });
    if (item.session_id) {
      for (const ask of listAsks(item.session_id).filter((a) => a.feedback_id === id)) {
        const planning = ask.state === "planning";
        if (result.recovered || planning !== (item.labels || []).includes(PLANNING_LABEL)) {
          updateAsk(item.session_id, ask.id, { witPlanning: { planning, ok: false, error: "Label update pending", at: new Date().toISOString() } }, { origin: "wit" });
        }
      }
    }
    return filed;
  }
  const retryable = result.diag.transient && attempts < MAX_AUTO_ATTEMPTS;
  const wait = RETRY_MINUTES[Math.min(attempts - 1, RETRY_MINUTES.length - 1)];
  return patchItem(id, {
    status: "failed",
    attempts,
    last_error: { ...result.diag, message: result.message, at: new Date().toISOString(), base: apiBase() },
    next_retry_at: retryable ? new Date(Date.now() + wait * 60_000).toISOString() : null,
  });
}

function presentItem(item) {
  if (item.status === "filed") {
    return {
      filed: true,
      queue_id: item.id,
      ...item.issue,
      tracker_slug: item.tracker_slug,
      ...(item.cross_post_slugs?.length ? {
        also_on: item.cross_post_slugs.filter((slug) => item.cross_posts?.[slug]?.attached),
        cross_post_errors: Object.fromEntries(item.cross_post_slugs.filter((slug) => !item.cross_posts?.[slug]?.attached).map((slug) => [slug, item.cross_posts?.[slug]?.error || "not attempted"])),
      } : {}),
      app_version: VERSION,
      attempts: item.attempts,
      ...(item.posted_as ? { posted_as: item.posted_as.label, posted_with: item.posted_as.method, ...(item.posted_as.note ? { identity_note: item.posted_as.note } : {}) } : {}),
      ...(item.recovered_existing ? { note: "Found the issue already created by an earlier attempt; not posted twice." } : {}),
    };
  }
  const e = item.last_error;
  return {
    filed: false,
    queue_id: item.id,
    status: item.status,
    saved_for_retry: true,
    error: e?.message || (item.status === "sending" ? "a submission of this exact feedback is already in progress" : "not sent yet"),
    diagnostic: e ? { kind: e.kind, code: e.code, http_status: e.http_status, host: e.host, base: e.base } : null,
    attempts: item.attempts || 0,
    next_retry_at: item.next_retry_at || null,
    note: item.next_retry_at
      ? "Not filed. The full feedback is saved on the server and will be retried automatically; no issue URL exists yet."
      : "Not filed. The full feedback is saved on the server; call feedback_queue with retry_id to try again once the cause is fixed.",
  };
}

export async function submitFeedback({
  message,
  sessionId,
  includeTranscript = false,
  source = "app",
  target,
  about,
  title,
  originalText,
  identity,
  asSystem = false,
  on_behalf_of,
  reporter_agent,
  origin = "explicit",
  automatic,
  planning = false,
} = {}) {
  const text = String(message || "").trim();
  if (!text) throw new Error("Feedback message is required");
  const destination = resolveTarget(target);
  // `about` = the board the feedback concerns. The origin board (`target`)
  // stays primary; the about-board gets a secondary attachment (cross-post).
  const aboutBoard = about ? resolveTarget(about) : null;
  const crossPostSlugs = aboutBoard && aboutBoard.slug !== destination.slug ? [aboutBoard.slug] : [];
  origin = origin === "automatic" ? "automatic" : "explicit";
  const voiceSession = sessionId ? currentVoiceSession(sessionId) : null;
  const reporter = feedbackReporter({ identity, on_behalf_of, reporter_agent, origin, sessionId, voiceSession });

  const transcript = includeTranscript && sessionId
    ? transcriptTail(sessionId, { entries: 16, maxChars: 6_000 })
    : "";

  if (feedbackProvider() === "stub") {
    return {
      id: `feedback-stub-${Date.now().toString(36)}`,
      title: feedbackTitle(text, title),
      also_on: crossPostSlugs,
      status: "stubbed",
      posted_as: null,
      tracker_slug: destination.slug,
      app_version: VERSION,
      transcript_included: !!transcript,
      origin,
      reporter_metadata: reporter,
    };
  }

  // Automatic windows must be distinct from explicit feedback and from the
  // next 24h window, even when the error text is identical.
  const keyText = origin === "automatic" ? `automatic:${automatic.signature}:${automatic.first_seen}`
    : (on_behalf_of || reporter_agent) ? `${text}\nAuthor: ${metadataLine(on_behalf_of)}\nAgent: ${metadataLine(reporter_agent)}` : text;
  const id = `fb-${idempotencyKey(destination.slug, keyText)}`;
  const db = loadQueue();
  let item = db.items.find((i) => i.id === id);
  let planningResult = null;
  if (item && planning) planningResult = await setFeedbackPlanning({ idOrUrl: id, planning: true });
  if (item?.status === "filed") return { ...presentItem(item), duplicate: true, ...(planningResult ? { wit_planning: planningResult } : {}) };
  if (!item) {
    const marker = `VA3 feedback ref: ${id}`;
    item = {
      id,
      ref_marker: marker,
      tracker_slug: destination.slug,
      labels: [...destination.labels, ...(origin === "automatic" ? ["automatic", "tool-error"] : []), ...(planning ? [PLANNING_LABEL] : [])],
      title: feedbackTitle(text, title),
      cross_post_slugs: crossPostSlugs,
      cross_posts: {},
      description: [
        text,
        "---",
        `Submitted from Voice Assistant v3 v${VERSION}`,
        `Source: ${source}`,
        voiceSession ? `Voice session id: ${voiceSession.id}` : "",
        `Origin board: ${destination.name}`,
        aboutBoard && aboutBoard.slug !== destination.slug ? `About: ${aboutBoard.name} (cross-posted there)` : "",
        transcript ? `Recent transcript tail:\n\n${transcript}` : "",
      ].filter(Boolean).join("\n\n").slice(0, 20_000 - reporter.length - marker.length - 4) + `\n\n${marker}\n\n${reporter}`,
      original_text: originalText ? String(originalText).slice(0, 20_000) : null,
      session_id: sessionId || null,
      voice_session_id: voiceSession?.id || null,
      source,
      origin,
      reporter_metadata: reporter,
      ...(origin === "automatic" ? automatic : {}),
      transcript_included: !!transcript,
      status: "pending",
      attempts: 0,
      created_at: new Date().toISOString(),
    };
    db.items.push(item);
    saveQueue(db);
  }
  const after = await runItem(id, await requestCredential(identity, asSystem || origin === "automatic"));
  if (planning && after?.recovered_existing) planningResult = await setFeedbackPlanning({ idOrUrl: id, planning: true });
  return { ...presentItem(after), transcript_included: after.transcript_included, ...(planningResult ? { wit_planning: planningResult } : {}) };
}

async function requestCredential(identity, asSystem) {
  if (asSystem) return systemCredential();
  try { return await witCredential(identity || undefined); } catch (error) { return { error: error.message }; }
}

// Retry due items (transient failures past their backoff), or one item now.
export async function retryFeedback({ id } = {}) {
  if (feedbackProvider() === "stub") return [];
  const now = Date.now();
  const due = loadQueue().items.filter((i) => (
    i.status !== "filed"
    && (id ? i.id === id : (i.next_retry_at && Date.parse(i.next_retry_at) <= now))
  ));
  const results = [];
  for (const item of due) {
    const after = await runItem(item.id);
    results.push(presentItem(after));
    // The turn that filed it already said "saved for retry"; a later success
    // from the background loop reaches the conversation as a low-tier
    // notice (public/pending-queue.js). The URL is the one WIT returned.
    if (!id && after?.status === "filed" && after.issue?.url && item.session_id) {
      publishUi({
        type: "feedback_filed", session_id: item.session_id, queue_id: item.id, title: after.title || item.title || null,
        text: `[Feedback filed on retry] ${after.title || item.title || item.id} — ${after.issue.url}`,
      });
    }
  }
  if (!id) {
    for (const ask of pendingPlanningLabels()) await reflectAskPlanning(null, ask);
  }
  return results;
}

export function feedbackQueue({ includeFiled = false } = {}) {
  return loadQueue().items
    .filter((i) => includeFiled || i.status !== "filed")
    .map((i) => ({
      ...presentItem(i),
      title: i.title,
      tracker_slug: i.tracker_slug,
      created_at: i.created_at,
      queue_status: i.status,
      session_id: i.session_id || null,
      source: i.source || null,
      origin: i.origin || "explicit",
      ...(i.origin === "automatic" ? { signature: i.signature, first_seen: i.first_seen, last_seen: i.last_seen, count: i.count } : {}),
    }));
}

let retryTimer = null;
export function startFeedbackRetryLoop({ intervalMs = 60_000 } = {}) {
  if (retryTimer || feedbackProvider() === "stub") return;
  retryTimer = setInterval(() => {
    retryFeedback().catch((error) => console.warn(`[feedback] retry loop: ${error.message}`));
  }, intervalMs);
  retryTimer.unref();
}

// ---------- notes on existing feedback ----------
// Resolve a queue id (fb-…), a WIT issue URL, a slug, or an issue UUID to the
// WIT issue it names.
async function resolveIssue(ref) {
  const value = String(ref || "").trim();
  if (!value) throw new Error("id_or_url is required");
  const queued = loadQueue().items.find((i) => i.id === value || i.issue?.url === value || i.issue?.id === value || i.issue?.slug === value);
  if (queued?.status === "filed" && queued.issue?.id) return { issue: queued.issue, queueItem: queued };
  if (queued) return { issue: null, queueItem: queued };
  let key = value;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/issues?\/([^/?#]+)/) || url.pathname.match(/\/board\/[^/]+\/(?:issue\/)?([^/?#]+)/);
    if (!match) throw new Error(`Not a World Issue Tracker issue URL: ${value}`);
    key = decodeURIComponent(match[1]);
  } catch (error) {
    if (/^https?:/i.test(value)) throw error;
  }
  const res = await witFetch(`/get-issues?id=${encodeURIComponent(key)}&limit=1`);
  if (!res.ok) throw Object.assign(new Error(`World Issue Tracker returned HTTP ${res.status} looking up ${key}`), { lookup: true });
  const issue = (await res.json()).issues?.[0];
  if (!issue) throw new Error(`No World Issue Tracker issue ${key}`);
  return { issue: presentIssue(issue), queueItem: null };
}

// Append a note to existing feedback. WIT supports comments (create-comment),
// so the note becomes a comment on the issue. Feedback still waiting in the
// local queue gets the note added before it files. If the comment cannot be
// posted, a linked follow-up issue is filed through the durable queue. The
// result always says which of these happened.
export async function updateFeedback({ idOrUrl, note, sessionId, identity } = {}) {
  const text = String(note || "").trim();
  if (!text) throw new Error("note is required");
  if (feedbackProvider() === "stub") {
    return { ok: true, method: "stubbed", note: "Stub feedback provider: nothing was posted." };
  }
  const { issue, queueItem } = await resolveIssue(idOrUrl);
  if (!issue && queueItem) {
    const stamp = new Date().toISOString();
    patchItem(queueItem.id, { description: `${queueItem.description}\n\nUpdate ${stamp}:\n${text}`.slice(0, 20_000) });
    const after = await runItem(queueItem.id, await requestCredential(identity, false));
    return { ok: true, method: "queued_item_updated", ...presentItem(after), note_added: true, explanation: "That feedback had not been filed yet; the note was added to it before filing." };
  }
  let failure;
  const cred = await requestCredential(identity, false);
  try {
    if (cred.error) throw new Error(cred.error);
    const res = await witFetch("/create-comment", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cred.headers },
      // A signed-in user comments under their own WIT name; the agent key
      // keeps the "Voice Assistant v3" author label.
      body: JSON.stringify({ issue_id: issue.id, content: `${text}\n\n(Added from Voice Assistant v3 v${VERSION})`, ...(cred.method === "agent-key" ? { author_name: "Voice Assistant v3" } : {}) }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.success !== false) {
      return { ok: true, method: "comment", appended: true, issue_url: issue.url, issue_title: issue.title, comment_id: body.comment?.id || body.id || null, posted_as: cred.label, posted_with: cred.method, ...(cred.note ? { identity_note: cred.note } : {}) };
    }
    if ((res.status === 401 || res.status === 403) && cred.method === "ideaflow-id") markRejected(cred.identity, "wit", `HTTP ${res.status}`);
    failure = describe(classify(null, res), body.message || body.error);
  } catch (error) {
    failure = describe(classify(error), error.message);
  }
  const followUp = await submitFeedback({
    message: `Follow-up to ${issue.url || issue.id} (${issue.title || "earlier feedback"}):\n\n${text}`,
    title: `Follow-up: ${issue.title || "earlier feedback"}`.slice(0, 120),
    sessionId,
    source: "update_feedback follow-up",
    target: TARGETS[issue.tracker_slug] ? issue.tracker_slug : undefined,
    originalText: text,
    identity,
    asSystem: true,
  });
  return {
    ok: followUp.filed !== false,
    method: "follow_up",
    appended: false,
    comment_error: failure,
    original_url: issue.url,
    follow_up: followUp,
    explanation: `Could not add a comment (${failure}); filed a linked follow-up instead${followUp.filed ? "" : " (saved for retry)"}.`,
  };
}

// ---------- planning (not actionable) ----------
// World Issue Tracker has no planning status (statuses: open, acknowledged,
// in-progress, resolved, closed, none; checked 2026-11-09), and its lifecycle
// chips only know active / on-deck / paused / archived. A planning ask's issue
// keeps its status and carries the plain `planning` label instead; leaving
// planning removes the label. Known limitation: WIT's ready queue still lists
// a labelled open issue. Feedback still in the local queue gets the label
// before it files.
export const PLANNING_LABEL = "planning";
const PLANNING_COLOR = "#8b5cf6";

export async function setFeedbackPlanning({ idOrUrl, planning } = {}) {
  const want = Boolean(planning);
  if (!idOrUrl) return { ok: false, method: "none", error: "No WIT issue or queue id on this ask." };
  if (feedbackProvider() === "stub") return { ok: true, method: "stubbed", planning: want };
  let resolved;
  try {
    resolved = await resolveIssue(idOrUrl);
  } catch (error) {
    return { ok: false, method: "lookup", error: String(error.message || error) };
  }
  const { issue, queueItem } = resolved;
  if (!issue && queueItem) {
    const labels = (queueItem.labels || []).filter((l) => l !== PLANNING_LABEL);
    patchItem(queueItem.id, { labels: want ? [...labels, PLANNING_LABEL] : labels });
    return { ok: true, method: "queued_item_updated", planning: want, queue_id: queueItem.id };
  }
  const cred = systemCredential();
  if (cred.error) return { ok: false, method: "label", error: cred.error, issue_url: issue.url };
  try {
    const res = await witFetch(want ? "/add-label" : "/remove-label", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...cred.headers },
      body: JSON.stringify(want
        ? { issue_id: issue.id, name: PLANNING_LABEL, color: PLANNING_COLOR }
        : { issue_id: issue.id, slug: PLANNING_LABEL }),
    });
    const body = await res.json().catch(() => ({}));
    // Adding a label the issue already has is a no-op success for us.
    const already = want && (res.status === 409 || /duplicate|already/i.test(String(body.error || body.message || "")));
    if ((res.ok && body.success !== false) || already) {
      return { ok: true, method: want ? "label_added" : "label_removed", planning: want, label: PLANNING_LABEL, issue_url: issue.url, issue_id: issue.id };
    }
    return { ok: false, method: "label", error: describe(classify(null, res), body.message || body.error), issue_url: issue.url };
  } catch (error) {
    return { ok: false, method: "label", error: describe(classify(error), error.message), issue_url: issue.url };
  }
}

// An ask moved into or out of planning: mirror it on its WIT issue. Returns
// null when nothing changed or the ask has no WIT link. Never throws.
const planningUpdates = new Map();
export async function reflectAskPlanning(before, after) {
  if (!after || !(after.feedback_id || after.wit_url)) return null;
  const changed = (before?.state === "planning") !== (after.state === "planning");
  if (!changed && !(after.wit_planning && !after.wit_planning.ok)) return null;
  const key = `${after.session_id || ""}:${after.id || ""}`;
  const prior = planningUpdates.get(key) || Promise.resolve();
  const work = prior.catch(() => {}).then(async () => {
    const current = after.session_id && after.id ? getAsk(after.session_id, after.id) : after;
    if (!current) return null;
    const planning = current.state === "planning";
    let result = await setFeedbackPlanning({ idOrUrl: current.feedback_id || current.wit_url, planning });
    if (result.method === "queued_item_updated") {
      const filed = loadQueue().items.find((item) => item.id === result.queue_id && item.status === "filed");
      if (filed && (filed.filed_labels === null || planning !== (filed.filed_labels || []).includes(PLANNING_LABEL))) {
        result = { ok: false, method: "label", error: "Label update pending", planning };
      }
    }
    if (current.session_id && current.id) {
      const latest = getAsk(current.session_id, current.id);
      if (latest && (latest.state === "planning") === planning && latest.feedback_id === current.feedback_id && latest.wit_url === current.wit_url) {
        updateAsk(current.session_id, current.id, { witPlanning: { planning, ok: result.ok, error: result.error || null, at: new Date().toISOString() } }, { origin: "wit" });
      }
    }
    return result;
  });
  planningUpdates.set(key, work);
  try { return await work; } finally { if (planningUpdates.get(key) === work) planningUpdates.delete(key); }
}
