// Release freshness: is the running build really the latest?
//
// Three facts, each with its own source and time:
// - running: the version/commit this process loaded at start;
// - deployed: what is on disk in the deployed checkout now (a newer commit
//   there means a restart is needed);
// - origin: the deploy branch on the git remote, checked with a short timeout.
// "latest" is only claimed when origin was reachable and matched. Otherwise
// the status says "unknown" with the last check time and the reason.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { env, PROJECT_ROOT } from "./env.js";

const pexec = promisify(execFile);
const CHECK_EVERY_MS = 15 * 60_000;

async function git(args, timeout = 8_000) {
  const { stdout } = await pexec("git", args, {
    cwd: PROJECT_ROOT,
    timeout,
    env: { ...process.env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=5", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

function readPackage() {
  return JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8"));
}

const boot = readPackage();
const running = { version: boot.version, updated_at: boot.updated_at || null, commit: null, started_at: new Date().toISOString() };
git(["rev-parse", "HEAD"]).then((c) => { running.commit = c; }).catch(() => {});

let origin = { checked_at: null, reachable: null, commit: null, remote: null, branch: null, error: null, last_success_at: null };
let inflight = null;

async function checkOrigin() {
  const checkedAt = new Date().toISOString();
  try {
    const branch = env("VA3_RELEASE_BRANCH") || await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const remote = env("VA3_RELEASE_REMOTE", "origin");
    const url = await git(["remote", "get-url", remote]).catch(() => null);
    if (!url) {
      origin = { ...origin, checked_at: checkedAt, reachable: false, remote, branch, error: `no git remote named ${remote}` };
      return origin;
    }
    const out = await git(["ls-remote", remote, `refs/heads/${branch}`], 12_000);
    const commit = out.split(/\s+/)[0] || null;
    origin = { checked_at: checkedAt, reachable: true, commit, remote: `${remote} (${url})`, branch, error: commit ? null : `branch ${branch} not on ${remote}`, last_success_at: checkedAt };
  } catch (error) {
    // git prints the real cause first (e.g. "ssh: connect to host … timed out")
    // and generic advice after it; report the cause.
    const lines = String(error.stderr || error.message || error).trim().split("\n").map((l) => l.trim()).filter(Boolean);
    const detail = lines.find((l) => /^(ssh:|fatal:)|timed out|Could not resolve|refused|denied/i.test(l)) || lines[0] || "unreachable";
    origin = { ...origin, checked_at: checkedAt, reachable: false, error: error.killed ? "timed out" : detail.slice(0, 200) };
  }
  return origin;
}

async function relation(a, b) {
  if (!a || !b) return null;
  if (a === b) return "same";
  try { await git(["merge-base", "--is-ancestor", b, a]); return "ahead"; } catch { /* not ahead */ }
  try { await git(["merge-base", "--is-ancestor", a, b]); return "behind"; } catch { /* not behind */ }
  return "diverged";
}

export async function releaseStatus({ refresh = false } = {}) {
  if (refresh || !origin.checked_at || Date.now() - Date.parse(origin.checked_at) > CHECK_EVERY_MS) {
    inflight = inflight || checkOrigin().finally(() => { inflight = null; });
    await inflight;
  }
  let deployed = { version: null, updated_at: null, commit: null };
  try {
    const pkg = readPackage();
    deployed = { version: pkg.version, updated_at: pkg.updated_at || null, commit: await git(["rev-parse", "HEAD"]) };
  } catch { /* reported as unknown */ }

  let status;
  let summary;
  if (running.commit && deployed.commit && running.commit !== deployed.commit) {
    status = "restart_needed";
    summary = `A newer build (${deployed.version}) is deployed on disk; this process still runs ${running.version}. Restart to load it.`;
  } else if (!origin.reachable) {
    status = "unknown";
    summary = `Running ${running.version}. Whether it is the latest is unknown: ${origin.remote || "origin"} ${origin.error || "not checked yet"}${origin.checked_at ? ` (checked ${origin.checked_at})` : ""}.`;
  } else {
    const rel = await relation(running.commit, origin.commit);
    status = rel === "same" ? "latest" : rel === "ahead" ? "ahead_of_origin" : rel === "behind" ? "update_available" : rel === "diverged" ? "diverged" : "unknown";
    summary = {
      latest: `Running ${running.version}, which matches ${origin.branch} on ${origin.remote} as of ${origin.checked_at}.`,
      ahead_of_origin: `Running ${running.version}, newer than ${origin.branch} on ${origin.remote} (local changes not pushed) as of ${origin.checked_at}.`,
      update_available: `${origin.remote} has newer commits on ${origin.branch} than the running ${running.version} (checked ${origin.checked_at}).`,
      diverged: `The running build and ${origin.remote} ${origin.branch} have diverged (checked ${origin.checked_at}).`,
      unknown: `Running ${running.version}; could not compare with ${origin.remote}.`,
    }[status];
  }
  return { status, summary, running, deployed, origin };
}

export function startReleaseChecks() {
  releaseStatus({ refresh: true }).catch(() => {});
  setInterval(() => releaseStatus({ refresh: true }).catch(() => {}), CHECK_EVERY_MS).unref();
}

export function runningRelease() {
  return running;
}
