// Effective capabilities, computed live, so the realtime model can answer
// "what can you do?" from facts instead of guesses.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "./env.js";
import { agentHosts, localHost, remoteHosts } from "./host.js";
import { agentModelPreferences, defaultAgentMode, detectProvider, paseoBin, paseoStatus, tmuxBin } from "./agents.js";
import { smartModels } from "./openai.js";
import { toolDefinitions } from "./tools.js";

const sshBin = () => env("VA3_SSH_BIN", "/usr/bin/ssh");

const pexec = promisify(execFile);
const reachCache = new Map(); // alias -> { at, reachable, detail }

async function reachable(alias) {
  const cached = reachCache.get(alias);
  if (cached && Date.now() - cached.at < 60_000) return cached;
  let result;
  try {
    await pexec(sshBin(), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", alias, "true"], { timeout: 6_000 });
    result = { reachable: true, detail: "ssh ok" };
  } catch (error) {
    result = { reachable: false, detail: String(error.stderr || error.message || error).trim().split("\n").pop().slice(0, 160) };
  }
  reachCache.set(alias, { ...result, at: Date.now() });
  return result;
}

// The models behind each tier, so "which model are you?" is answered from
// configuration rather than guessed.
export function models() {
  return {
    realtime_voice: env("REALTIME_MODEL", "gpt-realtime-2.1"),
    smart_tier: smartModels().primary,
    smart_tier_fallback: smartModels().fallback_available ? smartModels().fallback : "none",
    transcription: env("REALTIME_TRANSCRIBE_MODEL", "gpt-transcribe"),
    session_agent: `${env("VA3_SESSION_AGENT_PROVIDER", "claude")} (provider default model) via Paseo`,
    agents_default: `${env("PASEO_AGENT_PROVIDER", "claude")}; GUI/computer use: ${env("VA3_GUI_AGENT_PROVIDER", "codex")}`,
    agent_model_preferences: {
      claude: agentModelPreferences("claude").join(", ") || "provider default",
      codex: agentModelPreferences("codex").join(", ") || "provider default",
      note: "First preferred model the host's Paseo provider offers (Claude defaults to Opus, then Sonnet); an explicit model hint wins; unavailable model lists or no matching model use the provider default.",
    },
  };
}

export async function capabilities() {
  const host = localHost();
  const [paseo, paseoPath, tmuxPath, agentTransport] = await Promise.all([
    paseoStatus(), paseoBin(), tmuxBin(), detectProvider(),
  ]);
  const remotes = await Promise.all(Object.entries(remoteHosts()).map(async ([alias, label]) => ({
    id: alias, machine: label, ...(await reachable(alias)),
  })));
  const reach = new Map(remotes.map((r) => [r.id, r]));
  const agentTargets = Object.values(agentHosts()).map((h) => ({
    id: h.id,
    machine: h.label,
    via: h.local ? "this server's Paseo daemon" : `Paseo daemon at ${h.paseoHost}`,
    reachable: h.local ? paseo.available : reach.get(h.id)?.reachable ?? null,
    can_attempt: "anything: shell, files, network, browser, GUI and computer use",
  }));
  const tools = toolDefinitions().map((t) => ({ name: t.name, does: t.description.split(/(?<=\.)\s/)[0] }));
  return {
    models: models(),
    server_host: { id: host.id, machine: host.label, hostname: host.hostname, user: host.user },
    remote_hosts: remotes,
    agents: {
      main_route: "ask_agent: this conversation's persistent session agent (created on first use)",
      parallel_route: "dispatch_agents: one new agent per independent ask, in parallel, with a receipt each and safe retries; spawn_coding_agent for a single new agent with a chosen mode",
      hosts: agentTargets,
      default_transport: agentTransport,
      default_mode: defaultAgentMode(),
      default_provider: env("PASEO_AGENT_PROVIDER", "claude"),
      gui_provider: `${env("VA3_GUI_AGENT_PROVIDER", "codex")} (computer use)`,
      mode_changes: "set_agent_mode changes a running agent's mode",
      permissions: "pending permissions are announced as [Agent needs permission]; agent_permission allow_all approves everything for one agent",
      paseo: { available: paseo.available, cli: paseoPath },
      tmux_fallback: { available: Boolean(tmuxPath), cli: tmuxPath },
    },
    terminals: { backends: [paseo.available && "paseo", tmuxPath && "tmux"].filter(Boolean), herdr: "not integrated; use Paseo or tmux terminals" },
    direct_shell: { tool: "run_command", hosts: [host.id, ...remotes.map((r) => r.id)], timeout_default_s: 120, timeout_max_s: 1800, audit: "data/command-audit.jsonl" },
    files: { tools: ["list_files", "read_file", "write_file"], read_limit_bytes: 65_536, write_limit_bytes: 1_048_576, writes: "atomic; create never overwrites" },
    tools,
    // Limits of the voice tier only. What agents can do is never limited
    // here: they attempt the task and report what actually happened.
    voice_tier_limits: [
      "Cannot hear while muted, or in Listen mode until the wake phrase.",
      "Cannot identify who is speaking; navigation or other ambient audio may be transcribed.",
      "A remote host can be used only while it is reachable (see agents.hosts and remote_hosts).",
    ],
  };
}
