import fs from "node:fs";
import { collection, dataPath } from "./store.ts";
import { id, now } from "./util.ts";
import type { Msg } from "./types.ts";

export type ApprovalMode = "ask-risky" | "ask-all" | "auto";

export interface Bot {
  id: string;
  name: string;
  emoji: string;
  color: string;
  persona: string;
  providerId: string | null;
  model: string | null;
  approvalMode: ApprovalMode;
  tools: { web: boolean; browser: boolean; apps: boolean; phone: boolean };
  skills: string[];
  pinned: boolean;
  hidden: boolean;
  createdAt: string;
  lastMessageAt?: string;
  unread: number;
  /** Claude Code / Codex conversation to resume. */
  cliSession?: string;
  alwaysAllow: string[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "note";
  text: string;
  at: string;
  tool?: { name: string; input?: unknown; result?: string; isError?: boolean; status: "running" | "done" | "denied" };
  status?: "streaming" | "done" | "error" | "stopped";
  source?: string;
}

const botsFile = collection<Bot[]>("bots", []);

export const DEFAULT_BOTS: Partial<Bot>[] = [
  { name: "Maus", emoji: "🐭", color: "#1084fe", persona: "You are Maus, the user's main personal assistant. You are warm, brief and practical. You plan, delegate to tools, and check in before anything risky." },
  { name: "Researcher", emoji: "🔎", color: "#2a9d8f", persona: "You research topics thoroughly using web search and the browser, cite your sources with links, and summarise clearly for a non-technical reader." },
  { name: "Inbox", emoji: "📬", color: "#e76f51", persona: "You look after the user's email, calendar and messages through connected apps. You summarise what matters, draft replies for approval, and never send without approval." },
];

export function listBots(): Bot[] {
  return botsFile.get();
}

export function getBot(botId: string): Bot | undefined {
  return botsFile.get().find((b) => b.id === botId);
}

export function createBot(input: Partial<Bot>): Bot {
  const bot: Bot = {
    id: id("bot"),
    name: input.name?.trim() || "New bot",
    emoji: input.emoji || "🤖",
    color: input.color || "#6c757d",
    persona: input.persona ?? "",
    providerId: input.providerId ?? null,
    model: input.model ?? null,
    approvalMode: input.approvalMode ?? "ask-risky",
    tools: { web: true, browser: true, apps: true, phone: false, ...(input.tools ?? {}) },
    skills: input.skills ?? [],
    pinned: input.pinned ?? false,
    hidden: false,
    createdAt: now(),
    unread: 0,
    alwaysAllow: [],
  };
  botsFile.update((b) => void b.push(bot));
  return bot;
}

export function updateBot(botId: string, patch: Partial<Bot>): Bot {
  let found: Bot | undefined;
  botsFile.update((all) => {
    found = all.find((b) => b.id === botId);
    if (found) Object.assign(found, patch, { id: found.id, createdAt: found.createdAt });
  });
  if (!found) throw new Error("No such bot");
  return found;
}

export function deleteBot(botId: string) {
  botsFile.update((all) => {
    const i = all.findIndex((b) => b.id === botId);
    if (i >= 0) all.splice(i, 1);
  });
  for (const f of [`messages-${botId}`, `history-${botId}`]) fs.rmSync(dataPath("chats", `${f}.json`), { force: true });
}

export function ensureDefaultBots() {
  if (botsFile.get().length) return;
  DEFAULT_BOTS.forEach((b, i) => createBot({ ...b, pinned: i === 0 }));
}

// Chat display messages and the model's history are kept per bot.
const msgs = (botId: string) => collection<ChatMessage[]>(`chats/messages-${botId}`, []);
const hist = (botId: string) => collection<Msg[]>(`chats/history-${botId}`, []);

export function messages(botId: string, before?: string, limit = 60): ChatMessage[] {
  const all = msgs(botId).get();
  let end = all.length;
  if (before) {
    const i = all.findIndex((m) => m.id === before);
    if (i >= 0) end = i;
  }
  return all.slice(Math.max(0, end - limit), end);
}

export function addMessage(botId: string, m: Omit<ChatMessage, "id" | "at"> & { id?: string }): ChatMessage {
  const full: ChatMessage = { id: m.id ?? id("msg"), at: now(), ...m } as ChatMessage;
  msgs(botId).update((a) => void a.push(full));
  return full;
}

export function patchMessage(botId: string, msgId: string, patch: Partial<ChatMessage>): ChatMessage | undefined {
  let found: ChatMessage | undefined;
  msgs(botId).update((a) => {
    found = a.find((x) => x.id === msgId);
    if (found) Object.assign(found, patch);
  });
  return found;
}

export function history(botId: string): Msg[] {
  return hist(botId).get();
}

export function setHistory(botId: string, h: Msg[]) {
  hist(botId).set(h);
}

export function clearChat(botId: string) {
  msgs(botId).set([]);
  hist(botId).set([]);
  updateBot(botId, { cliSession: undefined });
}

export function lastMessage(botId: string): ChatMessage | undefined {
  const a = msgs(botId).get();
  for (let i = a.length - 1; i >= 0; i--) if (a[i].role === "user" || a[i].role === "assistant") return a[i];
  return undefined;
}
