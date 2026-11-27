/**
 * Shared spoken-speech rules for live calls and podcasts:
 *  - how to write for the ear (adapted from Blader's Humanizer, MIT), and
 *  - optional delivery cues the AI writes in the same pass as the words.
 *
 * Cues are playback metadata only. They never reach the spoken words or
 * the visible transcript; a missing or broken cue just means normal speech.
 *
 *   {pause 400}      silence, in milliseconds (100–2000)
 *   {faster} {slower} {higher} {lower}   subtle change for this phrase only
 *   {rate 1.1} {pitch 0.95}              exact values for this phrase only
 *   {react mm-hmm}   a short cached reaction clip (mm-hmm, uh-huh, hmm, oh, right, yeah, ah)
 */

export const SPOKEN_STYLE = `Write for listening, not reading:
- Say the point first, plainly. No run-ups ("Here's the thing", "Let's dive in"), no "not X but Y" framing, no one-line closers that repeat the point.
- Use natural contractions (it's, you'll, didn't) and vary sentence length: mostly short, the odd longer one.
- Don't force things into threes, don't inflate ordinary facts, and don't argue with objections nobody raised.
- Keep every fact, name, number, date and time exactly; keep uncertainty ("I think", "probably") where it's real.
- No lists, headings, links, emoji or formatting: it's heard, not seen.`;

export const CUE_GUIDE = `Optional delivery cues (they're never spoken or shown): {pause 300} for a short silence; {faster}, {slower}, {higher} or {lower} at the start of a phrase changes only that phrase, subtly; {react mm-hmm} (or uh-huh, hmm, oh, right, yeah, ah) for a brief listening sound; {laugh}, {chuckle}, {sigh} or {breath} for an expressive sound where a person really would (something funny, a relief, a pause before something serious). Use them rarely and only where a person naturally would — most phrases need none, and never in serious or sad moments except a soft {sigh}.`;

export type PlayItem =
  | { kind: "speech"; text: string; rate?: number; pitch?: number }
  | { kind: "pause"; ms: number }
  | { kind: "clip"; name: string };

export const REACTIONS = ["mm-hmm", "uh-huh", "hmm", "oh", "right", "yeah", "ah", "laugh", "chuckle", "sigh", "breath"] as const;
/** Expressive sounds that can be written on their own: {laugh}, {chuckle}, {sigh}, {breath}. */
const EXPRESSIVE = new Set(["laugh", "chuckle", "sigh", "breath"]);
const NAMED: Record<string, { rate?: number; pitch?: number }> = {
  faster: { rate: 1.08 },
  slower: { rate: 0.92 },
  higher: { pitch: 1.05 },
  lower: { pitch: 0.95 },
};
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const CUE = /\{\s*([a-z-]+)(?:\s+([^{}]*?))?\s*\}/gi;

/** Text with every cue (valid or not) removed: what's spoken and shown. */
export function stripCues(text: string): string {
  return normalizeTags(text).replace(CUE, " ").replace(/\{[^{}]*$/, "").replace(/\s+([,.!?;:])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

/**
 * One phrase (with any cues) → what to play, in order. A speed/pitch cue
 * applies to the words after it in this phrase only; the next phrase is
 * back to normal unless it has its own cue.
 */
/** Sound tags written the way other speech models do ("[laughs]", "<sigh>", "*chuckles*") become cues. */
export function normalizeTags(t: string): string {
  return t.replace(/[\[<*(]\s*(laugh|laughs|laughing|chuckle|chuckles|sigh|sighs|breath|breathes|inhales)\s*[\]>*)]/gi, (_, w: string) => {
    const k = w.toLowerCase();
    return `{${k.startsWith("laugh") ? "laugh" : k.startsWith("chuckle") ? "chuckle" : k.startsWith("sigh") ? "sigh" : "breath"}}`;
  });
}

export function planPhrase(phrase: string): PlayItem[] {
  phrase = normalizeTags(phrase);
  const out: PlayItem[] = [];
  let rate: number | undefined;
  let pitch: number | undefined;
  let last = 0;
  const pushText = (raw: string) => {
    const text = stripCues(raw);
    if (!/[A-Za-z0-9]/.test(text)) return;
    const prev = out[out.length - 1];
    // Words split only by an ignored cue stay one phrase.
    if (prev?.kind === "speech" && prev.rate === rate && prev.pitch === pitch) prev.text = `${prev.text} ${text}`;
    else out.push({ kind: "speech", text, ...(rate !== undefined ? { rate } : {}), ...(pitch !== undefined ? { pitch } : {}) });
  };
  for (const m of phrase.matchAll(CUE)) {
    pushText(phrase.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
    const name = m[1].toLowerCase();
    const arg = (m[2] ?? "").trim().toLowerCase();
    if (name === "pause") {
      const ms = Number(arg.replace(/ms$/, ""));
      if (Number.isFinite(ms) && ms > 0) out.push({ kind: "pause", ms: Math.round(clamp(ms, 100, 2000)) });
    } else if (name === "react") {
      const r = REACTIONS.find((x) => x === arg.replace(/[^a-z-]/g, ""));
      if (r) out.push({ kind: "clip", name: r });
    } else if (name === "rate" || name === "speed") {
      const v = Number(arg);
      if (Number.isFinite(v) && v > 0) rate = Math.round(clamp(v, 0.8, 1.25) * 100) / 100;
    } else if (name === "pitch") {
      const v = Number(arg);
      if (Number.isFinite(v) && v > 0) pitch = Math.round(clamp(v, 0.85, 1.15) * 100) / 100;
    } else if (EXPRESSIVE.has(name)) {
      out.push({ kind: "clip", name });
    } else if (NAMED[name]) {
      rate = NAMED[name].rate ?? rate;
      pitch = NAMED[name].pitch ?? pitch;
    }
    // Anything else is ignored: normal speech.
  }
  pushText(phrase.slice(last));
  return out;
}

/** True when a streamed piece ends inside an unfinished cue (wait for the rest). */
export const openCue = (s: string) => s.lastIndexOf("{") > s.lastIndexOf("}");

// ---------------- Turn-end (did they finish their thought?) ----------------

/**
 * Local estimate of whether a heard turn is finished, from its words (the
 * phone's voice detection decides when they paused). "The other thing is…"
 * or a sentence ending on "and" keeps listening; a complete sentence or a
 * question lets the reply go ahead.
 */
const TRAILING = /\b(and|but|or|so|because|cause|like|um+|uh+|er+|the|a|an|to|of|for|with|that|which|if|then|is|are|was|my|your|our|also|plus|about|other thing is|thing is|what i mean is|i mean|i think|i was going to say|the problem is|basically|well|actually)\s*(\.\.\.|…)?$/i;
export function turnFinished(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/(\.\.\.|…|,|-|–|—)$/.test(t)) return false;
  if (TRAILING.test(t.replace(/[.!?]+$/, ""))) return false;
  return true;
}

/**
 * The pause before speaking, after a clear end of turn: quick for a simple
 * exchange, a little more room for something reflective.
 */
export function beatMs(heard: string): number {
  const t = heard.trim().toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (/^(yes|yeah|yep|no|nope|ok(ay)?|thanks|thank you|cool|great|sure|right)\b/.test(t) && words <= 4) return 200;
  if (/\b(why|how come|what do you think|should i|feel|worried|advice|opinion|explain|difference|decide)\b/.test(t)) return 550;
  if (/\?$/.test(t) || /^(what|when|where|who|which|is|are|can|could|do|does|did|will|would)\b/.test(t)) return words > 12 ? 400 : 300;
  return words > 20 ? 450 : 320;
}

// ---------------- Hold and wake (per bot) ----------------

const HOLD = /^(?:ok(?:ay)?[, ]+|sorry[, ]+|um+[, ]+)?(?:hold on|hang on|wait|one sec|just a sec|give me a (?:sec|second|minute|moment)|hold that thought|one moment|bear with me)\b(?:[\s,]*(?:a|one|just)?\s*(?:sec(?:ond)?|minute|moment|tick|bit)s?)?(?:[\s,]*(?:please|mate|maus))?[.!]*$/i;
/** "Hold on a sec", "hang on", "one moment please"… (short, clear requests only). */
export const isHoldRequest = (t: string) => t.trim().split(/\s+/).length <= 8 && HOLD.test(t.trim());

/**
 * While a bot is on hold: did this local transcript wake it? Only its own
 * name counts. Returns what to do, or null to stay on hold (silence, side
 * talk or another bot's name). The text is never stored or sent anywhere
 * unless it wakes the bot.
 */
export function wakeFrom(text: string, botName: string): { action: "wake" | "continue" | "ask"; question?: string } | null {
  const name = botName.trim().toLowerCase();
  if (!name) return null;
  const t = text.trim().toLowerCase().replace(/[“”"]/g, "");
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`^(?:(?:hey|ok(?:ay)?|right|so)[, ]+)?${esc}\\b[\\s,.!?:-]*(.*)$`, "i").exec(t);
  if (!m) return null;
  const rest = text.trim().slice(text.trim().length - m[1].length).trim();
  if (!rest) return { action: "wake" };
  if (/^(?:please\s+)?(?:continue|carry on|go on|keep going|go ahead|resume|where were we|as you were(?: saying)?|you were saying)\b[\s.!,]*(?:please)?[.!]*$/i.test(rest)) return { action: "continue" };
  return { action: "ask", question: rest };
}

// ---------------- Speaking in pieces ----------------

/**
 * Cuts streamed text into speakable pieces: a sentence as soon as it ends;
 * the very first piece even earlier, at a comma; long runs at a space; never
 * inside a delivery cue.
 */
/** True when there's something to say (not just spaces or punctuation). Plain ranges: the phone's Node.js has no Unicode tables. */
const SPEAKABLE = /[^\s!-/:-@[-`{-~\u2013\u2014\u2018\u2019\u201c\u201d\u2026]/;

export class SpeechChunker {
  private buf = "";
  private first = true;
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      let cut = -1;
      const end = this.buf.search(/[.!?…](?=[\s"')\]]|$)|\n/);
      if (end >= 0 && (end + 1 < this.buf.length || /\n$/.test(this.buf))) cut = end + 1;
      if (cut < 0 && this.first) {
        const m = this.buf.slice(18).search(/[,;:—–](?=\s)/);
        if (m >= 0) cut = 18 + m + 1;
      }
      if (cut < 0 && this.buf.length > 160) {
        const sp = this.buf.lastIndexOf(" ", 160);
        cut = sp > 40 ? sp : 160;
      }
      if (cut < 0) break;
      // Never split a delivery cue ("{pause 300}"): wait for its closing brace.
      if (openCue(this.buf.slice(0, cut))) {
        const close = this.buf.indexOf("}", cut);
        if (close < 0) break;
        cut = close + 1;
      }
      const piece = this.buf.slice(0, cut).trim();
      this.buf = this.buf.slice(cut);
      if (SPEAKABLE.test(piece)) {
        out.push(piece);
        this.first = false;
      }
    }
    return out;
  }
  flush(): string {
    const rest = this.buf.trim();
    this.buf = "";
    return SPEAKABLE.test(rest) ? rest : "";
  }
}

