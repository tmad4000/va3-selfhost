// Two-layer memory:
//  - scratchpad: short-term working memory, baked into the realtime session
//    instructions on every connect and refreshable mid-session (keeps the
//    fast model from getting "ditzy" about the current thread).
//  - persistent store: append-friendly JSONL of durable memory items, with a
//    naive substring search. Swap for a real DB/embedding store later.
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR, SELF_HOST } from "./env.js";
import { matchProjectFamily } from "./projects.js";
import { currentVoiceSession } from "./transcripts.js";
import { parseScratchpad, serializeScratchpad, scratchpadTimestamp, scratchpadContext } from "./scratchpad.js";
import { displayTimeZone } from "./settings.js";
import { onVisionSynced, pushToVision } from "./vision-sync.js";

const SCRATCHPAD = join(DATA_DIR, "scratchpad.md");
const MEMORY = join(DATA_DIR, "memory.jsonl");

function ensure() {
  mkdirSync(DATA_DIR, { recursive: true });
}

export function readScratchpad() {
  ensure();
  return existsSync(SCRATCHPAD) ? readFileSync(SCRATCHPAD, "utf8") : "";
}

export function writeScratchpad(content) {
  // Explicit human Markdown editing may change the whole pad. Model tools use
  // updateScratchpadThread/addScratchpad/resolveScratchpad instead.
  return persistScratchpad(parseScratchpad(content));
}

function persistScratchpad(pad) {
  ensure();
  const content = serializeScratchpad(pad);
  const temporary = `${SCRATCHPAD}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, SCRATCHPAD);
  return { ok: true, bytes: Buffer.byteLength(content) };
}

export function updateScratchpadThread(content) {
  if (typeof content !== "string") throw new Error("Thread summary must be text");
  if (/^## (Thread|Entries)\s*$/m.test(content)) throw new Error("Supply only the thread summary, without section headings or entries");
  const pad = parseScratchpad(readScratchpad());
  pad.thread = content;
  return persistScratchpad(pad);
}

export function addScratchpad(items, { topic, sessionId } = {}) {
  if (!sessionId) throw new Error("No conversation is active; scratchpad entries need a session");
  if (!Array.isArray(items) || !items.length || items.length > 100
    || items.some((item) => typeof item !== "string" || !item.trim() || /[\r\n]/.test(item) || item.length > 1_000)) {
    throw new Error("items must contain 1-100 short, single-line strings (up to 1000 characters each)");
  }
  if (topic !== undefined && (typeof topic !== "string" || /[\r\n]/.test(topic) || topic.length > 120)) {
    throw new Error("topic must be a short, single-line string");
  }
  const voice = currentVoiceSession(sessionId);
  const timestamp = scratchpadTimestamp(new Date(), displayTimeZone());
  const session = `${voice ? `voice session ${voice.n} · ` : ""}conversation ${sessionId}`;
  const entries = items.map((text) => ({ timestamp, session, text: text.trim(), topic: topic?.trim() || null, resolvedAt: null }));
  const pad = parseScratchpad(readScratchpad());
  pad.entries.push(...entries);
  persistScratchpad(pad);
  return { ok: true, added: entries };
}

export function appendScratchpad(content, options) {
  return addScratchpad([content], options);
}

export function resolveScratchpad(match) {
  if (typeof match !== "string" || !match.trim()) throw new Error("A nonempty entry substring is required");
  const pad = parseScratchpad(readScratchpad());
  const matches = pad.entries.filter((entry) => !entry.legacy && !entry.resolvedAt && entry.text.toLowerCase().includes(match.trim().toLowerCase()));
  if (matches.length !== 1) return { ok: false, reason: matches.length ? "ambiguous" : "not_found", matches: matches.map((entry) => entry.text) };
  matches[0].resolvedAt = scratchpadTimestamp(new Date(), displayTimeZone());
  persistScratchpad(pad);
  return { ok: true, resolved: matches[0] };
}

// `project` ties a memory item to a known project family (e.g.
// "notestream-vision"), either passed explicitly or auto-detected from the
// key/content against server/projects.js's alias list. Detected family keys
// are also added to tags for substring searches by canonical key.
//
// A notestream-vision item is also pushed to the real NotesStream Vision app
// (server/vision-sync.js) after the local append: the local item is written
// first and never waits on or depends on the network. `syncToVision: false`
// keeps a fact *about* the project local. The pending push is exposed as the
// non-enumerable `visionSync` promise so a caller can wait for the result.
export function saveMemory({ key, content, tags = [], project, syncToVision = true, visionTags = [], source = "memory_save" } = {}) {
  ensure();
  // Project families are the original installation's; standalone servers keep plain memories.
  const detected = SELF_HOST ? null : matchProjectFamily(`${key || ""} ${content || ""}`);
  const resolvedProject = project || detected?.key || undefined;
  const resolvedTags = resolvedProject && !tags.includes(resolvedProject) ? [...tags, resolvedProject] : tags;
  const item = {
    id: `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts: new Date().toISOString(),
    key: String(key || "").slice(0, 200),
    content: String(content || ""),
    tags: resolvedTags,
    ...(resolvedProject ? { project: resolvedProject } : {}),
  };
  appendFileSync(MEMORY, JSON.stringify(item) + "\n");
  if (resolvedProject === "notestream-vision" && syncToVision !== false && item.content.trim()) {
    let visionSync;
    try {
      visionSync = pushToVision({ text: item.content, tags: visionTags, memoryId: item.id, source }).catch((error) => {
        console.warn(`[vision] push for ${item.id} failed: ${error.message}`);
        return { synced: false, saved_locally: true, error: error.message };
      });
    } catch (error) {
      console.warn(`[vision] could not queue ${item.id}: ${error.message}`);
      visionSync = Promise.resolve({ synced: false, saved_locally: true, error: error.message });
    }
    Object.defineProperty(item, "visionSync", { value: visionSync, enumerable: false });
  }
  return item;
}

// Rewrites one memory item in place (atomic temp + rename). Unparsable lines
// are preserved as-is.
export function patchMemory(id, patch) {
  ensure();
  if (!existsSync(MEMORY)) return null;
  let found = null;
  const lines = readFileSync(MEMORY, "utf8").split("\n").filter(Boolean).map((line) => {
    let m;
    try { m = JSON.parse(line); } catch { return line; }
    if (m.id !== id) return line;
    found = { ...m, ...patch };
    return JSON.stringify(found);
  });
  if (!found) return null;
  const tmp = `${MEMORY}.${process.pid}.tmp`;
  writeFileSync(tmp, lines.join("\n") + "\n");
  renameSync(tmp, MEMORY);
  return found;
}

onVisionSynced((queued) => {
  for (const memoryId of queued.memory_ids || []) {
    try {
      patchMemory(memoryId, { vision_note_id: queued.vision_note_id, vision_synced_at: queued.synced_at });
    } catch (error) {
      console.warn(`[vision] could not stamp ${memoryId}: ${error.message}`);
    }
  }
});

export function listMemory({ limit = 50 } = {}) {
  ensure();
  if (!existsSync(MEMORY)) return [];
  const lines = readFileSync(MEMORY, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

export function searchMemory(query, { limit = 10 } = {}) {
  const q = String(query || "").toLowerCase();
  if (!q) return [];
  const all = listMemory({ limit: 5000 });
  return all
    .filter((m) => (m.key + " " + m.content + " " + (m.tags || []).join(" ")).toLowerCase().includes(q))
    .slice(-limit);
}

// Composed context injected into the realtime model's instructions.
export function memoryContextBlock() {
  const content = readScratchpad();
  const scratch = content.trim() ? scratchpadContext(content) : "";
  const recent = listMemory({ limit: 12 });
  const parts = [];
  if (scratch) {
    parts.push("## Scratchpad (short-term working memory — the current thread)\n" + scratch);
  }
  if (recent.length) {
    parts.push(
      "## Recent persistent memories\n" +
        recent.map((m) => `- [${m.key || "note"}${m.project ? `/${m.project}` : ""}] ${m.content}`.slice(0, 300)).join("\n")
    );
  }
  return parts.join("\n\n");
}
