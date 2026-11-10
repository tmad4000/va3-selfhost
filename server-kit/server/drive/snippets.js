// Retention for the server's copies of Jacob's drive-mode speech
// (data/drive/<conversation>/inputs/<input-id>.m4a). The phone uploads each
// utterance once (the existing segments path); the server needs it until the
// turn is processed. Afterwards it is a speech snippet, kept so a turn can be
// re-checked, then expired automatically:
//   speech_snippets "keep" (default): deleted VA3_SNIPPET_SERVER_HOURS (48)
//     after it was processed, and at most VA3_SNIPPET_SERVER_MAX_PER_CONV (100)
//     settled files per conversation (oldest first);
//   speech_snippets "off": deleted once settled for OFF_GRACE_MS (the fallback
//     brain may still re-read a batch just after the realtime turn).
// Audio whose input is still received/processing is never deleted. Files and
// the inputs directory are kept owner-only (0600 / 0700); the sweep also
// tightens files written before this existed. The input record keeps its
// metadata and gets audio_expired_at. Nothing here sends audio anywhere.
import { chmodSync, existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { env } from "../env.js";
import { getSettings } from "../settings.js";
import { DRIVE_DIR, mutateState, validId } from "./store.js";

export const OFF_GRACE_MS = 2 * 60 * 1000;
const SETTLED = new Set(["done", "empty"]);
const SWEEP_MS = 10 * 60 * 1000;

export function snippetPolicy(settings = getSettings()) {
  const hours = Number(env("VA3_SNIPPET_SERVER_HOURS", "48"));
  const max = Number(env("VA3_SNIPPET_SERVER_MAX_PER_CONV", "100"));
  return {
    mode: settings.speech_snippets === "off" ? "off" : "keep",
    max_age_ms: Math.max(0, Number.isFinite(hours) ? hours : 48) * 3600 * 1000,
    max_per_conversation: Math.max(0, Number.isFinite(max) ? Math.floor(max) : 100),
  };
}

function tighten(path, mode) {
  try { if ((statSync(path).mode & 0o777) !== mode) chmodSync(path, mode); } catch { /* raced with delete */ }
}

// Pure decision over one conversation's files: which to delete and why.
// files: [{ name, id, mtimeMs }]; inputs: state.inputs.
export function expiryPlan(files, inputs, policy, now = Date.now()) {
  const settled = [];
  for (const f of files) {
    const input = inputs[f.id];
    if (!input && now - f.mtimeMs < OFF_GRACE_MS) continue;
    if (input && !SETTLED.has(input.status)) continue;
    const at = Date.parse(input?.settled_at || input?.received_at || "") || f.mtimeMs;
    settled.push({ ...f, at });
  }
  const drop = new Map();
  for (const f of settled) {
    if (policy.mode === "off") { if (now - f.at >= OFF_GRACE_MS) drop.set(f.name, "off"); }
    else if (now - f.at > policy.max_age_ms) drop.set(f.name, "expired");
  }
  if (policy.mode !== "off") {
    const kept = settled.filter((f) => !drop.has(f.name)).sort((a, b) => b.at - a.at);
    for (const f of kept.slice(policy.max_per_conversation)) drop.set(f.name, "over_limit");
  }
  return drop;
}

export async function sweepConversation(conv, { policy = snippetPolicy(), now = Date.now() } = {}) {
  if (!validId(conv)) return { deleted: 0 };
  const dir = join(DRIVE_DIR, conv, "inputs");
  if (!existsSync(dir)) return { deleted: 0 };
  tighten(dir, 0o700);
  const files = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(/^([A-Za-z0-9_-]+)\.(m4a|wav)$/);
    if (!m) continue;
    const path = join(dir, name);
    tighten(path, 0o600);
    try { files.push({ name, id: m[1], mtimeMs: statSync(path).mtimeMs }); } catch { /* gone */ }
  }
  return mutateState(conv, (s) => {
    const current = files.flatMap((f) => {
      try { return [{ ...f, mtimeMs: statSync(join(dir, f.name)).mtimeMs }]; } catch { return []; }
    });
    const drop = expiryPlan(current, s.inputs, policy, now);
    let deleted = 0;
    for (const [name, reason] of drop) {
      const id = name.replace(/\.(m4a|wav)$/, "");
      const input = s.inputs[id];
      if (input && !SETTLED.has(input.status)) continue;
      try { unlinkSync(join(dir, name)); deleted += 1; } catch { continue; }
      if (input) { input.audio_expired_at = new Date(now).toISOString(); input.audio_expired_reason = reason; }
    }
    return { deleted };
  });
}

export async function sweepAll(opts = {}) {
  if (!existsSync(DRIVE_DIR)) return { deleted: 0, conversations: 0 };
  let deleted = 0;
  let conversations = 0;
  for (const conv of readdirSync(DRIVE_DIR)) {
    if (!validId(conv)) continue;
    try {
      const r = await sweepConversation(conv, opts);
      deleted += r.deleted;
      conversations += 1;
    } catch (err) {
      console.warn(`[drive] snippet sweep failed for ${conv}: ${err.message || err}`);
    }
  }
  return { deleted, conversations };
}

let timer = null;
export function startSnippetSweep() {
  if (timer) return;
  const run = () => sweepAll().then((r) => { if (r.deleted) console.log(`[drive] expired ${r.deleted} speech snippet(s)`); }).catch(() => {});
  run();
  timer = setInterval(run, SWEEP_MS);
  timer.unref?.();
}
