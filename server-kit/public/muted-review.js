// Review what the assistant said since the mic was muted.
//
// Mute changes are recorded in the conversation as system rows with
// metadata.event === "mic_state" (server/transcripts.js recordMicState). Older
// conversations only have the voice model's set_microphone tool call, so that
// is accepted as a fallback marker. The result is the assistant's own words
// (its transcript text), never a replay of the user's audio: while muted the
// model hears nothing, so there is no user audio to replay.
//
// Pure functions; loaded as a classic script in the browser
// (window.VA3MutedReview), imported by the server and the node tests
// (globalThis.VA3MutedReview).
(() => {
  const MIC_EVENT = "mic_state";
  const DEFAULT_LIMIT = 10;
  const MAX_LIMIT = 50;

  // { muted: boolean } for a row that changes mic state, else null.
  function micChange(row, { legacy = true } = {}) {
    if (!row || typeof row !== "object") return null;
    const meta = row.metadata || {};
    if (row.role === "system" && meta.event === MIC_EVENT && typeof meta.muted === "boolean") {
      return { muted: meta.muted, source: meta.source || null };
    }
    // Legacy marker: "⚙ set_microphone({"muted":true})" written by the tool log.
    if (legacy && row.role === "tool" && typeof row.text === "string" && row.text.startsWith("⚙ set_microphone(")) {
      const m = row.text.match(/"muted"\s*:\s*(true|false)/);
      if (m) return { muted: m[1] === "true", source: "voice" };
    }
    return null;
  }

  function clampLimit(limit) {
    const n = Math.floor(Number(limit));
    if (!Number.isFinite(n) || n < 1) return DEFAULT_LIMIT;
    return Math.min(n, MAX_LIMIT);
  }

  // rows: transcript rows in file order ({ id, ts, role, text, metadata }).
  // Returns the assistant's replies since the most recent mute (and, if the
  // mic was later unmuted, up to the present), newest last.
  function selectSinceMute(rows, { limit, duringMuteOnly = false, offset = 0, row: selectedRow } = {}) {
    const list = Array.isArray(rows) ? rows : [];
    const max = clampLimit(limit);
    const firstSystemMarker = list.findIndex((row) => micChange(row, { legacy: false }));
    let muteIndex = -1;
    let unmuteIndex = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      const change = micChange(list[i], { legacy: firstSystemMarker === -1 || i < firstSystemMarker });
      if (!change) continue;
      if (change.muted) { muteIndex = i; break; }
      if (unmuteIndex === -1) unmuteIndex = i;
    }
    const start = muteIndex === -1 ? 0 : muteIndex + 1;
    const overlapIds = new Set(Array.isArray(list[muteIndex]?.metadata?.overlapping_row_ids) ? list[muteIndex].metadata.overlapping_row_ids : []);
    const replies = [];
    let userRows = 0;
    let mutedResponseCount = 0;
    for (let i = 0; i < list.length; i++) {
      const row = list[i];
      const priorOverlap = i < start && overlapIds.has(row?.id);
      if (i < start && !priorOverlap) continue;
      if (row?.role === "user") userRows++;
      if (row?.role !== "assistant") continue;
      const text = String(row.text || "").trim();
      if (!text) continue;
      const selectedPeriod = list[muteIndex]?.metadata?.mute_period_id;
      const responsePeriod = row.metadata?.mute_period_id;
      const overlapping = typeof row.metadata?.muted_during === "boolean" ? row.metadata.muted_during : row.metadata?.muted_at_start;
      const duringMute = priorOverlap || (muteIndex !== -1 && (selectedPeriod && responsePeriod
        ? selectedPeriod === responsePeriod && overlapping === true
        : typeof overlapping === "boolean"
        ? overlapping
        : (unmuteIndex === -1 || i < unmuteIndex)));
      if (duringMute) mutedResponseCount++;
      replies.push({
        id: row.id || null,
        row: i + 1,
        ts: row.ts || null,
        speaker: "assistant",
        text,
        during_mute: duringMute,
      });
    }
    const selected = replies.filter((row) => (!duringMuteOnly || row.during_mute) && (selectedRow == null || row.row === selectedRow));
    const total = selected.length;
    const pageOffset = Math.min(Number.isSafeInteger(Number(offset)) && Number(offset) >= 0 ? Number(offset) : 0, total);
    const end = total - pageOffset;
    const page = duringMuteOnly ? selected.slice(pageOffset, pageOffset + max) : selected.slice(Math.max(0, end - max), end);
    const muteRow = muteIndex === -1 ? null : list[muteIndex];
    return {
      found_mute: muteIndex !== -1,
      muted_at: muteRow?.ts || null,
      unmuted_at: unmuteIndex === -1 ? null : list[unmuteIndex]?.ts || null,
      still_muted: muteIndex !== -1 && unmuteIndex === -1,
      total_responses: total,
      muted_response_count: mutedResponseCount,
      truncated: total > max,
      user_rows_since: userRows,
      responses: page,
      offset: pageOffset,
      has_more: pageOffset + page.length < total,
      ...(duringMuteOnly ? { during_mute_only: true } : {}),
      note: muteIndex === -1
        ? "No mute found in this conversation; these are the assistant's most recent replies."
        : "These are the assistant's own words from the transcript, not a recording of your audio.",
    };
  }

  // Display model for the review panel: heading, count line and rows.
  function view(result, { now = Date.now() } = {}) {
    const r = result || { responses: [], total_responses: 0 };
    const count = r.total_responses || 0;
    const since = r.muted_at ? formatTime(r.muted_at) : null;
    const heading = r.during_mute_only ? "Assistant replies while muted" : r.found_mute ? "Assistant replies since you muted" : "Recent assistant replies";
    const summary = count === 0
      ? (r.found_mute ? `Nothing said since you muted${since ? ` at ${since}` : ""}.` : "The assistant hasn't said anything yet.")
      : r.during_mute_only
        ? `${count} ${count === 1 ? "reply" : "replies"} while muted (showing ${r.offset + 1}–${r.offset + r.responses.length}).`
        : `${count} ${count === 1 ? "reply" : "replies"}${since ? ` since ${since}` : ""}${r.truncated ? (r.offset ? ` (showing ${count - r.offset - r.responses.length + 1}–${count - r.offset})` : ` (showing the last ${r.responses.length})`) : ""}.`;
    return {
      heading,
      summary,
      disclaimer: "Assistant output only, from the transcript. Your microphone audio is not recorded or replayed.",
      rows: (r.responses || []).map((x) => ({
        label: x.during_mute ? "Assistant · while muted" : "Assistant",
        time: x.ts ? formatTime(x.ts) : "",
        text: x.text,
      })),
      empty: count === 0,
      age_ms: r.muted_at ? Math.max(0, now - Date.parse(r.muted_at)) : null,
    };
  }

  // The unmute chip: offered only when the assistant spoke while muted.
  function unmuteChip(result) {
    const n = result?.muted_response_count || 0;
    if (!result?.found_mute || n === 0) return null;
    return { count: n, text: `${n} ${n === 1 ? "reply" : "replies"} while muted — Review` };
  }

  function clearDialog(list, summary) {
    list.replaceChildren();
    summary.textContent = "";
  }

  function formatTime(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    // Tracked display zone (Pacific by default) when the page has loaded
    // public/time-format.js; the server and bare tests fall back to local.
    const T = globalThis.VA3Time;
    if (T) return T.formatClock(d, { timeZone: globalThis.VA3TimePrefs?.().time_zone ?? T.DEFAULT_TIME_ZONE, zone: false });
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  function responseStart(owner, id, muted, sessionId, generation, mutePeriodId = null) {
    if (!id) return null;
    owner.responses ||= new Map();
    if (!owner.responses.has(id)) owner.responses.set(id, { muted_at_start: !!muted, muted_during: !!muted, mute_period_id: muted ? mutePeriodId : null, sessionId, generation });
    return owner.responses.get(id);
  }

  function responseBegin(owner, id, muted, sessionId, generation, mutePeriodId = null) {
    owner.responses?.clear();
    return responseStart(owner, id, muted, sessionId, generation, mutePeriodId);
  }

  function playbackStopped(owner, responseActive) {
    if (!responseActive) owner.responses?.clear();
  }

  function responseMuted(owner, sessionId, generation, mutePeriodId) {
    for (const response of owner.responses?.values() || []) {
      if (response.sessionId !== sessionId) continue;
      response.muted_during = true;
      response.mute_period_id = mutePeriodId;
      response.generation = generation;
    }
  }

  function applyTranscriptEntry(state, sessionId, entry, key) {
    if (sessionId !== state.transcriptSessionId) return false;
    // A duplicate write returns the existing row; keep one copy.
    if (!state.transcriptEntries.some((row) => row.id === entry?.id)) state.transcriptEntries.push(entry);
    const el = key ? state.messages.get(key) : null;
    if (el && entry?.id) el.dataset.rowId = entry.id;
    return true;
  }

  function enqueueWrite(owner, write) {
    const pending = (owner.chain || Promise.resolve()).then(write);
    owner.chain = pending.catch(() => {});
    return pending;
  }

  async function retryWrite(write, onFailure) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await write();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response;
      } catch (error) {
        onFailure(error);
        if (attempt === 1) throw error;
      }
    }
  }

  const api = { applyTranscriptEntry, responseStart, responseBegin, playbackStopped, responseMuted, retryWrite, enqueueWrite, clearDialog, MIC_EVENT, DEFAULT_LIMIT, MAX_LIMIT, micChange, selectSinceMute, view, unmuteChip };
  globalThis.VA3MutedReview = api;
})();
