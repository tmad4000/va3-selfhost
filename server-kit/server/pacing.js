// Paced breathing and clip playback: preset loading, argument resolution, and
// the session-end record. Timing is intrinsic and runs in the browser
// (public/pacer.js on the Web Audio clock, public/clip.js on the media
// element / YouTube player). The server only resolves what to run, tells the
// tab(s) through a ui event, and records how it ended. Paseo schedules never
// drive breaths; a scheduled wakeup may only START a session (by calling the
// start_breathing tool through /api/tool), and a finished session posts one
// transcript row plus, when the conversation keeps an ask ledger, evidence.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DATA_DIR, PROJECT_ROOT } from "./env.js";
import { appendTranscript } from "./transcripts.js";
import { createAsk, getAsk, listAsks, resolveSourceRow, updateAsk } from "./asks.js";

const REPO_PRESETS = join(PROJECT_ROOT, "presets", "pacing.json");
const LOCAL_PRESETS = () => join(DATA_DIR, "pacing-presets.json");
export const CUES = Object.freeze(["none", "tones", "spoken", "both"]);
const PHASES = ["inhale", "hold", "exhale", "hold_out"];
const MAX_MINUTES = 60;
const MAX_PHASE_SECONDS = 60;

function readJson(file) {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf8")); } catch (error) {
    throw new Error(`Presets file ${file} is not valid JSON: ${error.message}`);
  }
}

// Re-read on every call so edits apply without a restart. DATA_DIR overrides
// win per key over the repo file.
export function loadPresets() {
  const repo = readJson(REPO_PRESETS);
  const local = readJson(LOCAL_PRESETS());
  return {
    defaults: { pattern: "4-7-8", minutes: 3, cue: "both", lead_in_seconds: 3, ...(repo.defaults || {}), ...(local.defaults || {}) },
    patterns: { ...(repo.patterns || {}), ...(local.patterns || {}) },
    clips: { ...(repo.clips || {}), ...(local.clips || {}) },
  };
}

const norm = (s) => String(s ?? "").toLowerCase().replace(/[’']/g, "").replace(/\s+/g, " ").trim();

function findPreset(map, name) {
  const key = norm(name);
  if (!key) return null;
  for (const [id, preset] of Object.entries(map)) {
    if (norm(id) === key || (preset.aliases || []).some((a) => norm(a) === key)) return { id, ...preset };
  }
  return null;
}

function seconds(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PHASE_SECONDS) throw new Error(`${name} must be between 0 and ${MAX_PHASE_SECONDS} seconds`);
  return Math.round(n * 100) / 100;
}

// "4-7-8", "4-4-4-4", "5.5/5.5", "4 6": 2 numbers = in/out, 3 = in/hold/out,
// 4 = in/hold/out/hold. "6 bpm" = resonance at that rate (40% in, 60% out,
// the Breathe tracker's guide split).
function parsePattern(text) {
  const t = norm(text);
  const bpm = t.match(/^(\d+(?:\.\d+)?)\s*(?:bpm|breaths? (?:a|per) minute|per minute|\/min)$/);
  if (bpm) {
    const rate = Number(bpm[1]);
    if (!(rate >= 2 && rate <= 30)) throw new Error("Breathing rate must be between 2 and 30 per minute");
    const cycle = 60 / rate;
    return { label: `${rate} per minute`, inhale: Math.round(cycle * 40) / 100, hold: 0, exhale: Math.round(cycle * 60) / 100, hold_out: 0 };
  }
  const nums = t.split(/[\s,/:x-]+/).filter(Boolean);
  if (nums.length < 2 || nums.length > 4 || nums.some((n) => !/^\d+(?:\.\d+)?$/.test(n))) return null;
  const v = nums.map(Number);
  const [inhale, hold, exhale, hold_out] = v.length === 2 ? [v[0], 0, v[1], 0] : v.length === 3 ? [v[0], v[1], v[2], 0] : v;
  return { label: nums.join("-"), inhale, hold, exhale, hold_out };
}

export function resolveBreathing(args = {}) {
  const presets = loadPresets();
  const d = presets.defaults;
  const explicit = Object.fromEntries(PHASES.map((p) => [p, seconds(args[`${p}_seconds`], `${p}_seconds`)]));
  const hasExplicit = PHASES.some((p) => explicit[p] !== undefined);
  const requested = args.pattern ?? (hasExplicit ? "custom" : d.pattern);
  let base = null;
  let presetId = null;
  if (norm(requested) !== "custom") {
    const preset = findPreset(presets.patterns, requested);
    if (preset) { base = preset; presetId = preset.id; } else base = parsePattern(requested);
    if (!base) {
      throw new Error(`Unknown breathing pattern "${requested}". Presets: ${Object.keys(presets.patterns).join(", ")}; or give seconds like "4-7-8", "5.5/5.5", "6 bpm", or inhale_seconds/hold_seconds/exhale_seconds/hold_out_seconds.`);
    }
  }
  const phases = {};
  for (const p of PHASES) phases[p] = explicit[p] ?? seconds(base?.[p] ?? 0, p) ?? 0;
  if (!(phases.inhale > 0) || !(phases.exhale > 0)) throw new Error("A breathing pattern needs a positive inhale and exhale");
  const cycle = PHASES.reduce((sum, p) => sum + phases[p], 0);
  const minutes = args.minutes === undefined || args.minutes === null || args.minutes === "" ? Number(d.minutes) : Number(args.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_MINUTES) throw new Error(`minutes must be between 0 and ${MAX_MINUTES}`);
  const cue = norm(args.cue || d.cue);
  if (!CUES.includes(cue)) throw new Error(`cue must be one of ${CUES.join(", ")}`);
  // Whole cycles only, so a session never stops mid-breath.
  const cycles = Math.max(1, Math.round((minutes * 60) / cycle));
  const label = hasExplicit && !presetId
    ? PHASES.map((p) => phases[p]).filter((s, i) => s > 0 || i < 3).join("-")
    : base?.label || presetId || String(requested);
  return {
    kind: "breathing",
    preset: presetId,
    label,
    phases: PHASES.filter((p) => phases[p] > 0).map((p) => ({ name: p, seconds: phases[p] })),
    cycle_seconds: Math.round(cycle * 100) / 100,
    cycles,
    minutes: Math.round(minutes * 100) / 100,
    planned_seconds: Math.round(cycles * cycle * 10) / 10,
    cue,
    lead_in_seconds: Math.max(0, Math.min(10, Number(d.lead_in_seconds) || 0)),
  };
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
function youtubeId(url) {
  const host = url.hostname.replace(/^www\.|^m\./, "");
  if (host === "youtu.be") return url.pathname.slice(1).split("/")[0];
  if (["youtube.com", "youtube-nocookie.com", "music.youtube.com"].includes(host)) {
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
    if (m) return m[1];
  }
  return null;
}
// YouTube's t= / start= accept "870", "870s", "14m30s", "1h2m3s".
function timeParam(value) {
  if (!value) return undefined;
  const m = String(value).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/);
  if (!m || !m[0]) return undefined;
  return Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0);
}
function clipSeconds(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 24 * 3600) throw new Error(`${name} must be a number of seconds`);
  return Math.round(n * 10) / 10;
}

export function resolveClip(args = {}) {
  const presets = loadPresets();
  const preset = findPreset(presets.clips, args.preset) || findPreset(presets.clips, args.url);
  const raw = String(preset?.url || args.url || "").trim();
  if (!raw) throw new Error(`play_clip needs a url or a preset. Presets: ${Object.keys(presets.clips).join(", ")}`);
  let url;
  try { url = new URL(raw); } catch { throw new Error(`"${raw}" is not a URL or a known clip preset. Presets: ${Object.keys(presets.clips).join(", ")}`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error("Only http(s) clips can be played");
  const id = youtubeId(url);
  const start = clipSeconds(args.start_seconds, "start_seconds") ?? clipSeconds(preset?.start_seconds, "start_seconds")
    ?? timeParam(url.searchParams.get("t") || url.searchParams.get("start")) ?? 0;
  const end = clipSeconds(args.end_seconds, "end_seconds") ?? clipSeconds(preset?.end_seconds, "end_seconds")
    ?? timeParam(url.searchParams.get("end"));
  if (end !== undefined && end <= start) throw new Error("end_seconds must be after start_seconds");
  const title = String(args.title || preset?.title || (id ? `YouTube ${id}` : url.pathname.split("/").pop() || url.hostname)).slice(0, 200);
  const base = { kind: "clip", preset: preset?.id || null, title, start_seconds: start, end_seconds: end ?? null };
  if (id) {
    if (!YT_ID.test(id)) throw new Error("That YouTube link has no valid video id");
    const q = new URLSearchParams({ start: String(Math.floor(start)), autoplay: "1", rel: "0", playsinline: "1", enablejsapi: "1" });
    if (end !== undefined) q.set("end", String(Math.ceil(end)));
    return { ...base, source: "youtube", video_id: id, watch_url: `https://www.youtube.com/watch?v=${id}&t=${Math.floor(start)}s`, embed_url: `https://www.youtube-nocookie.com/embed/${id}?${q}` };
  }
  return { ...base, source: "media", src: url.href };
}

export function newMediaId(kind) {
  return `${kind === "breathing" ? "br" : "clip"}-${randomUUID().slice(0, 8)}`;
}

export function presetSummary() {
  const p = loadPresets();
  return {
    patterns: Object.entries(p.patterns).map(([id, v]) => ({ id, label: v.label || id })),
    clips: Object.entries(p.clips).map(([id, v]) => ({ id, title: v.title || id, start_seconds: v.start_seconds ?? 0, end_seconds: v.end_seconds ?? null })),
    defaults: p.defaults,
  };
}

const fmtMin = (s) => {
  const total = Math.max(0, Math.round(Number(s) || 0));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m && sec ? `${m} min ${sec} s` : m ? `${m} min` : `${sec} s`;
};

// "Breathing: 4-7-8 for 5 min, completed" / "Clip: <title>, stopped after 1 min 10 s".
export function outcomeText(o) {
  const status = ["completed", "stopped", "interrupted", "error"].includes(o.status) ? o.status : "ended";
  const elapsed = Number(o.elapsed_seconds) || 0;
  if (o.kind === "breathing") {
    const planned = o.minutes ? `${o.minutes} min` : fmtMin(o.planned_seconds);
    const tail = status === "completed" ? "completed" : `${status} after ${fmtMin(elapsed)}${o.reason ? ` (${o.reason})` : ""}`;
    return `Breathing: ${o.label || "paced breathing"} for ${planned}, ${tail}`;
  }
  const range = o.start_seconds || o.end_seconds ? ` [${fmtClock(o.start_seconds)}–${o.end_seconds ? fmtClock(o.end_seconds) : "end"}]` : "";
  const tail = status === "completed" ? "played to the end" : `${status} after ${fmtMin(elapsed)}${o.reason ? ` (${o.reason})` : ""}`;
  return `Clip: ${o.title || "clip"}${range}, ${tail}`;
}
function fmtClock(s) {
  const t = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

// Session end: one transcript row and, if this conversation keeps an ask
// ledger, evidence on the ask the session served (the explicit ask_id, else
// the ask from the turn that started it; a ledger with no such ask gets one).
// A start with no origin tab runs in every open tab; the first report wins.
const recorded = new Set();
export function recordOutcome(outcome = {}) {
  const sessionId = outcome.session_id ? String(outcome.session_id) : "";
  const text = outcomeText(outcome);
  if (!sessionId) return { ok: true, text, entry: null, ask: null };
  const key = outcome.id ? `${sessionId}:${outcome.id}` : null;
  if (key && recorded.has(key)) return { ok: true, duplicate: true, text, entry: null, ask: null };
  if (key) { recorded.add(key); if (recorded.size > 500) recorded.delete(recorded.values().next().value); }
  const entry = appendTranscript(sessionId, {
    role: "system",
    text,
    metadata: { kind: `${outcome.kind}_outcome`, media_id: outcome.id || null, status: outcome.status || null, elapsed_seconds: Number(outcome.elapsed_seconds) || 0 },
  });
  let ask = null;
  try {
    const asks = listAsks(sessionId);
    let target = outcome.ask_id ? getAsk(sessionId, outcome.ask_id) : null;
    if (!target && outcome.source_row_id) target = asks.find((a) => a.kind === "ask" && a.source_row_id === outcome.source_row_id && a.state !== "done" && a.state !== "planning") || null;
    const evidence = `${text} (${new Date().toISOString().slice(0, 16)}Z).`;
    if (target) {
      ask = updateAsk(sessionId, target.id, { state: "done", evidence: target.evidence ? `${target.evidence}\n${evidence}` : evidence }, { origin: outcome.kind });
    } else if (asks.length) {
      const source = outcome.source_row_id ? { id: outcome.source_row_id } : null;
      ask = createAsk(sessionId, {
        text: outcome.kind === "breathing" ? `Guide my breathing: ${outcome.label || "paced"}` : `Play ${outcome.title || "a clip"}`,
        sourceRowId: source?.id ?? null, state: "done", evidence, origin: outcome.kind,
      });
    }
  } catch { /* the ledger never blocks the transcript row */ }
  return { ok: true, text, entry, ask };
}

export function sourceRowFor(sessionId) {
  if (!sessionId) return null;
  try { return resolveSourceRow(String(sessionId))?.id || null; } catch { return null; }
}
