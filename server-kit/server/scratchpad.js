// Markdown storage format shared by all scratchpad writes. Unknown/legacy text
// is retained as undated entries; never invent capture times for old notes.
const ENTRY = /^- (?:\[x\] )?\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]·]+) · ([^\]\n]+?)(?: · topic: ("(?:\\.|[^"\\])*"))?\] (.*)$/;
const RESOLVED = / <!-- resolved: (\d{4}-\d{2}-\d{2} \d{2}:\d{2} [^>]+) -->$/;

export function parseScratchpad(content) {
  const source = String(content ?? "").replace(/\r\n/g, "\n");
  const sections = source.match(/^## Thread\n([\s\S]*?)\n## Entries(?:\n|$)([\s\S]*)$/);
  if (!sections) return { thread: "", entries: source.trim() ? [{ text: source.trimEnd(), legacy: true }] : [] };
  const entries = [];
  let unknown = [];
  function flush() {
    const text = unknown.join("\n").replace(/^\n+|\n+$/g, "");
    if (text.trim()) entries.push({ text, legacy: true });
    unknown = [];
  }
  for (const line of sections[2].split("\n")) {
    const match = line.match(ENTRY);
    const resolved = line.startsWith("- [x] ") && match?.[4].match(RESOLVED);
    // Retain malformed checkboxes rather than silently treating them as active.
    if (!match || (line.startsWith("- [x] ") && !resolved)) { unknown.push(line); continue; }
    flush();
    let topic = null;
    try { topic = match[3] ? JSON.parse(match[3]) : null; } catch { unknown.push(line); continue; }
    entries.push({
      timestamp: match[1], session: match[2], topic,
      text: resolved ? match[4].slice(0, -resolved[0].length) : match[4],
      resolvedAt: resolved ? resolved[1] : null,
    });
  }
  flush();
  return { thread: sections[1].trim(), entries };
}

export function serializeEntry(entry) {
  if (entry.legacy) return entry.text;
  return `- ${entry.resolvedAt ? "[x] " : ""}[${entry.timestamp} · ${entry.session}${entry.topic ? ` · topic: ${JSON.stringify(entry.topic)}` : ""}] ${entry.text}${entry.resolvedAt ? ` <!-- resolved: ${entry.resolvedAt} -->` : ""}`;
}

export function serializeScratchpad({ thread = "", entries = [] }) {
  return `## Thread\n\n${thread.trim()}\n\n## Entries\n\n${entries.map(serializeEntry).join("\n")}\n`;
}

// Stamped in the tracked display zone (memory.js passes displayTimeZone();
// Pacific when omitted), with its date-specific DST name (PDT/PST).
// Kept free of server imports: tests load this module before setting DATA_DIR.
export function scratchpadTimestamp(date = new Date(), timeZone = "America/Los_Angeles") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    hourCycle: "h23", timeZoneName: "short",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")} ${value("timeZoneName")}`;
}

export function scratchpadContext(content) {
  const pad = parseScratchpad(content);
  // Bounds apply to both count and text, even after unrestricted manual edits.
  const entries = pad.entries.filter((entry) => !entry.resolvedAt).slice(-30)
    .map((entry) => serializeEntry({
      ...entry, text: entry.text.slice(0, 1_000), timestamp: entry.timestamp?.slice(0, 40),
      session: entry.session?.slice(0, 120), topic: entry.topic?.slice(0, 120),
    }).slice(0, 1_200));
  return `## Thread\n\n${pad.thread.slice(0, 4_000)}\n\n## Entries\n\n${entries.join("\n")}`;
}
