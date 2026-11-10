// Model-facing checklist projection only. Full server/UI records and all
// other tool results remain untouched. Shared by browser and Drive senders.
(() => {
  const VERSION = "list_asks.v1";
  const MAX_BYTES = 8192;
  const encoder = new TextEncoder();
  const bytes = (value) => encoder.encode(typeof value === "string" ? value : JSON.stringify(value)).length;
  const VIEWS = ["active", "recent", "all", "planning", "threads", "dispatches"];
  const FIELDS = ["record_json", "text", "evidence", "remaining"];
  const STATES = ["open", "in_progress", "blocked", "failed", "done", "planning"];
  // Mirrors server/asks.js isActionable; parity is covered by executable tests.
  const isActionable = (ask) => ["open", "in_progress", "blocked", "failed"].includes(ask?.state);
  const string = (value) => typeof value === "string" ? value : "";
  const number = (v, fallback, max) => Number.isSafeInteger(v) && v >= 0 ? Math.min(v, max) : fallback;
  const queryKeys = ["view", "offset", "limit", "id", "field", "detail_offset"];
  const hasQuery = (args = {}) => queryKeys.some((key) => args[key] !== undefined);
  function query(args = {}) {
    if (args.view !== undefined && !VIEWS.includes(args.view)) throw new Error(`view must be ${VIEWS.join(", ")}`);
    if (args.field !== undefined && !FIELDS.includes(args.field)) throw new Error(`field must be ${FIELDS.join(", ")}`);
    for (const key of ["offset", "limit", "detail_offset"]) {
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 0 || (key === "limit" && args[key] === 0))) throw new Error(`${key} must be a ${key === "limit" ? "positive" : "nonnegative"} integer`);
    }
    if (args.id !== undefined && (typeof args.id !== "string" || !args.id || args.id.length > 200)) throw new Error("id must be an ask id of at most 200 characters");
    return { view: args.view || "active", offset: number(args.offset, 0, Number.MAX_SAFE_INTEGER), limit: number(args.limit, 8, 12), id: args.id, field: args.field || "record_json", detail_offset: number(args.detail_offset, 0, Number.MAX_SAFE_INTEGER) };
  }
  function clipped(out, key, value, limit, truncated) {
    if (value === undefined || value === null) return;
    const text = String(value);
    out[key] = text.slice(0, limit);
    if (text.length > limit) truncated.push(key);
  }
  function askSummary(row, tight = false) {
    const out = {}, truncated = [];
    for (const [key, limit] of [["id", 200], ["kind", 24], ["state", 24], ["text", 220], ["evidence", 180], ["remaining", 180], ["updated_at", 40], ["updated_ago", 40], ["wit_url", 300]]) clipped(out, key, row[key], tight && ["text", "evidence", "remaining", "wit_url"].includes(key) ? 64 : limit, truncated);
    out.actionable = isActionable(row);
    out.historic = row.historic === true;
    out.owner = null;
    if (row.owner && typeof row.owner === "object") {
      out.owner = {};
      for (const [key, limit] of [["id", 200], ["kind", 30], ["label", 80]]) {
        const marks = []; clipped(out.owner, key, row.owner[key], limit, marks);
        truncated.push(...marks.map((name) => `owner.${name}`));
      }
    }
    if (truncated.length) out.truncated_fields = truncated;
    return out;
  }
  function smallSummary(row, view) {
    const out = {}, truncated = [];
    const fields = view === "threads" ? ["id", "title", "state", "provider", "model", "mode", "host"] : ["receipt_id", "title", "state", "agent_id", "ask_id", "created_at", "error"];
    for (const key of fields) clipped(out, key, row[key], key === "title" || key === "error" ? 180 : 120, truncated);
    if (truncated.length) out.truncated_fields = truncated;
    return out;
  }
  const byRecent = (a, b) => string(b.updated_at || b.created_at).localeCompare(string(a.updated_at || a.created_at)) || string(a.id || a.receipt_id).localeCompare(string(b.id || b.receipt_id));

  function project(name, value, args = {}) {
    if (name !== "list_asks" || !value || typeof value !== "object" || value.ok === false) return value;
    const envelope = value.result && typeof value.result === "object" && !Array.isArray(value.result);
    const source = envelope ? value.result : value;
    if (source.ok === false || !Array.isArray(source.asks)) return value;
    // Explicit server query results have already been projected. The model
    // boundary still checks the complete envelope budget before accepting it.
    if (source.voice_projection === VERSION && bytes(value) <= MAX_BYTES) return value;
    const wrap = (result) => envelope ? { ...value, result } : result;
    const budget = envelope ? MAX_BYTES : MAX_BYTES - 128; // room for the HTTP ok/result/replay envelope
    let q;
    try { q = query(args); } catch (error) { return wrap({ ok: false, error: error.message, voice_projection: VERSION }); }
    const asks = source.asks;
    const threads = Array.isArray(source.threads) ? source.threads : [];
    const dispatches = Array.isArray(source.dispatches) ? source.dispatches : [];
    const counts = Object.fromEntries(STATES.map((state) => [state, 0]));
    for (const row of asks) { if (Object.hasOwn(counts, row.state)) counts[row.state]++; }
    const base = {
      voice_projection: VERSION, total_asks: asks.length, counts,
      actionable: asks.filter(isActionable).length,
      current_actionable: asks.filter((row) => isActionable(row) && !row.historic).length,
      threads_total: threads.length, dispatches_total: dispatches.length,
      threads_as_of: string(source.threads_as_of).slice(0, 40) || null,
      threads_stale: source.threads_stale === true,
      paseo: string(source.paseo).slice(0, 40) || null,
      note: "Planning is not actionable. Historic failures/completions are not new updates; never retry them automatically. Missing ownership is unknown, not completion. Full records remain in the checklist.",
    };
    if (q.id) {
      const ask = asks.find((row) => row.id === q.id);
      if (!ask) return wrap({ ...base, ok: false, error: "Ask not found in this conversation", id: q.id, asks: [] });
      const text = q.field === "record_json" ? JSON.stringify(ask) : string(ask[q.field]);
      const offset = Math.min(q.detail_offset, text.length);
      const out = { ...base, asks: [], detail: { id: q.id, field: q.field, encoding: q.field === "record_json" ? "json_text_chunk" : "text", offset, total_chars: text.length, text: "", next_offset: null, truncated: false }, retrieve: "Call list_asks with the same id/field and detail_offset=next_offset to continue. Concatenate chunks to recover the exact field (JSON.parse record_json after all chunks). Offsets are JavaScript string positions. Chunks assume an unchanged record; record_json includes time-sensitive updated_ago/historic. Prefer text/evidence/remaining for stable prose." };
      let low = 0, high = Math.min(4000, text.length - offset);
      while (low < high) {
        const n = Math.ceil((low + high) / 2);
        out.detail.text = text.slice(offset, offset + n);
        out.detail.next_offset = offset + n < text.length ? offset + n : null;
        out.detail.truncated = out.detail.next_offset !== null;
        if (bytes(wrap(out)) <= budget) low = n; else high = n - 1;
      }
      out.detail.text = text.slice(offset, offset + low);
      out.detail.next_offset = offset + low < text.length ? offset + low : null;
      out.detail.truncated = out.detail.next_offset !== null;
      return wrap(out);
    }
    let rows, key;
    if (q.view === "threads") { rows = [...threads]; key = "threads"; }
    else if (q.view === "dispatches") { rows = [...dispatches]; key = "dispatches"; }
    else {
      key = "asks";
      rows = asks.filter((row) => q.view === "all" || (q.view === "planning" ? row.state === "planning" : q.view === "active" ? isActionable(row) && !row.historic : row.state !== "planning"));
    }
    rows.sort(byRecent);
    const offset = Math.min(q.offset, rows.length);
    const out = { ...base, view: q.view, offset, limit: q.limit, matched: rows.length, returned: 0, next_offset: null, omitted: rows.length - offset, filtered_out: (key === "asks" ? asks.length : rows.length) - rows.length, asks: [], ...(key !== "asks" ? { [key]: [] } : {}), truncated: false, retrieve: "Use view=all|planning|recent|threads|dispatches and offset=next_offset for more rows. For an ask's exact text/evidence/remaining/full record, call list_asks with id and field=text|evidence|remaining|record_json; continue with detail_offset=next_offset. Page offsets assume the checklist has not changed." };
    const refresh = () => {
      out.returned = out[key].length;
      out.next_offset = offset + out.returned < rows.length ? offset + out.returned : null;
      out.omitted = rows.length - out.returned;
      out.truncated = out.omitted > 0 || out[key].some((row) => row.truncated_fields?.length);
    };
    for (const row of rows.slice(offset, offset + q.limit)) {
      out[key].push(key === "asks" ? askSummary(row) : smallSummary(row, q.view));
      refresh();
      if (bytes(wrap(out)) > budget) {
        out[key].pop();
        if (!out[key].length && key === "asks") out[key].push(askSummary(row, true));
        refresh();
        break;
      }
    }
    refresh();
    return wrap(out);
  }
  function serialize(name, value, args = {}) { return JSON.stringify(project(name, value, args)); }
  globalThis.VA3VoiceToolResults = { MAX_BYTES, VERSION, VIEWS, FIELDS, bytes, isActionable, hasQuery, query, project, serialize };
})();
