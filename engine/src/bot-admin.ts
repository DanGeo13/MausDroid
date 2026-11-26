import { collection } from "./store.ts";
import { emit } from "./events.ts";
import { clip, id as newId, now } from "./util.ts";
import { getBot, listBots, updateBot, type Bot } from "./bots.ts";

/**
 * Bots changing other bots (Maus with your approval; Improver as admin),
 * with every change recorded so it can be undone.
 */
export type BotFields = Pick<Bot, "name" | "emoji" | "color" | "persona" | "providerId" | "model" | "tools" | "skills" | "approvalMode" | "disabledTools">;
const FIELDS: (keyof BotFields)[] = ["name", "emoji", "color", "persona", "providerId", "model", "tools", "skills", "approvalMode", "disabledTools"];

export interface BotChange {
  id: string;
  at: string;
  botId: string;
  botName: string;
  by: string;
  before: Partial<BotFields>;
  after: Partial<BotFields>;
  undoneAt?: string;
}
const changes = collection<BotChange[]>("bot-changes", []);
export const listBotChanges = () => changes.get().slice().reverse().slice(0, 60);

export interface BotEditInput {
  bot_id?: string;
  name?: string;
  emoji?: string;
  persona?: string;
  provider_id?: string | null;
  model?: string | null;
  tools?: Partial<Bot["tools"]>;
  enable_tools?: string[];
  disable_tools?: string[];
  skills?: string[];
  approval_mode?: Bot["approvalMode"];
}

/** Finds a bot by id or (case-insensitive) name. */
export function findBot(ref: string): Bot | undefined {
  const r = String(ref ?? "").trim();
  return getBot(r) ?? listBots().find((b) => b.name.trim().toLowerCase() === r.toLowerCase());
}

/** Works out the new values (and what they were) without changing anything. */
export function planBotEdit(editor: Bot, i: BotEditInput): { target: Bot; before: Partial<BotFields>; after: Partial<BotFields> } {
  const target = findBot(String(i.bot_id ?? ""));
  if (!target) throw new Error(`No bot "${i.bot_id}". Use bot_list to see them.`);
  const after: Partial<BotFields> = {};
  if (i.name !== undefined) {
    if (!String(i.name).trim()) throw new Error("A bot needs a name.");
    after.name = String(i.name).trim().slice(0, 60);
  }
  if (i.emoji !== undefined) after.emoji = String(i.emoji).slice(0, 8);
  if (i.persona !== undefined) after.persona = clip(String(i.persona), 8000);
  if (i.provider_id !== undefined) after.providerId = i.provider_id || null;
  if (i.model !== undefined) after.model = i.model || null;
  if (i.tools) after.tools = { ...target.tools, ...Object.fromEntries(Object.entries(i.tools).filter(([k]) => ["web", "browser", "apps", "phone"].includes(k)).map(([k, v]) => [k, Boolean(v)])) } as Bot["tools"];
  if (i.enable_tools?.length || i.disable_tools?.length) {
    const off = new Set(target.disabledTools ?? []);
    for (const t of i.enable_tools ?? []) off.delete(String(t));
    for (const t of i.disable_tools ?? []) off.add(String(t));
    after.disabledTools = [...off].sort();
  }
  if (i.skills !== undefined) after.skills = (i.skills ?? []).map(String);
  if (i.approval_mode !== undefined) {
    if (!["ask-risky", "ask-all", "auto"].includes(i.approval_mode)) throw new Error("approval_mode is ask-risky, ask-all or auto.");
    // No bot can loosen its own approvals.
    if (target.id === editor.id) throw new Error("A bot can't change its own approval settings — only you can, in the bot editor.");
    after.approvalMode = i.approval_mode;
  }
  if (!Object.keys(after).length) throw new Error("Nothing to change.");
  const before: Partial<BotFields> = {};
  for (const k of Object.keys(after) as (keyof BotFields)[]) (before as any)[k] = (target as any)[k] ?? null;
  return { target, before, after };
}

export function describeEdit(target: Bot, before: Partial<BotFields>, after: Partial<BotFields>): string {
  const show = (v: unknown) => clip(typeof v === "string" ? v : JSON.stringify(v ?? null), 160);
  return `Change ${target.emoji} ${target.name}: ${Object.keys(after)
    .map((k) => `${k}: ${show((before as any)[k])} → ${show((after as any)[k])}`)
    .join("; ")}`;
}

export function applyBotEdit(editor: Bot, i: BotEditInput): BotChange {
  const { target, before, after } = planBotEdit(editor, i);
  updateBot(target.id, after as Partial<Bot>);
  const c: BotChange = { id: newId("bchg"), at: now(), botId: target.id, botName: after.name ?? target.name, by: editor.name, before, after };
  changes.update((l) => {
    l.push(c);
    if (l.length > 300) l.splice(0, l.length - 300);
  });
  emit("settings.changed");
  return c;
}

/** Puts a bot back how it was before a change (if nothing changed those fields since). */
export function undoBotChange(cid: string): BotChange {
  const c = changes.get().find((x) => x.id === cid);
  if (!c) throw new Error("No such change.");
  if (c.undoneAt) throw new Error("Already undone.");
  const bot = getBot(c.botId);
  if (!bot) throw new Error("That bot no longer exists.");
  const moved = (Object.keys(c.after) as (keyof BotFields)[]).find((k) => JSON.stringify((bot as any)[k] ?? null) !== JSON.stringify((c.after as any)[k] ?? null));
  if (moved) throw new Error(`The bot's ${moved} has changed again since, so this can't be undone automatically.`);
  updateBot(bot.id, c.before as Partial<Bot>);
  changes.update((l) => {
    const x = l.find((y) => y.id === cid);
    if (x) x.undoneAt = now();
  });
  emit("settings.changed");
  return { ...c, undoneAt: now() };
}

export function botSummary(b: Bot) {
  return { id: b.id, name: b.name, emoji: b.emoji, persona: clip(b.persona, 600), providerId: b.providerId, model: b.model, tools: b.tools, disabledTools: b.disabledTools ?? [], skills: b.skills, approvalMode: b.approvalMode, pinned: b.pinned };
}

/** Turns one tool on or off for several bots at once (Settings → Tools). */
export function setToolForBots(tool: string, botIds: string[], enabled: boolean) {
  for (const id of botIds) {
    const b = getBot(id);
    if (!b) continue;
    const off = new Set(b.disabledTools ?? []);
    if (enabled) off.delete(tool);
    else off.add(tool);
    updateBot(id, { disabledTools: [...off].sort() });
  }
  emit("settings.changed");
}

export { FIELDS };
