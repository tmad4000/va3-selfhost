// Self-update: V3 changes its own code at Jacob's request, then deploys and
// restarts itself, with durable job state that survives the restart.
//
// The server only validates the request and launches bin/va3-self-update.mjs
// as a detached process (its own session, so `launchctl kickstart -k` of this
// service does not kill it). The runner does the work and records each step in
// DATA_DIR/self-update/jobs/<id>.json:
//
//   queued → preparing → worker_running (→ worker_blocked) → testing →
//   deploying → restarting → verifying → completed
//   (or failed / rolled_back, with the reason and evidence)
//
// "completed" requires the restarted service to report the new version. The
// browser polls /api/self-update/updates and tells the live conversation;
// "reconnected" is recorded when the browser first reports in after restart.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, env, PROJECT_ROOT } from "./env.js";
import { readTranscript } from "./transcripts.js";

export const JOBS_DIR = join(DATA_DIR, "self-update", "jobs");
const TERMINAL = new Set(["completed", "failed", "rolled_back"]);
const ANNOUNCE = new Set(["worker_blocked", "restarting", "completed", "failed", "rolled_back"]);
const BOOTED_AT = new Date().toISOString();
// A job sitting in "queued" this long, waiting its turn behind another
// active job, is worth telling Jacob about instead of going silent — he
// asked for a change and nothing visibly happened yet.
const QUEUE_NOTICE_MS = Number(env("VA3_SELF_UPDATE_QUEUE_NOTICE_MS", "120000"));
const QUEUE_NOTICE_MARK = "queued_delayed";

export function jobPath(id) {
  if (!/^su-[a-z0-9-]+$/.test(String(id))) throw new Error(`Invalid self-update job id ${id}`);
  return join(JOBS_DIR, `${id}.json`);
}

export function readJob(id) {
  const file = jobPath(id);
  if (!existsSync(file)) throw new Error(`No self-update job ${id}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeJob(job) {
  mkdirSync(JOBS_DIR, { recursive: true });
  const file = jobPath(job.id);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(job, null, 2));
  renameSync(tmp, file);
  return job;
}

// Read-modify-write with no await in between.
export function updateJob(id, patch, event) {
  const job = readJob(id);
  Object.assign(job, typeof patch === "function" ? patch(job) : patch, { updated_at: new Date().toISOString() });
  if (event) job.events = [...(job.events || []), { at: new Date().toISOString(), state: job.state, ...event }].slice(-100);
  return writeJob(job);
}

export function listJobs({ limit = 10 } = {}) {
  if (!existsSync(JOBS_DIR)) return [];
  return readdirSync(JOBS_DIR)
    .filter((f) => /^su-.*\.json$/.test(f))
    .map((f) => { try { return JSON.parse(readFileSync(join(JOBS_DIR, f), "utf8")); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit);
}

export function presentJob(job) {
  let log_tail = null;
  if (job.log) {
    try { log_tail = readFileSync(job.log, "utf8").slice(-4_000); } catch { /* log may not exist yet */ }
  }
  return {
    id: job.id,
    kind: job.kind || "change",
    state: job.state,
    task: job.task,
    created_at: job.created_at,
    updated_at: job.updated_at,
    base_commit: job.base_commit || null,
    base_version: job.base_version || null,
    new_version: job.new_version || null,
    deployed_commit: job.deployed_commit || null,
    worker: job.worker || null,
    tests: job.tests ? {
      passed: job.tests.passed,
      summary: job.tests.summary,
      attempts_run: job.tests.attempts_run || 1,
      failures: (job.tests.failures || []).map((f) => ({ test: failureLabel(f), error: f.error || null })),
      consistent_failures: job.tests.consistent_failures || [],
      flaky: job.tests.flaky || [],
      logs: (job.tests.attempts || []).map((a) => a.log).filter(Boolean),
    } : null,
    source_ref: job.source_ref || null,
    deploy_blocked: job.deploy_blocked || null,
    verification: job.verification || null,
    rollback: job.rollback || null,
    error: job.error || null,
    // The stage that was active when a failure happened (e.g. "testing",
    // "deploying", "restarting"), not just "failed" — so a report can say
    // where it stalled, not only that it did.
    failed_stage: job.failed_stage || null,
    waiting_on: job.waiting_on || null,
    log: job.log || null,
    log_tail,
    worker_log: job.worker_log || null,
    client_reconnected_at: job.client_reconnected_at || null,
    last_event: (job.events || []).slice(-1)[0] || null,
    finished: TERMINAL.has(job.state),
  };
}

// ---------- test results ----------
// Parse a test run's output (node --test spec or TAP reporter, plus
// bin/smoke.sh) into counts and the failing tests by file, name and first
// error lines, so a failed job says WHICH test failed, not just "fail 1".
function firstLines(text, n = 4) {
  return String(text || "").split("\n").map((l) => l.trim()).filter((l) => l && !/^at |^\^|^-+$|^\.\.\.$/.test(l)).slice(0, n).join(" | ").slice(0, 600);
}

export function summarizeTestOutput(output, { cwd = null } = {}) {
  const text = String(output || "");
  const rel = (file) => {
    let f = String(file || "").replace(/^file:\/\//, "").replace(/:\d+:\d+$/, "");
    if (cwd && f.startsWith(`${cwd}/`)) f = f.slice(cwd.length + 1);
    return f || null;
  };
  const counts = {};
  for (const m of text.matchAll(/^(?:ℹ|#) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/gm)) counts[m[1]] = Number(m[2]);
  const failures = [];
  const seen = new Set();
  const add = (f) => {
    const key = `${f.file}|${f.name}`;
    if (!seen.has(key)) { seen.add(key); failures.push(f); }
  };
  const specAt = text.lastIndexOf("✖ failing tests:");
  if (specAt >= 0) {
    const block = `${text.slice(specAt)}\n`;
    for (const m of block.matchAll(/^test at ([^\n]+)\n✖ ([^\n]+?)(?: \([\d.]+m?s\))?\n((?:[ \t][^\n]*\n|\n)*)/gm)) {
      add({ file: rel(m[1].trim()), name: m[2].trim(), error: firstLines(m[3]) });
    }
  }
  if (!failures.length) {
    // TAP: "not ok N - name" followed by an indented YAML block.
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/^(\s*)not ok \d+ - (.+?)\s*(?:# .*)?$/);
      if (!m) return;
      const block = [];
      for (let k = i + 1; k < lines.length && !/^\s*(?:not )?ok \d+ /.test(lines[k]); k++) block.push(lines[k]);
      const yaml = block.join("\n");
      const location = yaml.match(/location: '([^']+)'/)?.[1] || "";
      if (/^\s*failureType: 'subtestsFailed'/m.test(yaml)) return; // a file-level wrapper; its subtests are listed
      const error = yaml.match(/error: \|-\n([\s\S]*?)\n\s*(?:code|name|expected|actual|operator|stack|failureType):/)?.[1]
        || yaml.match(/error: '([^']*)'/)?.[1] || "";
      add({ file: rel(location), name: m[2], error: firstLines(error) });
    });
  }
  const smokeMatch = [...text.matchAll(/smoke: (\d+) passed, (\d+) failed/g)].pop();
  const smoke = smokeMatch ? { passed: Number(smokeMatch[1]), failed: Number(smokeMatch[2]) } : null;
  for (const m of text.matchAll(/^FAIL: (.+?)(?: — got: (.*))?$/gm)) add({ file: "bin/smoke.sh", name: m[1].trim(), error: firstLines(m[2] || "", 1) });
  const parts = [];
  if (counts.tests !== undefined || counts.pass !== undefined) parts.push(`tests: ${counts.pass ?? "?"} passed, ${counts.fail ?? "?"} failed${counts.cancelled ? `, ${counts.cancelled} cancelled` : ""}`);
  if (smoke) parts.push(`smoke: ${smoke.passed} passed, ${smoke.failed} failed`);
  return { counts, smoke, failures, summary: parts.join("; ") };
}

export const failureLabel = (f) => `${f.file ? `${f.file} › ` : ""}${f.name}`;

// Combine attempts: a failure that recurs on every attempt is consistent
// (treat as real); one that went away on a later attempt is a flake.
export function combineTestAttempts(attempts) {
  const last = attempts[attempts.length - 1];
  const failedRuns = attempts.filter((a) => !a.passed);
  const labels = (a) => new Set((a.failures || []).map(failureLabel));
  let consistent = [];
  let flaky = [];
  if (last.passed) {
    flaky = [...new Set(failedRuns.flatMap((a) => [...labels(a)]))];
  } else {
    const lastSet = labels(last);
    consistent = [...lastSet].filter((l) => failedRuns.every((a) => labels(a).has(l) || !(a.failures || []).length));
    flaky = [...new Set(failedRuns.slice(0, -1).flatMap((a) => [...labels(a)]))].filter((l) => !lastSet.has(l));
  }
  return {
    passed: last.passed,
    exit_code: last.exit_code,
    summary: last.summary,
    attempts_run: attempts.length,
    failures: last.passed ? [] : last.failures,
    consistent_failures: consistent,
    flaky,
    attempts: attempts.map(({ tail, ...a }, i) => (i === attempts.length - 1 ? { ...a, tail } : { ...a, tail: String(tail || "").slice(-1_500) })),
  };
}

export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

// A self-update changes the running app, so it must trace back to something
// Jacob actually said or typed in this conversation recently. Tool output,
// files, or agent replies cannot start one on their own.
function recentUserRequest(sessionId, maxAgeMinutes) {
  if (!sessionId) return null;
  const cutoff = Date.now() - maxAgeMinutes * 60_000;
  const rows = readTranscript(sessionId, { limit: 60 });
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.role !== "user") continue;
    if (row.metadata?.queued) continue; // queued text is not live consent
    if (Date.parse(row.ts) < cutoff) return null;
    return { text: String(row.text).slice(0, 2_000), at: row.ts, source: row.metadata?.source || "speech" };
  }
  return null;
}

export function startSelfUpdate({ task, sessionId, provider, port }) {
  const request = String(task || "").trim();
  if (!request) throw new Error("task is required");
  const evidence = recentUserRequest(sessionId, Number(env("VA3_SELF_UPDATE_REQUEST_WINDOW_MIN", "15")));
  if (!evidence) {
    throw new Error("A self-update needs a recent request from Jacob in this conversation (spoken or typed within 15 minutes). Ask him to confirm what to change.");
  }
  return launchSelfUpdate({ task: request, sessionId, provider, port, requestedBy: evidence });
}

// Also used by the operator CLI (`bin/va3-self-update.mjs start`), which runs
// with shell access on this machine and records itself as the requester.
export function launchSelfUpdate({ task, sessionId, provider, port, requestedBy, kind = "change", sourceRef = null }) {
  const request = String(task || "").trim();
  if (!request) throw new Error("task is required");
  const evidence = requestedBy;
  const active = listJobs({ limit: 20 }).filter((j) => !TERMINAL.has(j.state));
  const id = `su-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
  const job = writeJob({
    id,
    kind,
    ...(sourceRef ? { source_ref: String(sourceRef) } : {}),
    state: "queued",
    task: request,
    provider: provider || null,
    session_id: sessionId,
    requested_by: evidence,
    service_port: Number(port) || Number(env("PORT", "8732")),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    queued_behind: active.map((j) => j.id),
    events: [{ at: new Date().toISOString(), state: "queued", detail: "accepted" }],
    announced: [],
  });

  // Detached in its own session: survives this server's restart.
  const runner = join(PROJECT_ROOT, "bin", "va3-self-update.mjs");
  const logFile = join(JOBS_DIR, `${id}.log`);
  const out = openSync(logFile, "a");
  const child = spawn(process.execPath, [runner, id], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  updateJob(id, { runner_pid: child.pid, log: logFile });
  return {
    ...presentJob(readJob(id)),
    note: kind === "branch"
      ? `Re-queued ${sourceRef}: its commits are replayed onto the running build, then tested, deployed, restarted and verified (rolls back if that fails).`
      : kind === "pull"
      ? "Installing the update from the source repo in the background: tests run on it first, then the app deploys, restarts itself, and checks its new version (rolls back if that fails)."
      : "Accepted and running in the background. It is NOT done: a coding worker makes the change, then tests run, then the app deploys, restarts itself, and checks its new version. Updates arrive automatically; call self_update_status any time.",
  };
}

// Install newer commits from the release remote (the update banner's Update
// button or its auto-update). No coding worker: the runner tests the
// incoming commit in a worktree, then fast-forwards, restarts and verifies,
// rolling back on failure. One pull job at a time.
export function launchPullUpdate({ port, requestedBy }) {
  const running = listJobs({ limit: 20 }).find((j) => (j.kind === "pull") && !TERMINAL.has(j.state));
  if (running) return { ...presentJob(running), already_running: true };
  return launchSelfUpdate({ kind: "pull", task: "Install the update from the source repo", sessionId: null, port, requestedBy });
}

// The newest pull job, for the update banner (hidden once old and finished).
export function latestPullJob({ maxAgeMinutes = 30 } = {}) {
  const job = listJobs({ limit: 20 }).find((j) => j.kind === "pull");
  if (!job) return null;
  if (TERMINAL.has(job.state) && Date.now() - Date.parse(job.updated_at) > maxAgeMinutes * 60_000) return null;
  const shown = presentJob(job);
  delete shown.log_tail;
  return shown;
}

export function selfUpdateStatus({ id } = {}) {
  if (id) return presentJob(readJob(id));
  return { jobs: listJobs({ limit: 5 }).map(presentJob) };
}

// Announce each important state once per conversation. The browser acks what
// it delivered, so an update lost during the restart is offered again.
export function selfUpdateUpdates({ sessionId }) {
  if (!sessionId) return [];
  const updates = [];
  for (const job of listJobs({ limit: 10 })) {
    if (job.session_id !== sessionId) continue;
    // First contact from the browser after the restart that this job caused.
    if (job.restarted_at && !job.client_reconnected_at && Date.parse(BOOTED_AT) >= Date.parse(job.restarted_at)) {
      // A field, not an event: the last event keeps describing the job's state.
      updateJob(job.id, { client_reconnected_at: new Date().toISOString() });
    }
    if (ANNOUNCE.has(job.state) && !(job.announced || []).includes(job.state)) {
      updates.push(presentJob(readJob(job.id)));
    } else if (
      job.state === "queued" && job.waiting_on?.ids?.length
      && Date.now() - Date.parse(job.created_at) > QUEUE_NOTICE_MS
      && !(job.announced || []).includes(QUEUE_NOTICE_MARK)
    ) {
      updateJob(job.id, (j) => ({ announced: [...new Set([...(j.announced || []), QUEUE_NOTICE_MARK])] }));
      const shown = presentJob(readJob(job.id));
      shown.detail = `Still waiting its turn behind ${job.waiting_on.ids.join(", ")} (${job.waiting_on.states.join(", ")}); it will start once that finishes.`;
      updates.push(shown);
    }
  }
  return updates;
}

export function ackSelfUpdate({ id, state }) {
  return presentJob(updateJob(id, (job) => ({ announced: [...new Set([...(job.announced || []), String(state)])] })));
}

export const SERVER_BOOTED_AT = BOOTED_AT;
