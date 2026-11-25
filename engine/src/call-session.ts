import { bridge } from "./bridge.ts";
import { emit, subscribe } from "./events.ts";
import { currentRunTags, onTurnEnd, sendToBot, stopBot } from "./agent.ts";
import { getBot } from "./bots.ts";
import { readMemory } from "./memory.ts";
import { say } from "./voice.ts";
import { callSettings, endCall, getCall } from "./calls.ts";
import { id as newId, sleep } from "./util.ts";

/**
 * A live voice call, run by the engine (so it keeps going with the screen
 * off). Maus greets you by name for the time of day, then:
 *  - listens (the phone's speech recognition),
 *  - starts speaking as soon as the first words of its reply arrive, piece
 *    by piece, instead of waiting for the whole answer,
 *  - keeps listening in 20 ms slices while it thinks or talks: when you
 *    start speaking it stops at once (and drops the rest of that answer),
 *    then hears what you say.
 */

// ---------------- Greeting ----------------

const TEMPLATES = {
  late: ["Hey{ n}, you're up late. What's up?", "Hi{ n}, burning the midnight oil? What can I do?", "Hey{ n}. Late one tonight — what do you need?"],
  morning: ["Morning{, n}!", "Good morning{, n}. What can I do for you?", "Hey{ n}, how you going this morning?", "Morning{, n} — what's up?", "G'day{ n}! What's on this morning?"],
  afternoon: ["Afternoon{, n}!", "Good afternoon{, n}. What do you need?", "Hey{ n}, how's the day going?", "G'day{ n}, what's up?", "Hey{ n}, how you going?"],
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

/** A short opener for calls Maus makes: "Morning, Dan" / "Hey Dan" / "G'day Dan". */
export function shortGreeting(name: string, at = new Date(), pick = Math.random): string {
  const part = { late: "Hi", morning: "Morning", afternoon: "Afternoon", evening: "Evening" }[partOfDay(at)];
  const list = [`${part}{, n}`, "Hey{ n}", "G'day{ n}"];
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

// ---------------- The call ----------------

type Phase = "connecting" | "listening" | "thinking" | "speaking" | "ended";
interface Turn {
  id: string;
  botId: string;
  done: boolean;
  cancelled: boolean;
  spoke: boolean;
  line: number;
  off: () => void;
}
export interface Live {
  callId: string;
  phase: Phase;
  lines: { who: "you" | "maus"; text: string; interrupted?: boolean }[];
  note: string;
  active: boolean;
  interruptions: number;
  turn: Turn | null;
}

const live = new Map<string, Live>();
export const liveCall = (callId: string) => {
  const l = live.get(callId);
  return l ? { callId, phase: l.phase, lines: l.lines.slice(-12), note: l.note, active: l.active, interruptions: l.interruptions } : null;
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
  const l: Live = { callId, phase: "connecting", lines: [], note: "", active: true, interruptions: 0, turn: null };
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

async function finish(l: Live) {
  l.active = false;
  cancelTurn(l);
  setPhase(l, "ended");
  await bridge("/voice/call-mode", { on: false }).catch(() => {});
  endCall(l.callId);
  setTimeout(() => live.delete(l.callId), 10 * 60_000);
}

function cancelTurn(l: Live) {
  const t = l.turn;
  if (!t || t.done) return;
  t.cancelled = true;
  t.done = true;
  t.off();
  if (currentRunTags(t.botId).includes(t.id)) stopBot(t.botId);
  if (l.lines[t.line]) l.lines[t.line].interrupted = true;
  l.turn = null;
}

async function speakLine(l: Live, text: string, flush = false) {
  l.lines.push({ who: "maus", text });
  setPhase(l, "speaking");
  await say(text, flush);
}

/** Waits while Maus thinks or talks; returns "speech" the moment you start talking. */
async function waitWhileBusy(l: Live): Promise<"speech" | "idle"> {
  let errors = 0;
  while (l.active) {
    const busy = Boolean(l.turn && !l.turn.done);
    const st = await bridge<{ speech?: boolean; speaking?: boolean; error?: string }>("/voice/await-speech", { maxMs: 250, bargeIn: true }, 5000).catch((e) => ({ error: (e as Error).message, speech: false, speaking: false }));
    if (st.speech) return "speech";
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

function startTurn(l: Live, botId: string, text: string, name: string) {
  const id = newId("callturn");
  const chunker = new SpeechChunker();
  const turn: Turn = { id, botId, done: false, cancelled: false, spoke: false, line: -1, off: () => {} };
  l.turn = turn;
  setPhase(l, "thinking");
  const speakPiece = (piece: string) => {
    if (turn.cancelled) return;
    if (turn.line < 0) {
      l.lines.push({ who: "maus", text: piece });
      turn.line = l.lines.length - 1;
    } else l.lines[turn.line].text += ` ${piece}`;
    turn.spoke = true;
    setPhase(l, "speaking");
    void say(piece);
  };
  const unsub = subscribe((e) => {
    if (turn.cancelled || e.type !== "message.delta" || e.botId !== botId) return;
    if (!currentRunTags(botId).includes(id)) return;
    for (const piece of chunker.push(String(e.delta ?? ""))) speakPiece(piece);
  });
  const offEnd = onTurnEnd((b, reply, info) => {
    if (b !== botId || !(info?.tags ?? []).includes(id) || turn.done) return;
    turn.done = true;
    turn.off();
    if (turn.cancelled) return;
    const rest = chunker.flush();
    if (rest) speakPiece(rest);
    // A reply that didn't stream (some AIs) is spoken whole.
    if (!turn.spoke) speakPiece(reply?.trim() || (info?.failed ? "Sorry, something went wrong there." : "Done."));
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
  };
  sendToBot(
    botId,
    `${text}\n\n(Said aloud during a phone call with ${name || "you"}. Reply like natural spoken conversation: start with the answer in a short first sentence, one to three short sentences in all, no lists, links or formatting.)`,
    "call",
    [],
    id,
  );
}

async function conversation(l: Live, botId: string, reason: string) {
  const bot = getBot(botId);
  const name = userName();
  await bridge("/voice/call-mode", { on: true }).catch(() => {});
  await speakLine(l, reason ? `${shortGreeting(name)}, it's ${bot?.name ?? "Maus"}. ${reason}` : greeting(name), true);
  let silences = 0;
  let failures = 0;
  while (l.active) {
    const w = await waitWhileBusy(l);
    if (!l.active) break;
    if (w === "speech") {
      if (l.turn && !l.turn.done) cancelTurn(l);
      else if (l.lines.at(-1)?.who === "maus") l.lines[l.lines.length - 1].interrupted = true;
      l.interruptions++;
    }
    setPhase(l, "listening");
    const r = await bridge<{ text?: string; missed?: boolean; error?: string }>("/voice/listen", { soft: true, silenceMs: 700, timeoutSec: 30 }, 40_000).catch((e) => ({ text: "", missed: false, error: (e as Error).message }));
    if (!l.active) break;
    if (r.error && !r.missed) {
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
    const text = (r.text ?? "").trim();
    if (!text) {
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
    l.lines.push({ who: "you", text });
    changed(l);
    if (isGoodbye(text)) {
      await speakLine(l, `Bye${name ? ` ${name}` : ""}! Talk soon.`);
      await waitWhileBusy(l);
      break;
    }
    startTurn(l, botId, text, name);
  }
}
