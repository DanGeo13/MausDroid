import { bridge, bridgeAvailable } from "./bridge.ts";
import { onTurnEnd, sendToBot } from "./agent.ts";
import { getBot, listBots } from "./bots.ts";
import { settings } from "./settings.ts";
import { notifyUser } from "./notify.ts";

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

export async function speak(text: string) {
  if (!bridgeAvailable() || !text.trim()) return;
  await bridge("/voice/speak", { text: speakable(text), rate: settings().voice.rate }).catch(() => {});
}

/** Bots that last heard you by voice answer out loud (setting: "voice" / "always" / "never"). */
const spokenTo = new Set<string>();
export function sendByVoice(botId: string, text: string) {
  spokenTo.add(botId);
  return sendToBot(botId, text, "voice");
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
export function askAssistant(text: string, waitMs = 75_000): Promise<{ botId: string; botName: string; reply: string | null }> {
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
    sendToBot(bot.id, text, "assistant");
  });
}
