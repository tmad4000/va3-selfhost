// Wakeups: "remind me in ten minutes", delivered back into the conversation.
//
// Paseo owns the clock (design note 2026-10-28, section 10): every wakeup is a
// one-run Paseo schedule, so it survives VA3 restarts and shows in Paseo's
// schedule list. There is no native timer. By default the schedule targets the
// conversation's session agent (a Paseo heartbeat on that agent); the fired
// prompt tells the agent to POST the announcement to
// /api/conversations/:id/announce with a server-issued per-conversation token.
// VA3 owns delivery: the announcement becomes a transcript row and a UI event
// the browser speaks.
//
// Each wakeup is also an ask in the conversation ledger (server/asks.js), so a
// pending wakeup is visible in the checklist and a missed one turns blocked
// with the schedule's own run status instead of silently vanishing.
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { DATA_DIR, env } from "./env.js";
import { execPaseo, paseoBin, paseoEnv, paseoStatus, providerMode, startPaseoSweep } from "./agents.js";
import { ensureSessionAgent } from "./session-agent.js";
import { createAsk, updateAsk } from "./asks.js";
import { appendTranscript } from "./transcripts.js";
import { displayTimeZone } from "./settings.js";
import { publishUi, uiClientCount } from "./ui-events.js";

const pexec = promisify(execFile);
const WAKEUPS_FILE = join(DATA_DIR, "wakeups.json");
const TOKENS_FILE = join(DATA_DIR, "announce-tokens.json");
const SESSION_RE = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_AHEAD_MS = 366 * 24 * 3600_000;
const ACTIVE = new Set(["scheduled"]);

// The tracked display zone (time_display in server/settings.js; Pacific by
// default, VA3_TIMEZONE when set). Times without a zone are read in it.
function timezone() {
  return displayTimeZone() || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function requireSessionId(sessionId) {
  const id = String(sessionId || "");
  if (!SESSION_RE.test(id)) throw new Error("A wakeup needs an active conversation.");
  return id;
}

function clip(value, max) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------- storage ----------
function writeJson(file, data, mode) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  renameSync(tmp, file);
}

function load() {
  if (!existsSync(WAKEUPS_FILE)) return { version: 1, items: [] };
  try { return JSON.parse(readFileSync(WAKEUPS_FILE, "utf8")); } catch { return { version: 1, items: [] }; }
}

function patch(id, fields) {
  const db = load();
  const item = db.items.find((w) => w.id === id);
  if (!item) return null;
  Object.assign(item, fields, { updated_at: new Date().toISOString() });
  writeJson(WAKEUPS_FILE, db);
  return item;
}

// ---------- announce tokens ----------
// One random token per conversation, server-side only (mode 600). It is put in
// the scheduled prompt so the agent that fires can announce into exactly that
// conversation; nothing else needs it.
function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return {};
  try { return JSON.parse(readFileSync(TOKENS_FILE, "utf8")); } catch { return {}; }
}

export function announceToken(sessionId) {
  const id = requireSessionId(sessionId);
  const tokens = loadTokens();
  if (!tokens[id]) {
    tokens[id] = randomBytes(24).toString("hex");
    writeJson(TOKENS_FILE, tokens, 0o600);
    try { chmodSync(TOKENS_FILE, 0o600); } catch { /* best effort */ }
  }
  return tokens[id];
}

export function verifyAnnounceToken(sessionId, token) {
  const expected = loadTokens()[String(sessionId || "")];
  if (!expected || !token) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---------- time ----------
function zoneOffsetMs(date, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// Wall-clock time in `zone` -> Date.
function zonedDate(y, mo, d, h, mi, zone) {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - zoneOffsetMs(new Date(guess), zone);
  return new Date(guess - zoneOffsetMs(new Date(first), zone));
}

function zonedParts(date, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { y: +parts.year, mo: +parts.month - 1, d: +parts.day };
}

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

// Accepts "in 10 minutes", "10m", "2h30m", "90 seconds", an ISO 8601 time
// (with or without offset; no offset = Jacob's time zone), or a clock time
// ("15:30", "3pm", "3:30 pm") meaning its next occurrence.
export function parseWhen(when, now = new Date()) {
  const raw = String(when ?? "").trim().toLowerCase().replace(/^in\s+/, "").replace(/\s+from now$/, "");
  if (!raw) throw new Error("when is required (for example \"in 10 minutes\", \"15:30\", or an ISO time)");
  const zone = timezone();
  const relative = raw.replace(/\band\b|,/g, " ").match(/^(?:\d+(?:\.\d+)?\s*(?:s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)\s*)+$/);
  if (relative) {
    let ms = 0;
    for (const [, n, unit] of raw.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/g)) ms += Number(n) * UNIT_MS[unit[0]];
    return new Date(now.getTime() + ms);
  }
  const clock = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (clock && (clock[2] || clock[3])) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] || 0);
    if (clock[3] === "pm" && hour < 12) hour += 12;
    if (clock[3] === "am" && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) throw new Error(`Not a clock time: ${when}`);
    const today = zonedParts(now, zone);
    let at = zonedDate(today.y, today.mo, today.d, hour, minute, zone);
    if (at.getTime() <= now.getTime()) at = zonedDate(today.y, today.mo, today.d + 1, hour, minute, zone);
    return at;
  }
  const iso = String(when).trim().match(/^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/i);
  if (iso) return zonedDate(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], zone);
  const parsed = new Date(String(when).trim());
  if (Number.isNaN(parsed.getTime())) throw new Error(`Could not understand the time "${when}". Use "in 10 minutes", "15:30", or an ISO time.`);
  return parsed;
}

// Cron has minute granularity: fire at the start of the minute at or after the
// requested time, never sooner than ~20 s from now.
export function fireTime(requested, now = new Date()) {
  const at = new Date(Math.ceil(requested.getTime() / 60_000) * 60_000);
  while (at.getTime() - now.getTime() < 20_000) at.setTime(at.getTime() + 60_000);
  return at;
}

export function cronFor(at) {
  return `${at.getUTCMinutes()} ${at.getUTCHours()} ${at.getUTCDate()} ${at.getUTCMonth() + 1} *`;
}

export function localTimeLabel(at) {
  return at.toLocaleString("en-US", { timeZone: timezone(), weekday: "short", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
}

// ---------- Paseo ----------
async function runPaseo(args, { agentId, timeout = 15_000 } = {}) {
  const bin = await paseoBin();
  if (!bin) throw new Error("Paseo CLI not found");
  const childEnv = paseoEnv();
  if (agentId) childEnv.PASEO_AGENT_ID = agentId; // heartbeat create targets this agent
  const stdout = await execPaseo(bin, args, { timeout, env: childEnv });
  const text = stdout.trim();
  const start = text.search(/[[{]/);
  if (start < 0) return { text };
  try { return JSON.parse(text.slice(start)); } catch { return { text }; }
}

function announceBase() {
  return env("VA3_ANNOUNCE_BASE", `http://127.0.0.1:${env("VA3_ACTUAL_PORT", env("PORT", "8732"))}`).replace(/\/+$/, "");
}

export function wakeupPrompt({ wakeup, token }) {
  const url = `${announceBase()}/api/conversations/${wakeup.session_id}/announce`;
  const body = JSON.stringify({ wakeup_id: wakeup.id, text: wakeup.message });
  return `[VA3 wakeup ${wakeup.id}] Jacob asked his Voice Assistant to tell him this at ${wakeup.fire_label}: ${JSON.stringify(wakeup.message)}

Deliver it now: run this command once. It posts the announcement into his Voice Assistant conversation, which speaks it aloud.

curl -sS -X POST '${url}' -H 'Content-Type: application/json' -H 'X-VA3-Client: 1' -H 'X-VA3-Announce-Token: ${token}' --data-binary @- <<'VA3_ANNOUNCE'
${body}
VA3_ANNOUNCE

If the reminder asks you to check or do something first, do that, then send the same command with your result as "text" (one or two plain spoken sentences). Reply with the command's JSON output. Do not create other schedules.`;
}

async function targetAgent(sessionId, wanted) {
  if (wanted === "new_agent") return { kind: "new_agent" };
  try {
    const { record } = await ensureSessionAgent({ sessionId });
    if (record.provider === "paseo" && record.external_id) {
      return { kind: "session_agent", agent_id: record.id, external_id: record.external_id };
    }
    return { kind: "new_agent", note: `The session agent runs on ${record.provider}, not Paseo, so a one-shot Paseo agent will deliver this wakeup.` };
  } catch (error) {
    return { kind: "new_agent", note: `No session agent (${clip(error.message, 160)}); a one-shot Paseo agent will deliver this wakeup.` };
  }
}

export async function scheduleWakeup({ sessionId, when, message, target } = {}) {
  const session = requireSessionId(sessionId);
  const text = clip(message, 1_000);
  if (!text) throw new Error("message is required: what should be said when it fires");
  if (target && !["session_agent", "new_agent"].includes(target)) throw new Error("target must be session_agent or new_agent");
  const now = new Date();
  const at = fireTime(parseWhen(when, now), now);
  if (at.getTime() - now.getTime() > MAX_AHEAD_MS) throw new Error("Wakeups can be at most a year ahead.");

  // The clock is Paseo's: if its daemon is unhealthy, say so; never queue locally.
  // A fresh probe, not the cached one: scheduling must not trust stale health.
  const health = await paseoStatus({ fresh: true });
  if (!health.available) {
    return {
      ok: false,
      scheduled: false,
      error: `The Paseo daemon is not healthy (${health.detail || "no detail"}), so the wakeup was NOT scheduled. Nothing is queued; ask again once Paseo is running.`,
    };
  }

  const id = `wk-${randomBytes(4).toString("hex")}`;
  const wakeup = {
    id,
    session_id: session,
    message: text,
    requested: String(when),
    fire_at: at.toISOString(),
    fire_label: localTimeLabel(at),
    created_at: now.toISOString(),
    status: "scheduled",
  };
  const chosen = await targetAgent(session, target || "session_agent");
  const prompt = wakeupPrompt({ wakeup, token: announceToken(session) });
  const expires = `${Math.ceil((at.getTime() - now.getTime()) / 60_000) + 30}m`;
  const name = `VA3 wakeup ${id} · ${clip(text, 60)}`;
  const common = ["--cron", cronFor(at), "--timezone", "UTC", "--max-runs", "1", "--expires-in", expires, "--name", name, "--json"];
  let created;
  try {
    created = chosen.kind === "session_agent"
      ? await runPaseo(["heartbeat", "create", ...common, prompt], { agentId: chosen.external_id })
      : await runPaseo(["schedule", "create", ...common,
        "--provider", env("VA3_WAKEUP_PROVIDER", "claude"),
        "--mode", providerMode(env("VA3_WAKEUP_PROVIDER", "claude"), "auto"),
        "--cwd", env("VA3_SESSION_AGENT_CWD", join(homedir(), "code", "tmpworkspace")),
        prompt]);
  } catch (error) {
    return { ok: false, scheduled: false, error: `Paseo refused the schedule: ${clip(error.stderr || error.message, 300)}. Nothing was scheduled.` };
  }
  const scheduleId = created?.id || created?.schedule?.id;
  if (!scheduleId) return { ok: false, scheduled: false, error: `Paseo did not return a schedule id (${clip(created?.text || JSON.stringify(created), 200)}). Nothing was scheduled.` };

  Object.assign(wakeup, {
    schedule_id: scheduleId,
    target: chosen.kind,
    target_agent_id: chosen.agent_id || null,
    target_external_id: chosen.external_id || null,
  });
  try {
    const ask = createAsk(session, {
      text: `Wakeup at ${wakeup.fire_label}: ${text}`,
      state: "in_progress",
      evidence: `Paseo schedule ${scheduleId} created (${chosen.kind === "session_agent" ? `heartbeat on session agent ${chosen.external_id}` : "one-shot agent"}).`,
      remaining: `Waiting for it to fire at ${wakeup.fire_label} and announce.`,
      owner: chosen.kind === "session_agent" ? { kind: "session_agent", id: chosen.agent_id, external_id: chosen.external_id, label: "Session agent" } : null,
      origin: "schedule_wakeup",
    });
    wakeup.ask_id = ask.id;
  } catch (error) {
    wakeup.ask_error = clip(error.message, 200);
  }
  const db = load();
  db.items.push(wakeup);
  writeJson(WAKEUPS_FILE, db);
  return {
    ok: true,
    scheduled: true,
    ...presentWakeup(wakeup),
    ...(chosen.note ? { note: chosen.note } : {}),
  };
}

function presentWakeup(w, live) {
  return {
    id: w.id,
    message: w.message,
    fire_at: w.fire_at,
    fire_label: w.fire_label,
    status: w.status,
    schedule_id: w.schedule_id,
    target: w.target,
    ...(w.target_external_id ? { target_agent: w.target_external_id } : {}),
    ...(w.ask_id ? { ask_id: w.ask_id } : {}),
    ...(w.delivered_at ? { delivered_at: w.delivered_at, transcript_row_id: w.transcript_row_id } : {}),
    ...(w.error ? { error: w.error } : {}),
    ...(live ? { paseo: live } : {}),
  };
}

function presentRun(info) {
  const last = (info.runs || []).at(-1);
  return {
    status: info.status || "unknown",
    next_run_at: info.nextRunAt || null,
    last_run: last ? { status: last.status, started_at: last.startedAt, ended_at: last.endedAt, error: last.error || null, agent_id: last.agentId || null } : null,
  };
}

// Paseo's CLI hides agent-target schedules (heartbeats) from `schedule ls` and
// `schedule inspect` (client-side filter in paseo 0.10), so for those the
// daemon's own schedule record is read, read-only. Writes always go through
// the CLI.
function scheduleRecordFile(scheduleId) {
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(String(scheduleId))) return null;
  const dir = env("VA3_PASEO_SCHEDULES_DIR", join(env("PASEO_HOME", join(homedir(), ".paseo")), "schedules"));
  return join(dir, `${scheduleId}.json`);
}

async function inspectSchedule(scheduleId) {
  try {
    return presentRun(await runPaseo(["schedule", "inspect", scheduleId, "--json"], { timeout: 8_000 }));
  } catch (error) {
    const file = scheduleRecordFile(scheduleId);
    if (file && existsSync(file)) {
      try { return { ...presentRun(JSON.parse(readFileSync(file, "utf8"))), via: "paseo schedule record" }; } catch { /* fall through */ }
    }
    const text = String(error.stderr || error.stdout || error.message || error);
    return { status: /not found|no such/i.test(text) ? "gone" : "unknown", error: clip(text, 200) };
  }
}

export async function listWakeups({ sessionId, includeFinished = false } = {}) {
  const items = load().items
    .filter((w) => !sessionId || w.session_id === sessionId)
    .filter((w) => includeFinished || ACTIVE.has(w.status) || w.status === "missed")
    .slice(-30);
  const rows = await Promise.all(items.map(async (w) => presentWakeup(w, ACTIVE.has(w.status) ? await inspectSchedule(w.schedule_id) : null)));
  return { wakeups: rows, time_zone: timezone(), now: localTimeLabel(new Date()) };
}

export async function cancelWakeup({ id, sessionId } = {}) {
  const wakeup = load().items.find((w) => w.id === String(id || "") || w.schedule_id === String(id || ""));
  if (!wakeup || (sessionId && wakeup.session_id !== sessionId)) throw new Error(`No wakeup ${id} in this conversation`);
  if (!ACTIVE.has(wakeup.status) && wakeup.status !== "missed") return { ok: true, already: wakeup.status, ...presentWakeup(wakeup) };
  let deleted = true;
  let detail = "";
  try {
    await runPaseo(["schedule", "delete", wakeup.schedule_id, "--json"]);
  } catch (error) {
    detail = clip(error.stderr || error.message, 200);
    deleted = /not found|no such/i.test(detail); // already gone counts as deleted
  }
  if (!deleted) return { ok: false, error: `Paseo could not delete schedule ${wakeup.schedule_id}: ${detail}. The wakeup may still fire.` };
  const updated = patch(wakeup.id, { status: "cancelled", cancelled_at: new Date().toISOString() });
  if (wakeup.ask_id) {
    try {
      updateAsk(wakeup.session_id, wakeup.ask_id, { state: "done", evidence: `Cancelled; Paseo schedule ${wakeup.schedule_id} deleted${detail ? " (was already gone)" : ""}.`, remaining: "" }, { origin: "cancel_wakeup" });
    } catch { /* the ledger never blocks a cancel */ }
  }
  return { ok: true, cancelled: true, ...presentWakeup(updated) };
}

// ---------- delivery ----------
// Called by POST /api/conversations/:id/announce. Idempotent per wakeup: a
// retried POST returns the row written the first time.
export function announce(sessionId, { text, wakeupId, token } = {}) {
  const session = requireSessionId(sessionId);
  if (!verifyAnnounceToken(session, token)) {
    throw Object.assign(new Error("announce token missing or wrong for this conversation"), { status: 403 });
  }
  const body = clip(text, 2_000);
  if (!body) throw Object.assign(new Error("text is required"), { status: 400 });
  const wakeup = wakeupId ? load().items.find((w) => w.id === String(wakeupId)) : null;
  if (wakeupId && (!wakeup || wakeup.session_id !== session)) {
    throw Object.assign(new Error(`No wakeup ${wakeupId} in this conversation`), { status: 404 });
  }
  if (wakeup?.status === "delivered") return { ok: true, duplicate: true, entry_id: wakeup.transcript_row_id, listeners: 0 };

  const entry = appendTranscript(session, {
    role: "tool",
    text: `[Wakeup] ${body}`,
    metadata: { event: "announce", source: wakeup ? "paseo_schedule" : "announce", ...(wakeup ? { wakeup_id: wakeup.id, schedule_id: wakeup.schedule_id } : {}) },
  });
  const listeners = uiClientCount({ sessionId: session });
  publishUi({ type: "announce", session_id: session, text: body, entry_id: entry.id, wakeup_id: wakeup?.id || null });
  if (wakeup) {
    patch(wakeup.id, { status: "delivered", delivered_at: entry.ts, transcript_row_id: entry.id, listeners });
    if (wakeup.ask_id) {
      try {
        updateAsk(session, wakeup.ask_id, listeners > 0
          ? { state: "done", evidence: `Announced at ${localTimeLabel(new Date(entry.ts))} (transcript row ${entry.id}) to ${listeners} open app tab${listeners === 1 ? "" : "s"}.`, remaining: "" }
          : { state: "blocked", evidence: `Fired and written to the transcript (row ${entry.id}) at ${localTimeLabel(new Date(entry.ts))}.`, remaining: "No app tab was open to speak it; it is in the transcript." },
        { origin: "announce" });
      } catch { /* the ledger never blocks delivery */ }
    }
  }
  return { ok: true, entry_id: entry.id, listeners, spoken: listeners > 0 };
}

// A scheduled wakeup past its time (plus grace) that never announced is
// missed: ask the schedule why, mark the ask blocked, and say so in the
// conversation. Delivery can still arrive late and will then mark it done.
export async function sweepWakeups({ now = Date.now(), graceMs = Number(env("VA3_WAKEUP_GRACE_MS", "300000")) } = {}) {
  const overdue = load().items.filter((w) => w.status === "scheduled" && Date.parse(w.fire_at) + graceMs < now);
  const missed = [];
  for (const w of overdue) {
    const live = await inspectSchedule(w.schedule_id);
    if (live.status === "active" && live.next_run_at && Date.parse(live.next_run_at) > now) continue;
    const why = live.last_run
      ? `Paseo run ${live.last_run.status}${live.last_run.error ? `: ${live.last_run.error}` : ""}`
      : `Paseo schedule ${w.schedule_id} is ${live.status}${live.error ? ` (${live.error})` : ""} with no run recorded`;
    patch(w.id, { status: "missed", error: clip(why, 300) });
    const notice = `[Wakeup missed] ${w.fire_label}: "${w.message}" did not announce. ${why}.`;
    try {
      const entry = appendTranscript(w.session_id, { role: "tool", text: notice, metadata: { event: "announce_missed", wakeup_id: w.id, schedule_id: w.schedule_id } });
      publishUi({ type: "announce", session_id: w.session_id, text: notice, entry_id: entry.id, wakeup_id: w.id, missed: true });
    } catch { /* conversation may be gone */ }
    if (w.ask_id) {
      try { updateAsk(w.session_id, w.ask_id, { state: "blocked", evidence: clip(why, 600), remaining: "The wakeup did not fire; set it again or check the Paseo schedule." }, { origin: "wakeup-sweep" }); } catch { /* ignore */ }
    }
    missed.push(w.id);
  }
  return missed;
}

// Single-flight and backoff-aware (see startPaseoSweep): a slow Paseo never
// stacks overlapping sweeps.
let stopSweep = null;
export function startWakeupSweep({ intervalMs = 60_000 } = {}) {
  if (stopSweep) return;
  stopSweep = startPaseoSweep("wakeups", () => sweepWakeups(), intervalMs);
}
