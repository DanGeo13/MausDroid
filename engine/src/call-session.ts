import { enqueueSpeech } from "./speech-queue.ts";
import { bridge } from "./bridge.ts";
import { emit, subscribe } from "./events.ts";
import { currentRunTags, onTurnEnd, sendToBot, stopBot } from "./agent.ts";
import { getBot } from "./bots.ts";
import { readMemory } from "./memory.ts";
import { say, speakable, voiceParams } from "./voice.ts";
import { CUE_GUIDE, SPOKEN_STYLE, TOOL_PREAMBLE, beatMs, heardText, interruptionKind, isHoldRequest, planPhrase, silenceFor, toolWords, stripCues, turnFinished, wakeFrom, type PlayItem } from "./speech-style.ts";
import { callSettings, endCall, getCall } from "./calls.ts";
import { settings, speechPrefs } from "./settings.ts";
import { id as newId, sleep } from "./util.ts";

/**
 * A live voice call, run by the engine (so it keeps going with the screen
 * off). Maus greets you by name for the time of day, then:
 *  - listens (the phone's speech recognition),
 *  - starts speaking as soon as the first words of its reply arrive, piece
 *    by piece, instead of waiting for the whole answer,
 *  - keeps listening in 20 ms slices while it thinks or talks: when you
 *    start speaking it stops at once (and drops the rest of that answer),
 *    then hears what you say — from your first word (a short microphone
 *    pre-roll goes to on-device recognition),
 *  - waits if you paused mid-thought ("the other thing is…"), and leaves a
 *    natural beat before answering,
 *  - "hold on a sec" puts it on hold: it then listens on the phone only for
 *    its own name ("Maus", "Maus, continue", "Maus, what about…").
 * Speech goes through the phone's voice engine (e.g. Phonon) phrase by
 * phrase, with optional delivery cues (speed, pitch, pauses, reactions).
 */

// ---------------- Greeting ----------------

const TEMPLATES = {
  late: ["Hey{ n}, you're up late. What's up?", "Hi{ n}, burning the midnight oil? What can I do?", "Hey{ n}. Late one tonight — what do you need?"],
  morning: ["Morning{, n}!", "Good morning{, n}. What can I do for you?", "Hey{ n}, how you going this morning?", "Morning{, n} — what's up?", "Hi{ n}! What's on this morning?"],
  afternoon: ["Afternoon{, n}!", "Good afternoon{, n}. What do you need?", "Hey{ n}, how's the day going?", "Hi{ n}, what's up?", "Hey{ n}, how you going?"],
  evening: ["Evening{, n}!", "Good evening{, n}. What can I do for you?", "Hey{ n}, how you going?", "Evening{, n} — how was the day?", "Hey{ n}, what's up tonight?"],
};
let lastGreeting = "";

export function partOfDay(at: Date): keyof typeof TEMPLATES {
  const h = at.getHours();
  if (h < 5) return "late";
  if (h < 12) return "morning";
  if (h < 17) return "afternoon";
  if (h < 22) return "evening";
  return "late";
}

/** "Morning, Dan!", "Hey Dan, how you going?" — varies, never the same twice in a row. */
export function greeting(name: string, at = new Date(), pick = Math.random): string {
  const list = TEMPLATES[partOfDay(at)];
  let t = list[Math.floor(pick() * list.length) % list.length];
  if (t === lastGreeting && list.length > 1) t = list[(list.indexOf(t) + 1) % list.length];
  lastGreeting = t;
  const n = name.trim();
  return t.replace("{, n}", n ? `, ${n}` : "").replace("{ n}", n ? ` ${n}` : "");
}

/** A short opener for calls Maus makes: "Morning, Dan" / "Hey Dan" / "Hi Dan". */
export function shortGreeting(name: string, at = new Date(), pick = Math.random): string {
  const part = { late: "Hi", morning: "Morning", afternoon: "Afternoon", evening: "Evening" }[partOfDay(at)];
  const list = [`${part}{, n}`, "Hey{ n}", "Hi{ n}"];
  const n = name.trim();
  return list[Math.floor(pick() * list.length) % list.length].replace("{, n}", n ? `, ${n}` : "").replace("{ n}", n ? ` ${n}` : "");
}

/** Your name: set in Calls settings, or found in what MausDroid knows about you. */
export function userName(): string {
  const set = callSettings().userName?.trim();
  if (set) return set;
  const about = readMemory("about-me");
  const m = about.match(/\b(?:my name is|i am|i'm|call me|name:)\s+([A-Z][a-z]+)/);
  return m?.[1] ?? "";
}

// ---------------- Speaking in pieces ----------------

/**
 * Cuts streamed text into speakable pieces: a sentence as soon as it ends;
 * the very first piece even earlier, at a comma, so Maus starts talking
 * quickly; long runs at a space.
 */
export { SpeechChunker } from "./speech-style.ts";
import { SpeechChunker } from "./speech-style.ts";

// ---------------- The call ----------------

type Phase = "connecting" | "listening" | "thinking" | "speaking" | "on-hold" | "ended";
/** One spoken phrase of a reply: what's shown (no cues) and what's played. */
interface Phrase {
  seq: number;
  text: string;
  items: (PlayItem & { seq: number })[];
}
interface Turn {
  id: string;
  botId: string;
  done: boolean;
  cancelled: boolean;
  spoke: boolean;
  line: number;
  off: () => void;
  phrases: Phrase[];
  /** Interrupted or on hold: new phrases are kept but not played. */
  muted: boolean;
  /** What you asked (for background work and context). */
  asked: string;
  startedAt: number;
  /** It said "let me check" and is working in the background: talking doesn't cancel it. */
  working: boolean;
  /** The tool it's using now (for progress updates). */
  tool?: string;
}
/** A bot on hold: its reply and where it was interrupted. */
interface Hold {
  botId: string;
  name: string;
  turn: Turn | null;
  resumeSeq: number;
}
export interface Live {
  callId: string;
  phase: Phase;
  /** Each line with when it was said, so overlapping speech keeps its order. */
  lines: { who: "you" | "maus"; text: string; interrupted?: boolean; at?: number }[];
  note: string;
  active: boolean;
  interruptions: number;
  turn: Turn | null;
  /** Per bot. */
  holds: Map<string, Hold>;
  /** The phone has the phrase player (newer app). */
  player: boolean;
  /** The phone can recognise speech on the device (pre-roll, private hold listening). */
  local: boolean;
  /** Don't start playing a reply before this (the beat after you finish). */
  beatUntil: number;
  /** Woken by name alone: the next thing said may be "continue". */
  woke: Hold | null;
  /** "Wait, wait": what they'd heard, kept for whatever they say next. */
  carryNote?: string;
  resumeAsked: boolean;
  firstAudioMs: number[];
  /** Voice to quiet, per interruption (ms). */
  interruptMs: number[];
  /** Jobs still running in the background while you talk. */
  background: Turn[];
}

const live = new Map<string, Live>();
export const liveCall = (callId: string) => {
  const l = live.get(callId);
  return l ? { callId, phase: l.phase, lines: l.lines.slice(-12), note: l.note, active: l.active, interruptions: l.interruptions, onHold: l.phase === "on-hold", canResumeByVoice: l.local, firstAudioMs: l.firstAudioMs.slice(-5), interruptMs: l.interruptMs.slice(-5), working: l.background.filter((t) => !t.done).length } : null;
};

const changed = (l: Live) => emit("call.live", { callId: l.callId, phase: l.phase });
const setPhase = (l: Live, p: Phase) => {
  if (l.phase !== p) (l.phase = p), changed(l);
};
const BYE_START = /^(ok(ay)?[, ]+)?(bye|goodbye|good bye|see ya|see you|hang up|that's all|that is all|end (the )?call)\b/i;
/** "Bye", "OK, see you", or a short sign-off ending in bye ("never mind, bye"). */
export const isGoodbye = (t: string) => BYE_START.test(t.trim()) || (t.trim().split(/\s+/).length <= 5 && /\b(bye|goodbye|see ya|talk (to you )?later|cheers)\W*$/i.test(t.trim()));

/** Starts (or re-attaches to) the live conversation for an answered / started call. */
export function runCall(callId: string) {
  const existing = liveCall(callId);
  if (existing?.active) return existing;
  const c = getCall(callId);
  if (!c || c.state !== "active") throw new Error("This call isn't active.");
  const l: Live = { callId, phase: "connecting", lines: [], note: "", active: true, interruptions: 0, turn: null, holds: new Map(), player: false, local: false, beatUntil: 0, woke: null, resumeAsked: false, firstAudioMs: [], interruptMs: [], background: [] };
  live.set(callId, l);
  void conversation(l, c.botId, c.direction === "incoming" ? c.openingLine || c.reason : "")
    .catch((e) => (l.note = (e as Error).message))
    .finally(() => finish(l));
  return liveCall(callId)!;
}

/** You hang up. */
export async function hangUp(callId: string) {
  const l = live.get(callId);
  if (l) {
    l.active = false;
    cancelTurn(l);
  }
  await bridge("/voice/stop", {}).catch(() => {});
  if (!l) endCall(callId);
  return liveCall(callId);
}

/** Resume a held call from the screen (only needed where the phone can't listen for the name privately). */
export function resumeHold(callId: string) {
  const l = live.get(callId);
  if (l) l.resumeAsked = true;
  return liveCall(callId);
}

async function finish(l: Live) {
  l.active = false;
  cancelTurn(l);
  for (const h of l.holds.values()) if (h.turn) dropTurn(h.turn);
  l.holds.clear();
  setPhase(l, "ended");
  await bridge("/voice/call-mode", { on: false }).catch(() => {});
  endCall(l.callId);
  setTimeout(() => live.delete(l.callId), 10 * 60_000);
}

function dropTurn(t: Turn) {
  if (t.done && t.cancelled) return;
  t.cancelled = true;
  t.done = true;
  t.off();
  if (currentRunTags(t.botId).includes(t.id)) stopBot(t.botId);
}

function cancelTurn(l: Live) {
  const t = l.turn;
  if (!t) return;
  if (!t.cancelled) {
    dropTurn(t);
    if (l.lines[t.line]) l.lines[t.line].interrupted = true;
  }
  l.turn = null;
  // Nothing stale keeps playing: what's queued for that reply is cleared.
  if (l.player) void bridge("/speech/stop", {}).catch(() => {});
}

/** Plays phrases through the phone's phrase player (or plain speech on an older app). */
export async function play(l: Pick<Live, "player">, turnId: string, phrases: Phrase[], opts: { flush?: boolean; leadMs?: number } = {}) {
  if (!phrases.length) return;
  if (!l.player) {
    for (const [i, p] of phrases.entries()) await say(p.text, Boolean(opts.flush) && i === 0);
    return;
  }
  const prefs = speechPrefs();
  const items: (PlayItem & { seq: number })[] = phrases.flatMap((p) => p.items).filter((i) => prefs.reactions || i.kind !== "clip");
  // The beat before answering is a timed silence at the front of the queue: the first phrase is
  // made during it, and if you start talking again it's cancelled with everything else.
  if (opts.leadMs && opts.leadMs > 30 && prefs.smartWaiting) items.unshift({ kind: "pause", ms: Math.round(Math.min(opts.leadMs, 1500)), seq: phrases[0].seq });
  await enqueueSpeech({ items, turn: turnId, flush: Boolean(opts.flush), ...voiceParams() }).catch(async () => {
    for (const p of phrases) await say(p.text);
  });
}

export function makePhrase(seq: number, raw: string, cues: boolean): Phrase {
  const clean = speakable(raw);
  const items = (cues ? planPhrase(clean) : [{ kind: "speech" as const, text: stripCues(clean) }]).map((it) => ({ ...it, seq }));
  return { seq, text: stripCues(raw), items };
}

async function speakLine(l: Live, text: string, flush = false) {
  l.lines.push({ at: Date.now(), who: "maus", text });
  setPhase(l, "speaking");
  await play(l, newId("line"), [makePhrase(0, text, false)], { flush });
}

/** Waits while Maus thinks or talks; returns "speech" the moment you start talking. */
async function waitWhileBusy(l: Live): Promise<"speech" | "idle"> {
  let errors = 0;
  while (l.active) {
    const busy = Boolean(l.turn && !l.turn.done);
    const bargeIn = speechPrefs().interruptByVoice;
    const st = await bridge<{ speech?: boolean; speaking?: boolean; error?: string }>("/voice/await-speech", { maxMs: 250, bargeIn }, 5000).catch((e) => ({ error: (e as Error).message, speech: false, speaking: false }));
    if (st.speech && (bargeIn || (!busy && !st.speaking))) return "speech";
    if (st.error) {
      // No interrupting without the microphone: just wait for Maus to finish.
      if (errors++ === 0) l.note = st.error;
      const s = await bridge<{ speaking?: boolean }>("/voice/state", {}).catch(() => ({ speaking: false }));
      if (!busy && !s.speaking) return "idle";
      await sleep(200);
      continue;
    }
    if (!busy && !st.speaking) return "idle";
  }
  return "idle";
}

function startTurn(l: Live, botId: string, text: string, name: string, note = "") {
  const id = newId("callturn");
  const chunker = new SpeechChunker();
  const turn: Turn = { id, botId, done: false, cancelled: false, spoke: false, line: -1, off: () => {}, phrases: [], muted: false, asked: text, startedAt: Date.now(), working: false };
  l.turn = turn;
  setPhase(l, "thinking");
  const speakPiece = (piece: string) => {
    if (turn.cancelled) return;
    const ph = makePhrase(turn.phrases.length, piece, l.player);
    if (!ph.text && !ph.items.length) return;
    turn.phrases.push(ph);
    if (ph.text) {
      if (turn.line < 0) {
        l.lines.push({ at: Date.now(), who: "maus", text: ph.text });
        turn.line = l.lines.length - 1;
      } else l.lines[turn.line].text += ` ${ph.text}`;
    }
    turn.spoke = true;
    if (turn.muted) return; // interrupted or on hold: kept for "continue", not played
    setPhase(l, "speaking");
    void play(l, id, [ph], { leadMs: ph.seq === 0 ? l.beatUntil - Date.now() : 0 });
    if (ph.seq === 0 && l.player) void trackFirstAudio(l, id);
  };
  let earlyTimer: NodeJS.Timeout | null = null;
  const unsub = subscribe((e) => {
    if (turn.cancelled || e.botId !== botId || !currentRunTags(botId).includes(id)) return;
    // The tool it's using, for progress updates ("still checking your calendar…").
    const msg = (e as any).message;
    if (e.type === "message" && msg?.role === "tool") turn.tool = String(msg.tool?.name ?? "");
    if (e.type !== "message.delta") return;
    for (const piece of chunker.push(String(e.delta ?? ""))) speakPiece(piece);
    // Start talking after the first few words, even before a comma or full stop arrives.
    if (!turn.spoke && !earlyTimer) earlyTimer = setTimeout(() => {
      if (turn.spoke || turn.cancelled) return;
      const first = chunker.early();
      if (first) speakPiece(first);
    }, 300);
  });
  // A slow job: say so quickly, keep working, and give a short progress update now and then.
  const prefs0 = speechPrefs();
  const ackLines = ["Let me check.", "One sec, I'll look.", "Sure, checking now.", "On it."];
  const ack = setTimeout(() => {
    if (turn.spoke || turn.done || turn.cancelled || turn.muted || !prefs0.delegate) return;
    turn.working = true;
    void sayAside(l, ackLines[Math.floor(Math.random() * ackLines.length)]);
  }, 2500);
  // A tiny "mm" shortly after you stop, only if the answer hasn't started yet (cancelled otherwise).
  const microAck = setTimeout(() => {
    if (turn.spoke || turn.done || turn.cancelled || turn.muted || !l.player || !prefs0.reactions) return;
    void enqueueSpeech({ items: [{ kind: "clip", name: Math.random() < 0.5 ? "mm-hmm" : "hmm", seq: 0 }], turn: `micro:${id}`, ...voiceParams() }).catch(() => {});
  }, Math.max(600, l.beatUntil - Date.now() + 250));
  const progressMs = Number(process.env.MAUSDROID_CALL_PROGRESS_MS ?? 15_000);
  let progress: NodeJS.Timeout | null = null;
  const firstProgress = setTimeout(() => {
    const tick = () => {
      if (turn.spoke || turn.done || turn.cancelled || turn.muted || !turn.working) return;
      void sayAside(l, `Still ${toolWords(turn.tool ?? "")}.`);
    };
    tick();
    progress = setInterval(tick, progressMs);
  }, Math.round(progressMs / 2) + 2500);
  const offEnd = onTurnEnd((b, reply, info) => {
    if (b !== botId || !(info?.tags ?? []).includes(id) || turn.done) return;
    turn.done = true;
    turn.off();
    if (turn.cancelled) return;
    const rest = chunker.flush();
    if (rest) speakPiece(rest);
    // A reply that didn't stream (some AIs) is spoken in phrases.
    if (!turn.spoke) {
      const whole = reply?.trim() || (info?.failed ? "Sorry, something went wrong there." : "Done.");
      const c = new SpeechChunker();
      for (const p of [...c.push(`${whole}\n`), c.flush()].filter(Boolean)) speakPiece(p);
    }
  });
  const timer = setTimeout(() => {
    if (turn.done) return;
    turn.done = true;
    turn.off();
    speakPiece("Sorry, that's taking me a while. I'll message you when it's done.");
  }, 120_000);
  turn.off = () => {
    unsub();
    offEnd();
    clearTimeout(timer);
    clearTimeout(ack);
    clearTimeout(microAck);
    clearTimeout(firstProgress);
    if (progress) clearInterval(progress);
    if (earlyTimer) clearTimeout(earlyTimer);
  };
  sendToBot(botId, text, "call", [], id, `(Said aloud during a phone call with ${name || "you"}. Reply like natural spoken conversation: start with the answer in a short first sentence, one to three short sentences in all.${note ? `\n${note}` : ""}\n${TOOL_PREAMBLE}\n${SPOKEN_STYLE}${l.player ? `\n${CUE_GUIDE}` : ""})`);
}

/** A short aside ("let me check", "still looking…"): spoken, shown, not part of the reply. */
async function sayAside(l: Live, text: string) {
  if (!l.active || l.phase === "on-hold") return;
  l.lines.push({ at: Date.now(), who: "maus", text });
  changed(l);
  await play(l, newId("aside"), [makePhrase(0, text, false)]);
}

/** How long from queuing the first phrase until it was heard (shown on the call screen). */
async function trackFirstAudio(l: Live, turnId: string) {
  for (let i = 0; i < 40 && l.active; i++) {
    await sleep(150);
    const st = await bridge<{ current?: { turn: string } | null; firstAudioMs?: number }>("/speech/state", {}).catch(() => null);
    if (st?.current?.turn === turnId && (st.firstAudioMs ?? -1) >= 0) {
      l.firstAudioMs.push(st.firstAudioMs!);
      return;
    }
  }
}

/** The first phrase of the sentence that was playing, so "continue" starts that sentence again. */
export function sentenceStart(phrases: { seq: number; text: string }[], seq: number): number {
  let i = phrases.findIndex((p) => p.seq === seq);
  if (i < 0) return phrases.length ? phrases[0].seq : 0;
  while (i > 0 && !/[.!?…]["')\]]*$/.test(phrases[i - 1].text.trim())) i--;
  return phrases[i].seq;
}

type Heard = { text?: string; missed?: boolean; error?: string };
/** One listen: after an interruption, on-device with a pre-roll so the first word is kept. */
export async function listen(l: Pick<Live, "local">, opts: { preroll?: number; silenceMs?: number; timeoutSec?: number } = {}): Promise<Heard> {
  const silenceMs = opts.silenceMs ?? silenceFor(speechPrefs().beat);
  const timeoutSec = opts.timeoutSec ?? 30;
  // On-device recognition from MausDroid's own microphone whenever the phone has it: it doesn't depend on
  // the phone's default speech app (which can be an assistant like Grok that won't listen) and makes no beeps.
  if (l.local) {
    const nod = speechPrefs().reactions && speechPrefs().natural ? { backchannel: true, ...voiceParams() } : {};
    const r = await bridge<Heard>("/voice/listen-local", { prerollMs: opts.preroll || 300, silenceMs, timeoutSec, ...nod }, (timeoutSec + 10) * 1000).catch((e) => ({ error: (e as Error).message }) as Heard);
    if (!r.error) return r;
  }
  return bridge<Heard>("/voice/listen", { soft: true, silenceMs, timeoutSec, service: settings().voice.recognizer ?? "" }, (timeoutSec + 10) * 1000).catch((e) => ({ text: "", missed: false, error: (e as Error).message }));
}

/** Waits for a thought that trailed off ("the other thing is…") to finish. */
async function finishThought(l: Live, text: string): Promise<string> {
  let full = text;
  let nodded = false;
  for (let k = 0; k < 3 && l.active && !turnFinished(full); k++) {
    setPhase(l, "listening");
    // A long thought with a pause: a soft "mm-hmm" now and then, as a listener would (once per turn).
    if (!nodded && l.player && speechPrefs().reactions && full.split(/\s+/).length >= 8) {
      nodded = true;
      void enqueueSpeech({ items: [{ kind: "clip", name: "mm-hmm", seq: 0 }], turn: "nod", ...voiceParams() }).catch(() => {});
    }
    const more = await listen(l, { preroll: 300, silenceMs: 1200, timeoutSec: 8 });
    const t = (more.text ?? "").trim();
    if (!t) break;
    full = `${full} ${t}`;
  }
  return full;
}

/** "Hold on a sec": stop, keep this bot's reply and place, then wait for its name. */
async function holdOn(l: Live, botId: string, botName: string) {
  const turn = l.turn && !l.turn.cancelled ? l.turn : null;
  let resumeSeq = 0;
  if (turn) {
    turn.muted = true;
    // Where it was stopped (when you started talking, or now).
    const st = l.player ? await bridge<{ stopped?: { turn: string; seq: number } | null }>("/speech/stop", {}).catch(() => null) : null;
    const where = st?.stopped?.turn === turn.id ? st.stopped : null;
    // Not started yet: from the beginning. Interrupted: from the start of that sentence.
    resumeSeq = where ? sentenceStart(turn.phrases, where.seq) : turn.phrases.length && turn.spoke ? turn.phrases[0].seq : 0;
    l.turn = null;
  }
  const hold: Hold = { botId, name: botName, turn, resumeSeq };
  l.holds.set(botId, hold);
  await bridge("/speech/clear-stopped", {}).catch(() => {});
  await speakLine(l, l.local ? `Sure, take your time. Just say "${botName}" when you're ready.` : "Sure. Tap Resume when you're ready.", true);
  await waitWhileBusy(l);
  setPhase(l, "on-hold");
  // On hold: only this bot's name is listened for, on the phone itself. Anything else said is dropped
  // there and never reaches the transcript, a speech service or any bot.
  while (l.active && l.holds.get(botId) === hold) {
    if (l.resumeAsked) {
      l.resumeAsked = false;
      return resume(l, hold, "continue");
    }
    if (!l.local) {
      await sleep(400);
      continue;
    }
    const r = await bridge<{ text?: string }>("/voice/hold-listen", { name: botName, timeoutSec: 20 }, 35_000).catch((e) => {
      l.note = (e as Error).message;
      return { text: "" };
    });
    const heard = (r.text ?? "").trim();
    if (!heard) continue;
    const w = wakeFrom(heard, botName);
    if (!w) continue; // its name in passing ("I told Maus…"): still on hold
    l.lines.push({ at: Date.now(), who: "you", text: heard });
    changed(l);
    return resume(l, hold, w.action, w.question);
  }
}

/** Off hold: continue the interrupted reply, answer a new question, or just listen. */
async function resume(l: Live, hold: Hold, action: "wake" | "continue" | "ask", question?: string) {
  l.holds.delete(hold.botId);
  const t = hold.turn;
  if (action === "continue" && t && !t.cancelled) {
    t.muted = false;
    l.turn = t;
    const rest = t.phrases.filter((p) => p.seq >= hold.resumeSeq);
    setPhase(l, rest.length || !t.done ? (rest.length ? "speaking" : "thinking") : "listening");
    if (rest.length) await play(l, t.id, rest, { flush: true });
    else if (t.done) await speakLine(l, "That was everything I had.", true);
    return;
  }
  if (action === "wake") {
    // Just the name: listen; "continue" next picks the reply up again (the turn is kept until then).
    l.woke = t && !t.cancelled ? hold : null;
    await speakLine(l, "Yes?", true);
    return;
  }
  if (t) dropTurn(t); // a new question: the rest of the interrupted reply is dropped
  if (action === "continue") return void (await speakLine(l, "Sorry, I'd finished that one. What's next?", true));
  if (question) {
    l.beatUntil = Date.now() + beatFor(question);
    startTurn(l, hold.botId, question, userName());
  }
}

async function conversation(l: Live, botId: string, reason: string) {
  const bot = getBot(botId);
  const botName = bot?.name ?? "Maus";
  const name = userName();
  await bridge("/voice/call-mode", { on: true }).catch(() => {});
  // Newer app: phrase player and on-device listening.
  const prefs = speechPrefs();
  l.player = prefs.natural && Boolean(await bridge("/speech/state", {}).then(() => true).catch(() => false));
  l.local = l.player && Boolean(await bridge<{ onDevice?: boolean }>("/voice/local-available", {}).then((r) => r.onDevice).catch(() => false));
  if (l.player) void bridge("/speech/warm", voiceParams()).catch(() => {});
  await speakLine(l, reason ? `${shortGreeting(name)}, it's ${botName}. ${reason}` : greeting(name), true);
  let silences = 0;
  let failures = 0;
  while (l.active) {
    const w = await waitWhileBusy(l);
    if (!l.active) break;
    let interrupted: Turn | null = null;
    let stoppedAt: { seq: number; fraction: number } | null = null;
    if (w === "speech") {
      // A background job that's now speaking its answer counts as the reply being interrupted.
      const speakingJob = [...l.background].reverse().find((b) => b.spoke && !b.cancelled);
      if (!(l.turn && !l.turn.cancelled) && speakingJob) {
        l.background = l.background.filter((b) => b !== speakingJob);
        l.turn = speakingJob;
      }
      const t = l.turn && !l.turn.cancelled ? l.turn : null;
      if (t && t.working && !t.spoke) {
        // It's working on a job in the background: talking doesn't cancel it.
        l.background.push(t);
        l.turn = null;
      } else if (t) {
        // Stop and keep quiet, but keep the reply until we know what you said.
        (interrupted = t).muted = true;
        stoppedAt = await stopInfo(l, t);
      } else if (l.lines.at(-1)?.who === "maus") l.lines[l.lines.length - 1].interrupted = true;
      l.interruptions++;
      void bridge<{ interruptMs?: number }>("/speech/state", {}).then((st) => (st.interruptMs ?? -1) >= 0 && l.interruptMs.push(st.interruptMs!)).catch(() => {});
    }
    setPhase(l, "listening");
    const r = await listen(l, { preroll: w === "speech" ? 500 : 0 });
    if (!l.active) break;
    if (r.error && !r.missed) {
      if (interrupted) cancelTurn(l);
      l.note = r.error;
      changed(l);
      failures++;
      if (/permission/i.test(r.error) || failures >= 2) {
        await speakLine(l, `Sorry${name ? ` ${name}` : ""}, I can't hear you. ${r.error}`);
        await waitWhileBusy(l);
        break;
      }
      continue;
    }
    failures = 0;
    let text = (r.text ?? "").trim();
    if (!text) {
      if (interrupted) cancelTurn(l);
      if (++silences >= 3) {
        await speakLine(l, `I'll let you go${name ? `, ${name}` : ""}. Talk soon!`);
        await waitWhileBusy(l);
        break;
      }
      if (silences === 2) await speakLine(l, "Are you still there?");
      continue;
    }
    silences = 0;
    l.note = "";
    if (speechPrefs().holdByVoice && isHoldRequest(text)) {
      l.lines.push({ at: Date.now(), who: "you", text });
      changed(l);
      await holdOn(l, botId, botName);
      continue;
    }
    // What talking over it meant: just listening ("yeah", "go on"), stop and listen ("wait, wait"),
    // drop it ("cancel that"), or something new (a correction or request).
    const working = l.background.filter((t) => !t.done && !t.cancelled);
    const kind = interrupted || working.length ? interruptionKind(text) : "content";
    if (kind === "backchannel") {
      if (interrupted && !interrupted.cancelled) await resume(l, { botId, name: botName, turn: interrupted, resumeSeq: stoppedAt ? sentenceStart(interrupted.phrases, stoppedAt.seq) : 0 }, "continue");
      continue; // no new request to the AI
    }
    let note = "";
    if (interrupted) {
      const { heard, unheard } = heardText(interrupted.phrases, stoppedAt);
      // Playback-aware: the AI knows exactly what you heard before you cut in.
      note = `(You were interrupted mid-reply. They heard: "${heard || "nothing yet"}". They did NOT hear: "${unheard || "—"}". Don't repeat what they heard; answer what they said now.)`;
    }
    if (kind === "yield") {
      l.lines.push({ at: Date.now(), who: "you", text });
      changed(l);
      if (interrupted) cancelTurn(l);
      l.carryNote = note; // used with whatever they say next
      continue; // stop talking and listen
    }
    if (kind === "cancel") {
      l.lines.push({ at: Date.now(), who: "you", text });
      if (interrupted) cancelTurn(l);
      for (const t of working) dropTurn(t);
      l.background = [];
      await speakLine(l, "Okay, I've stopped that.");
      continue;
    }
    if (working.length) note = `${note}${note ? " " : ""}(You're still working in the background on: "${working.map((t) => t.asked).join('", "')}". If this changes that, take it into account.)`;
    if (l.carryNote) (note = `${l.carryNote} ${note}`.trim()), (l.carryNote = "");
    // Woken by name alone: "continue" picks the reply up again; anything else is a new turn.
    const woke = l.woke;
    l.woke = null;
    if (woke?.turn && /^(?:please\s+)?(?:continue|carry on|go on|keep going|go ahead|resume|where were we|you were saying)\b/i.test(text)) {
      l.lines.push({ at: Date.now(), who: "you", text });
      await resume(l, woke, "continue");
      continue;
    }
    if (woke?.turn) dropTurn(woke.turn);
    if (interrupted) cancelTurn(l);
    if (speechPrefs().smartWaiting) text = await finishThought(l, text);
    if (!l.active) break;
    l.lines.push({ at: Date.now(), who: "you", text });
    changed(l);
    if (isGoodbye(text)) {
      await speakLine(l, `Bye${name ? ` ${name}` : ""}! Talk soon.`);
      await waitWhileBusy(l);
      break;
    }
    l.beatUntil = Date.now() + beatFor(text);
    l.background = l.background.filter((t) => !t.done && !t.cancelled);
    startTurn(l, botId, text, name, note);
  }
}

/** Where the reply was when you cut in: which phrase, and how much of it you'd heard. */
async function stopInfo(l: Live, t: Turn): Promise<{ seq: number; fraction: number } | null> {
  if (!l.player) return null;
  const st = await bridge<{ stopped?: { turn: string; seq: number } | null; fraction?: number }>("/speech/stop", {}).catch(() => null);
  return st?.stopped?.turn === t.id ? { seq: st.stopped.seq, fraction: Number(st.fraction ?? 0) } : null;
}

/** The beat before answering, scaled by the setting (quick / normal / relaxed). */
export function beatFor(text: string): number {
  const p = speechPrefs();
  if (!p.smartWaiting) return 0;
  return Math.round(beatMs(text) * (p.beat === "quick" ? 0.6 : p.beat === "relaxed" ? 1.5 : 1));
}
