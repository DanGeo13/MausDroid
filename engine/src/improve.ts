import fs from "node:fs";
import path from "node:path";
import { collection } from "./store.ts";
import { emit } from "./events.ts";
import { clip, id, now } from "./util.ts";
import { config } from "./config.ts";
import { localParts } from "./time.ts";
import { createBot, getBot, listBots, messages, updateBot, type Bot } from "./bots.ts";
import { createRoutine, deleteRoutine, getRoutine, listRoutines, listRuns, pauseRoutine, resumeRoutine, updateRoutine, type Routine } from "./routines.ts";
import { validateSchedule, type Schedule } from "./schedule.ts";
import { listSkills, parseFrontmatter, saveSkill } from "./skills.ts";
import { notifyUser } from "./notify.ts";
import { onTurnEnd, sendToBot } from "./agent.ts";
import { addMessage } from "./bots.ts";
import { addRunValidator } from "./scheduler.ts";
import { looksSecret, similar } from "./audit.ts";
import * as selfupdate from "./selfupdate.ts";
import { assistantExamples } from "./phone-notifications.ts";
import { refreshCodexSecret } from "./cloud-keys.ts";
import { bridge, bridgeAvailable } from "./bridge.ts";

/**
 * The Improver: a bot that checks MausDroid once a night (10 minutes at most,
 * research stops after 5), and suggests at most 5 fixes for skills, routines
 * or code. Suggestions wait until midday, then appear as cards. NOTHING
 * changes until you tap Approve: routine and skill fixes are applied exactly
 * as shown on the card; code and other fixes are handed to the Improver
 * (Claude Code, Opus 5.5 by default), whose actions still ask as usual.
 */
export const IMPROVE_SYSTEM = "self-improve";
export const MAX_PER_NIGHT = 5;
export const IMPROVER_MODEL = "claude-opus-5-5";

export type Area = "routine" | "skill" | "code" | "other";
export type Status = "waiting" | "shown" | "building" | "applying" | "applied" | "failed" | "declined" | "expired";

export interface Proposal {
  id: string;
  runId: string;
  createdAt: string;
  /** Local date (YYYY-MM-DD) from which it's shown, at the show time. */
  showFrom: string;
  title: string;
  problem: string;
  change: string;
  area: Area;
  risk: "low" | "medium" | "high";
  evidence?: string;
  routinePatch?: { routineId: string; routineTitle: string; before: Record<string, unknown>; after: Record<string, unknown> };
  skill?: { name: string; before: string | null; after: string };
  /** A program change built in the cloud (Claude Code on GitHub): its pull request when ready. */
  build?: { prNumber?: number; prUrl?: string; runUrl?: string; startedAt: string; direct: boolean; attempt?: number; progress?: string; questions?: string; answers?: string[]; agent?: selfupdate.Agent };
  status: Status;
  decidedAt?: string;
  result?: string;
}

export interface Night {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  count: number;
}

export interface ImproveSettings {
  enabled: boolean;
  botId: string | null;
  nightTime: string;
  showTime: string;
  lastRevealDate?: string;
  /** Program changes you asked for directly install by themselves once their tests pass (default). */
  askBeforeInstall?: boolean;
  /** Where program changes are built: GitHub + Claude Code (default), GitHub + Codex, or off (only record them). */
  codingPlatform?: "github-claude" | "github-codex" | "off";
}

const settingsFile = collection<ImproveSettings>("improve-settings", { enabled: true, botId: null, nightTime: "02:30", showTime: "12:00" });
const proposals = collection<Proposal[]>("improvements", []);
const nights = collection<Night[]>("improve-nights", []);

settingsFile.update((s) => {
  if ((s.codingPlatform as string) === "github") s.codingPlatform = "github-claude";
});
export const improveSettings = () => settingsFile.get();
export const listProposals = () => proposals.get().slice().reverse();
export const getProposal = (pid: string) => proposals.get().find((p) => p.id === pid);
export const nightFor = (runId: string) => nights.get().find((n) => n.runId === runId);
export const listNights = () => nights.get().slice().reverse();

function patch(pid: string, p: Partial<Proposal>): Proposal | undefined {
  let out: Proposal | undefined;
  proposals.update((l) => {
    const x = l.find((y) => y.id === pid);
    if (x) out = Object.assign(x, p);
  });
  emit("improve.changed", {});
  return out ? { ...out } : undefined;
}

export const improverBot = (): Bot | undefined => {
  const s = settingsFile.get();
  return s.botId ? getBot(s.botId) : undefined;
};
export const isImprover = (botId: string) => settingsFile.get().botId === botId;

// ---------------- Setup ----------------

export const OLD_IMPROVER_PERSONA =
  "You are Improver, MausDroid's self-improvement bot. Each night you look for the few changes that would most help right now: errors, failing or missed routines, unclear or broken skills, and small code fixes. You are brief, concrete and never exhaustive. You never change anything yourself without the person's approval.";
export const IMPROVER_PERSONA = `You are Improver, MausDroid's self-improvement bot, with admin rights over MausDroid's set-up.
- When the person asks you directly for a change, do it now — don't make a suggestion card. You can change any bot (bot_list, bot_edit: instructions, AI and model, tool switches, single tools, skills, approvals of other bots), any routine (routine_admin_list, routine_admin_update), skills (skill_save) and see every tool (tool_list). After changing something, call improve_record so it shows in Improvements history, and say briefly what you changed (bot changes can be undone in Settings → Tools).
- If they ask to remove or cancel a suggestion, call improve_withdraw.
- Changes to MausDroid's own program (new screens, features, fixes in its code): call improve_build with a short title and a clear, complete spec. The coding agent of the chosen platform (GitHub + Claude Code or GitHub + Codex, in Improvements → Settings) makes the change in the cloud, runs every test, and — if they pass — it installs by itself; MausDroid restarts with it. Tell them it usually takes 5–20 minutes and they'll get a notification.
- While it builds you'll get progress lines; if the developer asks questions, you'll be told — ask the person and pass their answers on with improve_build_answer.
- If something is wrong after an update, or they ask to go back: improve_versions shows the versions kept on the phone, improve_rollback switches back at once (MausDroid restarts).
- In the nightly check (a routine), only suggest (improve_propose, at most 5); nothing changes until approved.
Be brief and concrete.`;

export const IMPROVE_PROMPT = `Nightly self-check. You have 10 minutes at most; research tools stop after 5, so be quick and don't be exhaustive.
1. Call improve_evidence to see recent errors, routine runs, routines, skills and earlier suggestions.
2. Pick the few changes that would help most right now: errors, failing / missed / timed-out routines and the prompts or schedules causing them, skills that are missing, broken or unclear, and — only if clearly worthwhile — small code fixes to MausDroid. A quick web_search or skills_market_search is fine if it helps find a fix.
   assistantExamples (if any) are recent notifications from Meta's Muse assistant: they show what a good assistant anticipates for the person. If MausDroid doesn't anticipate a need Muse does, a new or better routine is a good suggestion.
3. Call improve_propose ONCE with at most ${MAX_PER_NIGHT} suggestions (fewer is better; none if nothing is worth changing). Don't repeat earlier suggestions. For a routine fix include routine_patch with the exact new values; for a skill fix include the complete new SKILL.md. Never include passwords, tokens, card numbers or other credentials.
4. Call improve_finish with a one-line summary.
Don't notify the person: the suggestions are shown at midday as cards, and nothing changes until they approve.`;

function routineSchedule(s: ImproveSettings): Schedule {
  return { kind: "daily", time: s.nightTime, missedPolicy: "run-once", catchUpHours: 9 };
}

export function ensureImprover() {
  addRunValidator(IMPROVE_SYSTEM, (run) => (nightFor(run.id)?.finishedAt ? null : "The nightly check ended without recording its result (improve_finish), so it's incomplete."));
  let s = settingsFile.get();
  let bot = s.botId ? getBot(s.botId) : undefined;
  // Bring an Improver made by an older version up to date (only if its instructions were never edited).
  if (bot && bot.persona === OLD_IMPROVER_PERSONA) updateBot(bot.id, { persona: IMPROVER_PERSONA });
  if (!bot) {
    bot = listBots().find((b) => b.name === "Improver") ??
      createBot({ name: "Improver", emoji: "🛠️", color: "#8e44ad", persona: IMPROVER_PERSONA, providerId: "claude", model: IMPROVER_MODEL, tools: { web: true, browser: false, apps: false, phone: false } });
    settingsFile.update((x) => void (x.botId = bot!.id));
    s = settingsFile.get();
  }
  const existing = listRoutines().find((r) => r.system === IMPROVE_SYSTEM);
  if (!existing) {
    createRoutine({
      botId: bot.id,
      title: "Nightly self-improvement check",
      prompt: IMPROVE_PROMPT,
      schedule: routineSchedule(s),
      timeoutMinutes: 10,
      researchCutoffMinutes: 5,
      retry: { max: 1, delayMinutes: 5 },
      system: IMPROVE_SYSTEM,
      enabled: s.enabled,
    });
  }
}

export const improveRoutine = (): Routine | undefined => listRoutines().find((r) => r.system === IMPROVE_SYSTEM);

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export function saveImproveSettings(input: Partial<ImproveSettings>): ImproveSettings {
  if (input.nightTime !== undefined && !HM.test(input.nightTime)) throw new Error("Night time must be HH:MM.");
  if (input.showTime !== undefined && !HM.test(input.showTime)) throw new Error("Show time must be HH:MM.");
  if (input.botId !== undefined && input.botId !== null && !getBot(input.botId)) throw new Error("No such bot.");
  settingsFile.update((s) => {
    for (const k of ["enabled", "nightTime", "showTime", "botId", "askBeforeInstall", "codingPlatform"] as const) if (input[k] !== undefined) (s as any)[k] = input[k];
  });
  const s = settingsFile.get();
  const r = improveRoutine();
  if (r) {
    const changes: Partial<Routine> = {};
    if (r.schedule.time !== s.nightTime) changes.schedule = { ...r.schedule, time: s.nightTime };
    if (Object.keys(changes).length) updateRoutine(r.id, changes);
    if (s.botId && r.botId !== s.botId) {
      // A routine's bot can't be changed in place: recreate it for the new bot.
      createRoutine({ botId: s.botId, title: r.title, prompt: r.prompt, schedule: r.schedule, timeoutMinutes: r.timeoutMinutes, researchCutoffMinutes: r.researchCutoffMinutes, retry: r.retry, system: IMPROVE_SYSTEM, enabled: r.enabled });
      deleteRoutine(r.id);
    }
    const cur = improveRoutine();
    if (cur && cur.enabled !== s.enabled) s.enabled ? resumeRoutine(cur.id) : pauseRoutine(cur.id);
  }
  emit("improve.changed", {});
  return s;
}

// ---------------- Evidence ----------------

const since = (iso: string | undefined, hours: number) => Boolean(iso) && Date.now() - new Date(iso!).getTime() < hours * 3600_000;

export function collectEvidence() {
  const runs = listRuns(undefined, 400).filter((r) => since(r.finishedAt ?? r.queuedAt, 48));
  const problems = runs
    .filter((r) => ["failed", "timed_out", "missed", "skipped"].includes(r.status))
    .slice(0, 30)
    .map((r) => ({ routine: getRoutine(r.routineId)?.title ?? r.routineId, routineId: r.routineId, status: r.status, at: r.finishedAt ?? r.queuedAt, error: clip(r.error ?? "", 400) }));
  const routines = listRoutines().map((r) => ({
    id: r.id,
    title: r.title,
    bot: getBot(r.botId)?.name ?? "(missing bot)",
    enabled: r.enabled,
    schedule: r.schedule,
    nextRunAt: r.nextRunAt ?? null,
    timeoutMinutes: r.timeoutMinutes,
    system: r.system ?? null,
    prompt: clip(r.prompt, 1200),
    lastResult: r.lastResult ?? null,
    issues: [
      !getBot(r.botId) ? "its bot no longer exists" : "",
      r.enabled && !r.nextRunAt && r.schedule.kind !== "alert" ? "enabled but has no next run" : "",
    ].filter(Boolean),
  }));
  const skills = listSkills().map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source ?? "hand-made",
    issues: [!s.description ? "no description (bots can't tell when to use it)" : "", s.description.length > 400 ? "very long description" : ""].filter(Boolean),
  }));
  const botErrors: { bot: string; at: string; text: string }[] = [];
  for (const b of listBots()) {
    for (const m of messages(b.id, undefined, 150)) {
      if (!since(m.at, 48)) continue;
      if (m.status === "error" || m.tool?.isError) botErrors.push({ bot: b.name, at: m.at, text: clip(m.tool ? `${m.tool.name}: ${m.tool.result ?? ""}` : m.text, 300) });
    }
  }
  let engine: unknown = null;
  try {
    const st = JSON.parse(fs.readFileSync(path.join(config.dataDir, "engine-status.json"), "utf8"));
    engine = { version: config.version, startupProblems: (st.steps ?? []).filter((x: any) => x.ok === false).map((x: any) => `${x.step}: ${clip(String(x.error ?? "failed").split("\n")[0], 300)}`) };
  } catch {
    engine = { version: config.version };
  }
  const earlier = proposals.get().filter((p) => since(p.createdAt, 24 * 21)).map((p) => ({ id: p.id, title: p.title, status: p.status }));
  return { now: new Date().toISOString(), engine, routineProblems: problems, routines, skills, botErrors: botErrors.slice(-25), earlierSuggestions: earlier, assistantExamples: assistantExamples(7) };
}

// ---------------- Night records ----------------

export function beginNight(runId: string): Night {
  let n: Night | undefined;
  nights.update((l) => {
    n = l.find((x) => x.runId === runId);
    if (!n) {
      n = { runId, startedAt: now(), count: 0 };
      l.push(n);
      if (l.length > 90) l.splice(0, l.length - 90);
    }
  });
  return n!;
}

export function finishNight(runId: string, summary: string): Night {
  beginNight(runId);
  let n: Night | undefined;
  nights.update((l) => {
    n = l.find((x) => x.runId === runId)!;
    n.finishedAt = now();
    n.summary = clip(summary || "", 500);
  });
  emit("improve.changed", {});
  return n!;
}

/** Date (YYYY-MM-DD) a suggestion made now is first shown: today if before the show time, else tomorrow. */
export function showDateFor(at: Date, showTime: string): string {
  const p = localParts(at);
  if (p.hm < showTime) return p.ymd;
  const t = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, 12);
  return localParts(t).ymd;
}

// ---------------- Suggestions ----------------

export interface SuggestionInput {
  title?: string;
  problem?: string;
  change?: string;
  area?: string;
  risk?: string;
  evidence?: string;
  routine_patch?: { routine_id?: string; title?: string; prompt?: string; schedule?: Schedule; timeout_minutes?: number; enabled?: boolean };
  skill?: { name?: string; content?: string };
}

const ROUTINE_FIELDS: [keyof NonNullable<SuggestionInput["routine_patch"]>, keyof Routine][] = [
  ["title", "title"],
  ["prompt", "prompt"],
  ["schedule", "schedule"],
  ["timeout_minutes", "timeoutMinutes"],
  ["enabled", "enabled"],
];

function buildProposal(runId: string, s: SuggestionInput): Proposal {
  const title = String(s.title ?? "").trim();
  const problem = String(s.problem ?? "").trim();
  const change = String(s.change ?? "").trim();
  if (!title || !problem || !change) throw new Error("each suggestion needs a title, the problem and the change");
  const area = (["routine", "skill", "code", "other"].includes(String(s.area)) ? s.area : "other") as Area;
  const risk = (["low", "medium", "high"].includes(String(s.risk)) ? s.risk : "medium") as Proposal["risk"];
  if (looksSecret(JSON.stringify(s))) throw new Error("it looks like it contains a credential or card number");
  const p: Proposal = { id: id("imp"), runId, createdAt: now(), showFrom: showDateFor(new Date(), settingsFile.get().showTime), title: clip(title, 120), problem: clip(problem, 1200), change: clip(change, 2000), area, risk, evidence: s.evidence ? clip(String(s.evidence), 800) : undefined, status: "waiting" };
  if (area === "routine") {
    const rp = s.routine_patch;
    const r = rp?.routine_id ? getRoutine(String(rp.routine_id)) : undefined;
    if (!r) throw new Error("a routine fix needs routine_patch.routine_id of an existing routine");
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [inKey, key] of ROUTINE_FIELDS) {
      if (rp![inKey] === undefined) continue;
      before[key] = r[key] ?? null;
      after[key] = rp![inKey];
    }
    if (!Object.keys(after).length) throw new Error("routine_patch changes nothing");
    if (after.schedule) {
      const errs = validateSchedule(after.schedule as Schedule);
      if (errs.length) throw new Error(`schedule: ${errs.join(" ")}`);
    }
    if (after.timeoutMinutes !== undefined) {
      const t = Number(after.timeoutMinutes);
      if (!(t >= 1 && t <= 60)) throw new Error("timeout_minutes must be 1–60");
      if (r.system === IMPROVE_SYSTEM && t > 10) throw new Error("the nightly check stays at 10 minutes or less");
    }
    if (after.title !== undefined && !String(after.title).trim()) throw new Error("title can't be empty");
    p.routinePatch = { routineId: r.id, routineTitle: r.title, before, after };
  }
  if (area === "skill") {
    const name = String(s.skill?.name ?? "").trim();
    const content = String(s.skill?.content ?? "");
    const fm = parseFrontmatter(content);
    if (!name || !fm.name || !fm.description) throw new Error("a skill fix needs skill.name and a complete SKILL.md with name and description");
    const cur = listSkills().find((x) => x.name === name);
    p.skill = { name, before: cur ? fs.readFileSync(path.join(cur.dir, "SKILL.md"), "utf8") : null, after: content };
  }
  return p;
}

/** Records tonight's suggestions: at most 5 per night, no repeats of open or recently declined ones. */
export function addSuggestions(runId: string, list: SuggestionInput[]): { added: Proposal[]; refused: { title: string; reason: string }[] } {
  beginNight(runId);
  const added: Proposal[] = [];
  const refused: { title: string; reason: string }[] = [];
  const all = proposals.get();
  let count = all.filter((p) => p.runId === runId).length;
  const compare = all.filter((p) => ["waiting", "shown", "applying"].includes(p.status) || ((p.status === "declined" || p.status === "applied") && since(p.decidedAt, 24 * 21)));
  for (const s of Array.isArray(list) ? list : []) {
    const title = String(s?.title ?? "(untitled)");
    if (count >= MAX_PER_NIGHT) {
      refused.push({ title, reason: `only ${MAX_PER_NIGHT} suggestions a night` });
      continue;
    }
    try {
      const p = buildProposal(runId, s ?? {});
      const dup = [...compare, ...added].find((x) => similar(x.title, p.title) || x.title.toLowerCase() === p.title.toLowerCase() || (p.routinePatch && x.routinePatch?.routineId === p.routinePatch.routineId && x.status !== "declined" && x.status !== "applied"));
      if (dup) {
        refused.push({ title, reason: `repeats "${dup.title}" (${dup.status})` });
        continue;
      }
      added.push(p);
      count++;
    } catch (e) {
      refused.push({ title, reason: (e as Error).message });
    }
  }
  proposals.update((l) => {
    l.push(...added);
    if (l.length > 400) l.splice(0, l.length - 400);
  });
  nights.update((l) => {
    const n = l.find((x) => x.runId === runId);
    if (n) n.count = count;
  });
  emit("improve.changed", {});
  return { added, refused };
}

// ---------------- Midday reveal ----------------

/** At the show time, waiting suggestions become cards and one notification goes out. */
export async function revealDue(at = new Date(), force = false): Promise<Proposal[]> {
  const s = settingsFile.get();
  const p = localParts(at);
  if (!force && p.hm < s.showTime) return [];
  const due = proposals.get().filter((x) => x.status === "waiting" && (force || x.showFrom <= p.ymd));
  // Suggestions nobody decided on fade after a week.
  for (const x of proposals.get()) if (x.status === "shown" && !since(x.createdAt, 24 * 7)) patch(x.id, { status: "expired", decidedAt: now() });
  if (!due.length) return [];
  for (const x of due) patch(x.id, { status: "shown" });
  const bot = improverBot();
  if (force) emit("improve.changed", {});
  else if (s.lastRevealDate !== p.ymd) {
    settingsFile.update((x) => void (x.lastRevealDate = p.ymd));
    await notifyUser({
      title: `${bot?.emoji ?? "🛠️"} ${due.length} improvement${due.length === 1 ? "" : "s"} to review`,
      body: due.map((x) => `• ${x.title}`).join("\n").slice(0, 300),
      botId: bot?.id,
      priority: "normal",
      type: "improvement",
      source: bot?.name ?? "Improver",
      link: "improve:",
    });
  }
  return due;
}

let ticker: NodeJS.Timeout | null = null;
export function startImprover() {
  listen();
  if (proposals.get().some((p) => p.status === "building")) watchBuilds();
  if (ticker) return;
  void revealDue().catch(() => {});
  ticker = setInterval(() => void revealDue().catch(() => {}), 60_000);
}

// ---------------- Approve / not now / dismiss ----------------

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export async function approve(pid: string): Promise<Proposal> {
  const p = getProposal(pid);
  if (!p) throw new Error("No such suggestion");
  if (p.status !== "shown" && p.status !== "waiting") throw new Error(`This suggestion is already ${p.status}.`);
  const decided = { decidedAt: now() };
  if (p.area === "routine" && p.routinePatch) {
    const r = getRoutine(p.routinePatch.routineId);
    if (!r) return patch(pid, { ...decided, status: "failed", result: "The routine no longer exists." })!;
    const stale = Object.entries(p.routinePatch.before).find(([k, v]) => !same((r as any)[k] ?? null, v));
    if (stale) return patch(pid, { ...decided, status: "failed", result: `The routine's ${stale[0]} changed since this was suggested, so nothing was changed. It'll be looked at again tonight.` })!;
    try {
      updateRoutine(r.id, p.routinePatch.after as Partial<Routine>);
      return patch(pid, { ...decided, status: "applied", result: `Routine "${r.title}" updated.` })!;
    } catch (e) {
      return patch(pid, { ...decided, status: "failed", result: (e as Error).message })!;
    }
  }
  if (p.area === "skill" && p.skill) {
    const cur = listSkills().find((x) => x.name === p.skill!.name);
    const now_ = cur ? fs.readFileSync(path.join(cur.dir, "SKILL.md"), "utf8") : null;
    if (now_ !== p.skill.before) return patch(pid, { ...decided, status: "failed", result: "The skill changed since this was suggested, so nothing was changed." })!;
    if (cur) fs.writeFileSync(path.join(cur.dir, "SKILL.md"), p.skill.after);
    else saveSkill(p.skill.name, p.skill.after);
    return patch(pid, { ...decided, status: "applied", result: `Skill "${p.skill.name}" ${cur ? "updated" : "added"}.` })!;
  }
  // Program changes are built in the cloud; a finished build is installed (published) on approval.
  if (p.area === "code") {
    if (p.build?.prNumber && p.status === "shown") return installBuild(p);
    return startCodeBuild(p, false);
  }
  // Other changes: the Improver does the work; its actions still ask as usual.
  const bot = improverBot();
  if (!bot) return patch(pid, { ...decided, status: "failed", result: "No Improver bot is set." })!;
  const out = patch(pid, { ...decided, status: "applying" })!;
  sendToBot(bot.id, applyPrompt(p), "improvement", [], p.id);
  return out;
}

export function applyPrompt(p: Proposal) {
  return `The person APPROVED this improvement. Do exactly this, nothing more:

Title: ${p.title}
Problem: ${p.problem}
Change: ${p.change}
Area: ${p.area} · Risk: ${p.risk}

Rules: ${p.area === "code" ? "make the change in the MausDroid source (github.com/DanGeo13/MausDroid) on a new branch named improve/<short-name>, with tests where possible. Never push to main or the updates branch, never publish a release or APK, never touch signing keys. Any push or pull request goes through an approval card. " : ""}Every action that needs approval still asks. Never store credentials anywhere. If you can't finish it from here, say exactly what's left. End with a short summary of what changed.`;
}

export function snooze(pid: string): Proposal {
  const p = getProposal(pid);
  if (!p || !["shown", "waiting"].includes(p.status)) throw new Error("This suggestion can't be postponed.");
  const t = new Date();
  const tomorrow = localParts(new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1, 12)).ymd;
  return patch(pid, { status: "waiting", showFrom: tomorrow })!;
}

export function dismiss(pid: string): Proposal {
  const p = getProposal(pid);
  if (!p || !["shown", "waiting", "building"].includes(p.status)) throw new Error("This suggestion is already decided.");
  if (p.build?.prNumber) void selfupdate.closeBuild(p.build.prNumber).catch(() => {});
  return patch(pid, { status: "declined", decidedAt: now() })!;
}

// ---------------- Program changes built in the cloud ----------------

/** Improver (asked directly) or an approved card: a Claude Code session on GitHub makes the change and runs every test. */
export async function requestBuild(title: string, request: string): Promise<Proposal> {
  const p: Proposal = { id: id("imp"), runId: "direct", createdAt: now(), showFrom: localParts(new Date()).ymd, title: clip(title, 120), problem: "Asked for directly.", change: clip(request, 6000), area: "code", risk: "medium", status: "shown" };
  if (looksSecret(request)) throw new Error("That request looks like it contains a credential — leave secrets out.");
  proposals.update((l) => void l.push(p));
  return startCodeBuild(p, true);
}

const requestText = (p: Proposal) => `${p.title}\n\n${p.problem}\n\n${p.change}`;

/** The coding agent of the chosen platform. */
export function codingAgent(): selfupdate.Agent | null {
  const c = settingsFile.get().codingPlatform ?? "github-claude";
  return c === "off" ? null : c === "github-codex" ? "codex" : "claude";
}

async function startCodeBuild(p: Proposal, direct: boolean): Promise<Proposal> {
  const agent = codingAgent();
  if (!agent) return patch(p.id, { status: "shown", result: "Building is switched off (Improvements → Settings → Coding platform), so this is kept as a suggestion." })!;
  try {
    if (agent === "codex") await refreshCodexSecret();
    await selfupdate.startBuild(p.id, requestText(p), "", 1, agent);
  } catch (e) {
    return patch(p.id, { status: "failed", decidedAt: now(), result: `Couldn't start the cloud build: ${(e as Error).message}` })!;
  }
  const out = patch(p.id, { status: "building", decidedAt: now(), build: { startedAt: now(), direct, attempt: 1, progress: "Starting", answers: [], agent }, result: `Building in the cloud: ${selfupdate.AGENT_NAMES[agent]} is making the change and running every test (usually 5–20 minutes).` })!;
  progressNote(out, `Started in the cloud with ${selfupdate.AGENT_NAMES[agent]} on GitHub — I'll keep you posted.`);
  watchBuilds();
  return out;
}

/** A short progress line in Improver's chat (no AI turn). */
function progressNote(p: Proposal, text: string) {
  const bot = improverBot();
  if (!bot) return;
  const m = addMessage(bot.id, { role: "note", text: `🛠️ ${p.title}: ${text}`, status: "done", source: "build" });
  emit("message", { botId: bot.id, message: m });
}

/** Your answers to the cloud build's questions: it carries on with them. */
export async function answerBuild(pid: string, answers: string): Promise<Proposal> {
  const p = getProposal(pid);
  if (!p || p.status !== "building" || !p.build?.questions) throw new Error("That build isn't waiting for answers.");
  if (!answers.trim()) throw new Error("Write your answers first.");
  if (looksSecret(answers)) throw new Error("Leave passwords and keys out of answers.");
  const all = [...(p.build.answers ?? []), `Questions:\n${p.build.questions}\n\nAnswers:\n${answers.trim()}`];
  const attempt = (p.build.attempt ?? 1) + 1;
  try {
    await selfupdate.startBuild(p.id, requestText(p), all.join("\n\n---\n\n"), attempt, p.build.agent ?? codingAgent() ?? "claude");
  } catch (e) {
    throw new Error(`Couldn't send the answers: ${(e as Error).message}`);
  }
  const out = patch(pid, { build: { ...p.build, attempt, questions: undefined, answers: all, progress: "Carrying on with your answers", startedAt: now() } })!;
  progressNote(out, "Got your answers — carrying on.");
  watchBuilds();
  return out;
}

async function installBuild(p: Proposal): Promise<Proposal> {
  try {
    await selfupdate.mergeBuild(p.build!.prNumber!);
  } catch (e) {
    return patch(p.id, { status: "failed", result: `Couldn't install: ${(e as Error).message}` })!;
  }
  const out = patch(p.id, { status: "applied", decidedAt: now(), result: "Installed: publishing the update now; MausDroid restarts with it in a few minutes. If anything's wrong, roll back in Improvements." })!;
  followUpdate(p.title);
  return out;
}

let buildTimer: NodeJS.Timeout | null = null;
/** Checks cloud builds every 2 minutes while any are running. */
export function watchBuilds() {
  if (buildTimer) return;
  buildTimer = setInterval(() => void checkBuilds(), Number(process.env.MAUSDROID_BUILD_POLL_MS ?? 120_000));
}

export async function checkBuilds() {
  const building = proposals.get().filter((p) => p.status === "building");
  if (!building.length && buildTimer) {
    clearInterval(buildTimer);
    buildTimer = null;
    return;
  }
  const bot = improverBot();
  for (const p of building) {
    let st: selfupdate.BuildState;
    try {
      st = await selfupdate.buildState(p.id, p.build?.attempt ?? 1, p.title);
    } catch {
      continue; // try again next time
    }
    const build = { ...p.build!, prNumber: st.prNumber, prUrl: st.prUrl, runUrl: st.runUrl ?? p.build?.runUrl };
    if (st.state === "question") {
      if (p.build?.questions) continue; // already asked
      patch(p.id, { build: { ...build, questions: st.questions, progress: "Waiting for your answers" } });
      progressNote(p, "the developer needs a few answers before carrying on.");
      void notifyUser({ title: `${bot?.emoji ?? "🛠️"} Question about "${p.title}"`, body: (st.questions ?? "").slice(0, 300), botId: bot?.id, type: "improvement", priority: "high", link: "improve:" });
      // Improver asks you in its chat, in its own words, and passes your reply on.
      if (bot)
        sendToBot(
          bot.id,
          `[Cloud build "${p.title}" (id ${p.id}) needs answers before it can carry on. Ask the person these questions briefly in your own words, with the suggested defaults. When they answer, call improve_build_answer with id ${p.id} and their answers.]\n\n${st.questions}`,
          "build",
        );
      continue;
    }
    if (st.state === "building" && st.progress && st.progress !== p.build?.progress) {
      patch(p.id, { build: { ...build, progress: st.progress } });
      progressNote(p, st.progress);
      continue;
    }
    if (st.state === "ready") {
      const auto = p.build?.direct && !settingsFile.get().askBeforeInstall;
      const ready = patch(p.id, { build: { ...build, progress: "Ready" }, status: "shown", result: "Built and every test passed." })!;
      progressNote(p, auto ? "built and every test passed — installing." : "built and every test passed — tap Install in Improvements.");
      if (auto) await installBuild(ready);
      else void notifyUser({ title: `${bot?.emoji ?? "🛠️"} Improvement ready to install`, body: p.title, botId: bot?.id, type: "improvement", link: "improve:" });
    } else if (st.state === "failed") {
      patch(p.id, { build, status: "failed", result: st.detail ?? "The cloud build failed." });
      progressNote(p, `couldn't be built — ${st.detail ?? "the cloud build failed"}`);
      void notifyUser({ title: `${bot?.emoji ?? "🛠️"} Improvement couldn't be built`, body: `${p.title} — ${st.detail ?? ""}`.slice(0, 300), botId: bot?.id, type: "improvement", link: "improve:" });
    } else if (st.state === "merged") patch(p.id, { build, status: "applied", result: "Installed." });
    else if (st.state === "closed") patch(p.id, { build, status: "declined", result: "The change was closed without installing." });
    else if (build.runUrl !== p.build?.runUrl) patch(p.id, { build });
    if (st.state === "building" && Date.now() - new Date(p.build!.startedAt).getTime() > 90 * 60_000) patch(p.id, { build, status: "failed", result: "The cloud build took longer than 90 minutes." });
  }
}

/** After installing: fetch the published update as soon as it's out, then restart with it. */
function followUpdate(title: string) {
  if (!bridgeAvailable()) return;
  let tries = 0;
  const t = setInterval(async () => {
    if (++tries > 15) return clearInterval(t);
    const s = await bridge<{ state?: string; available?: string }>("/update/check", {}, 300_000).catch(() => null);
    if (s?.state === "ready") {
      clearInterval(t);
      const bot = improverBot();
      await notifyUser({ title: `${bot?.emoji ?? "🛠️"} Installing ${s.available}`, body: `${title} — MausDroid restarts for a moment.`, botId: bot?.id, type: "improvement", priority: "low" });
      await bridge("/update/apply", {}).catch(() => {});
    }
  }, Number(process.env.MAUSDROID_UPDATE_POLL_MS ?? 180_000));
}

let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  onTurnEnd((_botId, reply, info) => {
    for (const t of info?.tags ?? []) {
      const p = getProposal(t);
      if (!p || p.status !== "applying") continue;
      patch(t, { status: info.failed || info.aborted ? "failed" : "applied", result: clip(reply || (info.aborted ? "Stopped before it finished." : ""), 2000) });
    }
  });
}

/** A change Improver made straight away at the person's request (shows in history as applied). */
export function recordApplied(title: string, change: string, area: Area = "other"): Proposal {
  const p: Proposal = { id: id("imp"), runId: "direct", createdAt: now(), showFrom: localParts(new Date()).ymd, title: clip(title, 120), problem: "Asked for directly.", change: clip(change, 2000), area, risk: "low", status: "applied", decidedAt: now(), result: "Done at your request." };
  proposals.update((l) => void l.push(p));
  emit("improve.changed", {});
  return p;
}

/** Withdraws waiting / shown suggestions by id or title words. */
export function withdraw(refs: string[]): Proposal[] {
  const open = proposals.get().filter((p) => p.status === "waiting" || p.status === "shown");
  const hit = open.filter((p) => refs.some((r) => r === p.id || (r.length > 2 && p.title.toLowerCase().includes(r.toLowerCase()))));
  for (const p of hit) patch(p.id, { status: "declined", decidedAt: now(), result: "Withdrawn at your request." });
  return hit.map((p) => ({ ...p, status: "declined" as Status }));
}

/** For the screen. */
export function overview() {
  const s = settingsFile.get();
  const r = improveRoutine();
  const all = listProposals();
  return {
    settings: s,
    bot: improverBot() ? { id: improverBot()!.id, name: improverBot()!.name, emoji: improverBot()!.emoji, model: improverBot()!.model, providerId: improverBot()!.providerId } : null,
    routine: r ? { id: r.id, enabled: r.enabled, nextRunAt: r.nextRunAt ?? null, lastResult: r.lastResult ?? null } : null,
    shown: all.filter((p) => p.status === "shown"),
    waiting: all.filter((p) => p.status === "waiting").length,
    history: all.filter((p) => !["shown", "waiting", "building"].includes(p.status)).slice(0, 30),
    lastNight: listNights()[0] ?? null,
    building: all.filter((p) => p.status === "building"),
    versions: selfupdate.engineVersions(),
  };
}
