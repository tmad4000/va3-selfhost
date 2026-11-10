// Spoken relay of delegated answers (smart model, agents) for the voice tier.
//
// The smart model and agents answer in text (often markdown: headings, lists,
// code, paths, links). Read verbatim, that costs Jacob minutes of listening.
// `spokenSummary` turns such an answer into at most a couple of short plain
// sentences; tools.js returns it as the `say` hint, which low chatter speaks
// exactly (normal chatter treats it as the minimum). The full answer stays in
// the tool result for follow-up questions; nothing here drops data.
//
// Waiting states (an agent still running) get an empty `say`: the launch was
// already acknowledged and the app's cue and Waiting panel show the work.

export const RELAY_LIMITS = Object.freeze({ sentences: 2, chars: 240 });

const stripMarkdown = (text) => String(text || "")
  .replace(/```[\s\S]*?(```|$)/g, " ")          // fenced code blocks
  .replace(/^\s{0,3}(#{1,6}\s+|>\s?)/gm, "")      // headings, quotes
  .replace(/^\s*\|.*\|\s*$/gm, " ")               // table rows
  .replace(/^\s*([-*+•]|\d+[.)])\s+/gm, "")       // list markers
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")      // links/images -> text
  .replace(/https?:\/\/\S+/g, "")                 // bare URLs
  .replace(/`([^`]*)`/g, "$1")                    // inline code
  .replace(/(\*\*|__|\*|_)(\S[^*_]*?)\1/g, "$2");  // emphasis

// First paragraph that has words, limited to `sentences` sentences and
// `chars` characters, as plain speech. Empty input gives "".
export function spokenSummary(text, { sentences = RELAY_LIMITS.sentences, chars = RELAY_LIMITS.chars } = {}) {
  const paragraphs = stripMarkdown(String(text || "").replace(/```[\s\S]*?(```|$)/g, "\n\n"))
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => /[\p{L}\p{N}]/u.test(p));
  if (!paragraphs.length) return "";
  // A heading or lead-in ("## Summary", "Here's what I found:") says nothing
  // on its own; speak the paragraph after it.
  const label = (p) => /:$/.test(p) || (!/[.!?]$/.test(p) && p.split(" ").length <= 4);
  let lead = paragraphs.find((p) => !label(p)) || paragraphs[0];
  lead = lead.replace(/^(summary|answer|tl;?dr|short answer|result)\s*:\s*/i, "");
  const parts = lead.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [lead];
  let out = parts.slice(0, Math.max(1, sentences)).join(" ").replace(/\s+/g, " ").trim();
  if (out.length > chars) {
    const cut = out.slice(0, chars - 1);
    const space = cut.lastIndexOf(" ");
    out = `${(space > chars * 0.6 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "")}…`;
  }
  return out;
}

// The question a delegated reply leaves for Jacob, or "". An agent or the
// smart model that needs a decision asks it at the end of its reply; the
// two-sentence lead alone would drop it, Jacob would never hear it, and the
// work would stall into a re-ask loop. Only the final paragraph counts, and
// only its last sentence when that sentence ends in "?". Rhetorical or
// offer-style questions ("Want me to...?", "Anything else?") are not
// decisions and stay unspoken.
const OFFER = /^(want me to|would you like|shall i|should i also|do you want me to|let me know|anything else|need anything|any other)/i;
export function pendingQuestion(text, { chars = 160 } = {}) {
  const paragraphs = stripMarkdown(String(text || "").replace(/```[\s\S]*?(```|$)/g, "\n\n"))
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => /[\p{L}\p{N}]/u.test(p));
  const last = paragraphs[paragraphs.length - 1];
  if (!last || !/\?["')\]]*$/.test(last)) return "";
  const parts = last.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) || [last];
  const question = parts[parts.length - 1].trim();
  if (!/\?/.test(question) || OFFER.test(question)) return "";
  return question.length > chars ? "" : question;
}

// What to speak for a delegated reply: its short lead, plus the open
// question it ends with when the lead does not already contain it. A reply
// that is only a question is spoken as that question.
// Offer-style closers ("Want me to also...?") are dropped from the lead: low
// chatter speaks the say hint exactly and forbids trailing offers.
const dropOffers = (said) => {
  const parts = said.match(/[^.!?…]+(?:[.!?…]+(?=\s|$)|$)/g) || [];
  const kept = parts.filter((p) => !(OFFER.test(p.trim()) && /\?/.test(p)));
  // A reply that is nothing but an offer is a real question: keep it.
  return kept.length ? kept.join(" ").replace(/\s+/g, " ").trim() : said;
};

export function relaySummary(text, opts = {}) {
  const lead = dropOffers(spokenSummary(text, opts));
  const question = pendingQuestion(text);
  if (!question) return lead;
  const norm = (v) => v.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (norm(lead).includes(norm(question))) return lead;
  // Keep the decision; trim the lead to one sentence to stay short.
  const oneLead = dropOffers(spokenSummary(text, { ...opts, sentences: 1 }));
  if (!oneLead || norm(question).includes(norm(oneLead).replace(/…$/, ""))) return question;
  return `${oneLead.replace(/…$/, ".")} ${question}`.replace(/\.\./g, ".");
}

// The agent result inside a tool result, whichever shape the tool returns:
// agent_result/send_to_agent (top level) or ask_agent/spawn_coding_agent
// (nested `result`).
export function agentOutcome(result) {
  if (!result || typeof result !== "object") return null;
  if (result.result && typeof result.result === "object" && result.result.state) return result.result;
  if (result.state) return result;
  return null;
}

// The say hint for an agent tool result: a summary when it finished, a short
// blocker or failure line, and nothing while it is still working.
// undefined = no opinion (let the caller decide).
export function agentRelaySay(result) {
  const outcome = agentOutcome(result);
  if (!outcome) return undefined;
  switch (outcome.state) {
    case "completed": {
      const said = relaySummary(outcome.final_reply);
      return said || "Done.";
    }
    case "running":
    case "starting":
    case "queued":
      return "";
    case "blocked":
      return "The agent needs a permission.";
    case "failed": {
      const why = spokenSummary(outcome.error || "no reason given", { sentences: 1, chars: 140 });
      return `The agent failed: ${why.replace(/[.…]+$/, "")}.`;
    }
    default:
      return undefined;
  }
}
