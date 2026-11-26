import fs from "node:fs";
import path from "node:path";
import { collection, dataPath } from "./store.ts";
import { emit } from "./events.ts";
import { clip, docxText, id as newId, now } from "./util.ts";
import { getBot, listBots, type Bot } from "./bots.ts";

/**
 * Your playbook: how your assistant should work with you (e.g. documents
 * written for a previous assistant). Kept only on this phone — never in
 * MausDroid's code. Documents set to "always" are part of the main
 * assistant's instructions; "reference" ones are looked up when needed.
 * Corrections are added to it straight away, with a change log line.
 */
export interface PlaybookDoc {
  id: string;
  name: string;
  importedAt: string;
  mode: "always" | "reference";
  chars: number;
}
export interface PlaybookState {
  docs: PlaybookDoc[];
  /** "main" = the main assistant (Maus) and Improver; "all" = every bot. */
  appliesTo: "main" | "all";
}

const store = collection<PlaybookState>("playbook", { docs: [], appliesTo: "main" });
const docPath = (pid: string) => dataPath("playbook", `${pid}.md`);
export const playbookState = () => store.get();
export const readDoc = (pid: string) => {
  try {
    return fs.readFileSync(docPath(pid), "utf8");
  } catch {
    return "";
  }
};

/** Turns an uploaded file into text: Word (.docx) or any text/markdown file. */
export function fileToText(name: string, buf: Buffer): string {
  if (/\.docx$/i.test(name) || (buf[0] === 0x50 && buf[1] === 0x4b)) return docxText(buf);
  const t = buf.toString("utf8").replace(/^﻿/, "");
  if (/\u0000/.test(t)) throw new Error("That file isn't text or a Word document.");
  return t;
}

export function importDoc(name: string, buf: Buffer, mode?: PlaybookDoc["mode"]): PlaybookDoc {
  const text = fileToText(name, buf).trim();
  if (text.length < 20) throw new Error("That file has almost no text in it.");
  const doc: PlaybookDoc = {
    id: newId("pb"),
    name: clip(path.basename(name || "playbook"), 120),
    importedAt: now(),
    // Short documents (like a playbook) are followed always; long ones are kept for reference.
    mode: mode ?? (text.length <= 16_000 ? "always" : "reference"),
    chars: text.length,
  };
  fs.mkdirSync(path.dirname(docPath(doc.id)), { recursive: true });
  fs.writeFileSync(docPath(doc.id), text);
  store.update((s) => void s.docs.push(doc));
  emit("settings.changed");
  return doc;
}

export function updateDoc(pid: string, patch: { mode?: PlaybookDoc["mode"] }) {
  store.update((s) => {
    const d = s.docs.find((x) => x.id === pid);
    if (!d) throw new Error("No such document.");
    if (patch.mode === "always" || patch.mode === "reference") d.mode = patch.mode;
  });
  emit("settings.changed");
}

export function removeDoc(pid: string) {
  store.update((s) => {
    s.docs = s.docs.filter((d) => d.id !== pid);
  });
  fs.rmSync(docPath(pid), { force: true });
  emit("settings.changed");
}

export function setAppliesTo(v: PlaybookState["appliesTo"]) {
  if (v !== "main" && v !== "all") throw new Error("Choose main or all.");
  store.update((s) => void (s.appliesTo = v));
  emit("settings.changed");
}

/** The main assistant: the bot named Maus, else the pinned bot. */
function mainBot(): Bot | undefined {
  const bots = listBots().filter((b) => !b.hidden);
  return bots.find((b) => b.name.trim().toLowerCase() === "maus") ?? bots.find((b) => b.pinned) ?? bots[0];
}
export function appliesTo(bot: Bot): boolean {
  const s = store.get();
  if (!s.docs.length) return false;
  if (s.appliesTo === "all") return true;
  return bot.id === mainBot()?.id || bot.name === "Improver";
}

const HEADER = (bot: Bot) => `\n\n# The person's playbook (how to work with them)
These are the person's own rules, imported from documents they wrote with a previous assistant. Follow them closely; they're the person's standing instructions.
- If they name a previous assistant (e.g. "Tilly"), that now means you, ${bot.name}. Treat other assistant or bot names in them as the previous system's.
- Tools, scripts or boards they name that MausDroid doesn't have (e.g. run_script, named scripts, Cron 1, an Email board): use MausDroid's own tools for the same job, or say plainly it isn't set up here yet — never pretend.
- MausDroid's approval cards always apply. Where the playbook is stricter (e.g. never send a first draft, never delete email), follow the playbook.
- When the person corrects you or sets a new rule, add it with playbook_add straight away so they never have to repeat it.`;

/** The playbook part of a bot's instructions. */
export function playbookContext(bot: Bot): string {
  if (!appliesTo(bot)) return "";
  const s = store.get();
  const always = s.docs.filter((d) => d.mode === "always");
  const ref = s.docs.filter((d) => d.mode === "reference");
  let budget = 40_000;
  const parts: string[] = [];
  for (const d of always) {
    const t = readDoc(d.id);
    if (!t) continue;
    parts.push(`\n\n## ${d.name}\n${t.slice(0, budget)}`);
    budget -= Math.min(t.length, budget);
    if (budget <= 0) break;
  }
  const refs = ref.length ? `\n\nReference documents (open with playbook_read when a task needs them): ${ref.map((d) => `${d.name} (id ${d.id})`).join("; ")}.` : "";
  return `${HEADER(bot)}${parts.join("")}${refs}`;
}

/** Adds a rule under a section of the main playbook document, with a change log line. */
export function addRule(section: string, rule: string, by: string): { doc: string } {
  const s = store.get();
  const target = s.docs.find((d) => d.mode === "always") ?? s.docs[0];
  if (!target) throw new Error("No playbook imported yet (Settings → Memory → Playbook).");
  const r = rule.replace(/\s+/g, " ").trim();
  if (!r) throw new Error("Write the rule.");
  const sec = section.replace(/\s+/g, " ").trim() || "Rules";
  let text = readDoc(target.id);
  const lines = text.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").toLowerCase() === sec.toLowerCase());
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
    while (end > at + 1 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, `- ${r}`);
  } else {
    const log = lines.findIndex((l) => /^#{1,6}\s+change log/i.test(l));
    const block = [`## ${sec}`, `- ${r}`, ""];
    if (log >= 0) lines.splice(log, 0, ...block);
    else lines.push("", ...block);
  }
  text = lines.join("\n");
  const day = now().slice(0, 10);
  const entry = `- ${day}: added to ${sec} (${by}): ${r}`;
  if (/^#{1,6}\s+change log/im.test(text)) text = text.replace(/(^#{1,6}\s+change log[^\n]*\n)/im, `$1${entry}\n`);
  else text += `\n\n## Change log\n${entry}\n`;
  fs.writeFileSync(docPath(target.id), text);
  store.update((st) => {
    const d = st.docs.find((x) => x.id === target.id);
    if (d) d.chars = text.length;
  });
  emit("settings.changed");
  return { doc: target.name };
}

export const REVIEW_PROMPT = `Review the person's playbook (in your instructions; open reference documents with playbook_read) against MausDroid's set-up (bot_list, routine_admin_list, tool_list).
1. List the routines and checks it describes (e.g. weekday checks, reply watches with stop conditions, briefs) and which MausDroid already does.
2. Suggest the few most useful changes with improve_propose (at most 5): new routines for the main assistant, better wording, bot instructions — don't change anything now; the person approves the cards.
3. Note anything it relies on that MausDroid can't do yet (e.g. a connection or script), in one line each.
Reply with a short summary. Never copy private details (account numbers, family details) into suggestion titles.`;

export const getMainBotId = () => mainBot()?.id;
export const botById = getBot;
