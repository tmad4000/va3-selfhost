// Voice parity for app settings: one table of every setting set_app_setting
// can change, where it lives, and how a spoken value is normalized.
//
// Server settings (time display, server speech recordings) are written by
// server/tools.js through updateSettings(). Device settings live in this
// browser's localStorage; plan() turns a request into the exact storage writes
// plus the UI refreshes app.js must run, so the voice path writes the same
// keys and values as the on-screen control. Pure: node tests load it in a vm.
//
// Deliberately absent (own tools and guards): turn-taking and sleep
// (set_turn_taking, set_sleep_after_silence), chatter and delegation, agent
// approvals (scope-naming approval words), the microphone hard-disable
// (enable is a physical button press only), assistant volume, and the
// Listen-mode / wake-word / mute-cue options.
(() => {
  const root = typeof window !== "undefined" ? window : globalThis;
  const onOff = (v) => {
    if (typeof v === "boolean") return v ? "on" : "off";
    const s = String(v ?? "").toLowerCase().trim();
    if (["on", "true", "yes", "enable", "enabled", "keep"].includes(s)) return "on";
    if (["off", "false", "no", "disable", "disabled"].includes(s)) return "off";
    return null;
  };
  const CUE_CATEGORY_IDS = ["availability", "agent", "complete", "handoff", "error", "storage", "delegate", "queue", "working"];
  const CHIMES = ["soft", "bell", "off"];

  // where: "device" (this browser) or "server" (every device).
  const SETTINGS = Object.freeze({
    theme: { where: "device", values: ["system", "light", "dark"], label: "Theme" },
    auto_update: { where: "device", values: ["on", "off"], label: "Install updates automatically" },
    sound_cue_volume: { where: "device", range: [0, 100], label: "Sound cue volume" },
    sound_cue: { where: "device", values: ["on", "off"], needsCategory: true, label: "Sound cue category" },
    sound_cue_chatter: { where: "device", values: ["low", "normal"], label: "Quieter routine cues in low chatter" },
    restart_chime: { where: "device", values: CHIMES, label: "Restart chime" },
    offline_autosend: { where: "device", values: ["on", "off"], label: "Send queued offline input automatically" },
    device_speech_recordings: { where: "device", values: ["on", "off"], label: "Keep speech recordings on this device" },
    feedback_widget: { where: "device", values: ["on", "off"], label: "Embedded feedback widget" },
    floating_checklist: { where: "device", values: ["on", "off"], label: "Floating checklist" },
    read_indicators: { where: "device", values: ["on", "off"], label: "Read/unread indicators" },
    show_finished: { where: "device", values: ["on", "off"], label: "Show finished work" },
    time_zone: { where: "server", label: "Time zone (IANA name, or local)" },
    relative_times: { where: "server", values: ["on", "off"], label: "Relative times (\"12 minutes ago\")" },
    server_speech_recordings: { where: "server", values: ["keep", "off"], label: "Server copies of speech recordings" },
  });
  const NAMES = Object.keys(SETTINGS);
  const DEVICE = NAMES.filter((n) => SETTINGS[n].where === "device");

  const KEYS = Object.freeze({
    theme: "va3-theme",
    auto_update: "va3-auto-update",
    sound_cue_volume: "va3-cue-volume",
    sound_cue: "va3-cue-categories",
    sound_cue_chatter: "va3-cue-chatter",
    restart_chime: "va3-restart-chime",
    offline_autosend: "va3-outbox-autosend",
    device_speech_recordings: "va3-speech-snippets",
    feedback_widget: "va3-wit-widget",
    floating_checklist: "va3-checklist-floating",
    read_indicators: "va3-checklist-read-tracking",
    show_finished: "va3-work-view-finished",
  });

  function normalizeValue(name, value) {
    const def = SETTINGS[name];
    if (!def) return null;
    if (def.range) {
      const n = Number(String(value ?? "").replace(/%$/, ""));
      if (!Number.isFinite(n)) return null;
      return Math.max(def.range[0], Math.min(def.range[1], Math.round(n)));
    }
    if (name === "time_zone") {
      const s = String(value ?? "").trim();
      return s ? s : null;
    }
    const s = String(value ?? "").toLowerCase().trim();
    if (def.values.includes(s)) return s;
    if (name === "server_speech_recordings") return onOff(value) === "on" ? "keep" : onOff(value) === "off" ? "off" : null;
    if (def.values.includes("on")) return onOff(value);
    if (name === "restart_chime") return onOff(value) === "off" ? "off" : onOff(value) === "on" ? "soft" : null;
    return null;
  }

  // Turning speech recordings off deletes the ones already kept, so it needs
  // Jacob's spoken yes first: the call without confirm only asks.
  const DELETE_QUESTION = {
    device_speech_recordings: "That deletes the speech recordings saved on this device. Turn it off and delete them?",
    server_speech_recordings: "That deletes the server's copies of your speech recordings. Turn it off and delete them?",
  };
  function needsDeleteConfirmation(name, value, current, confirm) {
    if (!DELETE_QUESTION[name] || confirm === true || confirm === "true") return null;
    if (value !== "off" || current === "off") return null;
    return { ok: false, needs_confirmation: true, setting: name, value, error: "needs Jacob's spoken yes before deleting recordings", say: DELETE_QUESTION[name] };
  }

  const read = (storage, key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  function parseCategories(raw) {
    let obj = null;
    try { obj = JSON.parse(raw || "null"); } catch { obj = null; }
    const out = {};
    for (const id of CUE_CATEGORY_IDS) out[id] = obj && Object.hasOwn(obj, id) ? Boolean(obj[id]) : true;
    return out;
  }

  // Current device values as the UI reads them (same defaults).
  function deviceValues(storage) {
    const vol = Number(read(storage, KEYS.sound_cue_volume));
    return {
      theme: SETTINGS.theme.values.includes(read(storage, KEYS.theme)) ? read(storage, KEYS.theme) : "system",
      auto_update: read(storage, KEYS.auto_update) === "off" ? "off" : "on",
      sound_cue_volume: read(storage, KEYS.sound_cue_volume) !== null && Number.isFinite(vol) ? Math.max(0, Math.min(100, Math.round(vol))) : 100,
      sound_cues: parseCategories(read(storage, KEYS.sound_cue)),
      sound_cue_chatter: read(storage, KEYS.sound_cue_chatter) === "low" ? "low" : "normal",
      restart_chime: CHIMES.includes(read(storage, KEYS.restart_chime)) ? read(storage, KEYS.restart_chime) : "soft",
      offline_autosend: read(storage, KEYS.offline_autosend) === "on" ? "on" : "off",
      device_speech_recordings: read(storage, KEYS.device_speech_recordings) === "off" ? "off" : "on",
      feedback_widget: read(storage, KEYS.feedback_widget) === "off" ? "off" : "on",
      floating_checklist: read(storage, KEYS.floating_checklist) === "on" ? "on" : "off",
      read_indicators: read(storage, KEYS.read_indicators) === "on" ? "on" : "off",
      show_finished: read(storage, KEYS.show_finished) === "on" ? "on" : "off",
    };
  }

  // A device change: { ok, setting, value, category?, writes: [[key, value]],
  // refresh: [ui part names] } or { ok: false, error }.
  function plan({ setting, value, category, confirm } = {}, storage) {
    const name = String(setting || "").toLowerCase().trim();
    const def = SETTINGS[name];
    if (!def) return { ok: false, error: `Unknown setting. Known: ${NAMES.join(", ")}.` };
    if (def.where !== "device") return { ok: false, error: `${name} is a server setting.` };
    const v = normalizeValue(name, value);
    if (v === null) {
      const allowed = def.range ? `${def.range[0]}-${def.range[1]}` : def.values.join(", ");
      return { ok: false, error: `${name} must be ${allowed}.` };
    }
    const ask = needsDeleteConfirmation(name, v, deviceValues(storage)[name], confirm);
    if (ask) return ask;
    if (name === "sound_cue") {
      const cat = String(category || "").toLowerCase().trim();
      if (!CUE_CATEGORY_IDS.includes(cat)) return { ok: false, error: `category must be one of: ${CUE_CATEGORY_IDS.join(", ")}.` };
      const cats = parseCategories(read(storage, KEYS.sound_cue));
      cats[cat] = v === "on";
      return { ok: true, setting: name, category: cat, value: v, writes: [[KEYS.sound_cue, JSON.stringify(cats)]], refresh: ["cues", "work_audio"] };
    }
    const refresh = {
      theme: ["theme"], auto_update: ["update_bar"], sound_cue_volume: ["cues", "work_audio"], sound_cue_chatter: ["cues", "work_audio"],
      restart_chime: ["restart_chime"], feedback_widget: ["widget"], floating_checklist: ["checklist"], read_indicators: ["checklist"], show_finished: ["work"], offline_autosend: ["outbox"], device_speech_recordings: ["speech_recordings"],
    }[name];
    return { ok: true, setting: name, value: v, writes: [[KEYS[name], String(v)]], refresh };
  }

  // The server-side patch for a server setting, for updateSettings().
  function serverPatch({ setting, value } = {}) {
    const name = String(setting || "").toLowerCase().trim();
    const def = SETTINGS[name];
    if (!def || def.where !== "server") return { ok: false, error: `${name || "setting"} is not a server setting.` };
    const v = normalizeValue(name, value);
    if (v === null) return { ok: false, error: `${name} must be ${def.values ? def.values.join(", ") : "an IANA time zone such as America/New_York, or local"}.` };
    if (name === "time_zone") return { ok: true, setting: name, value: v, patch: { time_display: { time_zone: v } } };
    if (name === "relative_times") return { ok: true, setting: name, value: v, patch: { time_display: { relative: v === "on" } } };
    return { ok: true, setting: name, value: v, patch: { speech_snippets: v } };
  }

  root.VA3AppPrefs = { SETTINGS, NAMES, DEVICE, KEYS, CUE_CATEGORY_IDS, normalizeValue, plan, serverPatch, deviceValues, needsDeleteConfirmation };
})();
