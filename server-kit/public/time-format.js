// Time display (Jacob, 2026-11-08): every user-facing time is shown in one
// tracked zone, Pacific by default, with the abbreviation the date really has
// (PDT in summer, PST in winter: Intl applies the DST rules for that instant,
// never the current offset), and recent status times read as "12 minutes ago".
//
// The zone and the relative toggle are server-owned settings
// (time_display in server/settings.js); this file holds only the pure
// formatting the page, the server and the node tests share.
//
// Pure functions; loaded as a classic script in the browser
// (window.VA3Time) and imported by the server and node tests
// (globalThis.VA3Time).
(() => {
  const DEFAULT_TIME_ZONE = "America/Los_Angeles";
  // "local" = the viewer's own zone (the browser's; on the server, the host's).
  const LOCAL = "local";
  // Relative labels are used for times newer than this; older ones read as
  // an absolute date and time ("Nov 6, 4:05 AM PST").
  const RELATIVE_MAX_MS = 24 * 3_600_000;
  const formatters = new Map();

  function validTimeZone(zone) {
    if (zone === LOCAL) return true;
    if (typeof zone !== "string" || !zone.trim()) return false;
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
  }

  // Settings value -> an Intl timeZone (undefined = the runtime's own zone).
  function resolveZone(zone) {
    if (zone === LOCAL) return undefined;
    return validTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
  }

  function toDate(value) {
    if (value === null || value === undefined || value === "") return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function parts(date, zone, options) {
    const tz = resolveZone(zone);
    const key = `${tz || ""}|${JSON.stringify(options)}`;
    let f = formatters.get(key);
    if (!f) { f = new Intl.DateTimeFormat("en-US", { ...options, timeZone: tz }); formatters.set(key, f); }
    return Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  }

  // "PDT" / "PST" for Pacific (and EDT/CST/... for other US zones). Zones
  // without an English abbreviation come back as "GMT+1".
  function zoneAbbreviation(value, zone = DEFAULT_TIME_ZONE) {
    const date = toDate(value);
    return date ? parts(date, zone, { timeZoneName: "short" }).timeZoneName : "";
  }

  // The zone's UTC offset at that instant, e.g. "-07:00" (PDT) or "-08:00".
  function utcOffset(value, zone = DEFAULT_TIME_ZONE) {
    const date = toDate(value);
    if (!date) return "";
    const p = parts(date, zone, { hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    const min = Math.round((wall - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
    const sign = min < 0 ? "-" : "+";
    const abs = Math.abs(min);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  }

  // "3:05 PM PDT" (zone: false drops the abbreviation for dense lists).
  function formatClock(value, { timeZone = DEFAULT_TIME_ZONE, zone = true } = {}) {
    const date = toDate(value);
    if (!date) return "";
    const p = parts(date, timeZone, { hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short" });
    return `${p.hour}:${p.minute} ${p.dayPeriod}${zone ? ` ${p.timeZoneName}` : ""}`;
  }

  function dayKey(date, timeZone) {
    const p = parts(date, timeZone, { year: "numeric", month: "2-digit", day: "2-digit" });
    return `${p.year}-${p.month}-${p.day}`;
  }

  // "Nov 6" (with the year when it differs from now's year in that zone).
  function formatDay(value, { timeZone = DEFAULT_TIME_ZONE, now = Date.now() } = {}) {
    const date = toDate(value);
    if (!date) return "";
    const p = parts(date, timeZone, { year: "numeric", month: "short", day: "numeric" });
    const thisYear = parts(new Date(now), timeZone, { year: "numeric" }).year;
    return `${p.month} ${p.day}${p.year !== thisYear ? `, ${p.year}` : ""}`;
  }

  // "Nov 6, 4:05 AM PST": the date the instant falls on in the tracked zone.
  function formatDateTime(value, { timeZone = DEFAULT_TIME_ZONE, now = Date.now(), zone = true } = {}) {
    const date = toDate(value);
    if (!date) return "";
    return `${formatDay(date, { timeZone, now })}, ${formatClock(date, { timeZone, zone })}`;
  }

  // "just now", "1 minute ago", "12 minutes ago", "3 hours ago",
  // "2 days ago"; future instants read "in 5 minutes". Null past
  // maxMs, so the caller shows an absolute time instead.
  function formatRelative(value, { now = Date.now(), maxMs = Infinity } = {}) {
    const date = toDate(value);
    if (!date) return null;
    const diff = Number(now) - date.getTime();
    const abs = Math.abs(diff);
    if (abs > maxMs) return null;
    if (abs < 45_000) return "just now";
    const unit = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
    let label;
    const min = Math.round(abs / 60_000);
    if (min < 60) label = unit(Math.max(1, min), "minute");
    else {
      const h = Math.round(abs / 3_600_000);
      label = h < 24 ? unit(h, "hour") : unit(Math.round(abs / 86_400_000), "day");
    }
    return diff >= 0 ? `${label} ago` : `in ${label}`;
  }

  // The label for a user-facing status time: relative when recent and
  // enabled, otherwise absolute in the tracked zone. Same-day absolute times
  // drop the date. `title` is always the full absolute form for a tooltip.
  function formatStatusTime(value, { timeZone = DEFAULT_TIME_ZONE, relative = true, now = Date.now(), relativeMaxMs = RELATIVE_MAX_MS } = {}) {
    const date = toDate(value);
    if (!date) return { text: "", title: "", relative: false };
    const title = formatDateTime(date, { timeZone, now });
    const rel = relative ? formatRelative(date, { now, maxMs: relativeMaxMs }) : null;
    if (rel) return { text: rel, title, relative: true };
    const sameDay = dayKey(date, timeZone) === dayKey(new Date(now), timeZone);
    return { text: sameDay ? formatClock(date, { timeZone }) : title, title, relative: false };
  }

  // Normalize a stored/partial time_display setting.
  function normalizeTimeDisplay(value) {
    const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    return {
      time_zone: validTimeZone(v.time_zone) ? v.time_zone : DEFAULT_TIME_ZONE,
      relative: v.relative !== false,
    };
  }

  const api = {
    DEFAULT_TIME_ZONE, LOCAL, RELATIVE_MAX_MS, validTimeZone, resolveZone, zoneAbbreviation, utcOffset,
    formatClock, formatDay, formatDateTime, formatRelative, formatStatusTime, normalizeTimeDisplay,
  };
  globalThis.VA3Time = api;
})();
