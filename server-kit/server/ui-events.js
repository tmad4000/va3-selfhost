// Server -> browser UI events over Server-Sent Events (GET /api/events).
// Used for things the server decides the screen should do (open a panel) and
// for "something changed, refresh" nudges (the ask ledger). Events are scoped
// to a conversation when they carry session_id; unscoped events reach every
// open tab. A short in-memory backlog lets a reconnecting tab catch up via
// Last-Event-ID. Nothing here is durable or security-relevant: the API guard
// in index.js still decides who may connect.

const clients = new Set(); // { res, sessionId }
const backlog = [];
const BACKLOG = 50;
let seq = 0;

function write(res, event) {
  res.write(`id: ${event.id}\nevent: ui\ndata: ${JSON.stringify(event)}\n\n`);
}

function matches(client, event) {
  return !event.session_id || !client.sessionId || client.sessionId === event.session_id;
}

export function publishUi(event) {
  const full = {
    id: `ui-${Date.now().toString(36)}-${(++seq).toString(36)}`,
    ts: new Date().toISOString(),
    ...event,
  };
  backlog.push(full);
  if (backlog.length > BACKLOG) backlog.shift();
  for (const client of clients) {
    if (!matches(client, full)) continue;
    try { write(client.res, full); } catch { clients.delete(client); }
  }
  return full;
}

export function recentUiEvents({ sessionId, after } = {}) {
  const start = after ? backlog.findIndex((e) => e.id === after) + 1 : 0;
  return backlog.slice(Math.max(0, start)).filter((e) => matches({ sessionId }, e));
}

// Open tabs that would receive an event for this conversation (all tabs when
// no conversation is given).
export function uiClientCount({ sessionId } = {}) {
  if (!sessionId) return clients.size;
  return [...clients].filter((c) => c.sessionId === sessionId).length;
}

export function handleUiEvents(req, res, url) {
  const client = { res, sessionId: String(url.searchParams.get("session_id") || "") || null };
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const lastId = req.headers["last-event-id"];
  if (lastId) for (const event of recentUiEvents({ sessionId: client.sessionId, after: String(lastId) })) write(res, event);
  clients.add(client);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* closed */ } }, 20_000);
  ping.unref();
  req.on("close", () => { clearInterval(ping); clients.delete(client); });
}
