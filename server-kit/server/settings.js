// Server-owned user settings: DATA_DIR/settings.json. One writer (this
// module). The realtime prompt, the set_chatter_mode / set_turn_taking /
// set_sleep_after_silence tools and /api/settings all read and write through
// here, so a setting is real state, not a memory item the model happens to
// remember.
//
// Shape (getSettings()):
//   chatter: "low" | "normal"
//   delegation: "eager" (default: answer only trivial things directly) | "balanced"
//   turn_detection: { type: "server_vad" | "semantic_vad",
//                     silence_ms: 300..2500, threshold: 0.3..0.9,
//                     eagerness: "low" (default) | "medium" | "high" | "auto" }
//   sleep_after_silence_min: 0 (off) | 1..60 (default 5)
//   listen_session: "standby" (default) | "warm"
//     What Listen mode (Arm, sleep after silence) does with the realtime
//     model session. standby closes it, so nothing is billed until the local
//     wake word or an explicit enable opens a new one (~1-3 s to wake);
//     warm keeps it open with the mic track disabled (instant wake).
//   mic_command_prefix: false (default) | true
//     Microphone command prefix mode (public/mic-commands.js): when on,
//     spoken mute/unmute only count after "hey assistant" ("hey assistant,
//     mute"); a plain "mute"/"unmute" no longer changes the mic. It never
//     touches the hard-disable (mic_disabled) in either direction.
//   mic_vocabulary: { mic_on_off, sleep_wake, wakey_wakey } (booleans, each
//     default true): optional command words (public/mic-commands.js) —
//     Dragon-style "mic on/off", "go to sleep"/"wake up", "wakey wakey".
//   mute_session: "warm" (default) | "standby"; mute always disables model audio.
//   agent_approvals: { default: "ask" | "allow_all", hosts: { hostId: "ask" | "allow_all" } }
//   mic_disabled: { disabled: boolean, since: ISO | null, source: string | null }
//     Microphone hard-disable (public/mic-lock.js). Anyone may disable;
//     enabling needs a guarded browser request from a physical press of the
//     Enable microphone button (source "enable_button"). A typed or spoken
//     command, the settings UI and model tools cannot enable it.
//   time_display: { time_zone: IANA zone | "local" (default America/Los_Angeles,
//                   or VA3_TIMEZONE when set), relative: true (default) | false }
//     The one zone every user-facing time is shown and parsed in (footer
//     build time, status times, wakeups, scratchpad and Vision stamps), with
//     its date-correct abbreviation (PDT/PST). relative = recent status
//     times read "12 minutes ago". Formatting: public/time-format.js.
//   speech_snippets: "keep" (default) | "off"
//     Server copies of drive-mode utterance audio (data/drive/<conv>/inputs).
//     keep: deleted VA3_SNIPPET_SERVER_HOURS (48) after processing, at most
//     VA3_SNIPPET_SERVER_MAX_PER_CONV (100) per conversation; off: deleted
//     within minutes of processing. Unprocessed audio is never deleted.
//     Browser and phone copies have their own per-device switch.
//     (server/drive/snippets.js, docs/speech-snippets.md)
//   updated_at: ISO string | null
//
// Turn-detection fields Jacob never set fall back to the env defaults
// (REALTIME_TURN_DETECTION, REALTIME_VAD_SILENCE_MS, REALTIME_VAD_THRESHOLD,
// REALTIME_VAD_EAGERNESS), then to the built-ins; a stored value always wins.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, env } from "./env.js";
import { agentHosts } from "./host.js";
import "../public/time-format.js";
import "../public/mic-commands.js";

const VA3Time = globalThis.VA3Time;
const VA3MicCommands = globalThis.VA3MicCommands;

export const CHATTER_MODES = Object.freeze(["low", "normal"]);
export const DELEGATION_LEVELS = Object.freeze(["eager", "balanced"]);
export const TURN_TYPES = Object.freeze(["server_vad", "semantic_vad"]);
export const EAGERNESS = Object.freeze(["low", "medium", "high", "auto"]);
export const SILENCE_MS = Object.freeze({ min: 300, max: 2500, default: 750 });
export const THRESHOLD = Object.freeze({ min: 0.3, max: 0.9, default: 0.5 });
export const SLEEP_MIN = Object.freeze({ min: 1, max: 60, default: 5 });
export const LISTEN_SESSION_MODES = Object.freeze(["standby", "warm"]);
export const SPEECH_SNIPPET_MODES = Object.freeze(["keep", "off"]);
// Spoken presets. Each sets the silence timer (server VAD) and the matching
// eagerness (semantic VAD), so a preset means the same thing in either mode.
export const TURN_PRESETS = Object.freeze({
  patient: Object.freeze({ silence_ms: 1200, eagerness: "low" }),
  normal: Object.freeze({ silence_ms: 750, eagerness: "auto" }),
  quick: Object.freeze({ silence_ms: 400, eagerness: "high" }),
});
const FILE = () => join(DATA_DIR, "settings.json");

// Standing agent approval policy (Jacob, 2026-11-01: "blanket approve
// computer use either globally or on a per-device basis"). "ask" (the
// default) leaves every permission request to Jacob; "allow_all" lets the
// server's auto-approve sweep answer the permission requests Paseo agents on
// that host raise, exactly like per-agent allow-all. It never changes an
// agent's mode or sandbox, and an agent Jacob set to ask_each still asks.
// Only allowlisted hosts (VA3_AGENT_HOSTS) can carry an override.
export const APPROVAL_POLICIES = Object.freeze(["ask", "allow_all"]);

function approvalSettings(value, { strict = false } = {}) {
  const fail = (message) => { if (strict) throw new Error(message); };
  if (value === undefined || value === null) value = {};
  if (typeof value !== "object" || Array.isArray(value)) { fail("agent_approvals must be an object"); value = {}; }
  for (const key of Object.keys(value)) if (!["default", "hosts"].includes(key)) fail(`Unknown agent_approvals key: ${key}`);
  if (value.default !== undefined && !APPROVAL_POLICIES.includes(value.default)) fail("agent_approvals.default must be ask or allow_all");
  if (value.hosts !== undefined && (!value.hosts || typeof value.hosts !== "object" || Array.isArray(value.hosts))) fail("agent_approvals.hosts must be an object");
  const allowed = agentHosts();
  const hosts = {};
  for (const [id, policy] of Object.entries(value.hosts && typeof value.hosts === "object" ? value.hosts : {})) {
    if (!Object.hasOwn(allowed, id)) { fail(`Unknown agent host: ${id}. Allowed: ${Object.keys(allowed).join(", ")}`); continue; }
    if (!APPROVAL_POLICIES.includes(policy)) { fail(`Policy for ${id} must be ask or allow_all`); continue; }
    hosts[id] = policy;
  }
  return { default: APPROVAL_POLICIES.includes(value.default) ? value.default : "ask", hosts };
}

// The effective policy for one agent host. Unknown hosts always ask.
export function agentApprovalPolicy(hostId, settings = getSettings()) {
  if (!Object.hasOwn(agentHosts(), String(hostId || ""))) return "ask";
  return settings.agent_approvals.hosts[hostId] || settings.agent_approvals.default;
}

function micDisabledSettings(value) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const disabled = v.disabled === true;
  return {
    disabled,
    since: disabled && typeof v.since === "string" ? v.since : null,
    source: disabled && typeof v.source === "string" ? v.source : null,
  };
}

export const MIC_ENABLE_REFUSED = "Only Jacob can re-enable the microphone, by pressing the Enable microphone button himself.";
// The one control that may lift the lock (public/mic-lock.js ENABLE_SOURCES).
export const MIC_ENABLE_SOURCE = "enable_button";

// Zone default: VA3_TIMEZONE when it names a real zone, else Pacific.
export function timeDisplayDefaults() {
  const zone = String(env("VA3_TIMEZONE", "") || "").trim();
  return { time_zone: zone && VA3Time.validTimeZone(zone) ? zone : VA3Time.DEFAULT_TIME_ZONE, relative: true };
}

function timeDisplaySettings(value, { strict = false } = {}) {
  const base = timeDisplayDefaults();
  if (value === undefined || value === null) return base;
  if (typeof value !== "object" || Array.isArray(value)) { if (strict) throw new Error("time_display must be an object"); return base; }
  const out = { ...base };
  for (const key of Object.keys(value)) if (!["time_zone", "relative"].includes(key) && strict) throw new Error(`Unknown time_display key: ${key}`);
  if (value.time_zone !== undefined) {
    const zone = String(value.time_zone || "").trim();
    if (VA3Time.validTimeZone(zone)) out.time_zone = zone;
    else if (strict) throw new Error(`time_zone must be an IANA zone like America/Los_Angeles, or "local"`);
  }
  if (value.relative !== undefined) {
    if (typeof value.relative === "boolean") out.relative = value.relative;
    else if (strict) throw new Error("relative must be true or false");
  }
  return out;
}

// The Intl timeZone server-side labels use (undefined = the host's own zone).
export function displayTimeZone(settings = getSettings()) {
  return VA3Time.resolveZone(settings.time_display.time_zone);
}

const clamp = (n, { min, max }) => Math.min(max, Math.max(min, n));

function readStored() {
  try {
    if (existsSync(FILE())) return JSON.parse(readFileSync(FILE(), "utf8")) || {};
  } catch { /* unreadable file: defaults */ }
  return {};
}

// Built-in defaults overlaid with env (the same variables
// turnDetectionConfig() in server/openai.js reads). Bad env values are
// ignored, not fatal; in-range env values are clamped to the settings range.
export function turnDetectionDefaults() {
  const type = String(env("REALTIME_TURN_DETECTION", "") || "").toLowerCase().trim();
  const num = (key) => { const raw = env(key, ""); const n = Number(raw); return raw !== "" && raw != null && Number.isFinite(n) ? n : null; };
  const silence = num("REALTIME_VAD_SILENCE_MS");
  const threshold = num("REALTIME_VAD_THRESHOLD");
  const eagerness = String(env("REALTIME_VAD_EAGERNESS", "") || "").toLowerCase().trim();
  return {
    type: TURN_TYPES.includes(type) ? type : "server_vad",
    silence_ms: silence !== null && silence > 0 ? Math.round(clamp(silence, SILENCE_MS)) : SILENCE_MS.default,
    threshold: threshold !== null && threshold > 0 && threshold <= 1 ? Math.round(clamp(threshold, THRESHOLD) * 100) / 100 : THRESHOLD.default,
    eagerness: EAGERNESS.includes(eagerness) ? eagerness : "low",
  };
}

// Validate and clamp a partial turn-detection patch. Numbers out of range are
// clamped; values of the wrong kind (unknown type, NaN) throw so a typo is
// refused rather than silently stored. Returns only the fields provided.
export function normalizeTurnPatch(patch = {}) {
  if (!patch || typeof patch !== "object") throw new Error("turn_detection must be an object");
  const out = {};
  if (patch.preset !== undefined && patch.preset !== null && patch.preset !== "") {
    const preset = TURN_PRESETS[String(patch.preset).toLowerCase().trim()];
    if (!preset) throw new Error(`preset must be one of: ${Object.keys(TURN_PRESETS).join(", ")}`);
    Object.assign(out, preset);
  }
  if (patch.type !== undefined) {
    const type = String(patch.type).toLowerCase().trim();
    if (!TURN_TYPES.includes(type)) throw new Error(`type must be one of: ${TURN_TYPES.join(", ")}`);
    out.type = type;
  }
  if (patch.silence_ms !== undefined) {
    const n = Number(patch.silence_ms);
    if (patch.silence_ms === null || patch.silence_ms === "" || !Number.isFinite(n)) throw new Error("silence_ms must be a number of milliseconds");
    out.silence_ms = Math.round(clamp(n, SILENCE_MS));
  }
  if (patch.threshold !== undefined) {
    const n = Number(patch.threshold);
    if (patch.threshold === null || patch.threshold === "" || !Number.isFinite(n)) throw new Error("threshold must be a number");
    out.threshold = Math.round(clamp(n, THRESHOLD) * 100) / 100;
  }
  if (patch.eagerness !== undefined) {
    const e = String(patch.eagerness).toLowerCase().trim();
    if (!EAGERNESS.includes(e)) throw new Error(`eagerness must be one of: ${EAGERNESS.join(", ")}`);
    out.eagerness = e;
  }
  return out;
}

// 0/"off"/false = off; otherwise whole minutes clamped to 1..60.
export function normalizeSleepMinutes(value) {
  if (value === false || value === null) return 0;
  const raw = typeof value === "string" ? value.toLowerCase().trim() : value;
  if (raw === "off" || raw === "never" || raw === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error("sleep_after_silence_min must be a number of minutes or off");
  if (n <= 0) return 0;
  return Math.round(clamp(n, SLEEP_MIN));
}

// Effective turn detection: stored fields over env/built-in defaults. A
// corrupt stored field is dropped rather than breaking every session mint.
function effectiveTurnDetection(stored) {
  const base = turnDetectionDefaults();
  if (!stored || typeof stored !== "object") return base;
  const clean = {};
  for (const key of ["type", "silence_ms", "threshold", "eagerness"]) {
    if (stored[key] === undefined) continue;
    try { Object.assign(clean, normalizeTurnPatch({ [key]: stored[key] })); } catch { /* ignore bad field */ }
  }
  return { ...base, ...clean };
}

export function getSettings() {
  const stored = readStored();
  let sleep = SLEEP_MIN.default;
  try { if (stored.sleep_after_silence_min !== undefined) sleep = normalizeSleepMinutes(stored.sleep_after_silence_min); } catch { /* default */ }
  return {
    chatter: CHATTER_MODES.includes(stored.chatter) ? stored.chatter : CHATTER_MODES[0],
    delegation: DELEGATION_LEVELS.includes(stored.delegation) ? stored.delegation : DELEGATION_LEVELS[0],
    turn_detection: effectiveTurnDetection(stored.turn_detection),
    sleep_after_silence_min: sleep,
    listen_session: LISTEN_SESSION_MODES.includes(stored.listen_session) ? stored.listen_session : LISTEN_SESSION_MODES[0],
    mic_command_prefix: stored.mic_command_prefix === true,
    mic_vocabulary: VA3MicCommands.normalizeVocab(stored.mic_vocabulary),
    mute_session: LISTEN_SESSION_MODES.includes(stored.mute_session) ? stored.mute_session : "warm",
    agent_approvals: approvalSettings(stored.agent_approvals),
    mic_disabled: micDisabledSettings(stored.mic_disabled),
    time_display: timeDisplaySettings(stored.time_display),
    speech_snippets: SPEECH_SNIPPET_MODES.includes(stored.speech_snippets) ? stored.speech_snippets : SPEECH_SNIPPET_MODES[0],
    updated_at: typeof stored.updated_at === "string" ? stored.updated_at : null,
  };
}

export function micDisabled() {
  return getSettings().mic_disabled.disabled;
}

export function micCommandPrefix() {
  return getSettings().mic_command_prefix;
}

export function micVocabulary() {
  return getSettings().mic_vocabulary;
}

export function listenSessionMode() {
  return getSettings().listen_session;
}

export function chatterMode() {
  return getSettings().chatter;
}

export function delegationLevel() {
  return getSettings().delegation;
}

export function turnDetectionSettings() {
  return getSettings().turn_detection;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Only known keys with valid values are written; anything else is refused
// rather than silently stored. The file keeps only what was explicitly set,
// so env defaults still apply to turn-detection fields never touched.
// context (agent_approvals only): { guarded, identity, source }. guarded is
// set by the HTTP handlers after the request guard; identity comes from the
// request, never from tool arguments.
export function updateSettings(patch = {}, context = {}) {
  const before = getSettings();
  const stored = readStored();
  const next = { ...stored };
  if (patch.agent_approvals !== undefined) {
    if (!context.guarded) throw new Error("The agent approval policy can only be changed by a guarded request from Jacob.");
    if (!patch.agent_approvals || typeof patch.agent_approvals !== "object" || Array.isArray(patch.agent_approvals)) throw new Error("agent_approvals must be an object");
    next.agent_approvals = approvalSettings({ ...before.agent_approvals, ...patch.agent_approvals }, { strict: true });
  }
  if (patch.mic_disabled !== undefined) {
    const raw = patch.mic_disabled && typeof patch.mic_disabled === "object" ? patch.mic_disabled.disabled : patch.mic_disabled;
    // Strict booleans only: the string "false" must never read as a disable,
    // and nothing but an explicit false may enable.
    if (raw !== true && raw !== false) throw new Error("mic_disabled must be true or false");
    if (raw === false && before.mic_disabled.disabled && (!context.guarded || context.source !== MIC_ENABLE_SOURCE)) throw new Error(MIC_ENABLE_REFUSED);
    if (raw !== before.mic_disabled.disabled) {
      next.mic_disabled = raw
        ? { disabled: true, since: new Date().toISOString(), source: String(context.source || "settings").slice(0, 40) }
        : { disabled: false, since: null, source: String(context.source || "settings").slice(0, 40) };
    }
  }
  if (patch.chatter !== undefined) {
    const mode = String(patch.chatter).toLowerCase().trim();
    if (!CHATTER_MODES.includes(mode)) throw new Error(`chatter must be one of: ${CHATTER_MODES.join(", ")}`);
    next.chatter = mode;
  }
  if (patch.delegation !== undefined) {
    const level = String(patch.delegation).toLowerCase().trim();
    if (!DELEGATION_LEVELS.includes(level)) throw new Error(`delegation must be one of: ${DELEGATION_LEVELS.join(", ")}`);
    next.delegation = level;
  }
  if (patch.turn_detection !== undefined) {
    const turn = normalizeTurnPatch(patch.turn_detection);
    const prior = stored.turn_detection && typeof stored.turn_detection === "object" ? stored.turn_detection : {};
    next.turn_detection = { ...prior, ...turn };
  }
  if (patch.sleep_after_silence_min !== undefined) {
    next.sleep_after_silence_min = normalizeSleepMinutes(patch.sleep_after_silence_min);
  }
  if (patch.listen_session !== undefined) {
    const mode = String(patch.listen_session).toLowerCase().trim();
    if (!LISTEN_SESSION_MODES.includes(mode)) throw new Error(`listen_session must be one of: ${LISTEN_SESSION_MODES.join(", ")}`);
    next.listen_session = mode;
  }
  if (patch.mic_command_prefix !== undefined) {
    if (patch.mic_command_prefix !== true && patch.mic_command_prefix !== false) throw new Error("mic_command_prefix must be true or false");
    next.mic_command_prefix = patch.mic_command_prefix;
  }
  if (patch.mic_vocabulary !== undefined) {
    const v = patch.mic_vocabulary;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("mic_vocabulary must be an object");
    for (const [key, value] of Object.entries(v)) {
      if (!VA3MicCommands.VOCAB_KEYS.includes(key)) throw new Error(`Unknown mic_vocabulary key: ${key}. Allowed: ${VA3MicCommands.VOCAB_KEYS.join(", ")}`);
      if (value !== true && value !== false) throw new Error(`mic_vocabulary.${key} must be true or false`);
    }
    next.mic_vocabulary = { ...VA3MicCommands.normalizeVocab(stored.mic_vocabulary), ...v };
  }
  if (patch.mute_session !== undefined) {
    if (!LISTEN_SESSION_MODES.includes(patch.mute_session)) throw new Error("mute_session must be standby or warm");
    next.mute_session = patch.mute_session;
  }
  if (patch.time_display !== undefined) {
    if (!patch.time_display || typeof patch.time_display !== "object" || Array.isArray(patch.time_display)) throw new Error("time_display must be an object");
    const prior = stored.time_display && typeof stored.time_display === "object" ? stored.time_display : {};
    timeDisplaySettings(patch.time_display, { strict: true });
    next.time_display = { ...prior, ...Object.fromEntries(Object.entries(patch.time_display).filter(([, v]) => v !== undefined)) };
  }
  if (patch.speech_snippets !== undefined) {
    const mode = String(patch.speech_snippets).toLowerCase().trim();
    if (!SPEECH_SNIPPET_MODES.includes(mode)) throw new Error(`speech_snippets must be one of: ${SPEECH_SNIPPET_MODES.join(", ")}`);
    next.speech_snippets = mode;
  }
  const approvalsChanged = patch.agent_approvals !== undefined && !same(before.agent_approvals, next.agent_approvals);
  const micChanged = next.mic_disabled !== undefined && micDisabledSettings(next.mic_disabled).disabled !== before.mic_disabled.disabled;
  const written = !same({ ...stored, updated_at: undefined }, { ...next, updated_at: undefined });
  if (written) {
    next.updated_at = new Date().toISOString();
    mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    // Weakening or restoring a permission gate is audited before it applies.
    if (approvalsChanged) {
      appendFileSync(join(DATA_DIR, "command-audit.jsonl"), `${JSON.stringify({
        ts: next.updated_at, event: "agent_approval_policy", identity: context.identity || null,
        source: context.source || "settings", ...(context.evidence ? { evidence: context.evidence } : {}),
        before: before.agent_approvals, after: next.agent_approvals,
      })}\n`);
    }
    if (micChanged) {
      appendFileSync(join(DATA_DIR, "command-audit.jsonl"), `${JSON.stringify({
        ts: next.updated_at, event: "mic_disabled", identity: context.identity || null,
        source: context.source || "settings", disabled: micDisabledSettings(next.mic_disabled).disabled,
        ...(context.gesture ? { gesture: String(context.gesture).slice(0, 20) } : {}),
      })}\n`);
    }
    renameSync(tmp, FILE());
  }
  const settings = getSettings();
  const changed = !same({ ...before, updated_at: null }, { ...settings, updated_at: null });
  return { ok: true, changed, settings };
}
