// Which machine this server (and therefore every local tool) runs on. The
// realtime model must name the machine explicitly. Known machine names come
// from the owner's config/owner-defaults.json ("known_hosts"), never source.
import { hostname, userInfo } from "node:os";
import { env, ownerDefault } from "./env.js";

const KNOWN = ownerDefault("known_hosts", {});

export function localHost() {
  const name = hostname();
  const short = name.toLowerCase().replace(/\.local$/, "");
  const known = KNOWN[short];
  return {
    id: env("VA3_HOST_ID", known?.id || "local"),
    label: env("VA3_HOST_LABEL", known?.label || name),
    hostname: name,
    user: userInfo().username,
  };
}

// Remote hosts reachable over SSH for file and command tools. Only aliases in
// this allowlist are accepted; the model can never supply an arbitrary target.
export function remoteHosts() {
  const configured = env("VA3_REMOTE_HOSTS", "none");
  const out = {};
  if (configured.trim().toLowerCase() === "none") return out;
  for (const part of configured.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [alias, ...label] = part.split("=");
    if (/^[a-z0-9-]+$/i.test(alias)) out[alias.toLowerCase()] = label.join("=") || alias;
  }
  return out;
}

// Machines a coding agent can be launched on, each through its own Paseo
// daemon. The server's own daemon is used for the local host; other hosts are
// reached with `paseo --host <endpoint>` (an SSH endpoint by default). This is
// a server-owned allowlist: the model picks an id, never an endpoint.
export function agentHosts() {
  const local = localHost();
  const out = { [local.id]: { id: local.id, label: local.label, local: true, paseoHost: null } };
  const configured = env("VA3_AGENT_HOSTS", "m5=ssh://m5");
  if (configured.trim().toLowerCase() === "none") return out;
  const labels = remoteHosts();
  for (const part of configured.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [alias, ...endpoint] = part.split("=");
    const id = alias.toLowerCase();
    if (!/^[a-z0-9-]+$/.test(id) || id === local.id || !endpoint.join("=")) continue;
    out[id] = { id, label: labels[id] || id, local: false, paseoHost: endpoint.join("=") };
  }
  return out;
}

export function resolveAgentHost(value) {
  const hosts = agentHosts();
  const local = localHost();
  const wanted = String(value || "").trim().toLowerCase();
  if (!wanted || wanted === "local" || wanted === local.id) return hosts[local.id];
  if (hosts[wanted]) return hosts[wanted];
  throw new Error(`Unknown agent host "${value}". Allowed: ${Object.keys(hosts).join(", ")}`);
}

export function resolveHost(value) {
  const local = localHost();
  const wanted = String(value || "").trim().toLowerCase();
  if (!wanted || wanted === "local" || wanted === local.id) return { remote: false, id: local.id, label: local.label };
  const remotes = remoteHosts();
  if (remotes[wanted]) return { remote: true, id: wanted, alias: wanted, label: remotes[wanted] };
  throw new Error(`Unknown host "${value}". Allowed: ${[local.id, ...Object.keys(remotes)].join(", ")}`);
}
