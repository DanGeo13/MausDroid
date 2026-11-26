import type { ToolSpec } from "../types.ts";
import { getBot, listBots, type Bot } from "../bots.ts";
import { bridge, bridgeAvailable } from "../bridge.ts";
import { webFetch, webSearch, tailnetFetch } from "./web.ts";
import { notifyUser } from "../notify.ts";
import { askQuestion } from "../approvals.ts";
import { appendMemory, readMemory } from "../memory.ts";
import { createRoutine, deleteRoutine, getRoutine, listRoutines, listRuns, pauseRoutine, resumeRoutine, routineDetails, updateRoutine, type Schedule } from "../routines.ts";
import { runRoutineNow } from "../scheduler.ts";
import { describeSchedule } from "../schedule.ts";
import { currentRunTags } from "../agent.ts";
import { getRun } from "../routines.ts";
import { requestApproval } from "../approvals.ts";
import * as calendar from "../calendar.ts";
import * as brief from "../brief.ts";
import * as audit from "../audit.ts";
import { searchMarketplace } from "../skills.ts";
import { describeLocationError, getLocation } from "../location.ts";
import * as calls from "../calls.ts";
import * as improve from "../improve.ts";
import * as share from "../share.ts";
import * as botAdmin from "../bot-admin.ts";
import * as selfupdate from "../selfupdate.ts";
import { saveSkill } from "../skills.ts";
import { listSkills, readSkill, readSkillFile } from "../skills.ts";
import { callComposio, composioTools } from "../composio.ts";
import fs from "node:fs";
import { describe as describeFile, filePath, getFile, readText } from "../files.ts";

export interface ToolContext {
  bot: Bot;
  signal: AbortSignal;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
  images?: { mediaType: string; data: string }[];
}

interface Tool {
  spec: ToolSpec;
  group: keyof Bot["tools"] | "core";
  /** A short reason when this call needs your approval in "ask-risky" mode. */
  risk?: (input: any) => string | null;
  /** Ask even in "never ask" mode (e.g. changing or deleting a routine). */
  alwaysAsk?: boolean;
  /** MausDroid admin: Improver may use it without asking (you gave it admin rights). */
  admin?: boolean;
  /** The type of access, for "Always allow this type" (default: the tool's name). */
  permission?: (input: any) => { key: string; label: string };
  run: (ctx: ToolContext, input: any) => Promise<ToolResult | string>;
}

const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const str = (description: string) => ({ type: "string", description });

const WRITE_WORDS = /(SEND|CREATE|DELETE|REMOVE|UPDATE|POST|REPLY|INSERT|ADD|MOVE|PATCH|PUT|UPLOAD|SHARE|INVITE|PAY|PURCHASE|BUY|ARCHIVE|TRASH|MODIFY|SET_|EXECUTE|RUN|SUBMIT|ACCEPT|DECLINE|CANCEL|TRANSFER|FORWARD)/i;

function browserNeeded() {
  if (!bridgeAvailable()) throw new Error("The background browser needs the Android app.");
}

const builtins: Tool[] = [
  {
    group: "web",
    spec: { name: "web_search", description: "Search the web. Returns titles, links and snippets.", inputSchema: obj({ query: str("What to search for") }, ["query"]) },
    run: (_c, i) => webSearch(i.query),
  },
  {
    group: "web",
    spec: {
      name: "web_fetch",
      description:
        "Get a web page or API URL as readable text. Pages that build their content with JavaScript are opened in the phone's background browser automatically (render 'auto'); use render 'always' to force that, e.g. for lists that load after the page. For logins or clicking, use the browser tools.",
      inputSchema: obj({ url: str("http(s) URL"), render: { type: "string", enum: ["auto", "always", "never"], description: "JavaScript pages: auto (default), always, never" }, wait_ms: { type: "number", description: "With JavaScript: extra wait for content to load (default 2500, max 15000)" } }, ["url"]),
    },
    run: (_c, i) => webFetch(i.url, i.render ?? "auto", Number(i.wait_ms ?? 2500)),
  },
  {
    group: "browser",
    spec: {
      name: "browser_open",
      description: "Open a page in the phone's background browser (keeps your logins, runs JavaScript, works while the screen is off). Returns a tab id and the page text.",
      inputSchema: obj({ url: str("URL to open"), tab: str("Existing tab id to reuse (optional)") }, ["url"]),
    },
    run: async (_c, i) => {
      browserNeeded();
      const r = await bridge("/browser/open", i, 90_000);
      return `tab=${r.tab}\ntitle=${r.title}\nurl=${r.url}\n\n${r.text ?? ""}`;
    },
  },
  {
    group: "browser",
    spec: { name: "browser_read", description: "Read the current page of a tab: mode 'text' (default), 'links', or 'forms' (inputs and buttons with selectors).", inputSchema: obj({ tab: str("Tab id"), mode: { type: "string", enum: ["text", "links", "forms"] } }, ["tab"]) },
    run: async (_c, i) => {
      browserNeeded();
      return (await bridge("/browser/read", i)).text;
    },
  },
  {
    group: "browser",
    spec: { name: "browser_click", description: "Click an element by CSS selector, or by its visible text.", inputSchema: obj({ tab: str("Tab id"), selector: str("CSS selector"), text: str("Visible text of the element") }, ["tab"]) },
    risk: (i) => `Click ${i.text ? `"${i.text}"` : i.selector} in the background browser`,
    run: async (_c, i) => {
      browserNeeded();
      const r = await bridge("/browser/click", i, 60_000);
      return `${r.result}\nurl=${r.url}\n\n${r.text ?? ""}`;
    },
  },
  {
    group: "browser",
    spec: { name: "browser_type", description: "Type into an input (CSS selector). submit=true presses Enter / submits the form.", inputSchema: obj({ tab: str("Tab id"), selector: str("CSS selector of the input"), text: str("Text to type"), submit: { type: "boolean" } }, ["tab", "selector", "text"]) },
    risk: (i) => (i.submit ? `Type and submit "${String(i.text).slice(0, 80)}"` : null),
    run: async (_c, i) => {
      browserNeeded();
      const r = await bridge("/browser/type", i, 60_000);
      return `${r.result}\nurl=${r.url}\n\n${r.text ?? ""}`;
    },
  },
  {
    group: "browser",
    spec: { name: "browser_screenshot", description: "See what a tab looks like (image).", inputSchema: obj({ tab: str("Tab id") }, ["tab"]) },
    run: async (_c, i) => {
      browserNeeded();
      const r = await bridge("/browser/screenshot", i, 60_000);
      return { text: `Screenshot of ${r.url}`, images: [{ mediaType: "image/jpeg", data: r.jpeg }] };
    },
  },
  {
    group: "browser",
    spec: { name: "browser_scroll", description: "Scroll a tab down or up one screen, returns the newly visible text.", inputSchema: obj({ tab: str("Tab id"), direction: { type: "string", enum: ["down", "up"] } }, ["tab"]) },
    run: async (_c, i) => {
      browserNeeded();
      return (await bridge("/browser/scroll", i)).text;
    },
  },
  {
    group: "browser",
    spec: { name: "browser_tabs", description: "List open background browser tabs, or close one (close=tab id).", inputSchema: obj({ close: str("Tab id to close (optional)") }) },
    run: async (_c, i) => {
      browserNeeded();
      if (i.close) await bridge("/browser/close", { tab: i.close });
      return JSON.stringify((await bridge("/browser/tabs")).tabs, null, 1);
    },
  },
  {
    group: "browser",
    spec: { name: "browser_ask_login", description: "When a site needs you (the person) to sign in, show them the page so they can log in themselves. Their login is then remembered for the background browser.", inputSchema: obj({ url: str("Sign-in page"), reason: str("Why") }, ["url"]) },
    run: async (c, i) => {
      browserNeeded();
      await bridge("/login/show", { url: i.url, reason: i.reason, bot: c.bot.name });
      return "The sign-in page is now showing for the person. Ask them to tell you when they've finished, then continue.";
    },
  },
  {
    group: "core",
    spec: { name: "notify_user", description: "Send the person a phone notification (smart alert). Use for things that matter; be brief. priority: low (silent), normal, high (breaks quiet hours).", inputSchema: obj({ title: str("Short title"), body: str("One or two sentences"), priority: { type: "string", enum: ["low", "normal", "high"] } }, ["title", "body"]) },
    run: async (c, i) => {
      const runId = currentRunTags(c.bot.id).find((t) => t.startsWith("run_"));
      await notifyUser({ title: `${c.bot.emoji} ${i.title}`, body: i.body, botId: c.bot.id, priority: i.priority, source: c.bot.name, routineId: runId ? getRun(runId)?.routineId : undefined, link: i.link });
      return "Notification sent.";
    },
  },
  {
    group: "core",
    spec: { name: "ask_user", description: "Ask the person a question and wait for the answer. Give options when there are clear choices.", inputSchema: obj({ question: str("The question"), options: { type: "array", items: { type: "string" } } }, ["question"]) },
    run: async (c, i) => {
      const r = await askQuestion(c.bot.id, i.question, i.options, c.signal);
      return r.answer ? `The person answered: ${r.answer}` : "The person did not answer.";
    },
  },
  {
    group: "core",
    spec: { name: "memory_save", description: "Remember a lasting fact or preference. scope 'me' = about the person (shared by all bots), 'bot' = only you.", inputSchema: obj({ note: str("What to remember"), scope: { type: "string", enum: ["me", "bot"] } }, ["note"]) },
    run: async (c, i) => {
      appendMemory(i.scope === "bot" ? c.bot.id : "about-me", i.note);
      return "Saved.";
    },
  },
  {
    group: "core",
    spec: { name: "skill_read", description: "Open an installed skill's instructions (or one of its files) before doing a task it covers.", inputSchema: obj({ name: str("Skill name"), file: str("Optional file inside the skill") }, ["name"]) },
    run: async (_c, i) => (i.file ? readSkillFile(i.name, i.file) : readSkill(i.name)),
  },
  {
    group: "core",
    spec: {
      name: "file_read",
      description: "Look inside a file the person attached (by its file id). Text-like files (txt, md, json, html, csv, code…) return their text, pictures are shown to you; other types return their details.",
      inputSchema: obj({ file_id: str("The file id, e.g. file_0123abcd…"), offset: { type: "number", description: "Character to start from, for long files" } }, ["file_id"]),
    },
    run: async (_c, i) => {
      const a = getFile(String(i.file_id));
      if (!a) return { text: "No such file.", isError: true };
      if (a.kind === "text") {
        const t = readText(a, 2_000_000);
        const off = Math.max(0, Number(i.offset ?? 0));
        return `${describeFile(a)}\n\n${t.slice(off, off + 30_000)}${t.length > off + 30_000 ? `\n\n[More: call again with offset ${off + 30_000}]` : ""}`;
      }
      if (a.kind === "image" && a.size < 5_000_000 && /png|jpe?g|gif|webp/.test(a.mime))
        return { text: describeFile(a), images: [{ mediaType: a.mime, data: fs.readFileSync(filePath(a)).toString("base64") }] };
      return `${describeFile(a)}. This type can't be read as text here. Claude Code and ChatGPT (Codex) bots can open it directly; you can also upload it to a connected app (e.g. Google Drive) or describe what to do with it.`;
    },
  },
  {
    group: "web",
    spec: { name: "tailnet_fetch", description: "Call a service on the person's private Tailscale network (e.g. their PC at http://my-pc:11434). Works without opening the Tailscale app.", inputSchema: obj({ url: str("URL on the tailnet"), method: str("GET (default), POST…"), body: str("Request body"), content_type: str("Body type") }, ["url"]) },
    risk: (i) => (i.method && i.method.toUpperCase() !== "GET" ? `${i.method} ${i.url} on your tailnet` : null),
    run: async (_c, i) => tailnetFetch(i.url, (i.method ?? "GET").toUpperCase(), i.body, i.content_type ? { "content-type": i.content_type } : {}),
  },
];

/** Tools only some bots get: calling (Maus), editing bots (Maus, Improver), admin (Improver). */
const ONLY_IMPROVER = /^(improve_|routine_admin_|skill_save$|tool_list$)/;
const ONLY_MAUS_OR_IMPROVER = /^bot_(list|edit)$/;
function mayHave(bot: Bot, name: string) {
  if (name === "call_user") return calls.isCallBot(bot.id);
  if (ONLY_IMPROVER.test(name)) return improve.isImprover(bot.id);
  if (ONLY_MAUS_OR_IMPROVER.test(name)) return improve.isImprover(bot.id) || calls.callBot()?.id === bot.id;
  return true;
}
export function onlyFor(name: string): string | null {
  if (name === "call_user") return "Maus";
  if (ONLY_IMPROVER.test(name)) return "Improver";
  if (ONLY_MAUS_OR_IMPROVER.test(name)) return "Maus and Improver";
  return null;
}

/** Every built-in tool, for the bot editor and Settings → Tools. */
export function toolCatalog() {
  return allBuiltins().map((t) => ({
    name: t.spec.name,
    description: t.spec.description,
    group: t.group,
    risky: Boolean(t.alwaysAsk || t.risk || WRITE_WORDS.test(t.spec.name.replace(/^(web|skill|memory|routine)_(read|list|search|fetch)$/, ""))),
    onlyFor: onlyFor(t.spec.name),
  }));
}

/** Every tool a bot may use right now (its switches + connected apps). */
let extraTools: Tool[] | null = null;
/** Built-in tools plus the routine tools (built on first use). */
const allBuiltins = () => [...builtins, ...(extraTools ??= [...routineTools(), ...calendarTools(), ...briefTools(), ...auditTools(), ...locationTools(), ...callTools(), ...improveTools(), ...shareTools(), ...adminTools()])];

export async function toolsFor(bot: Bot): Promise<Tool[]> {
  const list = allBuiltins().filter((t) => t.group === "core" || bot.tools[t.group as keyof Bot["tools"]]);
  // Only the call bot (Maus) can phone the person.
  const off = new Set(bot.disabledTools ?? []);
  const allowed = list.filter((t) => mayHave(bot, t.spec.name) && !off.has(t.spec.name));
  list.length = 0;
  list.push(...allowed);
  if (bot.tools.apps) {
    try {
      for (const spec of await composioTools())
        list.push({
          group: "apps",
          spec,
          risk: (i) => {
            const n = spec.name.toUpperCase();
            if (n.includes("SEARCH_TOOLS") || n.includes("GET_TOOL_SCHEMAS") || n.includes("MANAGE_CONNECTIONS")) return null;
            if (n.includes("WORKBENCH") || n.includes("BASH")) return "Run code in Composio's cloud workbench";
            const slugs: string[] = (i?.tools ?? []).map((t: any) => String(t.tool_slug ?? ""));
            const writes = slugs.filter((s) => WRITE_WORDS.test(s));
            return writes.length ? `Use connected apps: ${writes.join(", ")}` : null;
          },
          run: async (_c, input) => callComposio(spec.name, input),
        });
      for (let i = list.length - 1; i >= 0; i--) if (off.has(list[i].spec.name)) list.splice(i, 1);
    } catch {
      /* Composio unreachable: the bot works without apps this turn */
    }
  }
  return list;
}

export function describeSkills(names: string[]): string {
  const skills = listSkills().filter((s) => !names.length || names.includes(s.name));
  if (!skills.length) return "";
  return `\n\n# Skills\nOpen a skill with skill_read before a task it covers:\n${skills.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`;
}

export function memoryContext(botId: string): string {
  const me = readMemory("about-me").slice(-6000);
  const mine = readMemory(botId).slice(-4000);
  return `${me ? `\n\n# What you know about the person\n${me}` : ""}${mine ? `\n\n# Your own notes\n${mine}` : ""}`;
}

export type { Tool };

// ---------------- Routines ----------------

const scheduleSchema = {
  kind: { type: "string", enum: ["daily", "weekly", "alert", "custom", "once", "interval"], description: "daily = Once a Day; weekly = Once a Week; alert = Upon Alert; custom = intervals / specific dates / recurring" },
  time: str("daily/weekly: local time HH:MM"),
  days: { type: "array", items: { type: "number" }, description: "weekly (or custom recurring): weekdays 0=Sun..6=Sat" },
  time_zone: str('IANA time zone, e.g. "Australia/Sydney" (default: the phone\'s)'),
  custom: {
    type: "object",
    description: "custom: {mode:'interval', minutes>=15} | {mode:'dates', dates:['YYYY-MM-DDTHH:MM']} | {mode:'recurring', everyDays, times:['HH:MM'], days?, startDate?}",
  },
  window: { type: "object", description: "Only run between {start:'HH:MM', end:'HH:MM', days?:[0-6]}" },
  conditions: str("Plain-language condition checked before acting"),
  alert: { type: "object", description: "alert: {type? (e.g. \"share\" = something the person shares to MausDroid; source is then the kind, e.g. \"YouTube video\"), source?, minPriority?: low|normal|high, contains?, dedupeMinutes?}" },
  missed_policy: { type: "string", enum: ["run-once", "skip"], description: "If a run is missed: run once late (default) or skip" },
  at: str("once: ISO date-time"),
  minutes: { type: "number", description: "interval: minutes (15 or more)" },
};

function scheduleFrom(i: any): Schedule {
  return {
    kind: i.kind,
    time: i.time,
    days: i.days,
    timeZone: i.time_zone,
    custom: i.custom,
    window: i.window,
    conditions: i.conditions,
    alert: i.alert,
    missedPolicy: i.missed_policy,
    at: i.at,
    minutes: i.minutes,
  };
}

/** Your own routine, or an error (bots can't touch each other's routines). */
function ownRoutine(bot: Bot, rid: string) {
  const r = getRoutine(String(rid));
  if (!r || r.botId !== bot.id) throw new Error("No routine with that id belongs to you. Use routine_list to see yours.");
  return r;
}

const routinePermission = { key: "routines:change", label: "changing or deleting your routines" };

function routineTools(): Tool[] {
  return [
    {
      group: "core",
      spec: {
        name: "routine_create",
        description: "Create a routine: Once a Day, Once a Week, Upon Alert, or Custom (intervals of 15+ minutes, specific dates, recurring). Write the prompt as instructions to yourself, including when to call notify_user.",
        inputSchema: obj({ title: str("Short name"), prompt: str("What to do each time"), ...scheduleSchema }, ["title", "prompt", "kind"]),
      },
      run: async (c, i) => {
        const r = createRoutine({ botId: c.bot.id, title: i.title, prompt: i.prompt, schedule: scheduleFrom(i) });
        return `Created routine "${r.title}" (id ${r.id}): ${describeSchedule(r.schedule)}. Next run: ${r.nextRunAt ?? (r.schedule.kind === "alert" ? "when a matching alert arrives" : "none")}.`;
      },
    },
    {
      group: "core",
      spec: { name: "routine_list", description: "List your routines with their full prompt, schedule, state, next/last run, last result and history summary.", inputSchema: obj({}) },
      run: async (c) => JSON.stringify(listRoutines(c.bot.id).map(routineDetails), null, 1),
    },
    {
      group: "core",
      spec: {
        name: "routine_update",
        description: "Change one of your routines (keeps its id). Give only what changes: title, prompt and/or schedule fields. The person approves the change.",
        inputSchema: obj({ id: str("Routine id"), title: str("New title"), prompt: str("New prompt"), ...scheduleSchema, kind: { ...scheduleSchema.kind, description: "New schedule kind (only when changing the schedule)" } }, ["id"]),
      },
      alwaysAsk: true,
      risk: (i) => `Change routine ${getRoutine(String(i.id))?.title ?? i.id}`,
      permission: () => routinePermission,
      run: async (c, i) => {
        const r = ownRoutine(c.bot, i.id);
        const patch: any = {};
        if (i.title) patch.title = i.title;
        if (i.prompt) patch.prompt = i.prompt;
        if (i.kind) patch.schedule = scheduleFrom(i);
        const u = updateRoutine(r.id, patch);
        return `Updated "${u.title}" (id ${u.id}): ${describeSchedule(u.schedule)}. Next run: ${u.nextRunAt ?? "—"}.`;
      },
    },
    {
      group: "core",
      spec: { name: "routine_delete", description: "Delete one of your routines. The person approves it.", inputSchema: obj({ id: str("Routine id") }, ["id"]) },
      alwaysAsk: true,
      risk: (i) => `Delete routine ${getRoutine(String(i.id))?.title ?? i.id}`,
      permission: () => routinePermission,
      run: async (c, i) => {
        const r = ownRoutine(c.bot, i.id);
        deleteRoutine(r.id);
        return `Deleted "${r.title}".`;
      },
    },
    {
      group: "core",
      spec: { name: "routine_run_now", description: "Start one of your routines now (it's queued and reported when it actually finishes).", inputSchema: obj({ id: str("Routine id") }, ["id"]) },
      run: async (c, i) => {
        const r = ownRoutine(c.bot, i.id);
        const run = runRoutineNow(r.id);
        return `Queued run ${run.id} of "${r.title}" (status: ${run.status}). Check routine_history for the result.`;
      },
    },
    {
      group: "core",
      spec: { name: "routine_history", description: "Recent runs of one of your routines: status, times, result or error.", inputSchema: obj({ id: str("Routine id"), limit: { type: "number" } }, ["id"]) },
      run: async (c, i) => {
        const r = ownRoutine(c.bot, i.id);
        return JSON.stringify(listRuns(r.id, Math.min(50, Number(i.limit ?? 10))).map(({ botId, routineId, ...run }) => run), null, 1);
      },
    },
    {
      group: "core",
      spec: { name: "routine_pause", description: "Pause one of your routines (it won't run until resumed).", inputSchema: obj({ id: str("Routine id") }, ["id"]) },
      run: async (c, i) => `Paused "${pauseRoutine(ownRoutine(c.bot, i.id).id).title}".`,
    },
    {
      group: "core",
      spec: { name: "routine_resume", description: "Resume a paused routine of yours.", inputSchema: obj({ id: str("Routine id") }, ["id"]) },
      run: async (c, i) => {
        const u = resumeRoutine(ownRoutine(c.bot, i.id).id);
        return `Resumed "${u.title}". Next run: ${u.nextRunAt ?? "when triggered"}.`;
      },
    },
  ];
}

// ---------------- Calendar ----------------

function calendarTools(): Tool[] {
  return [
    {
      group: "apps",
      spec: {
        name: "calendar_list",
        description: "List every Google calendar across the person's connected accounts: account alias, calendar name, id, access (owner/writer can add events; reader is read-only), and which one is the chosen destination. Also lists accounts that couldn't be read and why.",
        inputSchema: obj({}),
      },
      run: async () => {
        const d = await calendar.discoverCalendars();
        return JSON.stringify({ destination: calendar.getDestination(), calendars: d.calendars, problems: d.problems }, null, 1);
      },
    },
    {
      group: "apps",
      spec: {
        name: "calendar_create_event",
        description: "Add an event to Google Calendar. Goes to the chosen destination calendar unless you name one (calendar). Checks for an identical event first and confirms the event exists afterwards. The person approves it.",
        inputSchema: obj(
          {
            summary: str("Title"),
            start: str('Local start "YYYY-MM-DDTHH:MM"'),
            duration_minutes: { type: "number", description: "Default 60" },
            calendar: str("Calendar name or id (optional; default = the chosen destination)"),
            description: str("Notes"),
            location: str("Place"),
            time_zone: str("e.g. Australia/Sydney"),
          },
          ["summary", "start"],
        ),
      },
      alwaysAsk: true,
      risk: (i) => `Add "${i.summary}" on ${String(i.start).replace("T", " ")} to ${i.calendar ?? calendar.getDestination()?.name ?? "your calendar"}`,
      permission: () => ({ key: "calendar:write", label: "adding events to your calendars" }),
      run: async (_c, i) => {
        const r = await calendar.createEvent(
          { summary: i.summary, start: i.start, durationMinutes: i.duration_minutes, description: i.description, location: i.location, timeZone: i.time_zone },
          i.calendar ? { name: i.calendar } : undefined,
        );
        return { text: JSON.stringify(r, null, 1), isError: r.status === "failed" };
      },
    },
  ];
}

// ---------------- Morning Brief ----------------

function briefTools(): Tool[] {
  return [
    {
      group: "core",
      spec: {
        name: "morning_brief_prepare",
        description:
          "Gather today's Morning Brief facts: school day / term week (from confirmed term dates), today's calendar events, this week's Staff Update (found in Google Drive by title and content, with its link), Thursday sport rows from this week's sport-matrix tab, recent notices, the calendar destination status, the person's brief preferences (with which are confirmed vs assumed), plus warnings and source links. Never substitutes older documents.",
        inputSchema: obj({ date: str("YYYY-MM-DD (default today)") }),
      },
      run: async (_c, i) => JSON.stringify(await brief.prepareBrief(i.date), null, 1),
    },
    {
      group: "core",
      spec: {
        name: "morning_brief_publish",
        description: "Save the finished Morning Brief to the Briefing screen and send the 'Morning Brief ready' notification linking to it. Proposed calendar events wait for the person's approval on that screen.",
        inputSchema: obj(
          {
            date: str("YYYY-MM-DD (default today)"),
            summary: str("The brief, in plain words (Markdown ok)"),
            staff_update_summary: str("Key Staff Update items"),
            notices: { type: "array", items: { type: "string" } },
            proposed_events: { type: "array", items: { type: "object", properties: { summary: { type: "string" }, start: { type: "string", description: "YYYY-MM-DDTHH:MM" }, duration_minutes: { type: "number" }, reason: { type: "string" } }, required: ["summary", "start"] } },
            extra_warnings: { type: "array", items: { type: "string" } },
          },
          ["summary"],
        ),
      },
      run: async (c, i) => {
        const b = await brief.publishBrief(i, c.bot.id);
        return `Published briefing ${b.id} for ${b.date} (${b.warnings.length} warnings, ${b.proposedEvents.length} proposed events). The person was notified.`;
      },
    },
  ];
}

// ---------------- Weekly audit ----------------

/** The routine run this bot is working on (or a stand-in id when used from a chat). */
function auditRunId(bot: Bot) {
  return currentRunTags(bot.id).find((t) => t.startsWith("run_")) ?? `chat-${new Date().toISOString().slice(0, 10)}-${bot.id}`;
}

function auditTools(): Tool[] {
  return [
    {
      group: "web",
      spec: { name: "skills_market_search", description: "Search GitHub for agent skills (claude-skills / agent-skills repos) installable through MausDroid's Skills marketplace. Returns owner/repo, description, stars.", inputSchema: obj({ query: str("Search words") }) },
      run: async (_c, i) => JSON.stringify(await searchMarketplace(String(i.query ?? "")), null, 1),
    },
    {
      group: "core",
      spec: { name: "audit_begin", description: "Start the weekly audit: records the research window (5-minute cutoff) and checks the private wiki.", inputSchema: obj({}) },
      run: async (c) => {
        const runId = auditRunId(c.bot);
        const run = getRun(runId);
        const start = run?.startedAt ? new Date(run.startedAt) : new Date();
        const r = run ? getRoutine(run.routineId) : undefined;
        const cutoff = new Date(start.getTime() + (r?.researchCutoffMinutes ?? 5) * 60_000);
        const wiki = await audit.checkWiki();
        audit.upsertAudit(runId, { startedAt: start.toISOString(), researchCutoffAt: cutoff.toISOString(), wiki });
        return `Audit started. Research tools stop at ${cutoff.toISOString()} (in ${Math.max(0, Math.round((cutoff.getTime() - Date.now()) / 1000))} s). Wiki: ${wiki.detail}`;
      },
    },
    {
      group: "core",
      spec: {
        name: "audit_score",
        description: "Score audit candidates (/25; safety is a hard gate), remove duplicates (this audit and the wiki), rank them. Call once with all candidates.",
        inputSchema: obj({ candidates: { type: "array", items: { type: "object" }, description: "Each: name, source_ecosystem, source_url, summary, utility, adoption, scope_fit, setup, privacy (1-5), phase, primitives[], composio[], account_alias, github_repo?, action_type, safety{flag:bool}, alignment{what,why,integrations,implementation,workaround,upgrade_path,privacy}" } }, ["candidates"]),
      },
      run: async (c, i) => {
        const runId = auditRunId(c.bot);
        const scored = (Array.isArray(i.candidates) ? i.candidates : []).map((x: any) => audit.scoreCandidate({ primitives: [], ...x }));
        let wikiList: audit.WikiEntry[] = [];
        let wikiErr = "";
        try {
          wikiList = await audit.wikiEntries();
        } catch (e) {
          wikiErr = (e as Error).message;
        }
        const accepted = scored.filter((x: audit.Scored) => x.accepted);
        const { kept, duplicates } = audit.dedupe(accepted, wikiList);
        const all = [...kept, ...scored.filter((x: audit.Scored) => !x.accepted)];
        audit.upsertAudit(runId, { scored: all, duplicates });
        const ranked = audit.rank(all);
        return JSON.stringify({ accepted: ranked.map((x) => ({ rank: x.rank, name: x.name, total: x.total, phase: x.phase, slug: x.slug })), rejected: all.filter((x) => !x.accepted).map((x) => ({ name: x.name, reasons: x.reasons })), duplicates, wikiCheck: wikiErr || "ok", overflowToFile: Math.max(0, ranked.length - 20) }, null, 1);
      },
    },
    {
      group: "core",
      spec: { name: "audit_file_overflow", description: "File every accepted candidate ranked 21 or lower in the private wiki (verified by reading back). Refuses if the wiki isn't private.", inputSchema: obj({}) },
      run: async (c) => {
        const runId = auditRunId(c.bot);
        const rec = audit.auditFor(runId);
        if (!rec) return { text: "Call audit_score first.", isError: true };
        const overflow = audit.rank(rec.scored).slice(20);
        if (!overflow.length) return "Nothing ranked 21 or lower: no wiki filing needed.";
        const wiki = await audit.checkWiki();
        if (!wiki.ok) {
          audit.upsertAudit(runId, { wiki });
          return { text: `Wiki unavailable: ${wiki.detail} (Notion fallback isn't set up.) Nothing filed.`, isError: true };
        }
        const date = rec.startedAt.slice(0, 10);
        const filings = [];
        for (const x of overflow) filings.push({ ...(await audit.fileEntry(x, date)), phase: x.phase });
        audit.upsertAudit(runId, { filings, wiki });
        const ok = filings.filter((f) => f.ok && f.verified).length;
        return `Filed ${ok} of ${overflow.length} (verified). ${filings.filter((f) => !f.ok || !f.verified).map((f) => `${f.slug}: ${f.detail}`).join("; ")}`;
      },
    },
    {
      group: "core",
      spec: {
        name: "audit_finish",
        description: "Finish the audit: builds the report from the recorded scores and verified filings (no invented results) and saves it. Then call memory_save and notify_user.",
        inputSchema: obj({ unavailable_sources: { type: "array", items: { type: "string" } }, notes: str("Short notes") }),
      },
      run: async (c, i) => {
        const runId = auditRunId(c.bot);
        const rec = audit.auditFor(runId);
        if (!rec || !rec.scored.length) return { text: "No scored candidates recorded; the audit is incomplete. Tell the person.", isError: true };
        const updated = audit.upsertAudit(runId, { unavailable: (i.unavailable_sources ?? []).map(String), finishedAt: new Date().toISOString() });
        const report = audit.buildReport(updated, i.notes ? String(i.notes) : "");
        audit.upsertAudit(runId, { report });
        const ranked = audit.rank(updated.scored);
        const p1 = ranked.find((x) => x.phase === "phase-1-ready");
        const filed = updated.filings.filter((f) => f.ok && f.verified).length;
        return `${report}\n\n---\nNext: memory_save (scope "bot") three lines; then notify_user titled "Sunday Routine Audit Ready": top Phase 1 = ${p1?.name ?? "none"}, wiki overflow filed = ${filed}.`;
      },
    },
  ];
}

// ---------------- Location ----------------

function locationTools(): Tool[] {
  return [
    {
      group: "core",
      spec: {
        name: "device_location",
        description: "Get the phone's current location once (latitude, longitude, accuracy in metres, timestamp, provider). Only when needed for the task. The person approves; the app shows that you're using location. Never guess coordinates if this fails.",
        inputSchema: obj({ reason: str("Why you need it (shown to the person)"), max_age_minutes: { type: "number", description: "How old a known position may be (default 2)" } }, ["reason"]),
      },
      alwaysAsk: true,
      risk: (i) => `Use your location: ${i.reason ?? "no reason given"}`,
      permission: () => ({ key: "location", label: "using your location" }),
      run: async (c, i) => {
        const runId = currentRunTags(c.bot.id).find((t) => t.startsWith("run_"));
        const rt = runId ? getRoutine(getRun(runId)?.routineId ?? "") : undefined;
        const requester = `${c.bot.emoji} ${c.bot.name}${rt ? ` (routine “${rt.title}”)` : ""}`;
        const r = await getLocation(requester, Math.round(Number(i.max_age_minutes ?? 2) * 60_000));
        const err = describeLocationError(r);
        return err ? { text: JSON.stringify({ ...r, message: err }), isError: true } : JSON.stringify(r);
      },
    },
  ];
}

// ---------------- Calls ----------------

function callTools(): Tool[] {
  return [
    {
      group: "core",
      spec: {
        name: "call_user",
        description:
          "Phone the person (a ringing call on their phone) when something is worth talking about now. It never rings during their calendar events or lock-out times, and at most a few times an hour — if it can't call, it tells you why and leaves a quiet note. Prefer notify_user for anything that can wait.",
        inputSchema: obj({ reason: str("Why you're calling (shown on the incoming-call screen)"), opening_line: str("What you'll say first when they answer") }, ["reason"]),
      },
      run: async (_c, i) => {
        const c = await calls.ringUser(String(i.reason), i.opening_line ? String(i.opening_line) : undefined);
        if (c.state === "blocked") return `Didn't call: ${c.detail} A quiet notification was left instead.`;
        if (c.state === "declined") return "The person declined the call. Send a message instead if it matters.";
        if (c.state === "missed") return "No answer. A missed-call notification was left.";
        return "They answered. The conversation continues by voice; their words will arrive as messages from the call.";
      },
    },
  ];
}

// ---------------- Shares ----------------

function shareTools(): Tool[] {
  return [
    {
      group: "core",
      spec: {
        name: "routine_forward",
        description: "Send something the person shared (a link, video, photo…) to one of their routines, which runs now with it. Use the share id and routine ids from the share message.",
        inputSchema: obj({ share_id: str("The share id"), routine_id: str("The routine to send it to"), note: str("One line: why it belongs there") }, ["share_id", "routine_id"]),
      },
      run: async (_c, i) => {
        const r = share.forwardShare(String(i.share_id), String(i.routine_id), i.note ? String(i.note) : "");
        return r.already ? `"${r.title}" already has it (it runs automatically for shares or was sent it before).` : `Sent to "${r.title}" — run ${r.runId} is ${r.status}.`;
      },
    },
  ];
}

// ---------------- Self-improvement (Improver only) ----------------

function improveTools(): Tool[] {
  const runId = (bot: Bot) => currentRunTags(bot.id).find((t) => t.startsWith("run_")) ?? `chat-${new Date().toISOString().slice(0, 10)}-${bot.id}`;
  return [
    {
      group: "core",
      spec: { name: "improve_evidence", description: "Tonight's evidence: recent errors, failed/missed/timed-out routine runs, all routines (with prompts), skills, start-up problems and earlier suggestions (don't repeat them).", inputSchema: obj({}) },
      run: async (c) => {
        improve.beginNight(runId(c.bot));
        return JSON.stringify(improve.collectEvidence(), null, 1);
      },
    },
    {
      group: "core",
      spec: {
        name: "improve_propose",
        description: `Record suggestions (at most ${improve.MAX_PER_NIGHT} a night; fewer is better). Nothing changes now: each becomes a card shown at midday that the person approves or declines.`,
        inputSchema: obj(
          {
            suggestions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: str("Short title"),
                  problem: str("What's wrong or missing, in plain words"),
                  change: str("Exactly what would change"),
                  area: { type: "string", enum: ["routine", "skill", "code", "other"] },
                  risk: { type: "string", enum: ["low", "medium", "high"] },
                  evidence: str("What showed the problem (errors, run ids)"),
                  routine_patch: { type: "object", description: "area=routine: {routine_id, title?, prompt?, schedule?, timeout_minutes?, enabled?} with the exact NEW values" },
                  skill: { type: "object", description: "area=skill: {name, content} where content is the complete new SKILL.md (frontmatter name + description, then instructions)" },
                },
                required: ["title", "problem", "change", "area"],
              },
            },
          },
          ["suggestions"],
        ),
      },
      run: async (c, i) => {
        const r = improve.addSuggestions(runId(c.bot), i.suggestions);
        return `Recorded ${r.added.length}: ${r.added.map((p) => p.title).join("; ") || "none"}.${r.refused.length ? ` Not recorded: ${r.refused.map((x) => `${x.title} (${x.reason})`).join("; ")}.` : ""} They'll be shown at ${improve.improveSettings().showTime}.`;
      },
    },
    {
      group: "core",
      spec: { name: "improve_finish", description: "End tonight's check with a one-line summary.", inputSchema: obj({ summary: str("One line") }, ["summary"]) },
      run: async (c, i) => {
        const n = improve.finishNight(runId(c.bot), String(i.summary ?? ""));
        return `Done: ${n.count} suggestion(s) recorded.`;
      },
    },
  ];
}

// ---------------- Editing bots (Maus with your OK; Improver as admin) and Improver admin ----------------

function adminTools(): Tool[] {
  return [
    {
      group: "core",
      admin: true,
      spec: { name: "bot_list", description: "List all bots with their instructions, AI and model, tool switches, tools switched off, skills and approval setting.", inputSchema: obj({}) },
      run: async () => JSON.stringify(listBotsForTools().map(botAdmin.botSummary), null, 1),
    },
    {
      group: "core",
      admin: true,
      alwaysAsk: true,
      spec: {
        name: "bot_edit",
        description: "Change another bot (or yourself): name, emoji, instructions (persona), AI provider and model, tool switches, single tools on/off, skills, approval setting (not your own). Give only what changes. Every change can be undone in Settings → Tools.",
        inputSchema: obj(
          {
            bot_id: str("Bot id or name"),
            name: str("New name"),
            emoji: str("New emoji"),
            persona: str("New instructions (the whole text)"),
            provider_id: str("AI provider id (e.g. claude, chatgpt, local) or empty for the default"),
            model: str("Model id, or empty for the provider's default"),
            tools: { type: "object", description: "Tool switches: {web, browser, apps, phone} true/false" },
            enable_tools: { type: "array", items: { type: "string" }, description: "Single tools to switch on (names from tool_list / Settings → Tools)" },
            disable_tools: { type: "array", items: { type: "string" }, description: "Single tools to switch off" },
            skills: { type: "array", items: { type: "string" }, description: "Skills it may use (empty = all)" },
            approval_mode: { type: "string", enum: ["ask-risky", "ask-all", "auto"] },
          },
          ["bot_id"],
        ),
      },
      risk: () => "Change a bot", // the approval card shows the exact before → after (see gate)
      permission: () => ({ key: "bots:edit", label: "changing other bots" }),
      run: async (c, i) => {
        const ch = botAdmin.applyBotEdit(c.bot, i);
        return `Changed ${ch.botName} (change ${ch.id}, can be undone): ${Object.keys(ch.after).join(", ")}.`;
      },
    },
    {
      group: "core",
      admin: true,
      spec: { name: "tool_list", description: "Every built-in tool with what it does, whether it can change things, and which bots have it switched off.", inputSchema: obj({}) },
      run: async () => JSON.stringify(toolCatalog().map((t) => ({ ...t, offFor: listBotsForTools().filter((b) => (b.disabledTools ?? []).includes(t.name)).map((b) => b.name) })), null, 1),
    },
    {
      group: "core",
      admin: true,
      spec: { name: "routine_admin_list", description: "All routines of every bot (full details).", inputSchema: obj({}) },
      run: async () => JSON.stringify(listRoutines().map((r) => ({ ...routineDetails(r), bot: getBotName(r.botId) })), null, 1),
    },
    {
      group: "core",
      admin: true,
      spec: {
        name: "routine_admin_update",
        description: "Change any bot's routine (keeps its id): title, prompt, schedule, enabled, timeout_minutes. Give only what changes.",
        inputSchema: obj({ id: str("Routine id"), title: str("New title"), prompt: str("New prompt"), enabled: { type: "boolean" }, timeout_minutes: { type: "number" }, ...scheduleSchema, kind: { ...scheduleSchema.kind, description: "New schedule kind (only when changing the schedule)" } }, ["id"]),
      },
      run: async (_c, i) => {
        const r = getRoutine(String(i.id));
        if (!r) throw new Error("No routine with that id. Use routine_admin_list.");
        const patch: any = {};
        if (i.title) patch.title = i.title;
        if (i.prompt) patch.prompt = i.prompt;
        if (typeof i.enabled === "boolean") patch.enabled = i.enabled;
        if (typeof i.timeout_minutes === "number") patch.timeoutMinutes = Math.max(1, Math.min(60, i.timeout_minutes));
        if (i.kind) patch.schedule = scheduleFrom(i);
        const u = updateRoutine(r.id, patch);
        return `Updated "${u.title}" (${getBotName(u.botId)}): ${describeSchedule(u.schedule)}${u.enabled ? "" : " (paused)"}.`;
      },
    },
    {
      group: "core",
      admin: true,
      spec: { name: "skill_save", description: "Create or replace a skill: the complete SKILL.md (frontmatter with name and description, then instructions).", inputSchema: obj({ name: str("Skill name"), content: str("Complete SKILL.md") }, ["name", "content"]) },
      run: async (_c, i) => {
        if (!/^---[\s\S]*?name:[\s\S]*?description:[\s\S]*?---/.test(String(i.content))) throw new Error("SKILL.md needs frontmatter with name and description.");
        return `Saved skill "${saveSkill(String(i.name), String(i.content))}".`;
      },
    },
    {
      group: "core",
      admin: true,
      spec: { name: "improve_record", description: "Record a change you just made at the person's request, so it shows in Improvements history (applied).", inputSchema: obj({ title: str("Short title"), change: str("What you changed"), area: { type: "string", enum: ["routine", "skill", "code", "other"] } }, ["title", "change"]) },
      run: async (_c, i) => `Recorded: ${improve.recordApplied(String(i.title), String(i.change), (i.area ?? "other") as any).title}`,
    },
    {
      group: "core",
      admin: true,
      spec: {
        name: "improve_build",
        description: "Change MausDroid's own program (screens, features, fixes): a Claude Code session in the cloud makes the change from your spec, runs every test, and if they pass it's installed and MausDroid restarts with it (usually 5–20 minutes; the person gets a notification). Write a complete, specific spec.",
        inputSchema: obj({ title: str("Short title"), spec: str("What to change, in detail: behaviour, screens, edge cases") }, ["title", "spec"]),
      },
      run: async (_c, i) => {
        const p = await improve.requestBuild(String(i.title), String(i.spec));
        return p.status === "failed" ? `Couldn't start: ${p.result}` : `Building "${p.title}" in the cloud (id ${p.id}). ${p.result}`;
      },
    },
    {
      group: "core",
      admin: true,
      spec: { name: "improve_versions", description: "MausDroid program versions kept on the phone (which is running, which were set aside) and cloud builds in progress.", inputSchema: obj({}) },
      run: async () => JSON.stringify({ ...selfupdate.engineVersions(), building: improve.listProposals().filter((p) => p.status === "building").map((p) => ({ id: p.id, title: p.title, since: p.build?.startedAt, progress: p.build?.runUrl })) }, null, 1),
    },
    {
      group: "core",
      admin: true,
      spec: { name: "improve_rollback", description: "Go back to an earlier MausDroid program version kept on the phone (default: the one before the running version). MausDroid restarts in a few seconds; the version you leave isn't installed again.", inputSchema: obj({ version: str("Version to go back to, e.g. 0.8.2 (optional)") }) },
      run: async (_c, i) => {
        const r = selfupdate.rollBack(i.version ? String(i.version) : undefined);
        improve.recordApplied(`Rolled back ${r.from} → ${r.to}`, `Went back from ${r.from} to ${r.to}.`, "code");
        return `Going back from ${r.from} to ${r.to}; MausDroid restarts in a few seconds.`;
      },
    },
    {
      group: "core",
      admin: true,
      spec: { name: "improve_withdraw", description: "Withdraw waiting or shown suggestion cards the person no longer wants (by id or title words).", inputSchema: obj({ ids: { type: "array", items: { type: "string" }, description: "Suggestion ids or words from their titles" } }, ["ids"]) },
      run: async (_c, i) => {
        const r = improve.withdraw((i.ids ?? []).map(String));
        return r.length ? `Withdrew: ${r.map((p) => p.title).join("; ")}.` : "No matching waiting suggestions.";
      },
    },
  ];
}

const listBotsForTools = () => listBots().filter((b) => !b.hidden);
const getBotName = (id: string) => getBot(id)?.name ?? "(missing bot)";

// ---------------- Approvals ----------------

const COMPOSIO_READONLY = /SEARCH_TOOLS|GET_TOOL_SCHEMAS|MANAGE_CONNECTIONS/;

/** The type of access a call needs, for "Always allow this type". */
export function permissionFor(tool: Tool, input: any): { key: string; label: string } {
  if (tool.permission) return tool.permission(input);
  if (tool.spec.name.startsWith("composio__")) {
    const slugs: string[] = (input?.tools ?? []).map((t: any) => String(t.tool_slug ?? ""));
    const writes = slugs.filter((x) => WRITE_WORDS.test(x));
    const kits = [...new Set(writes.map((x) => x.split("_")[0].toLowerCase()))].sort();
    if (kits.length) return { key: `apps:${kits.join("+")}:write`, label: `changing things in ${kits.join(", ")}` };
    if (/WORKBENCH|BASH/i.test(tool.spec.name)) return { key: "apps:workbench", label: "running code in Composio's workbench" };
  }
  return { key: tool.spec.name, label: tool.spec.name.replace(/_/g, " ") };
}

/**
 * Decides whether a call may go ahead: allowed types pass, risky calls ask
 * (Allow once / Always allow this type / Deny). Used for every bot and for
 * Claude Code / Codex through the MCP server.
 */
export async function gate(bot: Bot, tool: Tool, input: any, signal?: AbortSignal): Promise<{ allow: boolean; reason?: string }> {
  // Routines with a research cutoff (the weekly audit): research tools stop when it passes.
  if (audit.RESEARCH_TOOLS.test(tool.spec.name)) {
    const run = getRun(currentRunTags(bot.id).find((t) => t.startsWith("run_")) ?? "");
    const r = run ? getRoutine(run.routineId) : undefined;
    if (run?.startedAt && r?.researchCutoffMinutes && Date.now() > new Date(run.startedAt).getTime() + r.researchCutoffMinutes * 60_000)
      return { allow: false, reason: `Research cutoff reached (${r.researchCutoffMinutes} min). Stop researching and score, file and report what you have.` };
  }
  // MausDroid admin tools: Improver has admin rights and isn't asked (other tools still follow its approval setting).
  if (tool.admin && improve.isImprover(bot.id)) return { allow: true };
  let reason = tool.risk?.(input) ?? null;
  if (tool.spec.name === "bot_edit") {
    try {
      const plan = botAdmin.planBotEdit(bot, input);
      reason = botAdmin.describeEdit(plan.target, plan.before, plan.after);
    } catch (e) {
      return { allow: false, reason: (e as Error).message };
    }
  }
  const ask = tool.alwaysAsk || bot.approvalMode === "ask-all" || (bot.approvalMode === "ask-risky" && Boolean(reason));
  if (!ask) return { allow: true };
  if (tool.spec.name.startsWith("composio__") && COMPOSIO_READONLY.test(tool.spec.name)) return { allow: true };
  const perm = permissionFor(tool, input);
  return requestApproval(bot.id, perm.key, reason ?? `Use ${tool.spec.name}`, JSON.stringify(input, null, 1).slice(0, 1200), signal, perm.label);
}
