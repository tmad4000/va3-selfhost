// Paseo health: one latency window + circuit breaker per daemon endpoint
// ("" is this server's own daemon, otherwise the --host value, e.g. ssh://m5).
//
// Every Paseo call (CLI child or daemon HTTP) records its outcome here. From
// that the server derives a single state the voice model can say once:
//   ok    calls are answering normally
//   slow  calls answer, but slowly (p90 over VA3_PASEO_SLOW_MS) or one timed
//         out recently
//   down  VA3_PASEO_DOWN_AFTER consecutive calls timed out or could not reach
//         the daemon (or the last probe failed)
// While a host is down, read-only calls are refused immediately instead of
// spawning one more doomed child; after VA3_PASEO_RETRY_MS one call is let
// through (half-open) and its outcome closes or re-opens the circuit.
//
// Outcomes: "ok" (the daemon answered, including app errors like "agent not
// found"), "timeout", "unreachable" (connection refused / daemon not running).
// Transports are kept apart: "cli" (a child per call, seconds) and "http"
// (the local daemon endpoint, milliseconds). Latency and adaptive timeouts
// use CLI samples, so fast HTTP answers never shrink a CLI read's timeout,
// and failures count per transport, so a wedged CLI still opens the circuit
// while HTTP answers.
import { env } from "./env.js";

const hosts = new Map();

function num(name, fallback) {
  const value = Number(env(name, String(fallback)));
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function healthOptions() {
  return {
    windowMs: num("VA3_PASEO_HEALTH_WINDOW_MS", 120_000),
    slowMs: num("VA3_PASEO_SLOW_MS", 5_000),
    downAfter: Math.max(1, num("VA3_PASEO_DOWN_AFTER", 3)),
    retryMs: num("VA3_PASEO_RETRY_MS", 15_000),
    timeoutFloorMs: num("VA3_PASEO_TIMEOUT_FLOOR_MS", 4_000),
  };
}

function entry(host = "") {
  const key = host || "";
  if (!hosts.has(key)) {
    hosts.set(key, { samples: [], consecutive: 0, byTransport: { cli: 0, http: 0 }, lastFailureAt: null, lastError: null, probe: null, halfOpen: false });
  }
  return hosts.get(key);
}

const SAMPLE_CAP = 200;

export function recordPaseoCall(host, { ms, outcome, error = null, at = Date.now(), transport = "cli" }) {
  const e = entry(host);
  const t = transport === "http" ? "http" : "cli";
  e.samples.push({ at, ms: Math.max(0, Math.round(ms || 0)), outcome, transport: t });
  if (e.samples.length > SAMPLE_CAP) e.samples.splice(0, e.samples.length - SAMPLE_CAP);
  if (outcome === "ok") {
    e.byTransport[t] = 0;
  } else {
    e.byTransport[t] += 1;
    e.lastFailureAt = at;
    e.lastError = error ? String(error).slice(0, 200) : outcome;
  }
  e.consecutive = Math.max(e.byTransport.cli, e.byTransport.http);
  e.halfOpen = false;
}

// A probe (paseo status / daemon HTTP ping) result: authoritative for "down".
export function recordPaseoProbe(host, { available, detail = "", at = Date.now() }) {
  const e = entry(host);
  e.probe = { available: Boolean(available), detail: String(detail || "").slice(0, 200), at };
  if (available) { e.byTransport.http = 0; e.consecutive = Math.max(e.byTransport.cli, 0); }
  else { e.lastFailureAt = at; e.lastError = e.probe.detail || "probe failed"; }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

// Pure: the health of one endpoint from its recorded state.
export function deriveHealth(e, { now = Date.now(), ...overrides } = {}) {
  const o = { ...healthOptions(), ...overrides };
  const recent = (e?.samples || []).filter((s) => now - s.at <= o.windowMs);
  // Latency from CLI calls when there are enough of them (HTTP answers are
  // 10-100x faster and would hide a slow CLI), else from everything.
  const okCli = recent.filter((s) => s.outcome === "ok" && s.transport !== "http");
  const answered = (okCli.length >= 5 ? okCli : recent.filter((s) => s.outcome === "ok")).map((s) => s.ms).sort((a, b) => a - b);
  const timeouts = recent.filter((s) => s.outcome === "timeout").length;
  const p50 = percentile(answered, 0.5);
  const p90 = percentile(answered, 0.9);
  const base = {
    p50_ms: p50,
    p90_ms: p90,
    calls_recent: recent.length,
    timeouts_recent: timeouts,
    consecutive_failures: e?.consecutive || 0,
    ...(e?.lastError ? { last_error: e.lastError } : {}),
    ...(e?.lastFailureAt ? { last_failure_at: new Date(e.lastFailureAt).toISOString() } : {}),
  };
  const probe = e?.probe;
  if (probe && !probe.available && now - probe.at <= o.windowMs
      && !(e.samples.length && e.samples.at(-1).outcome === "ok" && e.samples.at(-1).at > probe.at)) {
    return { state: "down", reason: `daemon probe failed: ${probe.detail || "unreachable"}`, ...base };
  }
  if ((e?.consecutive || 0) >= o.downAfter) {
    return { state: "down", reason: `${e.consecutive} calls in a row timed out or could not reach the daemon (last: ${e.lastError || "unknown"})`, ...base };
  }
  if (timeouts > 0) return { state: "slow", reason: `${timeouts} call(s) timed out in the last ${Math.round(o.windowMs / 1000)} s`, ...base };
  if (p90 !== null && p90 > o.slowMs) return { state: "slow", reason: `p90 latency ${p90} ms (over ${o.slowMs} ms)`, ...base };
  return { state: "ok", reason: recent.length ? `p90 latency ${p90 ?? "?"} ms` : "no recent calls", ...base };
}

export function paseoHealth(host = "", options = {}) {
  return deriveHealth(hosts.get(host || ""), options);
}

// The one-word state for /api/health and tool results.
export function paseoHealthState(host = "") {
  return paseoHealth(host).state;
}

export function allPaseoHealth() {
  const out = {};
  for (const key of new Set(["", ...hosts.keys()])) out[key || "local"] = paseoHealth(key);
  return out;
}

// Circuit breaker. Returns null when the call may run, otherwise the reason
// it is refused. While down, one call per VA3_PASEO_RETRY_MS is admitted as a
// half-open trial; its recorded outcome decides what happens next.
export function admitPaseoCall(host = "", { now = Date.now() } = {}) {
  const e = entry(host);
  const health = deriveHealth(e, { now });
  if (health.state !== "down") return null;
  const { retryMs } = healthOptions();
  const since = now - (e.lastFailureAt || 0);
  if (!e.halfOpen && since >= retryMs) {
    e.halfOpen = true;
    return null;
  }
  return `Paseo is down (${health.reason}); not queuing another call. Retrying on its own within ${Math.ceil(Math.max(0, retryMs - since) / 1000)} s.`;
}

// Shrink a read-only call's timeout toward 3x the recent p90 when the daemon
// is answering quickly: a call that is far slower than its peers is almost
// certainly hung, and holding its slot only delays the voice path. Never
// exceeds the caller's own limit; without enough data, the caller's limit.
export function adaptiveTimeout(host, requested, { now = Date.now() } = {}) {
  const e = hosts.get(host || "");
  const { windowMs, timeoutFloorMs } = healthOptions();
  const answered = (e?.samples || []).filter((s) => s.outcome === "ok" && s.transport !== "http" && now - s.at <= windowMs).map((s) => s.ms).sort((a, b) => a - b);
  if (answered.length < 5) return requested;
  return Math.min(requested, Math.max(timeoutFloorMs, 3 * percentile(answered, 0.9)));
}

// What a tool result carries so the model can say "Paseo is down" once
// instead of narrating every slow call.
export function paseoToolNote(host = "") {
  const health = paseoHealth(host);
  if (health.state === "ok") return { paseo: "ok" };
  return {
    paseo: health.state,
    paseo_note: health.state === "down"
      ? `Paseo is down (${health.reason}). Tell Jacob once, plainly, that Paseo is down; do not keep checking or narrate timeouts. Agent status shown is the last known.`
      : `Paseo is slow right now (${health.reason}). Status may lag; do not narrate the delay.`,
  };
}

export function classifyPaseoError(error) {
  if (!error) return "ok";
  if (error.killed || error.signal === "SIGKILL" || error.code === "ETIMEDOUT" || error.name === "TimeoutError" || error.timeout) return "timeout";
  // The CLI reports some failures as JSON on stdout, e.g.
  // {"error":{"code":"DAEMON_UNREACHABLE","message":"Cannot connect to daemon at ssh://m5: SSH connection failed..."}}
  const text = `${error.code || ""} ${error.cause?.code || ""} ${error.message || ""} ${error.stderr || ""} ${error.stdout || ""}`;
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENOTFOUND|unreachable|daemon (is )?not running|(could ?not|cannot) connect|connection refused|connection failed|fetch failed|spawn E[A-Z]+/i.test(text)) return "unreachable";
  return "ok"; // the daemon answered (e.g. "Agent not found")
}

export function resetPaseoHealth() {
  hosts.clear();
}
