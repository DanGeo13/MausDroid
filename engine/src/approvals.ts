import { emit } from "./events.ts";
import { id } from "./util.ts";
import { getBot, updateBot } from "./bots.ts";
import { notifyUser } from "./notify.ts";

/**
 * Approval and question cards. A bot that wants to do something risky
 * pauses here until you tap Allow / Deny (on the phone, in the
 * notification, or on the website). Questions work the same way.
 */
interface Pending {
  id: string;
  kind: "approval" | "question";
  botId: string;
  title: string;
  detail: string;
  tool?: string;
  options?: string[];
  resolve: (r: { allow: boolean; answer?: string; always?: boolean }) => void;
  createdAt: string;
}
const pending = new Map<string, Pending>();

export function pendingCards() {
  return [...pending.values()].map(({ resolve, ...rest }) => rest);
}

export function requestApproval(botId: string, tool: string, title: string, detail: string, signal?: AbortSignal) {
  const bot = getBot(botId);
  if (bot?.alwaysAllow.includes(tool)) return Promise.resolve({ allow: true });
  return open({ kind: "approval", botId, tool, title, detail }, signal);
}

export function askQuestion(botId: string, question: string, options: string[] | undefined, signal?: AbortSignal) {
  return open({ kind: "question", botId, title: question, detail: "", options }, signal);
}

function open(p: Omit<Pending, "id" | "resolve" | "createdAt">, signal?: AbortSignal) {
  return new Promise<{ allow: boolean; answer?: string; always?: boolean }>((resolve) => {
    const card: Pending = { ...p, id: id("card"), createdAt: new Date().toISOString(), resolve };
    pending.set(card.id, card);
    const { resolve: _r, ...pub } = card;
    emit("card", { card: pub });
    const bot = getBot(p.botId);
    void notifyUser({
      title: `${bot?.emoji ?? "🤖"} ${bot?.name ?? "Bot"} ${p.kind === "approval" ? "needs your OK" : "has a question"}`,
      body: p.kind === "approval" ? `${p.title}\n${p.detail}`.slice(0, 300) : p.title,
      botId: p.botId,
      cardId: card.id,
      actions: p.kind === "approval" ? ["Allow", "Deny"] : undefined,
      priority: "high",
    });
    signal?.addEventListener("abort", () => settle(card.id, { allow: false, answer: "(stopped)" }), { once: true });
  });
}

export function settle(cardId: string, r: { allow: boolean; answer?: string; always?: boolean }) {
  const card = pending.get(cardId);
  if (!card) return false;
  pending.delete(cardId);
  if (r.always && card.tool) {
    const bot = getBot(card.botId);
    if (bot && !bot.alwaysAllow.includes(card.tool)) updateBot(bot.id, { alwaysAllow: [...bot.alwaysAllow, card.tool] });
  }
  emit("card.settled", { cardId, allow: r.allow, answer: r.answer });
  card.resolve(r);
  return true;
}
