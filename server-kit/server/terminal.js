// Direct terminal access for the voice assistant, on an explicitly named host.
//
// 1. run_command: one shell command with a bounded run time and bounded
//    output, an exit status, cancellation, and an audit line per run in
//    DATA_DIR/command-audit.jsonl. Long commands keep running in the
//    background and are collected later with command_result.
// 2. Named persistent terminals: Paseo terminals (visible in the Paseo app)
//    or named tmux sessions (attachable with `tmux attach -t NAME` on the M4).
//    Open, send keys, read the screen, close. Existing tmux sessions can be
//    read and typed into, but only terminals this app opened can be closed.
//
// This module never relaxes any agent sandbox; it is the server's own shell,
// reachable only through the app's loopback/tailnet surface.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DATA_DIR, env } from "./env.js";
import { execPaseo, expandHome, paseoBin, paseoEnv, paseoStatus, tmuxBin } from "./agents.js";
import { localHost, resolveHost } from "./host.js";

const sshBin = () => env("VA3_SSH_BIN", "/usr/bin/ssh");

const pexec = promisify(execFile);
const AUDIT_FILE = join(DATA_DIR, "command-audit.jsonl");
const TERMINALS_FILE = join(DATA_DIR, "terminals.json");
const OUTPUT_LIMIT_DEFAULT = 12_000;
const OUTPUT_LIMIT_MAX = 48_000;
const TIMEOUT_DEFAULT = 120;
const TIMEOUT_MAX = 1_800;
const WAIT_DEFAULT = 30;
const WAIT_MAX = 120;
const KEEP_FINISHED = 50;

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function audit(entry) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(AUDIT_FILE, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch { /* audit is best-effort; never block the command */ }
}

// Keeps the head and tail of a stream so both the start and the conclusion of
// long output survive, with an exact count of what was dropped.
class BoundedBuffer {
  constructor(limit) { this.limit = limit; this.head = ""; this.tail = ""; this.total = 0; this.decoder = new StringDecoder("utf8"); }
  push(chunk) {
    // StringDecoder keeps multi-byte characters intact across chunk edges.
    const text = Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk);
    this.total += Buffer.byteLength(text);
    const half = Math.floor(this.limit / 2);
    if (this.head.length < half) {
      const take = text.slice(0, half - this.head.length);
      this.head += take;
      this.tail = (this.tail + text.slice(take.length)).slice(-half);
    } else {
      this.tail = (this.tail + text).slice(-half);
    }
  }
  value() {
    const kept = Buffer.byteLength(this.head) + Buffer.byteLength(this.tail);
    if (kept >= this.total) return { text: this.head + this.tail, truncated: false, bytes: this.total };
    return { text: `${this.head}\n…[${this.total - kept} bytes omitted]…\n${this.tail}`, truncated: true, bytes: this.total };
  }
}

const commands = new Map(); // id -> run

function resolveCwd(target, cwd) {
  if (target.remote) return cwd ? String(cwd) : "~";
  const raw = expandHome(cwd || homedir());
  if (!isAbsolute(raw)) throw new Error(`cwd must be absolute (got ${cwd})`);
  const dir = resolve(raw);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`cwd does not exist on ${target.label}: ${dir}`);
  return dir;
}

// "|| exit" plus a newline: if cd fails, nothing in the command runs, even a
// later part of a multi-command line.
function remoteCd(cwd) {
  if (cwd === "~") return 'cd -- "$HOME" || exit 125';
  if (cwd.startsWith("~/")) return `cd -- "$HOME"/${shellQuote(cwd.slice(2))} || exit 125`;
  return `cd -- ${shellQuote(cwd)} || exit 125`;
}

function present(run) {
  const stdout = run.stdout.value();
  const stderr = run.stderr.value();
  return {
    id: run.id,
    state: run.state,
    host: run.host.id,
    machine: run.host.label,
    cwd: run.cwd,
    command: run.command,
    exit_code: run.exitCode,
    ...(run.signal ? { signal: run.signal } : {}),
    timed_out: run.timedOut,
    cancelled: run.cancelled,
    duration_ms: (run.endedAt || Date.now()) - run.startedAt,
    stdout: stdout.text,
    stderr: stderr.text,
    output_truncated: stdout.truncated || stderr.truncated,
    stdout_bytes: stdout.bytes,
    stderr_bytes: stderr.bytes,
    ...(run.host.remote && ["cancelled", "timed_out"].includes(run.state) ? { note: "The local ssh session was ended; a remote process that ignores the hangup may still be running on that machine." } : {}),
    ...(run.state === "running" ? { next_step: `Still running (limit ${run.timeoutSeconds}s). Call command_result with id ${run.id} and wait_seconds, or cancel_command.` } : {}),
  };
}

function prune() {
  const finished = [...commands.values()].filter((r) => r.state !== "running").sort((a, b) => a.startedAt - b.startedAt);
  while (finished.length > KEEP_FINISHED) commands.delete(finished.shift().id);
}

function killGroup(run, signal) {
  try { process.kill(-run.child.pid, signal); } catch { try { run.child.kill(signal); } catch { /* gone */ } }
}

export async function runCommand({ command, cwd, host, timeoutSeconds, waitSeconds, maxOutput, source = "tool" }) {
  const text = String(command || "").trim();
  if (!text) throw new Error("command is required");
  const target = resolveHost(host);
  const dir = resolveCwd(target, cwd);
  const timeout = Math.max(1, Math.min(Number(timeoutSeconds) || TIMEOUT_DEFAULT, TIMEOUT_MAX));
  const wait = Math.max(0, Math.min(waitSeconds === undefined ? WAIT_DEFAULT : Number(waitSeconds) || 0, WAIT_MAX));
  const limit = Math.max(1_000, Math.min(Number(maxOutput) || OUTPUT_LIMIT_DEFAULT, OUTPUT_LIMIT_MAX));
  const id = `cmd-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;

  const child = target.remote
    ? spawn(sshBin(), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", target.alias, `${remoteCd(dir)}\n${text}`], { detached: true, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(env("VA3_SHELL", "/bin/zsh"), ["-c", text], { cwd: dir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });

  const run = {
    id, command: text, cwd: dir, host: target, child, source,
    timeoutSeconds: timeout,
    startedAt: Date.now(), endedAt: null,
    state: "running", exitCode: null, signal: null, timedOut: false, cancelled: false,
    stdout: new BoundedBuffer(limit), stderr: new BoundedBuffer(Math.min(limit, 8_000)),
  };
  commands.set(id, run);
  audit({ event: "start", id, host: target.id, cwd: dir, command: text, timeout_s: timeout, source });

  child.stdout.on("data", (d) => run.stdout.push(d));
  child.stderr.on("data", (d) => run.stderr.push(d));
  const timer = setTimeout(() => {
    run.timedOut = true;
    killGroup(run, "SIGTERM");
    setTimeout(() => { if (run.state === "running") killGroup(run, "SIGKILL"); }, 3_000).unref();
  }, timeout * 1_000);
  timer.unref();
  run.done = new Promise((resolveDone) => {
    const finish = (code, signal) => {
      if (run.state !== "running") return;
      clearTimeout(timer);
      run.endedAt = Date.now();
      run.exitCode = code;
      run.signal = signal || null;
      run.state = run.cancelled ? "cancelled" : run.timedOut ? "timed_out" : code === 0 ? "completed" : "failed";
      audit({
        event: "end", id, host: target.id, exit_code: code, signal: signal || null,
        state: run.state, duration_ms: run.endedAt - run.startedAt,
        stdout_bytes: run.stdout.total, stderr_bytes: run.stderr.total,
      });
      prune();
      resolveDone();
    };
    child.on("close", finish);
    child.on("error", (error) => { run.stderr.push(Buffer.from(String(error.message || error))); finish(127, null); });
  });

  if (wait > 0) await Promise.race([run.done, delay(wait * 1_000)]);
  return present(run);
}

export async function commandResult({ id, waitSeconds = 0 }) {
  const run = commands.get(String(id || ""));
  if (!run) throw new Error(`No command ${id} in this server's memory (finished results are kept for the last ${KEEP_FINISHED}; see command-audit.jsonl for history).`);
  const wait = Math.max(0, Math.min(Number(waitSeconds) || 0, WAIT_MAX));
  if (run.state === "running" && wait > 0) await Promise.race([run.done, delay(wait * 1_000)]);
  return present(run);
}

export async function cancelCommand({ id }) {
  const run = commands.get(String(id || ""));
  if (!run) throw new Error(`No command ${id}`);
  if (run.state !== "running") return { ok: false, error: `Command already ${run.state}`, result: present(run) };
  run.cancelled = true;
  killGroup(run, "SIGTERM");
  await Promise.race([run.done, delay(3_000)]);
  if (run.state === "running") { killGroup(run, "SIGKILL"); await Promise.race([run.done, delay(1_000)]); }
  return { ok: true, result: present(run) };
}

export function listCommands({ limit = 10 } = {}) {
  return [...commands.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map((run) => {
    const { stdout, stderr, ...rest } = present(run);
    return { ...rest, stdout_tail: stdout.slice(-400), stderr_tail: stderr.slice(-200) };
  });
}

// ---------- named terminals ----------
function loadTerminals() {
  try {
    return JSON.parse(readFileSync(TERMINALS_FILE, "utf8"));
  } catch (error) {
    // ENOENT (no file yet) is normal on first run; anything else (corrupt
    // JSON, permission error) means we're silently losing track of terminals
    // the assistant opened, so surface it.
    if (error?.code !== "ENOENT") console.warn(`[terminal] failed to read ${TERMINALS_FILE}: ${String(error.message || error).slice(0, 300)}`);
    return { terminals: [] };
  }
}
function saveTerminals(db) {
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${TERMINALS_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(db, null, 2));
  renameSync(tmp, TERMINALS_FILE);
}

function validName(name) {
  const value = String(name || "").trim();
  if (!/^[A-Za-z0-9._-]{1,48}$/.test(value)) throw new Error("Terminal name must be 1-48 letters, digits, dot, dash or underscore");
  return value;
}

async function tmuxSessions() {
  const tmux = await tmuxBin();
  if (!tmux) return [];
  try {
    // -u: without a UTF-8 locale (the launchd service has no LANG) tmux
    // prints the tab delimiters as "_" and no session would ever match.
    const { stdout } = await pexec(tmux, ["-u", "list-sessions", "-F", "#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_current_path}"]);
    return stdout.trim().split("\n").filter(Boolean).map((line) => {
      const [name, created, attached, path] = line.split("\t");
      return { name, created: new Date(Number(created) * 1_000).toISOString(), attached: Number(attached) > 0, cwd: path };
    });
  } catch (error) {
    // tmux exits non-zero with "no server running on <socket>" whenever no
    // session exists yet; that's expected and not worth logging. Anything
    // else (corrupt socket dir, permission error, tmux crash) would otherwise
    // vanish into an empty list with no trace, so surface it.
    const message = String(error?.stderr || error?.message || error).trim();
    if (!/no server running|no such file or directory|error connecting to/i.test(message)) {
      console.warn(`[terminal] tmux list-sessions failed unexpectedly: ${message.slice(0, 300)}`);
    }
    return [];
  }
}

function attachFor(term) {
  const host = localHost();
  return term.backend === "tmux"
    ? `ssh ${host.id === "m4" ? "m4" : host.hostname} -t tmux attach -t ${term.name}`
    : `Paseo app → workspace terminals → "${term.name}" (terminal ${String(term.terminal_id).slice(0, 8)})`;
}

export async function listTerminals() {
  const host = localHost();
  const own = loadTerminals().terminals;
  const tmux = await tmuxSessions();
  const ownTmux = new Set(own.filter((t) => t.backend === "tmux").map((t) => t.name));
  return {
    host: host.id,
    machine: host.label,
    opened_by_assistant: own.map((t) => ({ ...t, attach: attachFor(t), alive: t.backend === "tmux" ? tmux.some((s) => s.name === t.name) : undefined })),
    other_tmux_sessions: tmux.filter((s) => !ownTmux.has(s.name)).map((s) => ({ ...s, backend: "tmux", attach: attachFor({ backend: "tmux", name: s.name }) })),
  };
}

async function chooseBackend(requested) {
  const wanted = String(requested || "auto").toLowerCase();
  if (wanted === "tmux" || wanted === "paseo") return wanted;
  if (wanted !== "auto") throw new Error("backend must be auto, paseo, or tmux");
  if (env("VA3_TERMINAL_BACKEND")) return env("VA3_TERMINAL_BACKEND");
  if ((await paseoStatus()).available) return "paseo";
  if (await tmuxBin()) return "tmux";
  throw new Error("Neither Paseo nor tmux is available for terminals");
}

function findTerminal(name) {
  const value = String(name || "").trim();
  return loadTerminals().terminals.find((t) => t.name === value || t.terminal_id === value || (value.length >= 6 && t.terminal_id?.startsWith(value)));
}

export async function openTerminal({ name, cwd, backend, command }) {
  const termName = validName(name || `va3-term-${randomBytes(2).toString("hex")}`);
  const existing = findTerminal(termName);
  if (existing) return { ok: true, reused: true, ...existing, attach: attachFor(existing) };
  const host = localHost();
  const dir = resolveCwd({ remote: false, label: host.label }, cwd);
  const chosen = await chooseBackend(backend);
  const term = { name: termName, backend: chosen, cwd: dir, host: host.id, created: new Date().toISOString() };
  if (chosen === "paseo") {
    const bin = await paseoBin();
    if (!bin) throw new Error("Paseo CLI unavailable");
    const stdout = await execPaseo(bin, ["terminal", "create", "--cwd", dir, "--name", termName, "--json"], { env: paseoEnv(), timeout: 15_000 });
    const info = JSON.parse(stdout);
    term.terminal_id = info.id;
    term.workspace_id = info.workspaceId;
  } else {
    const tmux = await tmuxBin();
    if (!tmux) throw new Error("tmux unavailable");
    if ((await tmuxSessions()).some((s) => s.name === termName)) throw new Error(`A tmux session named ${termName} already exists; read or send to it instead.`);
    await pexec(tmux, ["new-session", "-d", "-s", termName, "-c", dir]);
  }
  const db = loadTerminals();
  db.terminals.push(term);
  saveTerminals(db);
  audit({ event: "terminal_open", name: termName, backend: chosen, cwd: dir });
  if (command) await sendToTerminal({ name: termName, text: command, enter: true });
  return { ok: true, ...term, attach: attachFor(term) };
}

async function resolveTarget(name) {
  const own = findTerminal(name);
  if (own) return own;
  const value = String(name || "").trim();
  if ((await tmuxSessions()).some((s) => s.name === value)) return { name: value, backend: "tmux", external: true };
  throw new Error(`No terminal named ${name}. Call terminal_list.`);
}

export async function sendToTerminal({ name, text, enter = true, waitMs = 0, keys }) {
  const term = await resolveTarget(name);
  const literal = String(text ?? "");
  const special = Array.isArray(keys) ? keys.filter((k) => /^(Enter|Escape|Tab|C-c|C-d|C-z|C-l|Up|Down|Left|Right|BSpace)$/.test(k)) : [];
  if (term.backend === "paseo") {
    const bin = await paseoBin();
    const args = ["terminal", "send-keys", term.terminal_id];
    if (literal) args.push(literal.startsWith("-") ? ` ${literal}` : literal);
    args.push(...special);
    if (enter) args.push("Enter");
    if (args.length === 3) throw new Error("Nothing to send");
    await execPaseo(bin, args, { env: paseoEnv(), timeout: 15_000 });
  } else {
    const tmux = await tmuxBin();
    if (literal) await pexec(tmux, ["send-keys", "-t", term.name, "-l", "--", literal]);
    for (const key of special) await pexec(tmux, ["send-keys", "-t", term.name, key]);
    if (enter) { await delay(100); await pexec(tmux, ["send-keys", "-t", term.name, "Enter"]); }
  }
  audit({ event: "terminal_send", name: term.name, backend: term.backend, text: literal.slice(0, 500), keys: special, enter: !!enter });
  const settle = Math.max(0, Math.min(Number(waitMs) || 800, 15_000));
  await delay(settle);
  return { ok: true, sent: true, ...(await readTerminal({ name: term.name, lines: 30 })) };
}

export async function readTerminal({ name, lines = 40 }) {
  const term = await resolveTarget(name);
  const count = Math.max(5, Math.min(Number(lines) || 40, 300));
  let screen;
  if (term.backend === "paseo") {
    const bin = await paseoBin();
    const stdout = await execPaseo(bin, ["terminal", "capture", term.terminal_id, "--json"], { env: paseoEnv(), timeout: 15_000, coalesce: true });
    screen = (JSON.parse(stdout).lines || []).join("\n");
  } else {
    const tmux = await tmuxBin();
    const { stdout } = await pexec(tmux, ["capture-pane", "-t", term.name, "-p", "-S", `-${count}`], { maxBuffer: 4 * 1024 * 1024 });
    screen = stdout;
  }
  const trimmed = screen.replace(/\s+$/, "").split("\n").slice(-count).join("\n");
  const host = localHost();
  return { name: term.name, backend: term.backend, host: host.id, machine: host.label, screen: trimmed.slice(-16_000), attach: attachFor(term) };
}

export async function closeTerminal({ name }) {
  const term = findTerminal(name);
  if (!term) throw new Error(`Only terminals opened by the assistant can be closed (${name} was not). Other sessions are left untouched.`);
  if (term.backend === "paseo") {
    const bin = await paseoBin();
    await execPaseo(bin, ["terminal", "kill", term.terminal_id], { env: paseoEnv(), timeout: 15_000 }).catch(() => {});
  } else {
    const tmux = await tmuxBin();
    await pexec(tmux, ["kill-session", "-t", term.name]).catch(() => {});
  }
  const db = loadTerminals();
  db.terminals = db.terminals.filter((t) => t !== term && t.name !== term.name);
  saveTerminals(db);
  audit({ event: "terminal_close", name: term.name, backend: term.backend });
  return { ok: true, closed: term.name, backend: term.backend };
}
