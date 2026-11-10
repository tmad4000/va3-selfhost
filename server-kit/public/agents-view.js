// Agents panel view logic: which agents belong to the current conversation,
// how each group is sorted, and the small labels on a card (provider/model
// chip, stuck summary). Pure functions over plain agent rows from
// GET /api/agents, so they run (and are tested) outside a browser.
//
// API: VA3AgentsView.SORTS / loadSort(storage) / saveSort(storage, value) /
// inConversation(agent, sessionId) / activityAt(agent) / sortAgents(list, sort) /
// groupAgents(list, sessionId, sort) / providerLabel(agent) / modelLabel(agent) /
// stuckSummary(agent).
(function (root) {
  const SORT_KEY = "va3-agents-sort";
  const SORTS = Object.freeze([
    { id: "newest", label: "Newest activity" },
    { id: "running", label: "Active first" },
    { id: "host", label: "By host" },
  ]);
  const DEFAULT_SORT = "newest";
  // Needs Jacob or is working first; finished and dead last.
  const STATE_RANK = { blocked: 0, stuck: 1, running: 2, starting: 2, unknown: 3, completed: 4, exited: 4 };

  function loadSort(storage) {
    let raw = null;
    try { raw = storage?.getItem(SORT_KEY); } catch { /* private mode */ }
    return SORTS.some((s) => s.id === raw) ? raw : DEFAULT_SORT;
  }

  function saveSort(storage, value) {
    const sort = SORTS.some((s) => s.id === value) ? value : DEFAULT_SORT;
    try { storage?.setItem(SORT_KEY, sort); } catch { /* private mode */ }
    return sort;
  }

  // Launched from this conversation, or sent to / answered from it.
  function inConversation(agent, sessionId) {
    if (!sessionId || !agent) return false;
    return agent.session_id === sessionId || (agent.interacted_sessions || []).includes(sessionId);
  }

  function time(value) {
    const t = Date.parse(value || "");
    return Number.isFinite(t) ? t : 0;
  }

  // The latest of: created, last message sent, last interaction.
  function activityAt(agent) {
    return Math.max(time(agent.created), time(agent.last_prompt?.sent_at), time(agent.last_interaction_at));
  }

  function stateOf(agent) {
    return agent.state || agent.live_status || "unknown";
  }

  function sortAgents(list, sort = DEFAULT_SORT) {
    const byNewest = (a, b) => activityAt(b) - activityAt(a) || String(b.id).localeCompare(String(a.id));
    const rows = [...(list || [])];
    if (sort === "running") {
      const rank = (a) => STATE_RANK[stateOf(a)] ?? 5;
      return rows.sort((a, b) => rank(a) - rank(b) || byNewest(a, b));
    }
    if (sort === "host") {
      const host = (a) => String(a.host || a.host_id || "server").toLowerCase();
      return rows.sort((a, b) => host(a).localeCompare(host(b)) || byNewest(a, b));
    }
    return rows.sort(byNewest);
  }

  function groupAgents(list, sessionId, sort = DEFAULT_SORT) {
    const current = [];
    const other = [];
    for (const agent of list || []) (inConversation(agent, sessionId) ? current : other).push(agent);
    return [
      { key: "current", label: "This conversation", agents: sortAgents(current, sort) },
      { key: "other", label: "Earlier / other conversations", agents: sortAgents(other, sort) },
    ];
  }

  function providerLabel(agent) {
    const p = String(agent.agent_provider || "").toLowerCase();
    return p === "claude" ? "Claude" : p === "codex" ? "Codex" : p ? p : "Unknown provider";
  }

  // Always answerable: an explicit model, or the provider's own default.
  function modelLabel(agent) {
    return `${providerLabel(agent)} · ${agent.model || "provider default"}`;
  }

  // Queued messages not yet handed to a successor (null when unknown).
  function handoffRemaining(agent) {
    const n = agent.queued_messages || agent.stuck_queued;
    if (!n) return null;
    const taken = (agent.handoff_successors || []).reduce((sum, t) => sum + (t.message_ids || []).length, 0);
    return Math.max(0, n - taken);
  }

  function stuckSummary(agent) {
    if (stateOf(agent) !== "stuck") return null;
    const n = agent.queued_messages || agent.stuck_queued;
    const left = handoffRemaining(agent);
    return ["Stuck", n ? `${n} queued` : null, agent.handoff_path ? "handoff saved" : null,
      left === 0 ? "all handed off" : left !== null && left < n ? `${left} not handed off` : null].filter(Boolean).join(" · ");
  }

  root.VA3AgentsView = {
    SORT_KEY, SORTS, DEFAULT_SORT, loadSort, saveSort, inConversation, activityAt, sortAgents, groupAgents,
    providerLabel, modelLabel, stuckSummary, handoffRemaining,
  };
})(typeof window !== "undefined" ? window : globalThis);
