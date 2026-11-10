// App-level controls the voice can call directly: restart this service, and
// export a conversation transcript as Markdown.
//
// restart_app is separate from self_update: no code changes, no tests, just a
// `launchctl kickstart -k` of the running service. The kickstart runs from a
// detached helper (its own session, so killing this service does not kill it)
// after a short delay, so the tool response reaches the browser first; the
// browser's existing reconnect/update banner covers the gap.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_DIR, env, PROJECT_ROOT } from "./env.js";
import { listSessions, readTranscript } from "./transcripts.js";
import { localHost } from "./host.js";

const RESTART_FILE = join(DATA_DIR, "restart.json");
const COOLDOWN_MS = 60_000;

// The version this process is running (read once at start, so a deploy that
// replaced package.json does not change it).
const RUNNING_VERSION = JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).version;
function version() {
  return RUNNING_VERSION;
}

export function restartCommand() {
  const label = env("VA3_SERVICE_LABEL", "com.jacob.voice-assistant-v3");
  return env("VA3_RESTART_CMD", `/bin/launchctl kickstart -k gui/${process.getuid()}/${label}`);
}

export function lastRestart() {
  if (!existsSync(RESTART_FILE)) return null;
  try { return JSON.parse(readFileSync(RESTART_FILE, "utf8")); } catch { return null; }
}

export function restartApp({ reason = "", delaySeconds } = {}) {
  const previous = lastRestart();
  if (previous && Date.now() - Date.parse(previous.requested_at) < COOLDOWN_MS) {
    return { ok: false, restarting: false, error: `A restart was already requested at ${previous.requested_at}; wait a minute before restarting again.` };
  }
  const delay = Math.max(0, Math.min(10, Number(delaySeconds ?? env("VA3_RESTART_DELAY_S", "1.5"))));
  const command = restartCommand();
  const record = {
    requested_at: new Date().toISOString(),
    from_version: version(),
    from_pid: process.pid,
    reason: String(reason || "").slice(0, 300),
    command,
  };
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${RESTART_FILE}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  renameSync(tmp, RESTART_FILE);
  const child = spawn("/bin/sh", ["-c", `sleep ${delay}; exec ${command}`], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  return {
    ok: true,
    restarting: true,
    from_version: record.from_version,
    helper_pid: child.pid,
    note: `Restarting the Voice Assistant service in about ${delay} seconds. Tools pause for a few seconds; the voice connection usually stays up, and the page shows a banner if a reload is needed.`,
  };
}

// Startup hook: if a restart was requested, record that this process is the
// one that came back (the browser's health poll shows the version).
export function noteStartup() {
  const previous = lastRestart();
  if (!previous || previous.completed_at) return null;
  const done = { ...previous, completed_at: new Date().toISOString(), to_version: version(), to_pid: process.pid };
  try { writeFileSync(RESTART_FILE, JSON.stringify(done, null, 2)); } catch { /* best effort */ }
  return done;
}

// ---------- export ----------
function line(row) {
  const when = row.ts ? new Date(row.ts).toISOString().replace("T", " ").slice(0, 19) + "Z" : "";
  const who = { user: "**Jacob**", assistant: "**Assistant**", tool: "_Tool/update_", system: "_System_" }[row.role] || row.role;
  if (row.metadata?.event === "voice_session_start") return `\n---\n\n### ${row.text} (${when})\n`;
  return `- ${when} ${who}: ${String(row.text).replace(/\n/g, "\n  ")}`;
}

export function exportSession({ sessionId } = {}) {
  const id = String(sessionId || "");
  if (!id) throw new Error("No conversation to export: pass id or use the current conversation.");
  const rows = readTranscript(id, { limit: 10_000 });
  if (!rows.length) throw new Error(`Conversation ${id} has no transcript rows.`);
  const meta = listSessions({ includeArchived: true }).find((s) => s.id === id);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = join(DATA_DIR, "exports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}-${stamp}.md`);
  const doc = [
    `# ${meta?.title || id}`,
    "",
    `- Conversation: \`${id}\``,
    `- Rows: ${rows.length} (${rows[0].ts} to ${rows.at(-1).ts})`,
    `- Exported: ${new Date().toISOString()} by Voice Assistant v3 ${version()} on ${localHost().label}`,
    "",
    ...rows.map(line),
    "",
  ].join("\n");
  writeFileSync(file, doc);
  return { ok: true, path: file, host: localHost().label, rows: rows.length, bytes: Buffer.byteLength(doc) };
}
