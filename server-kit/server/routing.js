// Shared, capability-based routing contract; no environment or state imports.
export const EVIDENCE_SCOPES = Object.freeze(["self_contained", "public_web", "private_state", "action", "agent_followup", "deep_investigation", "unknown"]);
export const ROUTING_POLICY = `Evidence takes precedence over wording and difficulty. The coding agent handles most work.
- Coding/execution defaults to Claude Opus 5.5. When Jacob explicitly says use Astra, use Astra for planning/architecture. When he says ask Fable (or use/consult Fable), dispatch planning to Fable, then dispatch implementation to the default coding agent without the planner override. Set phase=planning only for planning-only work; mixed plan-and-implement requests use execution. Explicit provider/model choices win. Existing sessions retain their model; do not spawn a duplicate merely to change phase.
- Existing agent work: send follow-ups to its owner; never start a second worker for it.
- Questions requiring actual code, logs, files, settings, accounts, machines, private project context, actions, or deeper investigation go to ask_agent, even when phrased as an explanation. Explicit requests for an agent also go there.
- Only self-contained reasoning, explanations, math, comparisons and drafts go to escalate_to_smart_model. Public research may use it with web search enabled. Multiple reasoning steps alone do not require an agent.
- If required evidence is missing or uncertain, use the agent; never guess how this app actually behaves. “Why did you cut yourself off?” needs logs; “How does voice interruption generally work?” is self-contained.
- Dispatch several independent agent-needed asks with dispatch_agents; do not turn smart-only questions into agent tasks merely because they arrived together.
- Preserve the ask ID, relevant context and actual answering tier. Never silently replace failed agent work with a speculative smart answer.`;

export function smartRoute(scope, useWebSearch = false) {
  if (scope === "self_contained") return { route: "smart", useWebSearch: Boolean(useWebSearch) };
  if (scope === "public_web") return { route: "smart", useWebSearch: true };
  return { route: "agent", reason: EVIDENCE_SCOPES.includes(scope) ? scope : "unknown" };
}

export const WORK_PHASES = Object.freeze(["planning", "execution"]);
export function workPhase(value = "execution") {
  if (!WORK_PHASES.includes(value)) throw new Error("phase must be planning or execution");
  return value;
}
