import { bridge } from "./bridge.ts";
import { emit } from "./events.ts";
import { onTurnEnd, sendToBot } from "./agent.ts";
import { getMainBotId } from "./playbook.ts";
import { getOverview, overviewFile, overviewSource, type Segment } from "./audio-overview.ts";
import { filePath } from "./files.ts";
import { listen, makePhrase, play, SpeechChunker } from "./call-session.ts";
import { SPOKEN_STYLE } from "./speech-style.ts";
import { id as newId, sleep } from "./util.ts";

/**
 * Hands-free podcast listening: the episode plays through the phone's
 * phrase player (call audio path, so the echo canceller ignores it) while
 * the microphone listens. Say "pause, explain that last bit": it stops,
 * saves the position, and the main assistant answers briefly from the
 * segment just heard and the source. "Continue" resumes from the saved
 * position. Tapping a transcript line jumps there.
 */
type State = "playing" | "paused" | "explaining" | "ended";
interface Session {
  id: string;
  overviewId: string;
  state: State;
  positionMs: number;
  note: string;
  active: boolean;
  local: boolean;
  /** Last explanation (shown on the screen). */
  answer?: string;
  seekTo: number | null;
}
const sessions = new Map<string, Session>();
const view = (s: Session) => ({ overviewId: s.overviewId, state: s.state, positionMs: s.positionMs, note: s.note, active: s.active, answer: s.answer });
export const podcastSession = (oid: string) => {
  const s = sessions.get(oid);
  return s ? view(s) : null;
};
const changed = (s: Session) => emit("podcast.live", { overviewId: s.overviewId, state: s.state });

/** The segment playing at a position (the one before it if this one only just started). */
export function segmentAt(segments: Segment[], ms: number): { seg: Segment | null; prev: Segment | null } {
  let i = segments.findIndex((x) => ms >= x.startMs && ms < x.endMs + 350);
  if (i < 0) i = segments.reduce((best, x, j) => (x.startMs <= ms ? j : best), -1);
  if (i > 0 && ms - segments[i].startMs < 1500) i--; // "that last bit" = what was just said
  return { seg: i >= 0 ? segments[i] : null, prev: i > 0 ? segments[i - 1] : null };
}

/** The part of the source around a quote (or the start of it). */
export function sourceAround(source: string, quote?: string, span = 900): string {
  if (!source) return "";
  const at = quote ? source.toLowerCase().indexOf(quote.toLowerCase().slice(0, 60)) : -1;
  if (at < 0) return source.slice(0, span * 2);
  return source.slice(Math.max(0, at - span), at + quote!.length + span);
}

export type Command = "continue" | "explain" | "repeat" | "pause" | "stop";
/** What you asked while it played. */
export function commandFrom(text: string): Command {
  const t = text.toLowerCase();
  if (/\b(stop listening|stop the podcast|that's enough|turn it off|close it|end it)\b/.test(t)) return "stop";
  if (/\b(explain|what (does|did) (that|this|it|she|he) mean|what do you mean|clarify|i don't (get|understand)|what was that about|tell me more|what's that)\b/.test(t)) return "explain";
  if (/\b(say that again|repeat that|go back|replay|again please|what did (she|he|they) say)\b/.test(t)) return "repeat";
  if (/^(ok(ay)?[, ]+)?(continue|carry on|keep going|go on|resume|play|go ahead|thanks?,? continue)\b/.test(t.trim()) || /\b(continue|carry on|keep going)\b/.test(t)) return "continue";
  return "pause";
}

async function playFrom(s: Session, ms: number) {
  const o = getOverview(s.overviewId);
  const f = o && overviewFile(o);
  if (!f) throw new Error("This episode's audio file is missing.");
  s.positionMs = ms;
  s.state = "playing";
  changed(s);
  await bridge("/speech/enqueue", { items: [{ kind: "audio", path: filePath(f), startMs: Math.max(0, Math.round(ms)), seq: 0 }], turn: `pod:${s.overviewId}`, flush: true }, 10_000);
}

async function explain(s: Session, question: string) {
  const o = getOverview(s.overviewId)!;
  const { seg, prev } = segmentAt(o.segments ?? [], s.positionMs);
  const src = sourceAround(overviewSource(o.id), seg?.source?.quote);
  // The last words heard before the pause (word timings), so "that last bit" is exact.
  const heardWords = (seg?.words ?? []).filter((w) => w.ms <= s.positionMs).slice(-14).map((w) => w.w).join(" ");
  const botId = getMainBotId();
  s.state = "explaining";
  changed(s);
  if (!botId) return;
  const tag = newId("podask");
  const reply = await new Promise<string>((resolve) => {
    const off = onTurnEnd((b, text, info) => {
      if (b !== botId || !(info?.tags ?? []).includes(tag)) return;
      off();
      resolve(text?.trim() || "Sorry, I couldn't work that out.");
    });
    setTimeout(() => (off(), resolve("Sorry, that's taking too long — say continue to keep listening.")), 60_000);
    sendToBot(
      botId,
      `While listening to the podcast "${o.title}", I paused and asked: "${question}"\n\n${heardWords ? `The last words heard before pausing: "…${heardWords}"\n` : ""}What was just said:\n${prev ? `${prev.host === "female" ? "Host A" : "Host B"}: ${prev.text}\n` : ""}${seg ? `${seg.host === "female" ? "Host A" : "Host B"}: ${seg.text}` : "(start of the episode)"}\n\n${src ? `The source it's based on:\n${src}\n\n` : ""}Answer briefly out loud (one to three short sentences), only from what's above; say so if the source doesn't cover it. I'll say "continue" to resume the episode.\n${SPOKEN_STYLE}`,
      "voice",
      [],
      tag,
    );
  });
  if (!s.active) return;
  s.answer = reply;
  const c = new SpeechChunker();
  const phrases = [...c.push(`${reply}\n`), c.flush()].filter(Boolean).map((p, i) => makePhrase(i, p, true));
  await play({ player: true }, `podans:${s.overviewId}`, phrases, { flush: true });
  s.state = "paused";
  changed(s);
}

/** Waits for the episode / answer to finish, or for you to start talking. */
async function waitForSpeech(s: Session): Promise<"speech" | "idle"> {
  while (s.active) {
    if (s.seekTo !== null) return "idle";
    const st = await bridge<{ speech?: boolean; speaking?: boolean; error?: string }>("/voice/await-speech", { maxMs: 250, bargeIn: true }, 5000).catch((e) => ({ error: (e as Error).message, speech: false, speaking: false }));
    if (st.speech) return "speech";
    const p = await bridge<{ positionMs?: number }>("/speech/state", {}).catch(() => ({ positionMs: -1 }));
    if ((p.positionMs ?? -1) >= 0) s.positionMs = p.positionMs!;
    if (st.error) {
      s.note = st.error;
      await sleep(300);
    }
    if (!st.speaking) return "idle";
  }
  return "idle";
}

async function run(s: Session, fromMs: number) {
  await bridge("/voice/call-mode", { on: true }).catch(() => {});
  s.local = Boolean(await bridge<{ onDevice?: boolean }>("/voice/local-available", {}).then((r) => r.onDevice).catch(() => false));
  await playFrom(s, fromMs);
  while (s.active) {
    const w = await waitForSpeech(s);
    if (!s.active) break;
    if (s.seekTo !== null) {
      const to = s.seekTo;
      s.seekTo = null;
      await playFrom(s, to);
      continue;
    }
    if (w === "speech" || s.state === "paused") {
      // Stopped by your voice: keep the exact spot.
      const st = await bridge<{ stoppedAtMs?: number }>("/speech/state", {}).catch(() => ({ stoppedAtMs: -1 }));
      if (w === "speech" && s.state === "playing" && (st.stoppedAtMs ?? -1) >= 0) s.positionMs = st.stoppedAtMs!;
      if (s.state === "playing") (s.state = "paused"), changed(s);
      const heard = await listen(s, { preroll: w === "speech" ? 500 : 0, silenceMs: 800, timeoutSec: 60 });
      if (!s.active) break;
      const text = (heard.text ?? "").trim();
      if (!text) continue;
      const cmd = commandFrom(text);
      if (cmd === "stop") break;
      if (cmd === "continue") await playFrom(s, s.positionMs);
      else if (cmd === "repeat") await playFrom(s, segmentAt(getOverview(s.overviewId)?.segments ?? [], s.positionMs).seg?.startMs ?? s.positionMs);
      else if (cmd === "explain") await explain(s, text);
      continue;
    }
    if (s.state === "playing") break; // reached the end
  }
}

/** Starts hands-free listening from a position (ms). */
export function startPodcast(oid: string, fromMs = 0) {
  const o = getOverview(oid);
  if (!o || o.status !== "ready") throw new Error("This episode isn't ready.");
  const old = sessions.get(oid);
  if (old?.active) {
    old.seekTo = Math.max(0, fromMs);
    return view(old);
  }
  const s: Session = { id: newId("pod"), overviewId: oid, state: "playing", positionMs: fromMs, note: "", active: true, local: false, seekTo: null };
  sessions.set(oid, s);
  void run(s, fromMs)
    .catch((e) => (s.note = (e as Error).message))
    .finally(async () => {
      s.active = false;
      s.state = "ended";
      changed(s);
      await bridge("/speech/stop", {}).catch(() => {});
      await bridge("/voice/watch-stop", {}).catch(() => {});
      await bridge("/voice/call-mode", { on: false }).catch(() => {});
    });
  return view(s);
}

export async function stopPodcast(oid: string) {
  const s = sessions.get(oid);
  if (s) s.active = false;
  await bridge("/speech/stop", {}).catch(() => {});
  return s ? view(s) : null;
}
