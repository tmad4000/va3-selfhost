// Secret masking for text shown in the Work view and sent to the voice model
// (docs/work-view.md section 6). Replaces credentials with "[redacted:<kind>]";
// never keeps a prefix or the last characters. Idempotent. Mask before you
// clip, so a cut-off token can never escape a pattern.
//
// Pure functions; loaded as a classic script in the browser
// (window.VA3Mask), imported by the server and the node tests
// (globalThis.VA3Mask).
(() => {
  const KV_NAMES = "password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|authorization|auth|x-api-key|cookie";
  const RULES = [
    ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
    // Bearer before JWT: "Bearer <jwt>" is one secret, one replacement.
    ["bearer", /\b(Bearer|Basic)\s+(?!\[redacted:)[A-Za-z0-9._~+/=-]{16,}/g, (_m, scheme) => `${scheme} [redacted:bearer]`],
    // key=value before the bare-key rules, so the variable name survives.
    // Header form: "Authorization: Bearer [redacted:bearer]" is already masked.
    ["value", new RegExp(`(^|[^A-Za-z0-9_-])((?:[A-Za-z0-9]+[_-])*(?:${KV_NAMES})(?:[_-][A-Za-z0-9]+)*)(["']?\\s*[:=]\\s*)(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|((?!\\[redacted:)(?!(?:Bearer|Basic)\\s)[^\\s"'&;,]{4,}))`, "gi"),
      (m, lead, name, sep, double, single) => {
        const value = double ?? single;
        if (value === undefined) return `${lead}${name}${sep}[redacted:value]`;
        if (value === "[redacted:value]" || value.length < 4 || /^(?:Bearer|Basic)\s/i.test(value)) return m;
        const quote = double !== undefined ? '"' : "'";
        return `${lead}${name}${sep}${quote}[redacted:value]${quote}`;
      }],
    ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
    ["key", /\bsk-[A-Za-z0-9_-]{16,}/g],
    ["key", /\bek_[A-Za-z0-9_-]{16,}/g],
    ["key", /\bgh[pousr]_[A-Za-z0-9]{20,}/g],
    ["key", /\bgithub_pat_[A-Za-z0-9_]{20,}/g],
    ["key", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
    ["key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
    ["key", /\bAIza[0-9A-Za-z_-]{35}/g],
    ["key", /\btskey-[A-Za-z0-9-]{16,}/g],
    ["userinfo", /(https?:\/\/)(?!\[redacted:)[^\s/:@]+:[^\s/@]+@/g, (_m, scheme) => `${scheme}[redacted:userinfo]@`],
    // Long hex, except exactly 40 chars: git commit SHAs are not secrets.
    ["hex", /\b[a-fA-F0-9]{32,}\b/g, (m) => (m.length === 40 ? m : "[redacted:hex]")],
    // Long base64-ish runs with mixed classes (no English word is 40 letters).
    // A slash-separated path of short segments is a path, not a secret.
    ["base64", /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{40,}={0,2}/g, (m) => {
      const longest = m.split("/").reduce((a, b) => (b.length > a.length ? b : a), "");
      return longest.length >= 32 && /[A-Z]/.test(longest) && /[a-z]/.test(longest) && /[0-9]/.test(longest) ? "[redacted:base64]" : m;
    }],
  ];
  const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g;

  function maskSecrets(text, { emails = false } = {}) {
    if (text == null) return "";
    let out = String(text);
    for (const [kind, re, fn] of RULES) out = out.replace(re, fn || (() => `[redacted:${kind}]`));
    if (emails) out = out.replace(EMAIL, "[redacted:email]");
    return out;
  }

  // Every string anywhere in a JSON-able value; other leaves untouched.
  function maskDeep(value, opts, depth = 0) {
    if (typeof value === "string") return maskSecrets(value, opts);
    if (!value || typeof value !== "object" || depth > 12) return value;
    if (Array.isArray(value)) return value.map((v) => maskDeep(v, opts, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = maskDeep(v, opts, depth + 1);
    return out;
  }

  // Mask first, then clip to max characters (ellipsis included).
  function clip(text, max, opts) {
    const s = maskSecrets(text, opts).replace(/\s+/g, " ").trim();
    if (!max || s.length <= max) return s;
    return `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
  }

  globalThis.VA3Mask = { maskSecrets, maskDeep, clip };
})();
