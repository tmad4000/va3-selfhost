// Known project families: names Jacob uses in conversation that all refer to
// the same project, so saved notes and actions can be tagged consistently
// even when he switches between aliases mid-conversation.
//
// NotesStream Vision is his core stream-of-thought notes workflow: short,
// chronological, informal capture (not structured documents or summaries).
// "ThoughtStream Vision" is a name he also uses for the same project family.
// This is the single source of truth for those aliases and for the Ideaflow
// suite description below; memory.js and openai.js both read it rather than
// duplicating the list.
const FAMILIES = Object.freeze({
  "notestream-vision": Object.freeze({
    key: "notestream-vision",
    name: "NotesStream Vision",
    style: "stream-of-thought notes: short, chronological, informal capture — not a structured document or summary",
    aliases: Object.freeze([
      "NotesStream Vision",
      "Notes Stream Vision",
      "Note Stream Vision",
      "ThoughtStream Vision",
      "Thought Stream Vision",
      // Speech-recognition mishearings seen in real dictation (2026-11-01).
      "Nord Stream Vision",
      "Notion Vision",
    ]),
  }),
});

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Finds the project family referenced anywhere in free text (a memory key +
// content, a scratchpad line, spoken words), or null if none match.
export function matchProjectFamily(text) {
  const norm = normalize(text);
  if (!norm) return null;
  for (const family of Object.values(FAMILIES)) {
    if (norm.includes(normalize(family.key)) || family.aliases.some((alias) => norm.includes(normalize(alias)))) {
      return family;
    }
  }
  return null;
}

export function projectFamily(key) {
  return FAMILIES[key] || null;
}

export function projectFamilies() {
  return Object.values(FAMILIES);
}

// The Ideaflow suite: the apps that share one account, Ideaflow ID. This is a
// suite, not a project family: naming it does not tag memory to any one app.
// "Flow suite" was a speech-recognition mishearing of "Ideaflow suite"
// (2026-11-01) and used to be wrongly listed as a NotesStream Vision alias.
// Hostnames were checked live (HTTP 200/308) on 2026-11-03.
const IDEAFLOW_SUITE = Object.freeze({
  name: "Ideaflow",
  aliases: Object.freeze(["Ideaflow suite", "IdeaFlow suite", "idea flow suite", "Flow suite", "the Flow suite"]),
  account: Object.freeze({ name: "Ideaflow ID", host: "id.ideaflow.app", button: "Sign in with Ideaflow" }),
  members: Object.freeze([
    Object.freeze({ name: "Thoughtstream / NoteStream Vision", host: "vision.ideaflow.app", what: "stream-of-thought notes (the NotesStream Vision family above)", va3: "save_to_vision" }),
    Object.freeze({ name: "OpenChat", host: "chat.ideaflow.app", what: "messaging", va3: "agent" }),
    Object.freeze({ name: "Unlinked", host: "unlinked.ai", what: "professional network and contacts", va3: "agent" }),
    Object.freeze({ name: "World Issue Tracker", host: "worldissuetracker.com", what: "issue boards; where VA3 feedback is filed", va3: "submit_feedback" }),
    Object.freeze({ name: "Social (idea network)", host: "social.ideaflow.app", what: "profiles and Jacob's project directory", va3: "agent" }),
    Object.freeze({ name: "Noos", host: null, what: "the knowledge graph backend behind the suite", va3: "agent" }),
  ]),
});

export function ideaflowSuite() {
  return IDEAFLOW_SUITE;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True when free text names the Ideaflow suite by any alias or mishearing.
// Whole-word match, so "workflow suite" is not the suite.
export function matchIdeaflowSuite(text) {
  const norm = normalize(text);
  if (!norm) return false;
  return IDEAFLOW_SUITE.aliases.some((alias) =>
    new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalize(alias))}($|[^a-z0-9])`).test(norm)
  );
}

export function ideaflowSuitePromptBlock() {
  const s = IDEAFLOW_SUITE;
  const how = {
    save_to_vision: "you can act on it directly with save_to_vision",
    submit_feedback: "you can act on it directly with submit_feedback (posts as his Ideaflow ID when linked, else the server agent key)",
    agent: "reach it through a delegated agent",
  };
  const members = s.members.map((m) => `- ${m.name}${m.host ? ` (${m.host})` : ""}: ${m.what}; ${how[m.va3]}.`);
  return (
    "## Ideaflow suite\n" +
    `Ideaflow (spelled with a capital I and lowercase f) is Jacob's suite of apps that share one account, ${s.account.name} (${s.account.host}, the "${s.account.button}" button). ` +
    `${s.aliases.map((a) => `"${a}"`).join(", ")} all mean this suite; "Flow suite" is a speech-recognition mishearing of "Ideaflow suite", not NotesStream Vision. Members:\n` +
    members.join("\n") +
    `\n${s.account.name} is the shared sign-in: account_status says which account this app uses, and sign_in_service / sign_out_service link or unlink it (today only for World Issue Tracker). There are no other direct integrations; do not claim one.`
  );
}

// Compact prompt text so the model recognizes the aliases without a second
// hardcoded list drifting out of sync with this module.
export function projectFamilyPromptBlock() {
  const lines = projectFamilies().map(
    (f) => `"${f.name}" (also called ${f.aliases.map((a) => `"${a}"`).join(", ")}) — ${f.style}.`
  );
  if (!lines.length) return "";
  return (
    "## Project families\n" +
    "These names all refer to the same project; recognize any of them and treat the note the same way:\n" +
    lines.join("\n") +
    "\nWhen Jacob dictates a note for one of these (or asks you to save something in that style), keep the content short and chronological in his own words, not rewritten into a summary. Mentioning the project by any alias while saving memory or updating the scratchpad is enough; the project field is also auto-detected from the text.\n" +
    "NotesStream Vision notes now really land in the app (vision.ideaflow.app, Jacob's account): when he says to save something to NotesStream Vision, Vision, ThoughtStream Vision or his thought stream, call save_to_vision with his words verbatim (hashtags inline). memory_save with project \"notestream-vision\" also pushes to Vision; pass sync_to_vision false for facts about the project that are not notes. Never write a notes file instead. Say \"Saved to Vision.\" only when the result has synced: true with a vision_note_id; otherwise say \"Saved locally; Vision sync pending\" and why. vision_sync_status lists anything not yet synced."
  );
}
