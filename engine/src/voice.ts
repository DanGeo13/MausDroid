import { bridge, bridgeAvailable } from "./bridge.ts";
import { onTurnEnd, sendToBot } from "./agent.ts";
import { getBot, listBots } from "./bots.ts";
import { settings, speechPrefs } from "./settings.ts";
import { CUE_GUIDE, SPOKEN_STYLE, SpeechChunker, planPhrase, stripCues } from "./speech-style.ts";
import { notifyUser } from "./notify.ts";
import type { Attachment } from "./files.ts";

/**
 * Voice and the digital assistant. Speech in and out use the phone's own
 * speech recognition and voice (free, works with any bot, including your
 * Claude / ChatGPT / Gemini subscriptions). API and local voices can be added
 * later as other engines.
 */

/** Makes a reply nicer to listen to: no Markdown symbols or long links. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_#>`|]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
}

/** The voice chosen in Settings: speed, engine (e.g. Kokoro), voice and pitch. */
export function voiceParams() {
  const v = settings().voice;
  return { rate: v.rate, engine: v.ttsEngine ?? "", voice: v.voiceName ?? "", pitch: v.pitch ?? 1 };
}

let playerSeen: { ok: boolean; at: number } | null = null;
/** The phone has the phrase player (newer app); checked again after a minute if not. */
async function hasPlayer(): Promise<boolean> {
  if (playerSeen && (playerSeen.ok || Date.now() - playerSeen.at < 60_000)) return playerSeen.ok;
  const ok = await bridge("/speech/state", {}, 3000).then(() => true).catch(() => false);
  playerSeen = { ok, at: Date.now() };
  return ok;
}

/** Text → what the phrase player plays: phrases with any delivery cues (pauses, speed, pitch, reactions). */
export function speechItems(text: string) {
  const c = new SpeechChunker();
  const pieces = [...c.push(`${text}\n`), c.flush()].filter(Boolean);
  const reactions = speechPrefs().reactions;
  return pieces.flatMap((p, seq) => planPhrase(speakable(p)).map((it) => ({ ...it, seq }))).filter((i) => reactions || i.kind !== "clip");
}

/** Speaks text; with wait=true returns only when the phone has finished speaking (for calls). */
export async function speak(text: string, wait = false) {
  if (!bridgeAvailable() || !text.trim()) return;
  // Natural speech: phrase by phrase through the voice engine (e.g. Phonon), with delivery cues.
  if (speechPrefs().natural && (await hasPlayer())) {
    const items = speechItems(text);
    if (!items.length) return;
    const ok = await bridge("/speech/enqueue", { items, turn: "read", flush: true, ...voiceParams() }, 10_000).then(() => true).catch(() => false);
    if (ok) {
      if (wait) for (let i = 0; i < 900; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const st = await bridge<{ speaking?: boolean }>("/speech/state", {}).catch(() => ({ speaking: false }));
        if (!st.speaking) break;
      }
      return;
    }
  }
  await bridge("/voice/speak", { text: speakable(stripCues(text)), ...voiceParams(), wait }, wait ? 180_000 : 60_000).catch(() => {});
}

/** Adds a piece to what's being said, without waiting (calls speak replies as they arrive). */
export async function say(text: string, flush = false) {
  const t = speakable(stripCues(text));
  if (!bridgeAvailable() || !t) return;
  await bridge("/voice/say", { text: t, ...voiceParams(), flush }, 15_000).catch(() => {});
}

/** Bots that last heard you by voice answer out loud (setting: "voice" / "always" / "never"). */
const spokenTo = new Set<string>();
export function sendByVoice(botId: string, text: string) {
  spokenTo.add(botId);
  // The answer will be heard: spoken style, with optional delivery cues (never shown in the chat).
  const p = speechPrefs();
  const hint = p.natural ? `(Said aloud; your reply is read out.\n${SPOKEN_STYLE}\n${CUE_GUIDE})` : undefined;
  return sendToBot(botId, text, "voice", [], undefined, hint);
}

onTurnEnd((botId, reply) => {
  const mode = settings().voice.readReplies;
  const asked = spokenTo.delete(botId);
  if (mode === "always" || (mode === "voice" && asked)) void speak(reply);
});

export function assistantBot() {
  const id = settings().assistant.botId;
  const bots = listBots().filter((b) => !b.hidden);
  return (id && getBot(id)) || bots.find((b) => b.pinned) || bots[0];
}

/**
 * The assistant asks a bot and waits for the answer (up to `waitMs`). Long
 * jobs keep running; the person gets a notification when they finish.
 */
export interface ScreenContext {
  app?: string;
  url?: string;
  text?: string;
}

export function askAssistant(text: string, attachments: Attachment[] = [], screen?: ScreenContext, waitMs = 75_000): Promise<{ botId: string; botName: string; reply: string | null }> {
  const bot = assistantBot();
  if (!bot) throw new Error("Create a bot first.");
  return new Promise((resolve) => {
    let done = false;
    const off = onTurnEnd((botId, reply) => {
      if (botId !== bot.id || done) return;
      done = true;
      off();
      clearTimeout(t);
      resolve({ botId: bot.id, botName: bot.name, reply });
    });
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      off();
      resolve({ botId: bot.id, botName: bot.name, reply: null });
      // Still working: send the answer as a notification when it's ready.
      const later = onTurnEnd((botId, reply) => {
        if (botId !== bot.id) return;
        later();
        void notifyUser({ title: `${bot.emoji} ${bot.name}`, body: reply.slice(0, 400) || "Finished.", botId: bot.id, priority: "high" });
      });
    }, waitMs);
    // What was on screen when the assistant was opened (only when the person allows it).
    const parts = [text];
    if (screen && (screen.text || screen.url || screen.app)) {
      parts.push(
        `\n[Screen context — what the person was looking at when they asked${screen.app ? `, in ${screen.app}` : ""}${screen.url ? `, page ${screen.url}` : ""}. Use it only if relevant; it may include private info.]${screen.text ? `\n${screen.text.slice(0, 6000)}` : ""}`,
      );
    }
    const sp = speechPrefs();
    sendToBot(bot.id, parts.join("\n"), "assistant", attachments, undefined, settings().assistant.speak && sp.natural ? `(Your reply is read out.\n${SPOKEN_STYLE}\n${CUE_GUIDE})` : undefined);
  });
}
