// HTTP surface for the drive-mode phone client. Every route requires the
// device bearer token (~/.config/va3/drive-token, created on first start),
// because tailscale serve proxies arrive from loopback and can't be told
// apart by address. Uploads are idempotent by input id, so the phone can
// retry blindly after any network failure.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { homedir } from "node:os";
import { env, DATA_DIR, SELF_HOST, openaiKey } from "../env.js";
import { appendTranscript, createSession, listSessions, readTranscript, updateSession } from "../transcripts.js";
import { driveModels } from "./ai.js";
import { realtimeEnabled, realtimeModel, warm } from "./realtime-brain.js";
import { askCoordinator, checklistDir, coordinatorStatus, patchChecklist } from "./coordinator.js";
import { clearContext, configurePipeline, drivePort, kick, noteInterrupt, speakReply } from "./pipeline.js";
import { snippetPolicy, startSnippetSweep } from "./snippets.js";
import { convDir, DRIVE_DIR, emit, lastSeq, mutateState, readState, validId, waitForEvents } from "./store.js";

import { credentialIdentity, initCredentials } from "./credentials.js";

const TOKEN_FILE = SELF_HOST ? join(DATA_DIR, "auth", "legacy-disabled") : env("DRIVE_TOKEN_FILE", join(homedir(), ".config", "va3", "drive-token"));
const MAX_AUDIO = 25 * 1024 * 1024;
const INPUT_RE = /^[A-Za-z0-9_-]{8,80}$/;

export function driveToken() {
  if (SELF_HOST) return ""; // explicit per-install registry only
  const fromEnv = env("DRIVE_TOKEN");
  if (fromEnv) return fromEnv;
  if (!existsSync(TOKEN_FILE)) {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true });
    writeFileSync(TOKEN_FILE, randomBytes(24).toString("base64url"));
    chmodSync(TOKEN_FILE, 0o600);
  }
  return readFileSync(TOKEN_FILE, "utf8").trim();
}

function cookieToken(req) {
  const m = String(req.headers.cookie || "").match(/(?:^|;\s*)va3drive=([^;]+)/);
  try { return m ? decodeURIComponent(m[1]) : ""; } catch { return ""; }
}

function requestToken(req, url) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7) : url.searchParams.get("token") || cookieToken(req);
}

function authorized(req, url) {
  const given = requestToken(req, url);
  if (SELF_HOST) return Boolean(credentialIdentity(DATA_DIR, given));
  const expected = driveToken();
  return Boolean(expected) && Buffer.byteLength(given) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}

async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("payload too large"), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = (await readRaw(req, 256 * 1024)).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("invalid JSON"), { status: 400 }); }
}

function sessionTitle(conv) {
  return listSessions({ includeArchived: true }).find((s) => s.id === conv)?.title || "Drive";
}

function sendFile(res, file, type, extraHeaders = {}) {
  if (!existsSync(file)) return json(res, 404, { error: "not found" });
  res.writeHead(200, { "Content-Type": type, "Content-Length": statSync(file).size, "Cache-Control": "private, max-age=86400", ...extraHeaders });
  createReadStream(file).pipe(res);
}

export function initDrive({ port }) {
  if (SELF_HOST) initCredentials(DATA_DIR);
  else driveToken();
  installCode();
  configurePipeline({ port, title: sessionTitle });
  if (!env("DRIVE_SNIPPET_SWEEP_OFF")) startSnippetSweep();
  // Resume anything that was mid-flight when the server last stopped.
  try {
    for (const s of listSessions({ includeArchived: false }).slice(0, 50)) {
      const st = readState(s.id);
      const stuck = Object.values(st.inputs).some((i) => i.status === "received" || i.status === "processing");
      if (stuck) {
        mutateState(s.id, (x) => { for (const i of Object.values(x.inputs)) if (i.status === "processing") i.status = "received"; })
          .then(() => kick(s.id));
      }
    }
  } catch (err) {
    console.error("[drive] resume scan failed:", err.message);
  }
}

// Short, phone-typeable install link: /i/<code>. The code (separate from the
// device token) only unlocks the install page, manifest and IPA.
const INSTALL_FILE = join(dirname(TOKEN_FILE), "install-code");
export function installCode() {
  if (!existsSync(INSTALL_FILE)) {
    mkdirSync(dirname(INSTALL_FILE), { recursive: true });
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    writeFileSync(INSTALL_FILE, Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join(""));
    chmodSync(INSTALL_FILE, 0o600);
  }
  return readFileSync(INSTALL_FILE, "utf8").trim();
}

// Returns true when the request was handled.
export async function handleDrive(req, res, url) {
  const path = url.pathname;
  const short = path.match(/^\/i\/([a-z0-9]{6,16})(\/manifest\.plist|\/VA3Drive\.ipa)?$/);
  if (short) {
    if (short[1] !== installCode()) { json(res, 404, { error: "not found" }); return true; }
    serveInstall(req, res, url, `/drive/install${short[2] || ""}`, `/i/${short[1]}`);
    return true;
  }
  if (!path.startsWith("/api/drive/") && !path.startsWith("/drive/")) return false;
  if (!authorized(req, url)) { json(res, 401, { error: "drive token required" }); return true; }
  try {
    await route(req, res, url, path);
  } catch (err) {
    json(res, err.status || 500, { ok: false, error: String(err.message || err) });
  }
  return true;
}

async function route(req, res, url, path) {
  const m = path.match(/^\/api\/drive\/conversations\/([A-Za-z0-9_-]+)(?:\/(.+))?$/);

  if (path === "/api/drive/hello") {
    const policy = snippetPolicy();
    let configured = false;
    try { configured = Boolean(openaiKey()); } catch {}
    return json(res, 200, { ok: true, protocol_version: 1, server: { id: SELF_HOST ? credentialIdentity(DATA_DIR, requestToken(req, url))?.server_id : "legacy", mode: SELF_HOST ? "selfhost" : "legacy", access: "owner" }, capabilities: { drive: true, realtime: realtimeEnabled(), coordinator: !SELF_HOST }, configuration: { openai_key_configured: configured }, brain: realtimeEnabled() ? realtimeModel() : "pipeline", models: driveModels(), server_time: new Date().toISOString(), speech_snippets: { mode: policy.mode, server_hours: policy.max_age_ms / 3600000 } });
  }

  if (path === "/api/drive/conversations" && req.method === "GET") {
    return json(res, 200, { conversations: listSessions({ includeArchived: false }).slice(0, 50) });
  }
  if (path === "/api/drive/conversations" && req.method === "POST") {
    const body = await readJson(req);
    return json(res, 200, { ok: true, conversation: createSession({ title: body.title }) });
  }

  if (m) {
    const [, conv, sub = ""] = m;
    if (!validId(conv)) return json(res, 400, { error: "invalid conversation id" });

    if (sub === "segments" && req.method === "POST") {
      const id = String(req.headers["x-input-id"] || "");
      const seq = Number(req.headers["x-seq"]);
      if (!INPUT_RE.test(id) || !Number.isInteger(seq) || seq < 1) return json(res, 400, { error: "x-input-id and positive integer x-seq required" });
      const existing = readState(conv).inputs[id];
      if (existing) { await readRaw(req, MAX_AUDIO); return json(res, 200, { ok: true, duplicate: true, status: existing.status }); }
      const audio = await readRaw(req, MAX_AUDIO);
      if (!audio.length) return json(res, 400, { error: "empty audio" });
      const ext = String(req.headers["content-type"] || "").includes("wav") ? "wav" : "m4a";
      const file = `${id}.${ext}`;
      const retryOf = String(req.headers["x-retry-of"] || "");
      if (retryOf && !INPUT_RE.test(retryOf)) return json(res, 400, { error: "invalid x-retry-of" });
      // Jacob's own speech: owner-only on disk, expired by server/drive/snippets.js.
      const inputsDir = convDir(conv, "inputs");
      chmodSync(inputsDir, 0o700);
      const fresh = await mutateState(conv, (s) => {
        if (s.inputs[id]) return false;
        writeFileSync(join(inputsDir, file), audio, { mode: 0o600 });
        s.inputs[id] = {
          kind: "audio",
          seq,
          file,
          bytes: audio.length,
          duration_ms: Number(req.headers["x-duration-ms"]) || null,
          recorded_at: String(req.headers["x-recorded-at"] || new Date().toISOString()),
          received_at: new Date().toISOString(),
          status: "received",
          ...(retryOf ? { retry_of: retryOf } : {}),
        };
        return true;
      });
      if (fresh) { emit(conv, { type: "input_received", input_id: id, segment_seq: seq }); kick(conv, { newInput: true }); }
      return json(res, 200, { ok: true, duplicate: !fresh, cursor: lastSeq(conv) });
    }

    if (sub === "text" && req.method === "POST") {
      const body = await readJson(req);
      const id = String(body.id || "");
      const text = String(body.text || "").trim();
      if (!INPUT_RE.test(id) || !text) return json(res, 400, { error: "id and text required" });
      if (readState(conv).inputs[id]) return json(res, 200, { ok: true, duplicate: true });
      if (body.target === "coordinator") {
        // "Take over and type into the agent": bypass the voice front model.
        await mutateState(conv, (s) => { s.inputs[id] = { kind: "direct", text, received_at: new Date().toISOString(), status: "done" }; });
        appendTranscript(conv, { role: "user", text, metadata: { source: "typed", to: "coordinator", input_id: id } });
        emit(conv, { type: "user_text", input_id: id, text, source: "typed", to: "coordinator" });
        const result = await askCoordinator(conv, { message: text, title: sessionTitle(conv), port: drivePort(), source: "typed directly" });
        return json(res, 200, { ok: true, ...result });
      }
      await mutateState(conv, (s) => {
        s.inputs[id] = { kind: "text", text, recorded_at: body.recorded_at || new Date().toISOString(), received_at: new Date().toISOString(), status: "received" };
      });
      kick(conv, { newInput: true });
      return json(res, 200, { ok: true });
    }

    if (sub === "events" && req.method === "GET") {
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      const wait = Math.min(30_000, Math.max(0, Number(url.searchParams.get("wait")) || 0) * 1000);
      let closed = false;
      req.on("close", () => { closed = true; });
      warm(conv); // the phone is attached: keep a fresh realtime session ready
      const events = await waitForEvents(conv, after, wait);
      if (closed) return;
      return json(res, 200, { events, cursor: events.at(-1)?.seq ?? Math.min(after, lastSeq(conv)), last_seq: lastSeq(conv) });
    }

    if (sub.startsWith("audio/") && req.method === "GET") {
      const name = sub.slice(6);
      if (!/^r_[A-Za-z0-9-]+-\d+\.(mp3|m4a)$/.test(name)) return json(res, 400, { error: "bad audio name" });
      return sendFile(res, join(convDir(conv, "replies"), name), name.endsWith(".m4a") ? "audio/mp4" : "audio/mpeg");
    }

    if (sub === "interrupt" && req.method === "POST") return json(res, 200, noteInterrupt(conv, await readJson(req)));
    if (sub === "clear" && req.method === "POST") return json(res, 200, await clearContext(conv));
    if (sub === "rename" && req.method === "POST") {
      const body = await readJson(req);
      return json(res, 200, { ok: true, conversation: updateSession(conv, { title: body.title }) });
    }

    if (sub === "state" && req.method === "GET") {
      const s = readState(conv);
      const counts = {};
      for (const i of Object.values(s.inputs)) counts[i.status] = (counts[i.status] || 0) + 1;
      return json(res, 200, {
        conversation: conv,
        title: sessionTitle(conv),
        epoch: s.epoch,
        inputs: counts,
        last_seq: lastSeq(conv),
        coordinator: await coordinatorStatus(conv),
        checklist_url: `/drive/checklist/${conv}/voice-session-checklist.html`,
      });
    }

    if (sub === "transcript" && req.method === "GET") {
      return json(res, 200, { entries: readTranscript(conv, { limit: Number(url.searchParams.get("limit") || 200) }) });
    }

    if (sub === "checklist" && req.method === "POST") {
      return json(res, 200, await patchChecklist(conv, await readJson(req)));
    }

    if (sub === "say" && req.method === "POST") {
      // Coordinator -> Jacob (bin/va3-say).
      const body = await readJson(req);
      const text = String(body.text || "").trim();
      if (!text) return json(res, 400, { error: "text required" });
      const replyId = await speakReply(conv, text, { source: "coordinator" });
      return json(res, 200, { ok: true, reply_id: replyId });
    }
  }

  if (path === "/drive/install" || path.startsWith("/drive/install/")) return serveInstall(req, res, url, path);

  const c = path.match(/^\/drive\/checklist\/([A-Za-z0-9_-]+)\/(voice-session-checklist\.(?:html|json))$/);
  if (c && validId(c[1])) {
    const file = normalize(join(checklistDir(c[1]), c[2]));
    // The checklist page polls its JSON by relative URL, so a ?token= page
    // load sets a path-scoped cookie for those follow-up requests.
    const cookie = url.searchParams.get("token")
      ? { "Set-Cookie": `va3drive=${encodeURIComponent(requestToken(req, url))}; Path=/drive/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000` }
      : {};
    return sendFile(res, file, c[2].endsWith(".html") ? "text/html; charset=utf-8" : "application/json", { "Cache-Control": "no-store", ...cookie });
  }

  return json(res, 404, { error: "no such drive endpoint" });
}

// Over-the-air install of the ad-hoc iOS build (registered devices only).
// iOS fetches the manifest and IPA itself, so the token rides in the URLs.
const DIST_DIR = join(DRIVE_DIR, "..", "ios-dist");
function serveInstall(req, res, url, path, shortPrefix = null) {
  const base = env("DRIVE_PUBLIC_URL", "");
  if (!base) return json(res, 503, { error: "Set DRIVE_PUBLIC_URL to this server's HTTPS address before publishing an iOS build" });
  const q = `token=${encodeURIComponent(requestToken(req, url) || driveToken())}`;
  // Links on the page/manifest: short-code form when entered that way.
  const link = (rest) => (shortPrefix ? `${base}${shortPrefix}${rest}` : `${base}/drive/install${rest}?${q}`);
  const metaFile = join(DIST_DIR, "build.json");
  if (!existsSync(metaFile)) return json(res, 404, { error: "no iOS build published yet" });
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  if (path === "/drive/install/VA3Drive.ipa") return sendFile(res, join(DIST_DIR, "VA3Drive.ipa"), "application/octet-stream", { "Cache-Control": "no-store" });
  if (path === "/drive/install/manifest.plist") {
    const body = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
<key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${link("/VA3Drive.ipa")}</string></dict></array>
<key>metadata</key><dict><key>bundle-identifier</key><string>${meta.bundle_id}</string><key>bundle-version</key><string>${meta.version}</string><key>kind</key><string>software</string><key>title</key><string>VA3 Drive</string></dict>
</dict></array></dict></plist>`;
    res.writeHead(200, { "Content-Type": "text/xml", "Cache-Control": "no-store" });
    return res.end(body);
  }
  const manifest = encodeURIComponent(link("/manifest.plist"));
  const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Install VA3 Drive</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1.25rem;color:#0f172a}a.btn{display:block;text-align:center;background:#3b82f6;color:#fff;text-decoration:none;padding:.9rem;border-radius:.75rem;font-weight:600;margin:1.5rem 0}small{color:#64748b}</style></head>
<body><h1>VA3 Drive</h1><p>Version ${meta.version} (build ${meta.build}) · built ${meta.built_at}</p>
<a class="btn" href="itms-services://?action=download-manifest&amp;url=${manifest}">Install on this iPhone</a>
<small>Open this page in Safari on a registered iPhone with Tailscale on. After installing, the app is on your home screen; the server address and device token are pre-filled.</small></body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  return res.end(page);
}
