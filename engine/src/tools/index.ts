import type { ToolSpec } from "../types.ts";
import type { Bot } from "../bots.ts";
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

/** Every tool a bot may use right now (its switches + connected apps). */
let extraTools: Tool[] | null = null;
/** Built-in tools plus the routine tools (built on first use). */
const allBuiltins = () => [...builtins, ...(extraTools ??= routineTools())];

export async function toolsFor(bot: Bot): Promise<Tool[]> {
  const list = allBuiltins().filter((t) => t.group === "core" || bot.tools[t.group as keyof Bot["tools"]]);
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
  alert: { type: "object", description: "alert: {type?, source?, minPriority?: low|normal|high, contains?, dedupeMinutes?}" },
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
export async function gate(bot: Bot, tool: Tool, input: any, signal?: AbortSignal): Promise<{ allow: boolean }> {
  const reason = tool.risk?.(input) ?? null;
  const ask = tool.alwaysAsk || bot.approvalMode === "ask-all" || (bot.approvalMode === "ask-risky" && Boolean(reason));
  if (!ask) return { allow: true };
  if (tool.spec.name.startsWith("composio__") && COMPOSIO_READONLY.test(tool.spec.name)) return { allow: true };
  const perm = permissionFor(tool, input);
  return requestApproval(bot.id, perm.key, reason ?? `Use ${tool.spec.name}`, JSON.stringify(input, null, 1).slice(0, 1200), signal, perm.label);
}
