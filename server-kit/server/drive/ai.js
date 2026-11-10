// Model calls for drive mode: speech-to-text, the text front model, and TTS.
// Store-and-forward audio arrives as whole utterances, so drive mode uses a
// transcribe -> think -> speak pipeline instead of a server-held realtime
// socket: the JSONL transcript stays the single source of truth and typed
// input takes exactly the same path. DRIVE_FAKE_AI=1 swaps in deterministic
// stubs for tests (no network, no spend).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { env, openaiKey } from "../env.js";

const apiBase = () => env("DRIVE_OPENAI_API_BASE", "https://api.openai.com/v1").replace(/\/+$/, "");

export const driveModels = () => ({
  transcribe: env("DRIVE_TRANSCRIBE_MODEL", "gpt-transcribe"),
  think: env("DRIVE_MODEL", "gpt-5.5"),
  tts: env("DRIVE_TTS_MODEL", "gpt-4o-mini-tts"),
  voice: env("DRIVE_TTS_VOICE", env("REALTIME_VOICE", "marin")),
});

const fake = () => env("DRIVE_FAKE_AI") === "1";

async function openaiJson(path, body, { signal } = {}) {
  const res = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `${path} failed: HTTP ${res.status}`);
  return json;
}

export async function transcribe(file, { signal } = {}) {
  if (fake()) {
    // Tests write the "spoken" words into the uploaded file itself.
    return readFileSync(file, "utf8").replace(/^FAKE-AUDIO:/, "").trim();
  }
  const form = new FormData();
  form.append("model", driveModels().transcribe);
  form.append("file", new Blob([readFileSync(file)]), basename(file));
  form.append("response_format", "json");
  const res = await fetch(`${apiBase()}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey()}` },
    body: form,
    signal,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `transcription failed: HTTP ${res.status}`);
  return String(json.text || "").trim();
}

// One Responses API turn. `input` is a Responses input array; returns
// { text, calls: [{call_id, name, arguments}], output } so the caller can run
// tools and continue with the raw output items appended.
export async function think({ instructions, input, tools, signal }) {
  if (fake()) return fakeThink(input);
  const json = await openaiJson("/responses", {
    model: driveModels().think,
    instructions,
    input,
    tools,
    tool_choice: "auto",
    reasoning: { effort: env("DRIVE_REASONING", "low") },
    include: ["reasoning.encrypted_content"],
    store: false,
  }, { signal });
  let text = "";
  const calls = [];
  for (const item of json.output || []) {
    if (item.type === "message") {
      for (const c of item.content || []) if (c.type === "output_text") text += c.text;
    } else if (item.type === "function_call") {
      calls.push({ call_id: item.call_id, name: item.name, arguments: item.arguments });
    }
  }
  return { text: text.trim(), calls, output: json.output || [] };
}

function fakeThink(input) {
  const last = [...input].reverse().find((i) => i.role === "user" || i.type === "function_call_output");
  if (last?.type === "function_call_output") {
    return { text: `Done. ${String(last.output).slice(0, 80)}`, calls: [], output: [] };
  }
  const said = String(last?.content || "");
  const m = said.match(/coordinator[:,]?\s*(.+)$/i);
  if (m) {
    const call = { type: "function_call", call_id: `call_${Date.now()}`, name: "ask_coordinator", arguments: JSON.stringify({ message: m[1] }) };
    return { text: "", calls: [call], output: [call] };
  }
  return { text: `You said: ${said.split("\n").at(-1).slice(0, 120)}. Second sentence here.`, calls: [], output: [] };
}

export async function speak(text, { signal } = {}) {
  if (fake()) return Buffer.from(`FAKE-MP3:${text}`);
  const res = await fetch(`${apiBase()}/audio/speech`, {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: driveModels().tts,
      voice: driveModels().voice,
      input: text,
      response_format: "mp3",
      instructions: "Speak naturally and briskly, like a calm co-pilot. The listener is driving.",
    }),
    signal,
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json?.error?.message || `tts failed: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Split a reply into sentence-sized TTS parts so the first part can start
// playing while later parts synthesize. Very short fragments merge forward.
export function splitForSpeech(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return [];
  const pieces = raw.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) || [raw];
  const out = [];
  for (const p of pieces.map((s) => s.trim()).filter(Boolean)) {
    if (out.length && (out.at(-1).length < 40 || p.length < 12)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out;
}
