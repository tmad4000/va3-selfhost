// Work view (docs/work-view.md): one row per request in this conversation,
// with who asked, who owns it, its current step, its blocker, its result, and
// whether that result reached speech. Pure functions over data the page
// already has (GET /api/checklist, GET /api/agents, the pending-notice queue
// and archive), so they run and are tested outside a browser.
//
// Every string a row carries goes through VA3Mask.clip (public/mask.js), even
// though the server already masks: a future endpoint must not leak by omission.
//
// API: VA3WorkView.KEYS / loadPrefs(storage) / savePref(storage, name, bool) /
// deriveRows({ checklist, agents, speech, sessionId, now }) / sortRows(rows) /
// splitFinished(rows, showFinished) / speechLabel(key, speech) /
// counts(rows) / headerLine(rows) / answer(action, { rows, now }) / agoLabel(ms).
(function (root) {
  const Mask = root.VA3Mask || globalThis.VA3Mask;
  const AgentsView = root.VA3AgentsView || globalThis.VA3AgentsView;
  const KEYS = Object.freeze({ visible: "va3-work-view", finished: "va3-work-view-finished" });
  const HISTORIC_MS = 6 * 60 * 60 * 1000;
  const PLACEHOLDER_STEPS = new Set(["Dispatching an agent.", "Not started", ""]);
  const LIMIT = Object.freeze({ title: 140, step: 120, blocker: 160, result: 160, full: 4000 });
  const STATE_LABEL = Object.freeze({ blocked: "Blocked", failed: "Failed", working: "Working", open: "Open", done: "Done" });
  const REQUESTER_LABEL = Object.freeze({ jacob: "Jacob", prime_agent: "Prime agent", system: "System" });
  const UNSPOKEN = new Set(["Interrupted", "Not confirmed heard", "Written, not spoken"]);

  const clip = (text, max) => (Mask ? Mask.clip(text, max) : String(text ?? "").slice(0, max));
  const time = (value) => { const t = Date.parse(value || ""); return Number.isFinite(t) ? t : 0; };

  function loadPrefs(storage) {
    const read = (k) => { try { return storage?.getItem(k); } catch { return null; } };
    return { visible: read(KEYS.visible) === "on", finished: read(KEYS.finished) === "on" };
  }
  function savePref(storage, name, value) {
    const key = KEYS[name];
    if (!key) return loadPrefs(storage);
    try { storage?.setItem(key, value ? "on" : "off"); } catch { /* private mode */ }
    return loadPrefs(storage);
  }

  function agoLabel(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const s = Math.round(ms / 1000);
    if (s < 60) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  }

  function agentState(agent) {
    return agent ? (agent.state || agent.live_status || "unknown") : null;
  }

  // ---------- speech ----------
  // speech = { queue, archive, batch: { keys, responseActive, speakingOut } }.
  // Returns { label, detail, unspoken } or null when there is nothing to say.
  function speechLabel(key, speech, agent) {
    if (!key || !speech) return null;
    const batch = speech.batch || {};
    if ((batch.keys || []).includes(key)) {
      if (batch.speakingOut) return { label: "Playing", detail: "Being read aloud now", unspoken: false };
      if (batch.responseActive) return { label: "Generating", detail: "The reply that reads it is being composed", unspoken: false };
    }
    const queued = (speech.queue || []).find((it) => it.key === key);
    if (queued) return queued.deferred
      ? { label: "Held until you're back", detail: "Waiting until you are back", unspoken: false }
      : { label: "Queued to speak", detail: "Waiting for a pause", unspoken: false };
    const archive = speech.archive || [];
    let rec = null;
    for (let i = archive.length - 1; i >= 0; i--) if (archive[i].key === key) { rec = archive[i]; break; }
    if (rec) {
      if (rec.heard_at) return { label: "Spoken", detail: rec.heard_by === "spoken" ? "Read aloud to completion" : "Marked heard", unspoken: false };
      if (rec.interrupted) return { label: "Interrupted", detail: "Reading it was cut off", unspoken: true };
      if (rec.expired) return { label: "Written, not spoken", detail: "Expired before a pause came", unspoken: true };
      if (!rec.spoken) return { label: "Written, not spoken", detail: "Added to context silently (Listen mode)", unspoken: true };
      return { label: "Not confirmed heard", detail: rec.deliveredWhileAway ? "Spoken while you were away" : "Spoken, but playback never finished", unspoken: true };
    }
    // Finished with something to say, but this tab never announced it.
    const st = agentState(agent);
    if (agent && ["completed", "exited", "failed", "blocked"].includes(st) && (agent.recent_output || (agent.pending_permissions || []).length)) {
      return { label: "Written, not spoken", detail: "Not announced in this tab", unspoken: true, approximate: true };
    }
    return null;
  }

  // ---------- rows ----------
  // Approximate where the ledger cannot tell (docs/work-view.md section 2):
  // the label then carries a "?".
  function requestedBy(ask, agent) {
    if (!ask) return agent?.role === "session" ? { kind: "system", approximate: false } : { kind: "jacob", approximate: true };
    if (ask.origin === "stream") return { kind: "prime_agent", approximate: true };
    if (ask.origin === "dispatch" && !ask.source_row_id) return { kind: "prime_agent", approximate: true };
    return { kind: "jacob", approximate: !ask.source_row_id };
  }

  function findAgent(agents, id) {
    if (!id) return null;
    return agents.find((a) => a.id === id || a.external_id === id) || null;
  }

  function ownerLabel(owner, agent) {
    if (!owner) return "Unassigned";
    if (owner.kind === "session_agent") return "Prime agent";
    if (owner.kind === "assistant") return "Assistant";
    if (owner.kind === "jacob") return "Jacob";
    if (owner.kind === "agent") return agent?.title || owner.label || owner.id || "Agent";
    return owner.label || owner.kind;
  }

  function rowState(askState, agent) {
    const st = agentState(agent);
    if (askState) {
      if (askState === "in_progress" && (st === "blocked" || st === "stuck")) return "blocked";
      if (askState === "in_progress" && st === "failed") return "failed";
      return askState === "in_progress" ? "working" : askState;
    }
    if (st === "blocked" || st === "stuck") return "blocked";
    if (st === "failed") return "failed";
    if (st === "running" || st === "starting") return "working";
    if (st === "completed" || st === "exited") return "done";
    return "open";
  }

  function lastLine(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    return lines[lines.length - 1] || "";
  }

  function blockerFor(ask, agent, receipt) {
    const perms = agent?.pending_permissions || [];
    if (perms.length) return `Waiting for permission: ${perms.map((p) => p.action || p.tool).filter(Boolean).join("; ") || "a request"}`;
    const stuck = agent && AgentsView ? AgentsView.stuckSummary(agent) : null;
    if (stuck) return stuck;
    if (ask && ["blocked", "failed"].includes(ask.state) && ask.remaining) return ask.remaining;
    if (receipt && ["blocked", "unknown", "failed"].includes(receipt.state)) return receipt.error || receipt.note || `Launch ${receipt.state}`;
    return "";
  }

  function buildRow({ ask, agent, receipt, speech, now }) {
    const state = rowState(ask?.state || null, agent);
    const blocker = (state === "blocked" || state === "failed") ? blockerFor(ask, agent, receipt) : "";
    let step = "";
    if (state === "working" && !blocker) {
      const remaining = String(ask?.remaining || "").trim();
      step = !PLACEHOLDER_STEPS.has(remaining) ? remaining : lastLine(agent?.recent_output) || "Working";
    }
    const resultText = ask?.evidence || (state === "done" || state === "failed" ? agent?.recent_output || "" : "");
    const updatedAt = Math.max(time(ask?.updated_at), agent && AgentsView ? AgentsView.activityAt(agent) : 0);
    const req = requestedBy(ask, agent);
    const key = agent ? `agent:${agent.id}` : null;
    return {
      id: ask ? ask.id : `agent:${agent.id}`,
      ask_id: ask?.id || null,
      agent_id: agent?.id || null,
      title: clip(ask?.text || agent?.title || agent?.id || "Untitled", LIMIT.title),
      requested_by: req.kind,
      requested_by_label: `${REQUESTER_LABEL[req.kind]}${req.approximate ? "?" : ""}`,
      // An agent with no ask owns itself: name what runs it, not its title again.
      owner: clip(ask ? ownerLabel(ask.owner, agent) : (AgentsView ? `${AgentsView.providerLabel(agent)} agent` : "Agent"), 60),
      host: agent?.host || null,
      state,
      state_label: STATE_LABEL[state] || state,
      ask_state: ask?.state || null,
      agent_state: agentState(agent),
      blocker: clip(blocker, LIMIT.blocker),
      current_step: clip(step, LIMIT.step),
      result: clip(resultText, LIMIT.result),
      result_full: clip(resultText, LIMIT.full),
      updated_at: updatedAt ? new Date(updatedAt).toISOString() : null,
      updated_ago: updatedAt ? agoLabel(now - updatedAt) : "",
      historic: ["blocked", "failed", "done"].includes(state) && updatedAt > 0 && now - updatedAt > HISTORIC_MS,
      stale: Boolean(agent?.stale),
      source_row_id: ask?.source_row_id || null,
      deep_link: agent?.deep_link || null,
      wit_url: ask?.wit_url || null,
      speech: speechLabel(key, speech, agent),
    };
  }

  function deriveRows({ checklist, agents, speech = null, sessionId, now = Date.now() } = {}) {
    // Planning ideas (state "planning") are saved, not actionable: never a work row.
    const asks = (checklist?.asks || []).filter((a) => (a.kind || "ask") === "ask" && a.state !== "planning");
    const pool = [...(agents || [])];
    for (const t of checklist?.threads || []) if (!findAgent(pool, t.id)) pool.push(t);
    const receipts = checklist?.dispatches || [];
    const owned = new Set();
    const rows = asks.map((ask) => {
      const agent = ask.owner && ask.owner.kind !== "assistant" && ask.owner.kind !== "jacob"
        ? findAgent(pool, ask.owner.id) || findAgent(pool, ask.owner.external_id) : null;
      if (agent) owned.add(agent.id);
      const receipt = receipts.find((r) => r.ask_id === ask.id) || null;
      return buildRow({ ask, agent, receipt, speech, now });
    });
    const inConv = (a) => (AgentsView ? AgentsView.inConversation(a, sessionId) : a.session_id === sessionId);
    for (const agent of pool) {
      if (owned.has(agent.id) || !inConv(agent)) continue;
      if (agent.role === "session" || agent.role === "session_agent") continue; // the prime agent is an owner, not a request
      owned.add(agent.id);
      rows.push(buildRow({ ask: null, agent, receipt: null, speech, now }));
    }
    return sortRows(rows);
  }

  function rank(row) {
    if (row.state === "blocked") return 0;
    if (row.state === "failed") return 1;
    if (row.speech?.unspoken) return 2;
    if (row.state === "working") return 3;
    if (row.state === "open") return 4;
    return 5;
  }
  function sortRows(rows) {
    return [...(rows || [])].sort((a, b) => rank(a) - rank(b) || time(b.updated_at) - time(a.updated_at) || String(a.id).localeCompare(String(b.id)));
  }
  // Finished (done, or historic) rows collapse unless "Show finished" is on.
  function splitFinished(rows, showFinished = false) {
    if (showFinished) return { current: rows, finished: [] };
    const finished = (r) => (r.state === "done" || r.historic) && !r.speech?.unspoken;
    return { current: rows.filter((r) => !finished(r)), finished: rows.filter(finished) };
  }

  function counts(rows) {
    const live = (rows || []).filter((r) => !r.historic);
    return {
      blocked: live.filter((r) => r.state === "blocked" || r.state === "failed").length,
      unspoken: (rows || []).filter((r) => r.speech?.unspoken).length,
      working: live.filter((r) => r.state === "working").length,
      playing: (rows || []).filter((r) => r.speech?.label === "Playing" || r.speech?.label === "Generating"),
    };
  }
  function headerLine(rows) {
    const c = counts(rows);
    const parts = [c.blocked ? `${c.blocked} blocked` : "", c.unspoken ? `${c.unspoken} not spoken` : "", c.working ? `${c.working} working` : ""].filter(Boolean);
    return parts.length ? parts.join(" · ") : "Nothing in progress";
  }

  // ---------- voice answers ----------
  const sentence = (s) => { const t = String(s || "").trim().replace(/[.…\s]+$/, ""); return t ? `${t}.` : ""; };
  const short = (s, n) => clip(s, n).replace(/[.…\s]+$/, "");
  const NUM = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  const num = (n) => NUM[n] || String(n);

  function item(r) {
    return { id: r.id, title: r.title, state: r.state, owner: r.owner, requested_by: r.requested_by_label, blocker: r.blocker || null, step: r.current_step || null, result: r.result || null, speech: r.speech?.label || null, agent_id: r.agent_id, ask_id: r.ask_id, updated_ago: r.updated_ago };
  }

  function answer(action, { rows = [], checklistSessionId, sessionId } = {}) {
    if (sessionId !== undefined && (!sessionId || checklistSessionId !== sessionId)) {
      return { ok: false, action, error: "Work status is still loading for this conversation.", say: "Work status is still loading." };
    }
    const all = rows || [];
    let items = [];
    let say = "";
    if (action === "blocked") {
      const blocked = all.filter((r) => r.state === "blocked" || r.state === "failed");
      const current = blocked.filter((r) => !r.historic);
      const list = current.length ? current : blocked;
      const old = !current.length && blocked.length;
      items = list.map(item);
      const when = (r) => (old && r.updated_ago ? ` (from ${r.updated_ago})` : "");
      if (!list.length) say = "Nothing is blocked.";
      else if (list.length === 1) say = `One blocked: ${short(list[0].title, 60)}${when(list[0])}. ${sentence(short(list[0].blocker || list[0].state_label, 90))}`;
      else {
        const head = list.slice(0, 3).map((r) => `${short(r.title, 50)}${when(r)}: ${short(r.blocker || r.state_label, 60)}`).join("; ");
        say = `${num(list.length)} blocked. ${head}.${list.length > 3 ? ` And ${list.length - 3} more.` : ""}`;
      }
    } else if (action === "unspoken") {
      const list = all.filter((r) => r.speech?.unspoken);
      items = list.map(item);
      if (!list.length) say = "Everything was spoken.";
      else {
        const head = list.slice(0, 2).map((r) => `${short(r.title, 50)}: ${short(r.result || r.blocker || r.speech.label, 90)}`).join("; ");
        say = `${num(list.length)} result${list.length === 1 ? "" : "s"} not spoken. ${head}.${list.length > 2 ? ` And ${list.length - 2} more.` : ""}`;
      }
    } else if (action === "status") {
      const c = counts(all);
      items = all.filter((r) => !r.historic && r.state !== "done").map(item);
      const parts = [c.working ? `${c.working} working` : "", c.blocked ? `${c.blocked} blocked` : "", c.unspoken ? `${c.unspoken} not spoken` : ""].filter(Boolean);
      say = parts.length ? `${parts.join(", ")}.` : "Nothing in progress.";
      say = say.charAt(0).toUpperCase() + say.slice(1);
      if (c.playing.length) say += ` Reading ${short(c.playing[0].title, 60)} now.`;
    } else {
      return { ok: false, error: `Unknown work_view action ${action}` };
    }
    return { ok: true, action, count: items.length, items, say, note: "Answer with the say field; the full items are for follow-up questions only." };
  }

  root.VA3WorkView = {
    KEYS, LIMIT, STATE_LABEL, UNSPOKEN, loadPrefs, savePref, agoLabel, speechLabel, deriveRows, sortRows, splitFinished, counts, headerLine, answer,
  };
})(typeof window !== "undefined" ? window : globalThis);
