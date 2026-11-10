// Spoken microphone command vocabulary: the one place that decides which
// words mute, unmute, put the assistant to sleep or wake it. Two
// server-owned settings (server/settings.js) shape it:
//
//   mic_command_prefix (default off): when on, mute and unmute (including
//     the Dragon-style "mic off" / "mic on") only count when "hey assistant"
//     (or the custom wake word) comes right before the action ("hey
//     assistant, mute"). A plain "mute" / "unmute" / "mic on" no longer
//     touches the mic, and wake phrases ("wake up", "wakey wakey") only wake
//     from Sleep, never lift a plain mute.
//   mic_vocabulary (each default on):
//     mic_on_off   "mic on" / "mic off" (also "microphone on/off"): unmute / mute
//     sleep_wake   "go to sleep" / "stop listening": Sleep (Listen mode);
//                  "wake up" / "start listening": wake
//     wakey_wakey  "wakey wakey": wake
//
// Always, whatever the settings:
//   - "mute" / "unmute" are the core words; the wake word always wakes Sleep;
//   - "disable microphone entirely" stays its own command (public/mic-lock.js)
//     and is never read as a mute; nothing here can lift the hard-disable
//     (only a physical press of Enable microphone does);
//   - "mute your voice" / "unmute yourself" are the assistant's own volume
//     (set_assistant_volume), never the mic;
//   - the assistant's own speech (playing, or just finished) can never wake
//     or unmute the mic (assistantAudible).
//
// "Sleep" is the user-facing name for what the code calls Listen mode / armed
// (formerly the "Arm" button): the model hears nothing until the wake word.
//
// Pure functions; loaded as a classic script in the browser after
// mic-lock.js (window.VA3MicCommands) and imported by the node tests.
(() => {
  const PREFIX = "hey assistant";
  const MIC = "(?:(?:the|my)\\s+)?(?:mic|microphone|mike)";
  const BARE_MIC = "(?:mic|microphone|mike)";
  const VOCAB_KEYS = ["mic_on_off", "sleep_wake", "wakey_wakey"];
  const VOCAB_DEFAULTS = Object.freeze({ mic_on_off: true, sleep_wake: true, wakey_wakey: true });
  const VOCAB_LABELS = {
    mic_on_off: "“mic on” / “mic off” (Dragon-style unmute / mute)",
    sleep_wake: "“go to sleep” / “wake up” (Sleep and wake)",
    wakey_wakey: "“wakey wakey” (wake)",
  };
  // How long after the assistant's audio stops its echo may still reach the
  // local recognizer.
  const ECHO_GRACE_MS = 1200;
  const escapeRe = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // Speech recognizers add punctuation ("Hey, assistant. Mute.").
  const clean = (text) => String(text || "").replace(/[“”"]/g, "").replace(/[.,!?;:]+/g, " ").replace(/\s+/g, " ").trim();

  function normalizeVocab(value) {
    const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
    const out = {};
    for (const key of VOCAB_KEYS) out[key] = typeof v[key] === "boolean" ? v[key] : VOCAB_DEFAULTS[key];
    return out;
  }

  // Words that point the command at the assistant's own voice, not the mic.
  const ASSISTANT_VOICE = /\b(?:your(?:\s+own)?\s+(?:voice|volume|audio|sound)|yourself|the\s+assistant(?:'s)?\s+(?:voice|volume)|assistant\s+(?:voice|volume))\b/i;
  const TAIL = "(?:\\s+(?:now|for\\s+now|for\\s+a\\s+(?:bit|second|sec|minute|moment)))?(?:\\s+please)?$";
  const HEAD = "^(?:please\\s+)?";
  // Phrase sources (no anchors) so the wake listener and the remainder
  // stripper use the same words as the parser.
  const PHRASES = {
    unmute: { core: [`un-?\\s?mute(?:\\s+(?:${MIC}|me))?`], mic_on_off: [`${BARE_MIC}\\s+on`] },
    mute: { core: [`mute(?:\\s+(?:${MIC}|me))?`, `turn\\s+off\\s+${MIC}`, `turn\\s+${MIC}\\s+off`], mic_on_off: [`${BARE_MIC}\\s+off`] },
    sleep: { sleep_wake: ["go\\s+to\\s+sleep", "stop\\s+listening"] },
    wake: { sleep_wake: ["wake\\s+up", "start\\s+listening"], wakey_wakey: ["wakey,?\\s+wakey"] },
  };
  const KINDS = ["unmute", "mute", "sleep", "wake"];

  function phraseSources(kind, vocab) {
    const v = normalizeVocab(vocab);
    const groups = PHRASES[kind] || {};
    return Object.entries(groups).flatMap(([group, list]) => (group === "core" || v[group] ? list : []));
  }

  function prefixRe(wakeWord) {
    const words = [PREFIX];
    const custom = String(wakeWord || "").trim().toLowerCase();
    if (custom && custom !== PREFIX) words.push(custom);
    return new RegExp(`\\b(?:${words.map(escapeRe).join("|")})\\b\\s*`, "i");
  }

  function actionOf(rest, vocab) {
    const s = clean(rest);
    if (!s || ASSISTANT_VOICE.test(s)) return null;
    for (const kind of KINDS) {
      const sources = phraseSources(kind, vocab);
      if (sources.length && new RegExp(`${HEAD}(?:${sources.join("|")})${TAIL}`, "i").test(s)) return kind;
    }
    return null;
  }

  // "mute" | "unmute" | "sleep" | "wake" | null for one utterance. The whole
  // utterance (after an optional prefix) must be the command, so "how do I
  // mute", "don't mute" or "go to sleep after five minutes" are not commands.
  //   prefix: prefix mode (mute/unmute must follow "hey assistant"; sleep
  //           and wake work with or without it).
  // A hard-disable or an enable request is never a command here:
  // public/mic-lock.js owns those.
  function parseMicIntent(text, { prefix = false, wakeWord = PREFIX, vocab } = {}) {
    const s = clean(text);
    if (!s || s.length > 160) return null;
    if (globalThis.VA3MicLock?.parseMicCommand(s)) return null;
    const m = prefixRe(wakeWord).exec(s);
    if (m) {
      const kind = actionOf(s.slice(m.index + m[0].length), vocab);
      if (kind) return kind;
    }
    const kind = actionOf(s, vocab);
    if (prefix && (kind === "mute" || kind === "unmute")) return null;
    return kind;
  }

  // The local listener's trigger while the model cannot hear (muted or
  // asleep). listening = Sleep / Listen mode (incl. standby), as opposed to a
  // plain mute.
  //   wake word: always.
  //   wake phrases ("wake up", "wakey wakey"): from Sleep always; from a plain
  //     mute only when prefix mode is off (as before).
  //   bare unmute words ("unmute", "mic on"): only when prefix mode is off;
  //     with it on, "hey assistant, unmute" still matches through the prefix.
  function wakeRe({ prefix = false, wakeWord = PREFIX, vocab, listening = false } = {}) {
    const word = String(wakeWord || "").trim().toLowerCase() || PREFIX;
    const words = [...new Set(prefix ? [PREFIX, word] : [word])].map(escapeRe);
    const wake = !prefix || listening ? phraseSources("wake", vocab) : [];
    const unmute = prefix ? [] : phraseSources("unmute", vocab);
    return new RegExp(`\\b(${[...unmute, ...wake, ...words].join("|")})\\b`, "i");
  }

  // What is left to send to the model after a wake: the wake phrase and an
  // unmute/wake action right after it are the command, not a request.
  function wakeRemainder(text, re, { vocab } = {}) {
    let rest = String(text || "").replace(re, " ").replace(/\s+/g, " ").trim();
    const actions = [...phraseSources("unmute", vocab), ...phraseSources("wake", vocab)];
    rest = rest.replace(new RegExp(`^[\\s.,!?;:]*(?:please\\s+)?(?:${actions.join("|")})\\b[\\s.,!?;:]*`, "i"), "");
    return /[\p{L}\p{N}]/u.test(rest) ? rest.trim() : "";
  }

  // True while the assistant's own voice may be what the local recognizer
  // hears: its audio is playing, stopped moments ago, or a local spoken
  // hint/speech synthesis is talking. Nothing heard then may wake or unmute.
  function assistantAudible({ speakingOut = false, speakingStoppedAt = 0, synthSpeaking = false, hintUntil = 0, now = Date.now() } = {}) {
    if (speakingOut || synthSpeaking) return true;
    if (now < (Number(hintUntil) || 0)) return true;
    return now - (Number(speakingStoppedAt) || 0) < ECHO_GRACE_MS;
  }

  // set_microphone guard. Prefix mode off: never blocks (unchanged). On: the
  // model may change the mic only when Jacob's own latest words carried the
  // matching command (mute/unmute with the prefix; "go to sleep" for
  // listen=true). Returns a refusal result, or null to allow.
  function guardSetMicrophone(args, utterance, { prefix = false, wakeWord = PREFIX, vocab } = {}) {
    if (!prefix) return null;
    const want = args?.listen ? "sleep" : args?.muted ? "mute" : "unmute";
    const said = [args?.utterance, utterance].map((u) => parseMicIntent(u, { prefix: true, wakeWord, vocab }));
    if (said.includes(want)) return null;
    if (want === "mute" && said.includes("sleep")) return null; // asleep is muted too
    const phrase = want === "sleep" ? "go to sleep" : `${PREFIX}, ${want}`;
    return {
      ok: false, refused: true, reason: "mic_prefix_required",
      muted_unchanged: true,
      note: `Mic command prefix mode is on: only “${phrase}” does this. A plain “${want}” is not a command; nothing changed. Say nothing about it.`,
    };
  }

  // The phrases to show/speak for each command with the current settings.
  function phrases({ prefix = false, vocab } = {}) {
    const v = normalizeVocab(vocab);
    const p = prefix ? `${PREFIX}, ` : "";
    return {
      mute: `${p}mute`,
      unmute: `${p}unmute`,
      mic_off: v.mic_on_off ? `${p}mic off` : null,
      mic_on: v.mic_on_off ? `${p}mic on` : null,
      sleep: v.sleep_wake ? "go to sleep" : null,
      wake: [v.sleep_wake ? "wake up" : null, v.wakey_wakey ? "wakey wakey" : null].filter(Boolean),
    };
  }

  const api = { PREFIX, VOCAB_KEYS, VOCAB_DEFAULTS, VOCAB_LABELS, ECHO_GRACE_MS, normalizeVocab, parseMicIntent, wakeRe, wakeRemainder, assistantAudible, guardSetMicrophone, phrases };
  globalThis.VA3MicCommands = api;
})();
