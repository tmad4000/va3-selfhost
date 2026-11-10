// Minimal OpenID Connect relying party (authorization code + PKCE) for
// "Sign in with Ideaflow". Zero dependencies: discovery, the authorization
// URL, the code exchange (client_secret_basic), refresh, and ID token
// verification against the provider's JWKS.
//
// Security notes:
// - Every endpoint from discovery must be HTTPS on the issuer's own origin
//   (plain HTTP only for a loopback issuer, which is what tests use).
// - The ID token must carry our client_id as audience and the exact nonce of
//   this sign-in; its signature is checked against the issuer's JWKS.
// - Tokens never leave this module except to server/accounts.js, which keeps
//   them in a mode-600 file and never returns them to the browser.
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from "node:crypto";

const TIMEOUT_MS = 15_000;
const DISCOVERY_TTL_MS = 10 * 60_000;
const discoveryCache = new Map(); // issuer -> { at, doc }
const jwksCache = new Map(); // issuer -> { at, keys }

const ALGORITHMS = {
  RS256: { kty: "RSA", digest: "sha256" },
  PS256: { kty: "RSA", digest: "sha256", padding: 6 /* RSA_PKCS1_PSS_PADDING */ },
  ES256: { kty: "EC", crv: "P-256", digest: "sha256", dsaEncoding: "ieee-p1363" },
  EdDSA: { kty: "OKP", digest: null },
};

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function pkcePair() {
  const verifier = randomToken(48);
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function loopback(hostname) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
}

// Issuer must be an absolute HTTPS URL (HTTP only on loopback, for tests).
export function normalizeIssuer(raw) {
  const url = new URL(String(raw || ""));
  if (url.username || url.password || url.search || url.hash) throw new Error("OIDC issuer must be a plain URL");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback(url.hostname))) {
    throw new Error("OIDC issuer must use HTTPS");
  }
  return url.href.replace(/\/+$/, "");
}

function endpointOnIssuer(value, issuer, label) {
  const url = new URL(String(value || ""));
  const base = new URL(issuer);
  if (url.origin !== base.origin) throw new Error(`OIDC ${label} is not on the issuer's origin`);
  return url.href;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  return res.json();
}

export async function discover(issuer, { now = Date.now() } = {}) {
  const iss = normalizeIssuer(issuer);
  const cached = discoveryCache.get(iss);
  if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.doc;
  const doc = await getJson(`${iss}/.well-known/openid-configuration`);
  if (normalizeIssuer(doc.issuer) !== iss) throw new Error("OIDC discovery issuer does not match");
  const out = {
    issuer: iss,
    authorization_endpoint: endpointOnIssuer(doc.authorization_endpoint, iss, "authorization_endpoint"),
    token_endpoint: endpointOnIssuer(doc.token_endpoint, iss, "token_endpoint"),
    jwks_uri: endpointOnIssuer(doc.jwks_uri, iss, "jwks_uri"),
    revocation_endpoint: doc.revocation_endpoint ? endpointOnIssuer(doc.revocation_endpoint, iss, "revocation_endpoint") : null,
    code_challenge_methods_supported: doc.code_challenge_methods_supported || [],
  };
  if (out.code_challenge_methods_supported.length && !out.code_challenge_methods_supported.includes("S256")) {
    throw new Error("OIDC provider does not support S256 PKCE");
  }
  discoveryCache.set(iss, { at: now, doc: out });
  return out;
}

export function clearOidcCaches() {
  discoveryCache.clear();
  jwksCache.clear();
}

export function authorizationUrl(doc, { clientId, redirectUri, scope, state, nonce, challenge, resource, prompt }) {
  const url = new URL(doc.authorization_endpoint);
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope,
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
    ...(resource ? { resource } : {}),
    ...(prompt ? { prompt } : {}),
  };
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.href;
}

// RFC 6749 2.3.1: form-encode the id and secret before base64.
function basicAuth(clientId, clientSecret) {
  const enc = (v) => encodeURIComponent(v).replace(/%20/g, "+");
  return `Basic ${Buffer.from(`${enc(clientId)}:${enc(clientSecret)}`).toString("base64")}`;
}

async function tokenRequest(doc, client, params) {
  const res = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: basicAuth(client.clientId, client.clientSecret),
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const error = new Error(`token endpoint: ${body.error || `HTTP ${res.status}`}${body.error_description ? ` (${body.error_description})` : ""}`);
    error.oauthError = body.error || null;
    error.status = res.status;
    throw error;
  }
  return body;
}

export function exchangeCode(doc, client, { code, redirectUri, verifier, resource }) {
  return tokenRequest(doc, client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
    ...(resource ? { resource } : {}),
  });
}

export function refreshTokens(doc, client, { refreshToken, resource }) {
  return tokenRequest(doc, client, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    ...(resource ? { resource } : {}),
  });
}

export async function revokeToken(doc, client, token) {
  if (!doc.revocation_endpoint || !token) return false;
  try {
    const res = await fetch(doc.revocation_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basicAuth(client.clientId, client.clientSecret) },
      body: new URLSearchParams({ token, token_type_hint: "refresh_token" }).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Claims of a JWT without verifying it. Only for reading our own access
// token's expiry/audience; never for trusting an identity.
export function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return null; }
}

async function jwksKeys(doc, kid, now) {
  const cached = jwksCache.get(doc.issuer);
  if (cached && now - cached.at < DISCOVERY_TTL_MS && cached.keys.some((k) => k.kid === kid)) return cached.keys;
  const body = await getJson(doc.jwks_uri);
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(doc.issuer, { at: now, keys });
  return keys;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ""), "utf8");
  const y = Buffer.from(String(b ?? ""), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function verifyIdToken(doc, idToken, { clientId, nonce, now = Date.now() }) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("ID token is not a JWT");
  let header;
  let claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("ID token is malformed");
  }
  const spec = ALGORITHMS[header.alg];
  if (!spec) throw new Error(`ID token algorithm ${header.alg} is not accepted`);
  if (claims.iss !== doc.issuer) throw new Error("ID token issuer does not match");
  const aud = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
  if (!aud.includes(clientId)) throw new Error("ID token audience is not this client");
  if (aud.length > 1 && claims.azp !== clientId) throw new Error("ID token azp is not this client");
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now - 60_000) throw new Error("ID token has expired");
  if (!safeEqual(claims.nonce, nonce)) throw new Error("ID token nonce does not match this sign-in");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("ID token has no subject");

  const keys = await jwksKeys(doc, header.kid, now);
  const candidates = keys.filter((k) => (!header.kid || k.kid === header.kid) && k.kty === spec.kty
    && (!spec.crv || k.crv === spec.crv) && (!k.alg || k.alg === header.alg) && (!k.use || k.use === "sig"));
  const data = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], "base64url");
  for (const jwk of candidates) {
    try {
      const key = createPublicKey({ key: jwk, format: "jwk" });
      const options = spec.padding ? { key, padding: spec.padding, saltLength: 32 } : spec.dsaEncoding ? { key, dsaEncoding: spec.dsaEncoding } : key;
      if (verify(spec.digest, data, options, signature)) return claims;
    } catch { /* try the next key */ }
  }
  throw new Error("ID token signature did not verify");
}
