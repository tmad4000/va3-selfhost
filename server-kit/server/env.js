// Zero-dependency env loading.
// Order: process.env > .env file > ~/.config/wit/openai-key fallback for the API key.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

const ROOT = new URL("..", import.meta.url).pathname;

function parseDotEnv(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

export const SELF_HOST = process.env.VA3_SELF_HOST === "1";
if (SELF_HOST && !isAbsolute(process.env.DATA_DIR || "")) throw new Error("VA3_SELF_HOST=1 requires an explicit absolute DATA_DIR");

const dotenvPath = join(ROOT, ".env");
const fileEnv = !SELF_HOST && existsSync(dotenvPath) ? parseDotEnv(readFileSync(dotenvPath, "utf8")) : {};

// Original-owner operational defaults (machine names, private URLs, cloud
// accounts) live in config/owner-defaults.json, which the self-host kit never
// ships (bin/self-host-files.json) and self-host mode never reads. Keep such
// values out of source so the shared kit stays generic (bin/kit-leak-check.mjs).
const ownerDefaultsPath = join(ROOT, "config", "owner-defaults.json");
let ownerDefaults = {};
if (!SELF_HOST && existsSync(ownerDefaultsPath)) {
  try { ownerDefaults = JSON.parse(readFileSync(ownerDefaultsPath, "utf8")) || {}; } catch { ownerDefaults = {}; }
}
export function ownerDefault(key, fallback) {
  return Object.hasOwn(ownerDefaults, key) ? ownerDefaults[key] : fallback;
}

export function env(key, fallback = "") {
  const owner = typeof ownerDefaults[key] === "string" ? ownerDefaults[key] : "";
  const v = process.env[key] ?? fileEnv[key] ?? "";
  return v !== "" ? v : owner !== "" ? owner : fallback;
}

export function openaiKey() {
  const fromEnv = env("OPENAI_API_KEY");
  if (fromEnv) return fromEnv;
  if (SELF_HOST) throw new Error("Set your own OPENAI_API_KEY in the self-host service environment");
  const cache = join(homedir(), ".config", "wit", "openai-key");
  if (existsSync(cache)) {
    return readFileSync(cache, "utf8").trim();
  }
  throw new Error(
    "No OpenAI API key found. Set OPENAI_API_KEY in .env or place the key at ~/.config/wit/openai-key"
  );
}

// Anthropic key for the smart-tier fallback; null (not an error) when absent,
// because the fallback is optional.
export function anthropicKey() {
  const fromEnv = env("ANTHROPIC_API_KEY");
  if (fromEnv) return fromEnv;
  if (SELF_HOST) return null;
  const file = join(homedir(), ".config", "anthropic", "api-key");
  try { return existsSync(file) ? readFileSync(file, "utf8").trim() || null : null; } catch { return null; }
}

export const PROJECT_ROOT = ROOT;
export const DATA_DIR = resolve(PROJECT_ROOT, env("DATA_DIR", "data"));

export function witAgentKey() {
  const fromEnv = env("WIT_AGENT_KEY");
  if (fromEnv) return fromEnv;
  if (SELF_HOST) throw new Error("Set WIT_AGENT_KEY explicitly to enable World Issue Tracker");
  const cache = join(homedir(), ".config", "wit", "agent-key");
  if (existsSync(cache)) {
    return readFileSync(cache, "utf8").trim();
  }
  throw new Error(
    "No World Issue Tracker agent key found. Set WIT_AGENT_KEY or place the key at ~/.config/wit/agent-key"
  );
}
