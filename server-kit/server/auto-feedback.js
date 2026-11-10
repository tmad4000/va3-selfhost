// Silent, best-effort tool failure reporting. Reserve synchronously before any
// network await, so concurrent calls share one durable 24h occurrence window.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, env, openaiKey, PROJECT_ROOT, witAgentKey } from "./env.js";
import { submitFeedback, updateAutomaticFeedback } from "./feedback.js";

const VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).version;
const SEEN_FILE = join(DATA_DIR, "auto-feedback-seen.json");
export const DEDUPE_MS = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

export function normalizeToolError(error) {
  return String(error).toLowerCase()
    .replace(/https?:\/\/[^\s"'<>]+/g, "<url>")
    .replace(/(?:[a-z]:[\\/]|~?\/)[^\s"'<>),;]+/gi, "<path>")
    .replace(/\b(?:va3|agent|session|call|req|trace|run|fb|vs)[-_][a-z0-9_-]+\b/g, "<id>")
    .replace(/\b((?:request|session|agent|call|trace)[-_ ]?id[=: ]+)[a-z0-9_-]+/g, "$1<id>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/g, "<id>")
    .replace(/\b[a-z][a-z0-9]*[-_][a-z0-9_-]*\d[a-z0-9_-]*\b/g, "<id>")
    .replace(/\b[0-9a-f]{8,}\b/g, "<id>")
    .replace(/\b\d+(?:\.\d+)*\b/g, "<n>")
    .replace(/\s+/g, " ").trim();
}

export function toolErrorSignature(tool, error) {
  return createHash("sha256").update(`${tool}\n${normalizeToolError(error)}`).digest("hex").slice(0, 20);
}

// Do not ship arbitrary command/message/file contents: even an innocently
// named argument can contain a credential. Preserve argument shape only.
export function redactedArgs(args) {
  const shape = {};
  for (const [key, value] of Object.entries(args || {}).slice(0, 30)) {
    const label = /^[a-z_]{1,40}$/.test(key) ? key : "argument";
    shape[label] = typeof value === "boolean" ? value : value == null ? null : "[redacted]";
  }
  return JSON.stringify(shape).slice(0, 500);
}

export function redactToolError(error, args = {}) {
  let text = String(error);
  const redact = (value) => {
    if (typeof value === "string" && value.length >= 4) text = text.split(value).join("[redacted]");
  };
  // Also remove exact sensitive args echoed by a failing command/provider.
  const walk = (value, depth = 0) => {
    if (depth > 8) return;
    if (typeof value === "string") redact(value);
    else if (value && typeof value === "object") Object.values(value).forEach((v) => walk(v, depth + 1));
  };
  walk(args);
  for (const read of [openaiKey, witAgentKey]) { try { redact(read()); } catch { /* unconfigured */ } }
  for (const key of Object.keys(process.env).filter((k) => /key|token|secret|password/i.test(k))) redact(process.env[key]);
  return text
    .replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/g, "[redacted]")
    .replace(/\b(?:sk-|ek_|wit_)[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/((?:[\w-]*(?:key|token|secret|password|authorization)[\w-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/g, "[url]")
    .replace(/(?:[a-z]:[\\/]|~?\/)[^\s"'<>),;]+/gi, "[path]")
    .slice(0, 1500);
}

export function excludedToolError(tool, error) {
  const text = String(error);
  // Conflicts already have inline and queue retries. Reporting calls the
  // feedback pipeline directly, so its failures cannot recurse through dispatch.
  if (/snapshot_conflict|storage_request_conflict|(?:WIT|World Issue Tracker).*\b409\b/i.test(text)) return true;
  const invalidValue = /^(?:mode|state|kind|path|cwd|decision|backend|cue|minutes|target|preset|type|silence_ms|threshold|eagerness|sleep_after_silence_min|terminal name|agent mode|coding-agent provider|working directory|breathing rate|[a-z_]+_seconds)\b.*\bmust be\b/i.test(text);
  return invalidValue || /\bunknown (?:agent host|host|panel|tool|service|feedback target|agent transport|breathing pattern)\b|\b(?:is required|are required|missing required)\b|^No conversation\b|^No (?:agent session|command|terminal named|ask|wakeup)\b|^Invalid (?:path|conversation|transcript)|^Nothing to send|^Command already\b|^play_clip needs a|^A wakeup needs an active conversation|^Marking an ask done needs evidence|recent request from Jacob|Nothing ran; it is safe to send the call again/i.test(text);
}

function loadSeen() {
  try { return JSON.parse(readFileSync(SEEN_FILE, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return { signatures: {}, paseo_timeout_at: null };
    throw error; // Fail closed on corrupt state rather than flooding WIT.
  }
}
function saveSeen(db) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SEEN_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  renameSync(tmp, SEEN_FILE);
}

export function recordToolError(tool, args, error, { identity, now = Date.now() } = {}) {
  // Stub runs exercise capture/formatting but submitFeedback never sends or
  // queues, and retryFeedback also refuses to send under the stub provider.
  try {
    if (env("VA3_AUTO_FEEDBACK", "on").toLowerCase() === "off" || excludedToolError(tool, error)) return;
    const cleanError = redactToolError(error, args);
    const signature = toolErrorSignature(tool, cleanError);
    const db = loadSeen();
    const previous = db.signatures[signature];
    const stamp = new Date(now).toISOString();
    if (previous && now - Date.parse(previous.first_seen) < DEDUPE_MS) {
      previous.last_seen = stamp;
      previous.count += 1;
      saveSeen(db);
      updateAutomaticFeedback({ signature, ...previous });
      return;
    }
    const paseoTimeout = /paseo/i.test(error) && /timed?\s*out|timeout|ETIMEDOUT/i.test(error);
    if (paseoTimeout && db.paseo_timeout_at && now - Date.parse(db.paseo_timeout_at) < HOUR) return;
    if (paseoTimeout) db.paseo_timeout_at = stamp;
    const occurrence = { first_seen: stamp, last_seen: stamp, count: 1 };
    db.signatures[signature] = occurrence;
    saveSeen(db);
    const pending = submitFeedback({
      title: `Tool error: ${tool} — ${cleanError.replace(/\s+/g, " ").slice(0, 100)}`,
      message: [`Tool: ${tool}`, `Arguments (redacted): ${redactedArgs(args)}`, `Error: ${cleanError}`,
        `Version: ${VERSION}`, `Signature: ${signature}`, "Tags: automatic, tool-error"].join("\n\n"),
      sessionId: args?.session_id,
      identity,
      source: "automatic tool error",
      origin: "automatic",
      automatic: { signature, ...occurrence },
      asSystem: true,
    });
    // Do not delay the original error, leak a reporting error, or produce any
    // model-visible notification. Failed transport stays in the retry queue.
    // Keep the reservation on unexpected failures too: WIT might already have
    // accepted the item before a local write failed. Do not risk a duplicate.
    void pending.catch(() => {});
  } catch { /* reporting must never change tool behavior */ }
}
