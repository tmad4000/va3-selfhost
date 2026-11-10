import "../../public/voice-tool-results.js";
// gpt-realtime-2.1 as the drive-mode speech brain, used per turn.
//
// Each turn gets a FRESH realtime session seeded from the JSONL transcript
// (the single ledger), then the uploaded utterance audio is appended and
// committed, and the model answers in audio. The session is closed after the
// turn, so nothing depends on a long-lived socket surviving; a warm socket is
// pre-opened while the phone is attached to hide the ~1 s connect cost.
// Reply audio streams out as progressively larger AAC parts (first part
// ~1 s) so the phone starts playing before the reply is finished.
import { execFile } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { WebSocket } from "../../vendor/ws/wrapper.mjs";
import { env, openaiKey, SELF_HOST } from "../env.js";

const pexec = promisify(execFile);
const RATE = 24_000;
const warmPool = new Map(); // conv -> { promise, idleTimer }

export const realtimeModel = () => env("DRIVE_REALTIME_MODEL", env("REALTIME_MODEL", "gpt-realtime-2.1"));
export const realtimeEnabled = () => env("DRIVE_BRAIN", SELF_HOST ? "pipeline" : "realtime") === "realtime" && env("DRIVE_FAKE_AI") !== "1";

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(realtimeModel())}`, {
      headers: { Authorization: `Bearer ${openaiKey()}` },
    });
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("realtime connect timeout")); }, 10_000);
    const listeners = new Set();
    ws.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === "session.created") { clearTimeout(timer); resolve(session); }
      if (ev.type === "error") { session.lastError = ev.error?.message || JSON.stringify(ev.error); console.error("[drive] realtime error:", session.lastError); }
      for (const l of listeners) l(ev);
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`realtime socket error: ${e.message || e.type}`)); };
    ws.onclose = () => { session.closed = true; for (const l of listeners) l({ type: "_closed" }); };
    const session = {
      ws,
      closed: false,
      openedAt: Date.now(),
      send: (obj) => ws.send(JSON.stringify(obj)),
      on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      close: () => { try { ws.close(); } catch {} },
    };
  });
}

// Keep one fresh, unused session ready while the phone is attached.
export function warm(conv) {
  if (!realtimeEnabled()) return;
  const slot = warmPool.get(conv);
  if (slot) { refreshIdle(conv, slot); return; }
  const promise = connect();
  const entry = { promise };
  warmPool.set(conv, entry);
  promise.then((s) => {
    s.on((ev) => { if (ev.type === "_closed" && warmPool.get(conv) === entry) warmPool.delete(conv); });
  }).catch(() => { if (warmPool.get(conv) === entry) warmPool.delete(conv); });
  refreshIdle(conv, entry);
}

function refreshIdle(conv, entry) {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(async () => {
    if (warmPool.get(conv) !== entry) return;
    warmPool.delete(conv);
    (await entry.promise.catch(() => null))?.close();
  }, 5 * 60_000);
}

async function takeSession(conv) {
  const entry = warmPool.get(conv);
  warmPool.delete(conv);
  if (entry) {
    clearTimeout(entry.idleTimer);
    const s = await entry.promise.catch(() => null);
    // Realtime sessions have a hard lifetime; don't start a turn on an old one.
    if (s && !s.closed && Date.now() - s.openedAt < 20 * 60_000) return s;
    s?.close();
  }
  return connect();
}

export async function toPcm(file) {
  const out = `${file}.${randomUUID().slice(0, 8)}.pcm.wav`;
  await pexec("/usr/bin/afconvert", ["-f", "WAVE", "-d", `LEI16@${RATE}`, "-c", "1", file, out], { timeout: 30_000 });
  const wav = readFileSync(out);
  rmSync(out, { force: true });
  const at = wav.indexOf(Buffer.from("data"));
  return wav.subarray(at + 8);
}

function wavHeader(bytes) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + bytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(bytes, 40);
  return h;
}

export async function encodePart(pcm, dir, name) {
  const wav = join(dir, `${name}.wav`);
  const m4a = join(dir, `${name}.m4a`);
  writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm]));
  try {
    await pexec("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", "-b", "48000", "-c", "1", wav, m4a], { timeout: 30_000 });
  } finally {
    rmSync(wav, { force: true });
  }
  return `${name}.m4a`;
}

/**
 * Run one turn.
 * @param history  Responses-style [{role, content}] from the ledger (before this batch)
 * @param items    this batch in order: {kind:"audio", pcm, note?, inputId} | {kind:"text", text, inputId}
 * @param hooks    onTranscript(inputId, text), onPart({pcm, index, final, text?}), onAssistantText(text),
 *                 runTool(name, args) -> result, superseded() -> bool
 * @returns {status: "completed"|"empty"|"superseded", spoke: bool}
 */
export async function realtimeTurn(conv, { instructions, tools, history, items, voice, hooks }) {
  if (hooks.superseded()) return { status: "superseded", spoke: false };
  const s = await takeSession(conv);
  const audioItems = items.filter((i) => i.kind === "audio");
  const transcripts = new Map();      // item_id -> inputId
  const pendingTranscripts = new Set(audioItems.map((i) => i.inputId));
  let resolveTranscripts;
  const transcriptsDone = new Promise((r) => { resolveTranscripts = r; if (!pendingTranscripts.size) r(); });
  let anySpeech = audioItems.length === 0;
  let spoke = false;
  let round = 0;

  const off = s.on((ev) => {
    if (ev.type === "conversation.item.input_audio_transcription.completed" || ev.type === "conversation.item.input_audio_transcription.failed") {
      const inputId = transcripts.get(ev.item_id);
      if (!inputId) return;
      const text = String(ev.transcript || "").trim();
      if (text.replace(/[^\p{L}\p{N}]/gu, "").length >= 2) anySpeech = true;
      hooks.onTranscript(inputId, text, ev.type.endsWith("failed"));
      pendingTranscripts.delete(inputId);
      if (!pendingTranscripts.size) resolveTranscripts();
    }
  });

  try {
    s.send({ type: "session.update", session: {
      type: "realtime",
      instructions,
      tools,
      tool_choice: "auto",
      output_modalities: ["audio"],
      audio: {
        input: { format: { type: "audio/pcm", rate: RATE }, turn_detection: null, transcription: { model: env("DRIVE_TRANSCRIBE_MODEL", "gpt-transcribe") } },
        output: { voice, format: { type: "audio/pcm", rate: RATE } },
      },
    } });
    for (const h of history) {
      s.send({ type: "conversation.item.create", item: { type: "message", role: h.role, content: [{ type: h.role === "assistant" ? "output_text" : "input_text", text: h.content }] } });
    }
    for (const it of items) {
      if (it.kind === "text") {
        s.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: it.text }] } });
        continue;
      }
      if (it.note) s.send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `(The next voice message was ${it.note}.)` }] } });
      for (let i = 0; i < it.pcm.length; i += 96_000) s.send({ type: "input_audio_buffer.append", audio: it.pcm.subarray(i, i + 96_000).toString("base64") });
      const committedP = waitFor(s, (ev) => ev.type === "input_audio_buffer.committed" || ev.type === "error", 15_000);
      s.send({ type: "input_audio_buffer.commit" });
      const committed = await committedP;
      if (committed.type === "error") throw new Error(committed.error?.message || "commit failed");
      transcripts.set(committed.item_id, it.inputId);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await runResponse(s, {
        // Hold audio until we know it wasn't just road noise.
        gate: async () => { await Promise.race([transcriptsDone, sleep(4_000)]); return anySpeech; },
        superseded: hooks.superseded,
        onPart: async (pcm, index, final) => { spoke = true; await hooks.onPart({ pcm, index, final, round }); },
      });
      if (result.status !== "completed") {
        await Promise.race([transcriptsDone, sleep(4_000)]);
        return { status: result.status, spoke };
      }
      if (result.text) hooks.onAssistantText(result.text, round);
      if (!result.calls.length) break;
      round++;
      for (const call of result.calls) {
        let args = {};
        try { args = JSON.parse(call.arguments || "{}"); } catch {}
        let out;
        try { out = await hooks.runTool(call.name, args); } catch (err) { out = { ok: false, error: String(err.message || err) }; }
        s.send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.call_id, output: call.name === "list_asks" ? globalThis.VA3VoiceToolResults.serialize(call.name, out, args) : JSON.stringify(out).slice(0, 8_000) } });
      }
    }
    await Promise.race([transcriptsDone, sleep(4_000)]);
    return { status: "completed", spoke };
  } finally {
    off();
    s.close();
    warm(conv); // fresh session for the next turn
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function waitFor(s, pred, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`realtime event timeout${s.lastError ? ` (last error: ${s.lastError})` : ""}`)); }, ms);
    const off = s.on((ev) => {
      if (ev.type === "_closed") { clearTimeout(timer); off(); reject(new Error("realtime socket closed")); }
      else if (pred(ev)) { clearTimeout(timer); off(); resolve(ev); }
    });
  });
}

// One response.create. Streams audio into parts: first flush at ~1 s, later
// parts at ~4 s, remainder at response.done.
function runResponse(s, { gate, superseded, onPart }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let buffered = 0;
    let parts = 0;
    let gated = null;          // null = unknown, true = speak, false = suppress
    let text = "";
    let finished = false;
    let chain = Promise.resolve();
    const threshold = () => (parts === 0 ? RATE * 2 * 1.0 : RATE * 2 * 4.0);
    const flush = (final) => {
      if (!buffered && !final) return;
      const pcm = Buffer.concat(chunks.splice(0));
      buffered = 0;
      const index = parts++;
      chain = chain.then(() => onPart(pcm, index, final));
    };
    const timer = setTimeout(() => done(reject, new Error("realtime response timeout")), 90_000);
    const done = (fn, v) => { if (finished) return; finished = true; clearTimeout(timer); off(); fn(v); };

    gate().then((ok) => {
      gated = ok;
      if (!ok) { s.send({ type: "response.cancel" }); return; }
      if (buffered >= threshold()) flush(false);
    });

    const off = s.on((ev) => {
      if (ev.type === "_closed") return done(reject, new Error("realtime socket closed mid-response"));
      if (ev.type === "error") {
        if (/no active response/i.test(ev.error?.message || "")) return;
        return done(reject, new Error(ev.error?.message || "realtime error"));
      }
      if (ev.type === "response.output_audio.delta") {
        if (gated === false) return;
        if (parts === 0 && superseded()) { s.send({ type: "response.cancel" }); gated = false; return void done(resolve, { status: "superseded", calls: [] }); }
        const b = Buffer.from(ev.delta, "base64");
        chunks.push(b);
        buffered += b.length;
        if (gated && buffered >= threshold()) flush(false);
      }
      if (ev.type === "response.output_audio_transcript.done") text += (text ? " " : "") + (ev.transcript || "");
      if (ev.type === "response.done") {
        const r = ev.response || {};
        if (gated === false) return chain.then(() => done(resolve, { status: "empty", calls: [] }));
        const calls = (r.output || []).filter((o) => o.type === "function_call").map((o) => ({ call_id: o.call_id, name: o.name, arguments: o.arguments }));
        const finalize = () => {
          if (buffered || parts) flush(true); // a zero-length final part just marks the end
          chain.then(() => done(resolve, { status: r.status === "cancelled" ? "superseded" : "completed", text, calls })).catch((e) => done(reject, e));
        };
        if (gated === null) gate().then((ok) => (ok ? finalize() : done(resolve, { status: "empty", calls: [] })));
        else finalize();
      }
    });
    s.send({ type: "response.create" });
  });
}
