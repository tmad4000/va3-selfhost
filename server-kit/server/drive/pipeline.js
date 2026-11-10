import "../../public/voice-tool-results.js";
// Drive-mode brain: ordered intake -> transcribe -> think (with tools) ->
// sentence-level TTS -> outbox events. One serial loop per conversation.
//
// Ordering: phone segments carry a monotonic per-device seq. A gap (segment
// 7 arrives before 6) is held up to GAP_WAIT_MS so offline bursts replay in
// spoken order; after that the loop proceeds rather than stalling forever.
// Coalescing: if new input lands while a reply is still being generated (not
// yet spoken), that reply is dropped and regenerated covering everything.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { appendTranscript, readTranscript } from "../transcripts.js";
import { dispatchTool, toolDefinitions } from "../tools.js";
import { memoryContextBlock } from "../memory.js";
import { speak, splitForSpeech, think, transcribe } from "./ai.js";
import { askCoordinator, coordinatorStatus, setCoordinatorSayHandler } from "./coordinator.js";
import { convDir, emit, mutateState, readState } from "./store.js";
import { encodePart, realtimeEnabled, toPcm, realtimeTurn } from "./realtime-brain.js";
import { env, ownerDefault, SELF_HOST } from "../env.js";
import { OFF_GRACE_MS, snippetPolicy, sweepConversation } from "./snippets.js";

const GAP_WAIT_MS = Number(process.env.DRIVE_GAP_WAIT_MS || 15_000);
const STALE_MS = 60_000;
const running = new Set();
const rekick = new Set();
const generation = new Map();
const gapTimers = new Map();
let serverPort = 8732;
let titleFor = () => "Drive";

export const drivePort = () => serverPort;

export function configurePipeline({ port, title }) {
  if (port) serverPort = port;
  if (title) titleFor = title;
}

const FRONT_TOOLS = new Set(["get_system_overview", "escalate_to_smart_model", "memory_save", "memory_search", "submit_feedback"]);

// The owner's name in model-facing text. Self-host: VA3_OWNER_NAME or neutral
// wording; the original installation's name comes from config/owner-defaults.json.
const ownerName = () => env("VA3_OWNER_NAME", SELF_HOST ? "" : "the owner");

// Standalone servers get generic local-memory tools only: no project families,
// no Vision sync, no coordinator.
const SELF_HOST_TOOLS = Object.freeze([
  {
    type: "function",
    name: "memory_save",
    description: "Save a durable fact, preference or decision the owner wants remembered across conversations.",
    parameters: { type: "object", properties: { key: { type: "string", description: "Short label" }, content: { type: "string" } }, required: ["key", "content"], additionalProperties: false },
  },
  {
    type: "function",
    name: "memory_search",
    description: "Search persistent memory for past facts.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
]);

function driveTools() {
  if (SELF_HOST) return SELF_HOST_TOOLS;
  const owner = ownerName();
  return [
    {
      type: "function",
      name: "ask_coordinator",
      description: `Forward a request to ${owner}'s persistent coordinator agent, which orchestrates coding/research/ops sub-agents through Paseo and keeps the session checklist. Use for anything multi-step, anything touching his machines, repos, deploys, email, or follow-ups, and for steering or questioning work already in progress. Returns immediately; the coordinator reports back by voice later.`,
      parameters: {
        type: "object",
        properties: { message: { type: "string", description: `Self-contained request in ${owner}'s words plus any context from this conversation the coordinator needs.` } },
        required: ["message"],
      },
    },
    {
      type: "function",
      name: "coordinator_status",
      description: "Check whether the coordinator agent is running, idle, or blocked on a permission prompt.",
      parameters: { type: "object", properties: {} },
    },
    ...toolDefinitions().filter((t) => FRONT_TOOLS.has(t.name)),
  ];
}

function instructions() {
  const now = new Date().toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit", month: "short", day: "numeric" });
  if (SELF_HOST) {
    const name = ownerName();
    return [`You are ${name ? `${name}'s` : "the server owner's"} voice assistant in VA3 Drive. Current time: ${now}. Reply in one to three short spoken sentences; avoid markdown, URLs, IDs and paths. Answer ${name ? `${name}'s` : "the owner's"} questions directly. Typed messages work like speech. Combine messages received together after being offline, and never pretend to have heard unclear audio. This standalone server supports voice conversation and local memory. Coordinator automation, browsing, external research and machine control are not configured here; state that clearly when requested and never claim to have executed an action.`, memoryContextBlock()].filter(Boolean).join("\n\n");
  }
  return [
    `You are ${ownerName()}'s voice assistant in DRIVE MODE (Voice Assistant v3). He is usually driving with flaky cell signal; your replies are synthesized to speech and played through the car. Current time: ${now}.

Style: one to three short spoken sentences. No markdown, lists, URLs, IDs or file paths. Lead with the answer. If he is just thinking out loud, a brief acknowledgment is enough.

You are the voice FRONT of an orchestration stack. You do not do multi-step work yourself: call ask_coordinator for anything involving agents, code, his machines, repos, deploys, email, research projects or follow-ups, and for steering or checking work already underway. Then confirm in a few words ("On it, I've passed that to the coordinator."). Messages labelled as coordinator updates in the history were already spoken to him; don't repeat them unless asked. Reminders, to-dos and follow-ups also go to ask_coordinator (it tracks them on the checklist); memory_save is only for durable preferences and facts. Use escalate_to_smart_model for hard reasoning or current events.

Never refuse on capability grounds and never say the coordinator or its agents "can't" do something on a machine: they can drive apps, screens and browsers ${ownerDefault("drive_machines", "on its hosts")}. If he insists, says "send it verbatim", or says it is a test, pass his exact words to ask_coordinator and report what actually happened.

Store-and-forward: some of his messages may carry a note that they were spoken while offline. When several arrive together, answer them together, briefly, and skip anything that is now moot. Never pretend to have heard something marked as unclear.

Typed messages (marked typed) come from the phone keyboard and work exactly like speech.`,
    memoryContextBlock(),
  ].filter(Boolean).join("\n\n");
}

// Conversation history since the last context-clear marker, as Responses input.
function historyInput(conv) {
  const rows = readTranscript(conv, { limit: 400 });
  let start = 0;
  rows.forEach((r, i) => { if (r.metadata?.drive_epoch) start = i + 1; });
  const out = [];
  let chars = 0;
  for (const r of rows.slice(start).reverse()) {
    if (!["user", "assistant"].includes(r.role)) continue;
    let content = r.text;
    if (r.role === "user") {
      const tags = [];
      if (r.metadata?.source === "typed") tags.push("typed");
      if (r.metadata?.offline_note) tags.push(r.metadata.offline_note);
      if (r.metadata?.retry_of) tags.push(retryNote());
      if (r.metadata?.to === "coordinator") tags.push("sent directly to the coordinator");
      if (tags.length) content = `(${tags.join("; ")}) ${content}`;
    } else if (r.metadata?.source === "coordinator") {
      content = `[coordinator update, already spoken] ${content}`;
    }
    chars += content.length;
    if (chars > 16_000 || out.length >= 60) break;
    out.unshift({ role: r.role, content });
  }
  return out;
}

function offlineNote(input) {
  const recorded = Date.parse(input.recorded_at || "");
  if (!recorded || Date.now() - recorded < STALE_MS) return "";
  const at = new Date(recorded).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const mins = Math.round((Date.now() - recorded) / 60_000);
  return `spoken at ${at} while offline, ${mins} min ago`;
}

// The owner re-sent a saved recording of an utterance (Retry on the phone).
const retryNote = () => SELF_HOST ? `re-sent by ${ownerName() || "the owner"} from a saved recording because an earlier attempt was not heard` : `re-sent by ${ownerName()} from his saved recording because an earlier attempt was not heard`;
function inputNote(input) {
  return [offlineNote(input), input.retry_of ? retryNote() : ""].filter(Boolean).join("; ");
}

// newInput=true means fresh speech/text arrived: an unspoken in-flight reply is
// superseded and regenerated to cover it. Timer re-kicks never cancel replies.
export function kick(conv, { newInput = false } = {}) {
  if (running.has(conv)) {
    rekick.add(conv);
    if (newInput) generation.set(conv, (generation.get(conv) || 0) + 1);
    return;
  }
  running.add(conv);
  loop(conv).catch((err) => {
    console.error(`[drive] ${conv} loop error:`, err);
    emit(conv, { type: "error", text: `Assistant error: ${String(err.message || err).slice(0, 200)}` });
  }).finally(() => {
    running.delete(conv);
    if (rekick.delete(conv)) kick(conv);
    else emit(conv, { type: "status", phase: "idle" });
  });
}

function readyBatch(state) {
  const pending = Object.entries(state.inputs)
    .filter(([, i]) => i.status === "received")
    .map(([id, i]) => ({ id, ...i }));
  const texts = pending.filter((i) => i.kind === "text");
  const audio = pending.filter((i) => i.kind === "audio").sort((a, b) => a.seq - b.seq);
  const ready = [];
  let expect = (state.last_audio_seq || 0) + 1;
  let waitUntil = 0;
  for (const a of audio) {
    if (a.seq > expect && Date.now() - Date.parse(a.received_at) < GAP_WAIT_MS) {
      waitUntil = Date.parse(a.received_at) + GAP_WAIT_MS;
      break;
    }
    ready.push(a);
    expect = a.seq + 1;
  }
  return { batch: [...ready, ...texts].sort((a, b) => Date.parse(a.recorded_at || a.received_at) - Date.parse(b.recorded_at || b.received_at)), waitUntil };
}

async function loop(conv) {
  for (;;) {
    rekick.delete(conv);
    const { batch, waitUntil } = readyBatch(readState(conv));
    if (!batch.length) {
      if (waitUntil && !gapTimers.has(conv)) {
        gapTimers.set(conv, setTimeout(() => { gapTimers.delete(conv); kick(conv); }, Math.max(250, waitUntil - Date.now())));
      }
      return;
    }
    await mutateState(conv, (s) => {
      for (const b of batch) {
        s.inputs[b.id].status = "processing";
        if (b.kind === "audio") s.last_audio_seq = Math.max(s.last_audio_seq || 0, b.seq);
      }
    });
    emit(conv, { type: "status", phase: batch.some((b) => b.kind === "audio") ? "processing" : "thinking" });

    if (realtimeEnabled()) {
      const r = await realtimeBatch(conv, batch).catch((err) => ({ error: err, spoke: false }));
      if (!r.error) continue;
      console.error(`[drive] realtime turn failed (${r.spoke ? "after speaking" : "falling back"}):`, r.error.message);
      if (r.spoke) continue;
      emit(conv, { type: "notice", text: "Realtime voice unavailable; using the fallback voice." });
    }
    const heard = await transcribeBatch(conv, batch);
    if (heard) await respond(conv);
  }
}

// speech_snippets "off": drop the server copy shortly after the turn settles.
function expireSoonIfOff(conv) {
  if (snippetPolicy().mode !== "off") return;
  setTimeout(() => sweepConversation(conv).catch(() => {}), OFF_GRACE_MS + 1_000).unref?.();
}

function markTranscribed(conv, input, text, { failed = false } = {}) {
  const clean = String(text || "").trim();
  const empty = clean.replace(/[^\p{L}\p{N}]/gu, "").length < 2;
  return mutateState(conv, (s) => {
    const i = s.inputs[input.id];
    if (!i || i.status === "done" || i.status === "empty") return false;
    i.status = failed ? "received" : empty ? "empty" : "done";
    if (!failed) i.settled_at = new Date().toISOString();
    i.transcript = clean;
    return !failed && !empty;
  }).then((fresh) => {
    if (failed) return false;
    if (!fresh) { if (input.kind !== "text") expireSoonIfOff(conv); emit(conv, { type: "input_ack", input_id: input.id, empty: true }); return false; }
    const typed = input.kind === "text";
    const note = typed ? "" : offlineNote(input);
    appendTranscript(conv, { role: "user", text: clean, metadata: { source: typed ? "typed" : "voice", input_id: input.id, recorded_at: input.recorded_at, ...(note ? { offline_note: note } : {}), ...(input.retry_of ? { retry_of: input.retry_of } : {}) } });
    emit(conv, { type: "user_text", input_id: input.id, text: clean, source: typed ? "typed" : "voice", recorded_at: input.recorded_at, offline: !!note, ...(input.retry_of ? { retry_of: input.retry_of } : {}) });
    if (!typed) expireSoonIfOff(conv);
    return true;
  });
}

// Realtime path: audio goes straight to gpt-realtime-2.1; transcripts for the
// ledger come back from the same session.
async function realtimeBatch(conv, batch) {
  const gen = (generation.get(conv) || 0) + 1;
  generation.set(conv, gen);
  const stale = () => generation.get(conv) !== gen;
  const history = historyInput(conv);
  const items = [];
  for (const b of batch) {
    if (b.kind === "text") {
      await markTranscribed(conv, b, b.text);
      items.push({ kind: "text", text: b.text, inputId: b.id });
    } else {
      items.push({ kind: "audio", pcm: await toPcm(join(convDir(conv, "inputs"), b.file)), note: inputNote(b), inputId: b.id });
    }
  }
  const byId = new Map(batch.map((b) => [b.id, b]));
  // Transcripts can finish out of order; write them to the ledger in spoken order.
  const order = items.filter((i) => i.kind === "audio").map((i) => i.inputId);
  const arrived = new Map();
  let flushChain = Promise.resolve();
  const onTranscript = (inputId, text, failed) => {
    arrived.set(inputId, { text, failed });
    flushChain = flushChain.then(async () => {
      while (order.length && arrived.has(order[0])) {
        const id = order.shift();
        const t = arrived.get(id);
        await markTranscribed(conv, byId.get(id), t.text, { failed: t.failed });
      }
    });
    return flushChain;
  };
  const replies = new Map(); // round -> reply id
  let spoke = false;
  try {
    const result = await realtimeTurn(conv, {
      instructions: instructions(),
      tools: driveTools(),
      history,
      items,
      voice: env("DRIVE_VOICE", env("REALTIME_VOICE", "marin")),
      hooks: {
        superseded: stale,
        onTranscript,
        onPart: async ({ pcm, index, final, round }) => {
          if (!replies.has(round)) {
            replies.set(round, `r_${randomUUID().slice(0, 12)}`);
            emit(conv, { type: "status", phase: "speaking" });
          }
          spoke = true;
          const replyId = replies.get(round);
          if (!pcm.length) { emit(conv, { type: "audio_end", reply_id: replyId, parts: index }); return; }
          const file = await encodePart(pcm, convDir(conv, "replies"), `${replyId}-${index}`);
          emit(conv, { type: "audio", reply_id: replyId, part: index, final, file, duration_ms: Math.round(pcm.length / 48), source: "assistant" });
        },
        onAssistantText: (text, round) => {
          const replyId = replies.get(round) || `r_${randomUUID().slice(0, 12)}`;
          appendTranscript(conv, { role: "assistant", text, metadata: { source: "assistant", reply_id: replyId, brain: "realtime" } });
          emit(conv, { type: "assistant_text", reply_id: replyId, text, source: "assistant" });
        },
        runTool: async (name, args) => {
          const result = await runTool(conv, name, args).catch((err) => ({ ok: false, error: String(err.message || err) }));
          appendTranscript(conv, { role: "tool", text: `${name}: ${JSON.stringify(result).slice(0, 2_000)}`, metadata: { tool: name } });
          emit(conv, { type: "tool", name, ok: result?.ok !== false });
          return result;
        },
      },
    });
    // Audio whose transcript never arrived goes back in the queue (as audio).
    await mutateState(conv, (s) => { for (const b of batch) if (s.inputs[b.id]?.status === "processing" && b.kind === "audio") s.inputs[b.id].status = "received"; });
    return { status: result.status, spoke };
  } catch (error) {
    return { error, spoke };
  }
}

// Fallback path: gpt-transcribe -> text model -> TTS.
async function transcribeBatch(conv, batch) {
  const todo = batch.filter((b) => readState(conv).inputs[b.id]?.status === "processing");
  const texts = await Promise.all(todo.map(async (b) => {
    if (b.kind === "text") return b.text;
    try { return await transcribe(join(convDir(conv, "inputs"), b.file)); } catch (err) { return { error: String(err.message || err) }; }
  }));
  let heard = batch.some((b) => readState(conv).inputs[b.id]?.status === "done");
  for (const [i, b] of todo.entries()) {
    const t = texts[i];
    if (t && typeof t === "object") {
      await mutateState(conv, (s) => { s.inputs[b.id].status = "received"; s.inputs[b.id].attempts = (s.inputs[b.id].attempts || 0) + 1; });
      emit(conv, { type: "input_error", input_id: b.id, text: `Transcription failed, will retry: ${t.error.slice(0, 120)}` });
      setTimeout(() => kick(conv), 10_000);
      continue;
    }
    if (await markTranscribed(conv, b, t)) heard = true;
  }
  return heard;
}

export { historyInput as _historyInput };

async function respond(conv) {
  const gen = (generation.get(conv) || 0) + 1;
  generation.set(conv, gen);
  const stale = () => generation.get(conv) !== gen;
  emit(conv, { type: "status", phase: "thinking" });

  const input = historyInput(conv);
  let text = "";
  for (let round = 0; round < 5; round++) {
    const r = await think({ instructions: instructions(), input, tools: driveTools() });
    if (stale()) return; // newer speech arrived; the next pass answers everything
    text = r.text;
    if (!r.calls.length) break;
    input.push(...r.output);
    for (const call of r.calls) {
      let args = {};
      try { args = JSON.parse(call.arguments || "{}"); } catch {}
      let result;
      try {
        result = await runTool(conv, call.name, args);
      } catch (err) {
        result = { ok: false, error: String(err.message || err) };
      }
      appendTranscript(conv, { role: "tool", text: `${call.name}: ${JSON.stringify(result).slice(0, 2_000)}`, metadata: { tool: call.name } });
      emit(conv, { type: "tool", name: call.name, ok: result?.ok !== false });
      input.push({ type: "function_call_output", call_id: call.call_id, output: call.name === "list_asks" ? globalThis.VA3VoiceToolResults.serialize(call.name, result, args) : JSON.stringify(result).slice(0, 8_000) });
    }
  }
  if (stale() || !text) return;
  await speakReply(conv, text, { source: "assistant" });
}

async function runTool(conv, name, args) {
  if (SELF_HOST) {
    if (name === "memory_save") return dispatchTool(name, { key: args.key, content: args.content, sync_to_vision: false, session_id: conv });
    if (name === "memory_search") return dispatchTool(name, { query: args.query, session_id: conv });
    throw new Error(`Tool not available on this server: ${name}`);
  }
  if (name === "ask_coordinator") return askCoordinator(conv, { message: args.message, title: titleFor(conv), port: serverPort, source: "voice front" });
  if (name === "coordinator_status") return coordinatorStatus(conv);
  if (!FRONT_TOOLS.has(name)) throw new Error(`Tool not available in drive mode: ${name}`);
  return dispatchTool(name, { ...args, session_id: conv });
}

export async function speakReply(conv, text, { source }) {
  const replyId = `r_${randomUUID().slice(0, 12)}`;
  appendTranscript(conv, { role: "assistant", text, metadata: { source, reply_id: replyId } });
  emit(conv, { type: "assistant_text", reply_id: replyId, text, source });
  const parts = splitForSpeech(text);
  emit(conv, { type: "status", phase: "speaking" });
  // Synthesize in parallel, publish strictly in order.
  const jobs = parts.map((p) => speak(p).then((buf) => ({ buf })).catch((err) => ({ err })));
  for (const [i, job] of jobs.entries()) {
    const r = await job;
    if (r.err) { emit(conv, { type: "error", text: `Speech synthesis failed: ${String(r.err.message).slice(0, 120)}` }); continue; }
    const file = `${replyId}-${i}.mp3`;
    writeFileSync(join(convDir(conv, "replies"), file), r.buf);
    emit(conv, { type: "audio", reply_id: replyId, part: i, parts: parts.length, final: i === parts.length - 1, file, text: parts[i], source });
  }
  return replyId;
}

setCoordinatorSayHandler((conv, text) => {
  speakReply(conv, text, { source: "coordinator" }).catch((err) => console.error("[drive] coordinator say failed:", err.message));
});

export async function clearContext(conv) {
  const epoch = await mutateState(conv, (s) => ++s.epoch);
  generation.set(conv, (generation.get(conv) || 0) + 1);
  appendTranscript(conv, { role: "system", text: "Voice context cleared. Earlier turns stay in history but are no longer sent to the voice model; the coordinator and its agents are untouched.", metadata: { drive_epoch: epoch } });
  emit(conv, { type: "context_cleared", epoch });
  return { ok: true, epoch };
}

// Everything model-facing that this module composes, for the self-host prompt
// audit (bin/kit-leak-check.mjs selfHostPromptAudit, test/self-host-prompt.test.mjs).
export function modelContextForAudit() {
  return { instructions: instructions(), tools: driveTools(), retry_note: retryNote(), interrupt_subject: ownerName() || "The owner" };
}

export function noteInterrupt(conv, { reply_id, played_ms }) {
  generation.set(conv, (generation.get(conv) || 0) + 1);
  appendTranscript(conv, { role: "system", text: `${ownerName() || "The owner"} cut off the previous reply after about ${Math.round((Number(played_ms) || 0) / 1000)} seconds.`, metadata: { reply_id, interrupted: true } });
  emit(conv, { type: "reply_cancelled", reply_id });
  return { ok: true };
}
