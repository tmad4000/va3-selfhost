// Durable per-conversation drive state:
//   data/drive/<conversation>/state.json   small mutable state (atomic writes)
//   data/drive/<conversation>/events.jsonl append-only outbox; seq = cursor
//   data/drive/<conversation>/inputs/      uploaded utterance audio
//   data/drive/<conversation>/replies/     synthesized reply audio
// The phone long-polls events after its last cursor, so a reply generated
// while it was out of signal is simply waiting for it on reconnect.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "../env.js";

export const DRIVE_DIR = join(DATA_DIR, "drive");
const ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const cache = new Map(); // conversation -> { events, waiters }

export function validId(id) {
  return ID_RE.test(String(id || ""));
}

export function convDir(conv, ...sub) {
  if (!validId(conv)) throw new Error("Invalid conversation id");
  const dir = join(DRIVE_DIR, conv, ...sub);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const DEFAULT_STATE = () => ({
  version: 1,
  epoch: 1,
  inputs: {},          // inputId -> { seq, kind, recorded_at, received_at, status, file?, text? }
  coordinator: null,   // { agent_id, created_at, checklist_dir }
  checklist_next: 1,
  phase: "idle",
});

export function readState(conv) {
  const file = join(convDir(conv), "state.json");
  if (!existsSync(file)) return DEFAULT_STATE();
  try { return { ...DEFAULT_STATE(), ...JSON.parse(readFileSync(file, "utf8")) }; } catch { return DEFAULT_STATE(); }
}

// Serialized read-modify-write per conversation, so concurrent uploads and
// pipeline updates never overwrite each other with a stale snapshot.
const locks = new Map();
export function mutateState(conv, fn) {
  const prev = locks.get(conv) || Promise.resolve();
  const next = prev.then(() => {
    const state = readState(conv);
    const result = fn(state);
    atomicWrite(join(convDir(conv), "state.json"), `${JSON.stringify(state, null, 2)}\n`);
    return result;
  });
  locks.set(conv, next.catch(() => {}));
  return next;
}

function entry(conv) {
  if (!cache.has(conv)) {
    const file = join(convDir(conv), "events.jsonl");
    const events = existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      : [];
    cache.set(conv, { events, waiters: new Set() });
  }
  return cache.get(conv);
}

export function lastSeq(conv) {
  return entry(conv).events.at(-1)?.seq || 0;
}

export function emit(conv, event) {
  const e = entry(conv);
  const record = { ...event, seq: lastSeq(conv) + 1, ts: new Date().toISOString() };
  e.events.push(record);
  if (e.events.length > 5_000) e.events.splice(0, e.events.length - 5_000);
  appendFileSync(join(convDir(conv), "events.jsonl"), `${JSON.stringify(record)}\n`);
  for (const wake of e.waiters) wake();
  e.waiters.clear();
  return record;
}

export function eventsAfter(conv, after, limit = 200) {
  return entry(conv).events.filter((ev) => ev.seq > after).slice(0, limit);
}

// Long-poll: resolve immediately when events exist, else wait up to waitMs.
export function waitForEvents(conv, after, waitMs) {
  const ready = eventsAfter(conv, after);
  if (ready.length || waitMs <= 0) return Promise.resolve(ready);
  return new Promise((resolve) => {
    const e = entry(conv);
    const wake = () => { clearTimeout(timer); resolve(eventsAfter(conv, after)); };
    const timer = setTimeout(() => { e.waiters.delete(wake); resolve([]); }, waitMs);
    e.waiters.add(wake);
  });
}
