// Accounts: which external services a VA3 user is signed in to, and how.
//
// A VA3 identity is the Tailscale login that tailscale serve attaches to each
// request (Tailscale-User-Login). Direct loopback callers (local agents, the
// drive pipeline) act as the owner identity. A later Ideaflow ID session can
// become another identity source without changing the record format.
//
// One record per identity at DATA_DIR/accounts/<identity>.json (dir 700,
// file 600). Each linked service says how it is authenticated:
//   services.wit = { method: "ideaflow-id", handle, subject, linked_at,
//                    expires_at, state, tokens: {...} }
// The server-held WIT agent key is not stored per user; it is the explicit
// fallback and is reported as `method: "agent-key"`.
//
// Tokens never leave the server: status results, UI events, transcripts and
// logs carry the handle, method and expiry only.
//
// "Sign in with Ideaflow" is the OIDC authorization-code flow with PKCE
// (server/oidc.js) against id.ideaflow.app. The callback returns to
// <PUBLIC_URL>/auth/callback/ideaflow, which must exactly match a redirect
// URI registered for VA3's client. Pending sign-ins live in memory for ten
// minutes and are single use.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { DATA_DIR, env, witAgentKey, SELF_HOST } from "./env.js";
import {
  authorizationUrl, decodeJwt, discover, exchangeCode, normalizeIssuer, pkcePair,
  randomToken, refreshTokens, revokeToken, verifyIdToken,
} from "./oidc.js";
import { appendTranscript } from "./transcripts.js";
import { publishUi } from "./ui-events.js";

const ACCOUNTS_DIR = join(DATA_DIR, "accounts");
const CALLBACK_PATH = "/auth/callback/ideaflow";
const DEFAULT_ISSUER = "https://id.ideaflow.app/api/auth";
const PENDING_TTL_MS = 10 * 60_000;
const REFRESH_MARGIN_MS = 60_000;
const SCOPE = "openid profile email offline_access";

const SERVICES = Object.freeze({
  wit: {
    id: "wit",
    name: "World Issue Tracker",
    // WIT accepts Ideaflow ID access tokens whose audience is this resource
    // (services/api OIDC_AUDIENCE in the WIT repo).
    resource: () => env("WIT_OAUTH_RESOURCE", "https://worldissuetracker.com"),
  },
});
const ALIASES = {
  wit: "wit",
  "world-issue-tracker": "wit",
  "world issue tracker": "wit",
  worldissuetracker: "wit",
  "worldissuetracker.com": "wit",
  "worldissuetracker-com": "wit",
};

export function resolveService(raw) {
  const key = String(raw || "wit").trim().toLowerCase();
  const id = ALIASES[key] || ALIASES[key.replace(/[_\s]+/g, "-")];
  if (!id) throw new Error(`Unknown service "${raw}". Known: ${Object.values(SERVICES).map((s) => `${s.id} (${s.name})`).join(", ")}`);
  return SERVICES[id];
}

// ---------- identity ----------
let ownerIdentity = null;
export function setOwnerIdentity(login) {
  if (login && !ownerIdentity) ownerIdentity = String(login).trim().toLowerCase();
}
export function defaultIdentity() {
  return env("VA3_OWNER_IDENTITY").toLowerCase() || ownerIdentity || "local-owner";
}
export function requestIdentity(req) {
  const login = String(req?.headers?.["tailscale-user-login"] || "").trim().toLowerCase();
  return login || defaultIdentity();
}

// ---------- storage ----------
function fileFor(identity) {
  const id = String(identity || "").toLowerCase();
  const name = /^[a-z0-9@+_-][a-z0-9@.+_-]{0,119}$/.test(id) ? id : `id-${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
  return join(ACCOUNTS_DIR, `${name}.json`);
}

function loadAccount(identity) {
  const file = fileFor(identity);
  if (!existsSync(file)) return { identity, services: {} };
  try {
    const record = JSON.parse(readFileSync(file, "utf8"));
    return { identity, ...record, services: record.services || {} };
  } catch {
    return { identity, services: {} };
  }
}

function saveAccount(record) {
  mkdirSync(ACCOUNTS_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(ACCOUNTS_DIR, 0o700); } catch { /* best effort */ }
  const file = fileFor(record.identity);
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  const out = { ...record, updated_at: new Date().toISOString() };
  out.created_at ||= out.updated_at;
  writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return out;
}

function patchService(identity, serviceId, patch) {
  const record = loadAccount(identity);
  if (patch === null) delete record.services[serviceId];
  else record.services[serviceId] = { ...(record.services[serviceId] || {}), ...patch };
  if (!Object.keys(record.services).length && patch === null) {
    try { unlinkSync(fileFor(identity)); } catch { /* already gone */ }
    return record;
  }
  return saveAccount(record);
}

// ---------- Ideaflow ID client configuration ----------
export function publicUrl() {
  const raw = env("PUBLIC_URL") || `http://localhost:${env("VA3_ACTUAL_PORT", env("PORT", "8732"))}/`;
  return raw.endsWith("/") ? raw : `${raw}/`;
}

export function redirectUri() {
  return new URL(CALLBACK_PATH, publicUrl()).href;
}

function clientFile() {
  return env("IDEAFLOW_OIDC_CLIENT_FILE", SELF_HOST ? join(DATA_DIR, "auth", "ideaflow-oidc-client.json") : join(homedir(), ".config", "va3", "ideaflow-oidc-client.json"));
}

// The registered client: the mode-600 credentials file written by Ideaflow
// ID's register:first-party-client script, or env overrides (tests).
export function ideaflowClient() {
  let file = {};
  const path = clientFile();
  if (existsSync(path)) {
    try { file = JSON.parse(readFileSync(path, "utf8")); } catch { return { configured: false, reason: `${path} is not valid JSON` }; }
  }
  const clientId = env("IDEAFLOW_OIDC_CLIENT_ID", file.client_id || "");
  const clientSecret = env("IDEAFLOW_OIDC_CLIENT_SECRET", file.client_secret || "");
  if (!clientId || !clientSecret) {
    return { configured: false, reason: `VA3 is not registered as an Ideaflow ID client yet (no ${path}). One-time setup: docs/accounts.md.` };
  }
  let issuer;
  try { issuer = normalizeIssuer(env("IDEAFLOW_OIDC_ISSUER", file.issuer || DEFAULT_ISSUER)); } catch (error) {
    return { configured: false, reason: error.message };
  }
  const redirect = redirectUri();
  const registered = Array.isArray(file.redirect_uris) ? file.redirect_uris : null;
  if (registered && !registered.includes(redirect)) {
    return { configured: false, reason: `The registered redirect URIs do not include ${redirect} (PUBLIC_URL changed?).` };
  }
  return { configured: true, issuer, clientId, clientSecret, redirectUri: redirect };
}

// ---------- WIT agent key (server-held fallback) ----------
function agentKeyAvailable() {
  try { return Boolean(witAgentKey()); } catch { return false; }
}
function agentKeyHandle() {
  return env("WIT_AGENT_KEY_HANDLE", "jacob");
}

// ---------- pending sign-ins ----------
const pending = new Map(); // state -> { identity, service, verifier, nonce, sessionId, created }

function prunePending(now = Date.now()) {
  for (const [state, p] of pending) if (now - p.created > PENDING_TTL_MS) pending.delete(state);
  while (pending.size > 50) pending.delete(pending.keys().next().value);
}

export async function startSignIn({ identity = defaultIdentity(), service = "wit", sessionId = null } = {}) {
  const svc = resolveService(service);
  const client = ideaflowClient();
  if (!client.configured) return { ok: false, service: svc.id, error: client.reason, sign_in_available: false };
  const doc = await discover(client.issuer);
  const { verifier, challenge } = pkcePair();
  const state = randomToken(32);
  const nonce = randomToken(24);
  prunePending();
  pending.set(state, { identity, service: svc.id, verifier, nonce, sessionId: sessionId ? String(sessionId) : null, created: Date.now() });
  const url = authorizationUrl(doc, {
    clientId: client.clientId,
    redirectUri: client.redirectUri,
    scope: SCOPE,
    state,
    nonce,
    challenge,
    resource: svc.resource(),
    // Show which Ideaflow account is being linked instead of silently
    // reusing whatever browser session exists.
    prompt: "select_account",
  });
  return {
    ok: true,
    service: svc.id,
    service_name: svc.name,
    url,
    expires_in_seconds: PENDING_TTL_MS / 1000,
    client_action: "open_url",
    note: `Opened Ideaflow sign-in for ${svc.name}. When Jacob finishes, the app says "[Account] ${svc.name} linked as <handle>".`,
  };
}

export function pendingSignIns() {
  prunePending();
  return pending.size;
}

function announceAccount(sessionId, text, extra = {}) {
  let entry = null;
  if (sessionId) {
    try { entry = appendTranscript(sessionId, { role: "tool", text, metadata: { event: "account_changed", ...extra } }); } catch { /* conversation may be gone */ }
  }
  publishUi({ type: "account_changed", session_id: sessionId || null, text, entry_id: entry?.id || null, ...extra });
}

function handleFrom(claims) {
  const email = typeof claims.email === "string" ? claims.email : "";
  return String(claims.preferred_username || claims.username || (email ? email.split("@")[0] : "") || claims.name || claims.sub).slice(0, 80);
}

function accessExpiry(tokens, now) {
  const claims = decodeJwt(tokens.access_token);
  if (claims?.exp) return new Date(claims.exp * 1000).toISOString();
  if (tokens.expires_in) return new Date(now + Number(tokens.expires_in) * 1000).toISOString();
  return null;
}

function audienceOk(accessToken, resource) {
  const claims = decodeJwt(accessToken);
  if (!claims) return false;
  const aud = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  return aud.includes(resource);
}

// GET /auth/callback/ideaflow. Returns { status, title, message } for a small
// HTML page; the state is single use whatever the outcome.
export async function completeSignIn({ query, identity }) {
  const state = String(query.get("state") || "");
  const flow = state ? pending.get(state) : null;
  if (state) pending.delete(state);
  if (!flow || Date.now() - flow.created > PENDING_TTL_MS) {
    return { status: 400, title: "Sign-in link expired", message: "This sign-in link has expired or was already used. Ask the assistant to sign in again." };
  }
  if (flow.identity !== identity) {
    return { status: 403, title: "Wrong device account", message: "This sign-in was started by a different tailnet account, so it was not linked." };
  }
  const svc = SERVICES[flow.service];
  if (query.get("error")) {
    const reason = String(query.get("error_description") || query.get("error")).slice(0, 200);
    announceAccount(flow.sessionId, `[Account] ${svc.name} sign-in did not finish: ${reason}`, { origin: "callback", service: svc.id, linked: false });
    return { status: 400, title: "Sign-in not completed", message: `Ideaflow ID said: ${reason}` };
  }
  const code = String(query.get("code") || "");
  if (!code) return { status: 400, title: "Sign-in not completed", message: "The callback carried no authorization code." };
  const client = ideaflowClient();
  if (!client.configured) return { status: 500, title: "Sign-in not configured", message: client.reason };
  try {
    const doc = await discover(client.issuer);
    const tokens = await exchangeCode(doc, client, { code, redirectUri: client.redirectUri, verifier: flow.verifier, resource: svc.resource() });
    const claims = await verifyIdToken(doc, tokens.id_token, { clientId: client.clientId, nonce: flow.nonce });
    if (!audienceOk(tokens.access_token, svc.resource())) {
      throw new Error(`Ideaflow ID did not issue an access token for ${svc.name} (audience ${svc.resource()})`);
    }
    const now = Date.now();
    const handle = handleFrom(claims);
    const accessExpiresAt = accessExpiry(tokens, now);
    patchService(identity, svc.id, {
      method: "ideaflow-id",
      handle,
      subject: claims.sub,
      email: claims.email || null,
      issuer: client.issuer,
      client_id: client.clientId,
      linked_at: new Date(now).toISOString(),
      expires_at: accessExpiresAt,
      refreshable: Boolean(tokens.refresh_token),
      state: "active",
      last_error: null,
      tokens: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_type: tokens.token_type || "Bearer",
        scope: tokens.scope || null,
        access_expires_at: accessExpiresAt,
      },
    });
    console.log(`[accounts] ${svc.id} linked via Ideaflow ID as ${handle}`);
    announceAccount(flow.sessionId, `[Account] ${svc.name} linked as ${handle}`, { origin: "callback", service: svc.id, linked: true, handle, method: "ideaflow-id" });
    return { status: 200, title: `${svc.name} linked`, message: `Signed in to ${svc.name} as ${handle} with your Ideaflow ID. You can close this tab.`, handle };
  } catch (error) {
    console.warn(`[accounts] ${svc.id} sign-in failed: ${error.message}`);
    announceAccount(flow.sessionId, `[Account] ${svc.name} sign-in failed: ${error.message}`, { origin: "callback", service: svc.id, linked: false });
    return { status: 502, title: "Sign-in failed", message: error.message };
  }
}

// ---------- tokens in use ----------
const refreshing = new Map(); // identity:service -> Promise

async function freshAccessToken(identity, serviceId) {
  const link = loadAccount(identity).services[serviceId];
  if (!link || link.method !== "ideaflow-id") return { token: null };
  if (link.state !== "active" || !link.tokens?.access_token) {
    return { token: null, reason: link.last_error || `Ideaflow ID sign-in is ${link.state || "not active"}` };
  }
  const expires = Date.parse(link.tokens.access_expires_at || "");
  if (!Number.isFinite(expires) || expires - Date.now() > REFRESH_MARGIN_MS) return { token: link.tokens.access_token, link };
  if (!link.tokens.refresh_token) {
    patchService(identity, serviceId, { state: "expired", last_error: "Ideaflow ID sign-in expired (no refresh token); sign in again.", tokens: null });
    return { token: null, reason: "Ideaflow ID sign-in expired; sign in again" };
  }
  const key = `${identity}:${serviceId}`;
  if (!refreshing.has(key)) {
    refreshing.set(key, (async () => {
      const client = ideaflowClient();
      if (!client.configured) return { token: null, reason: client.reason };
      const svc = SERVICES[serviceId];
      try {
        const doc = await discover(client.issuer);
        const tokens = await refreshTokens(doc, client, { refreshToken: link.tokens.refresh_token, resource: svc.resource() });
        const accessExpiresAt = accessExpiry(tokens, Date.now());
        const next = patchService(identity, serviceId, {
          expires_at: accessExpiresAt,
          last_error: null,
          tokens: {
            ...link.tokens,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || link.tokens.refresh_token,
            access_expires_at: accessExpiresAt,
          },
        });
        return { token: tokens.access_token, link: next.services[serviceId] };
      } catch (error) {
        if (error.oauthError === "invalid_grant" || error.status === 400 || error.status === 401) {
          patchService(identity, serviceId, { state: "expired", last_error: `Ideaflow ID sign-in expired (${error.message}); sign in again.`, tokens: null });
          return { token: null, reason: "Ideaflow ID sign-in expired; sign in again" };
        }
        return { token: null, reason: `could not refresh the Ideaflow ID token (${error.message})` };
      }
    })().finally(() => refreshing.delete(key)));
  }
  return refreshing.get(key);
}

function agentKeyCredential(note) {
  const key = witAgentKey(); // throws when missing; callers report it
  const handle = agentKeyHandle();
  return {
    headers: { "X-Agent-Key": key },
    method: "agent-key",
    handle,
    label: `${handle} (agent key)`,
    ...(note ? { note: `Posted with the server agent key: ${note}.` } : {}),
  };
}

// Credential for a WIT write made on behalf of `identity`: the user's
// Ideaflow ID bearer when linked and valid, otherwise the server agent key.
// System-originated writes (retries, follow-ups) call witSystemCredential.
export async function witCredential(identity = defaultIdentity()) {
  const { token, link, reason } = await freshAccessToken(identity, "wit");
  if (token) {
    return {
      headers: { Authorization: `Bearer ${token}` },
      method: "ideaflow-id",
      handle: link.handle,
      label: `${link.handle} (Ideaflow ID)`,
      identity,
    };
  }
  return { ...agentKeyCredential(reason), identity };
}

export function witSystemCredential() {
  return agentKeyCredential();
}

// WIT refused the user's bearer: stop using it until the next sign-in.
export function markRejected(identity, serviceId, detail) {
  const link = loadAccount(identity).services[serviceId];
  if (!link || link.method !== "ideaflow-id") return;
  patchService(identity, serviceId, { state: "rejected", last_error: `${SERVICES[serviceId].name} refused the Ideaflow ID token (${detail}); sign in again.` });
}

// ---------- status / sign-out ----------
function presentService(svc, link) {
  const fallback = agentKeyAvailable() ? { method: "agent-key", handle: agentKeyHandle() } : null;
  const client = ideaflowClient();
  const base = {
    service: svc.id,
    name: svc.name,
    sign_in_available: client.configured,
    ...(client.configured ? {} : { sign_in_unavailable_reason: client.reason }),
  };
  if (link?.method === "ideaflow-id" && link.state === "active") {
    return {
      ...base,
      signed_in: true,
      method: "ideaflow-id",
      handle: link.handle,
      linked_at: link.linked_at,
      expires_at: link.expires_at || null,
      refreshes_automatically: Boolean(link.refreshable),
      fallback,
      summary: `${svc.name}: signed in as ${link.handle} (Ideaflow ID)`,
    };
  }
  const lapsed = link?.method === "ideaflow-id" ? { previous_link: { handle: link.handle, state: link.state, problem: link.last_error || null } } : {};
  if (fallback) {
    return {
      ...base,
      signed_in: true,
      method: "agent-key",
      handle: fallback.handle,
      linked_at: null,
      expires_at: null,
      ...lapsed,
      summary: `${svc.name}: signed in as ${fallback.handle} (agent key)${lapsed.previous_link ? ` — Ideaflow ID sign-in ${link.state}` : ""}`,
    };
  }
  return { ...base, signed_in: false, method: null, handle: null, ...lapsed, summary: `${svc.name}: not signed in` };
}

export function accountStatus({ identity = defaultIdentity(), service } = {}) {
  const record = loadAccount(identity);
  const services = service ? [resolveService(service)] : Object.values(SERVICES);
  const out = Object.fromEntries(services.map((svc) => [svc.id, presentService(svc, record.services[svc.id])]));
  return { identity, services: out, summary: Object.values(out).map((s) => s.summary).join("; ") };
}

export async function signOut({ identity = defaultIdentity(), service = "wit", sessionId = null } = {}) {
  const svc = resolveService(service);
  const link = loadAccount(identity).services[svc.id];
  if (!link) {
    return { ok: true, service: svc.id, was_signed_in: false, note: `No Ideaflow ID sign-in for ${svc.name}; the server agent key is not a per-user sign-in and stays configured.`, status: accountStatus({ identity, service: svc.id }).services[svc.id] };
  }
  let revoked = false;
  const client = ideaflowClient();
  if (client.configured && link.tokens?.refresh_token) {
    try { revoked = await revokeToken(await discover(client.issuer), client, link.tokens.refresh_token); } catch { revoked = false; }
  }
  patchService(identity, svc.id, null);
  const status = accountStatus({ identity, service: svc.id }).services[svc.id];
  announceAccount(sessionId, `[Account] Signed out of ${svc.name} (Ideaflow ID). ${status.summary}.`, { service: svc.id, linked: false });
  return { ok: true, service: svc.id, was_signed_in: true, revoked_at_provider: revoked, status };
}

export const ACCOUNT_CALLBACK_PATH = CALLBACK_PATH;
