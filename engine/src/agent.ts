import { addMessage, getBot, history, messages, patchMessage, setHistory, updateBot, type Bot } from "./bots.ts";
import { emit } from "./events.ts";
import { provider, renamedProvider, settings, type ProviderConfig } from "./settings.ts";
import { getSecret } from "./secrets.ts";
import { anthropicTurn } from "./providers/anthropic.ts";
import { openaiTurn } from "./providers/openai.ts";
import { runCli } from "./providers/cli.ts";
import { isSignedIn } from "./subscriptions.ts";
import { describeSkills, gate, memoryContext, toolsFor, type Tool } from "./tools/index.ts";
import { playbookContext } from "./playbook.ts";
import { accessNote, LATEST_ACCESS_UPDATE } from "./access-updates.ts";
import { clip, errorText } from "./util.ts";
import { config } from "./config.ts";
import { fmtLong } from "./time.ts";
import { mcpTokenFor } from "./mcp-server.ts";
import { bridge, bridgeAvailable } from "./bridge.ts";
import type { Block, ModelTurn, Msg } from "./types.ts";
import { toBlocks, type Attachment } from "./files.ts";

const MAX_STEPS = 40;
const running = new Map<string, AbortController>();
type Queued = { text: string; source: string; attachments?: Attachment[]; tag?: string };
const queues = new Map<string, Queued[]>();
/** How a turn ended: which tagged requests it covered (e.g. routine runs), and whether it failed or was stopped. */
export interface TurnInfo {
  tags: string[];
  failed: boolean;
  aborted: boolean;
}
/** Called with the bot's final reply when a turn ends (voice read-aloud, assistant answers, routine runs). */
type TurnEnd = (botId: string, reply: string, info: TurnInfo) => void;
const turnEndListeners = new Set<TurnEnd>();
export const onTurnEnd = (fn: TurnEnd) => {
  turnEndListeners.add(fn);
  return () => turnEndListeners.delete(fn);
};
type TurnStart = (botId: string, tags: string[]) => void;
const turnStartListeners = new Set<TurnStart>();
export const onTurnStart = (fn: TurnStart) => {
  turnStartListeners.add(fn);
  return () => turnStartListeners.delete(fn);
};
const lastReply = new Map<string, string>();
const lastFailed = new Set<string>();
/** Tags of the turn a bot is working on now (tools use this to know which routine run they serve). */
const currentTags = new Map<string, string[]>();
export const currentRunTags = (botId: string) => currentTags.get(botId) ?? [];

function announceEnd(botId: string, reply: string, info: TurnInfo) {
  for (const l of turnEndListeners) {
    try {
      l(botId, reply, info);
    } catch {
      /* listener problems never stop the bot */
    }
  }
}

export const isBusy = (botId: string) => running.has(botId);
export const busyBots = () => [...running.keys()];

/** Lets the Android shell keep the CPU awake (screen off) only while a bot works. */
function tellShellBusy() {
  if (bridgeAvailable()) void bridge("/busy", { busy: running.size > 0 }).catch(() => {});
}

export function stopBot(botId: string) {
  running.get(botId)?.abort();
  // Requests still waiting are dropped: tell their owners (e.g. routine runs) they were stopped.
  const waiting = (queues.get(botId) ?? []).map((q) => q.tag).filter((t): t is string => Boolean(t));
  queues.delete(botId);
  if (waiting.length) announceEnd(botId, "", { tags: waiting, failed: true, aborted: true });
}

export function resolveProvider(bot: Bot): ProviderConfig {
  const s = settings();
  const id = renamedProvider(bot.providerId) ?? s.defaultProvider ?? s.providers.find((p) => p.enabled)?.id;
  const p = id ? provider(id) : undefined;
  if (!p || !p.enabled) throw new Error("No AI is set up for this bot yet. Open Settings → AI and sign in to Claude or ChatGPT.");
  return p;
}

export function systemPrompt(bot: Bot, extra = ""): string {
  const s = settings();
  const when = fmtLong(new Date());
  return [
    bot.persona || `You are ${bot.name}, a helpful assistant.`,
    `\n\nYou are ${bot.name}, one of the person's bots in MausDroid, an agent app running on their Android phone. It is ${when} (${s.timeZone}).`,
    "Work step by step with your tools. Prefer the quickest reliable tool (web_fetch before the browser; connected apps before the browser).",
    "Anything that sends, buys, posts, deletes or changes things for the person is paused for their approval automatically; just call the tool.",
    "Reading never needs approval — emails, calendars, files, messages you can see, web pages: just look, don't ask first. If the app you need isn't connected, start connecting it (connected apps: manage connections) and give the person the sign-in link; never ask them to copy and paste what you could read yourself. Earlier messages in a chat can be out of date (apps get connected, access changes): try the tool again before saying something can't be reached, and if it really can't, say exactly which source you tried and what's missing.",
    "Never type passwords, card numbers or one-time codes yourself: if a site needs a login use browser_ask_login.",
    "For Facebook, Messenger and WhatsApp never drive the person's account in the browser (it can get them banned); draft text for them to send instead.",
    "Reply in plain, friendly language. Keep answers short unless asked for detail.",
    describeSkills(bot.skills),
    memoryContext(bot.id),
    playbookContext(bot),
    extra,
  ].join(" ");
}

/** Keeps the model's history under a size budget, cutting only at a typed user message. */
function trimHistory(h: Msg[], maxChars = 400_000): Msg[] {
  const size = (m: Msg) => JSON.stringify(m).length;
  let total = h.reduce((a, m) => a + size(m), 0);
  let start = 0;
  while (total > maxChars && start < h.length - 2) {
    total -= size(h[start]);
    start++;
    while (start < h.length && !(h[start].role === "user" && h[start].content.some((b) => b.type === "text"))) {
      total -= size(h[start]);
      start++;
    }
  }
  return h.slice(start);
}

async function modelTurn(p: ProviderConfig, model: string, system: string, msgs: Msg[], tools: Tool[], signal: AbortSignal, onText: (d: string) => void): Promise<ModelTurn> {
  const req = { model, system, messages: msgs, tools: tools.map((t) => t.spec), signal, onText };
  const key = getSecret(`provider:${p.id}`);
  if (p.needsKey && !key) throw new Error(`${p.label} needs an API key (Settings → AI).`);
  if (p.kind === "anthropic") return anthropicTurn(req, key!);
  return openaiTurn(req, p.baseUrl!, key);
}

/** Sends a message to a bot. Returns at once; progress arrives as events. */
export function sendToBot(botId: string, text: string, source = "you", attachments?: Attachment[], tag?: string) {
  const bot = getBot(botId);
  if (!bot) throw new Error("No such bot");
  const msg = addMessage(botId, { role: "user", text, source, status: "done", ...(attachments?.length ? { attachments } : {}) });
  updateBot(botId, { lastMessageAt: msg.at });
  emit("message", { botId, message: msg });
  const q = queues.get(botId) ?? [];
  q.push({ text: source === "you" ? text : `[${source}] ${text}`, source, attachments, tag });
  queues.set(botId, q);
  if (!running.has(botId)) void drain(botId);
  return msg;
}

async function drain(botId: string) {
  const ctl = new AbortController();
  running.set(botId, ctl);
  emit("bot.busy", { botId, busy: true });
  tellShellBusy();
  let tags: string[] = [];
  try {
    while ((queues.get(botId) ?? []).length && !ctl.signal.aborted) {
      const batch = queues.get(botId)!.splice(0);
      const bot = getBot(botId);
      if (!bot) break;
      lastReply.delete(botId);
      lastFailed.delete(botId);
      // An existing chat catches up on access changes once, so it doesn't act on outdated "blocked" results.
      if (bot.accessSeen !== LATEST_ACCESS_UPDATE) {
        const note = accessNote(bot.accessSeen);
        updateBot(botId, { accessSeen: LATEST_ACCESS_UPDATE });
        if (note && batch[0]) {
          batch[0] = { ...batch[0], text: `${note}\n\n${batch[0].text}` };
          const shown = addMessage(botId, { role: "note", text: "MausDroid's access was updated: reading (email, calendar, files) just works, and only changes ask you. This chat has been told, so it tries again instead of using earlier results.", status: "done" });
          emit("message", { botId, message: shown });
        }
      }
      tags = batch.map((b) => b.tag).filter((t): t is string => Boolean(t));
      currentTags.set(botId, tags);
      for (const l of turnStartListeners) {
        try {
          l(botId, tags);
        } catch {
          /* ignore */
        }
      }
      try {
        const p = resolveProvider(bot);
        if (p.kind === "subscription") await runCliTurn(bot, p, batch.map((b) => b.text).join("\n\n"), ctl.signal, batch.flatMap((b) => b.attachments ?? []));
        else await runApiTurn(bot, p, batch, ctl.signal);
      } catch (e) {
        if (ctl.signal.aborted) break;
        const m = addMessage(botId, { role: "assistant", text: `⚠️ ${errorText(e)}`, status: "error" });
        emit("message", { botId, message: m });
        lastReply.set(botId, errorText(e));
        lastFailed.add(botId);
      }
      if (ctl.signal.aborted) break;
      announceEnd(botId, lastReply.get(botId) ?? "", { tags, failed: lastFailed.has(botId), aborted: false });
      tags = [];
    }
  } finally {
    currentTags.delete(botId);
    if (ctl.signal.aborted && tags.length) announceEnd(botId, lastReply.get(botId) ?? "", { tags, failed: true, aborted: true });
    running.delete(botId);
    emit("bot.busy", { botId, busy: false });
    tellShellBusy();
    if (ctl.signal.aborted) {
      const m = addMessage(botId, { role: "note", text: "Stopped.", status: "stopped" });
      emit("message", { botId, message: m });
    }
  }
}

async function runApiTurn(bot: Bot, p: ProviderConfig, batch: { text: string; attachments?: Attachment[] }[], signal: AbortSignal) {
  const h = history(bot.id);
  const content: Block[] = [];
  for (const b of batch) {
    content.push({ type: "text", text: b.text || "(see attached)" });
    content.push(...toBlocks(b.attachments ?? []));
  }
  h.push({ role: "user", content });
  const tools = await toolsFor(bot);
  const model = bot.model ?? p.defaultModel;

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) break;
    const reply = addMessage(bot.id, { role: "assistant", text: "", status: "streaming" });
    emit("message", { botId: bot.id, message: reply });
    let text = "";
    let turn: ModelTurn;
    try {
      turn = await modelTurn(p, model, systemPrompt(bot), trimHistory(h), tools, signal, (d) => {
        text += d;
        emit("message.delta", { botId: bot.id, messageId: reply.id, delta: d });
      });
    } catch (e) {
      patchMessage(bot.id, reply.id, { text: text || `⚠️ ${errorText(e)}`, status: signal.aborted ? "stopped" : "error" });
      emit("message.updated", { botId: bot.id, messageId: reply.id });
      setHistory(bot.id, h);
      if (signal.aborted) return;
      throw e;
    }
    const finalText = turn.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    patchMessage(bot.id, reply.id, { text: finalText, status: "done" });
    if (finalText.trim()) lastReply.set(bot.id, finalText);
    emit("message.updated", { botId: bot.id, messageId: reply.id, text: finalText, status: finalText ? "done" : "empty" });
    h.push({ role: "assistant", content: turn.blocks });

    const calls = turn.blocks.filter((b) => b.type === "tool_use") as Extract<Block, { type: "tool_use" }>[];
    if (!calls.length) break;
    const results: Block[] = [];
    for (const call of calls) results.push(await runTool(bot, tools, call, signal));
    h.push({ role: "user", content: results });
    setHistory(bot.id, h);
  }
  setHistory(bot.id, h);
  const b = getBot(bot.id);
  if (b) updateBot(bot.id, { unread: b.unread + 1, lastMessageAt: new Date().toISOString() });
}

async function runTool(bot: Bot, tools: Tool[], call: Extract<Block, { type: "tool_use" }>, signal: AbortSignal): Promise<Block> {
  const tool = tools.find((t) => t.spec.name === call.name);
  const card = addMessage(bot.id, { role: "tool", text: "", tool: { name: call.name, input: call.input, status: "running" } });
  emit("message", { botId: bot.id, message: card });
  const finish = (result: string, isError: boolean, status: "done" | "denied") => {
    patchMessage(bot.id, card.id, { tool: { name: call.name, input: call.input, result: clip(result, 4000), isError, status } });
    emit("message.updated", { botId: bot.id, messageId: card.id });
  };
  if (!tool) {
    finish("Unknown tool", true, "done");
    return { type: "tool_result", toolUseId: call.id, content: `There is no tool called ${call.name}.`, isError: true };
  }
  {
    const r = await gate(bot, tool, call.input, signal);
    if (!r.allow) {
      finish(r.reason ?? "You said no.", true, "denied");
      return { type: "tool_result", toolUseId: call.id, content: r.reason ?? "The person declined this action. Do not retry it; ask what they would like instead.", isError: true };
    }
  }
  try {
    const out = await tool.run({ bot, signal }, call.input);
    const res = typeof out === "string" ? { text: out } : out;
    finish(res.text, Boolean(res.isError), "done");
    return { type: "tool_result", toolUseId: call.id, content: clip(res.text), isError: res.isError, images: res.images };
  } catch (e) {
    finish(errorText(e), true, "done");
    return { type: "tool_result", toolUseId: call.id, content: errorText(e), isError: true };
  }
}

/** Errors meaning a saved Claude Code / Codex conversation no longer exists. */
export const STALE_SESSION = /no rollout found|thread\/resume failed|no conversation found|conversation .{0,40}not found|session .{0,40}not found|could not find (the )?(session|conversation)/i;

async function runCliTurn(bot: Bot, p: ProviderConfig, text: string, signal: AbortSignal, attachments: Attachment[] = []) {
  // On the phone the program reaches MausDroid locally; a computer reaches it over Tailscale.
  const onPhone = p.runOn !== "computer" && isSignedIn(p.subId!);
  const mcpBase = onPhone || !settings().tailscale.enabled ? `http://127.0.0.1:${config.port}` : `http://${settings().tailscale.hostname}`;
  const run = {
    attachments,
    prompt: text,
    model: bot.model ?? p.defaultModel,
    resume: bot.cliSession,
    mcpUrl: `${mcpBase}/mcp/${bot.id}`,
    mcpToken: mcpTokenFor(bot.id),
    systemPrompt: systemPrompt(bot, "\n\nMausDroid's tools (browser on the phone, connected apps, alerts, memory, routines, skills) are available through the mausdroid MCP server."),
  };
  let current: ReturnType<typeof addMessage> | null = null;
  let streaming: ReturnType<typeof addMessage> | null = null;
  let streamed = "";
  const toolMsgs = new Map<string, string>();
  let produced = false;
  const pass = async () => {
  for await (const ev of runCli(p, run, signal)) {
    if (ev.kind !== "session") produced = true;
    if (ev.kind === "session" && ev.sessionId) updateBot(bot.id, { cliSession: ev.sessionId });
    else if (ev.kind === "delta" && ev.text) {
      if (!streaming) {
        streaming = addMessage(bot.id, { role: "assistant", text: "", status: "streaming" });
        emit("message", { botId: bot.id, message: streaming });
      }
      streamed += ev.text;
      emit("message.delta", { botId: bot.id, messageId: streaming.id, delta: ev.text });
    } else if (ev.kind === "text" && ev.text) {
      if (streaming) {
        // The finished text replaces what was streamed (same message).
        patchMessage(bot.id, streaming.id, { text: ev.text, status: "done" });
        if (ev.text.startsWith(streamed) && ev.text.length > streamed.length) emit("message.delta", { botId: bot.id, messageId: streaming.id, delta: ev.text.slice(streamed.length) });
        emit("message.updated", { botId: bot.id, messageId: streaming.id, text: ev.text, status: "done" });
        current = streaming;
        streaming = null;
        streamed = "";
      } else {
        current = addMessage(bot.id, { role: "assistant", text: ev.text, status: "done" });
        emit("message", { botId: bot.id, message: current });
      }
      lastReply.set(bot.id, ev.text);
    } else if (ev.kind === "tool") {
      const m = addMessage(bot.id, { role: "tool", text: "", tool: { name: ev.name ?? "tool", input: ev.input, status: "running" } });
      if (ev.toolId) toolMsgs.set(ev.toolId, m.id);
      emit("message", { botId: bot.id, message: m });
    } else if (ev.kind === "tool_result" && ev.toolId && toolMsgs.has(ev.toolId)) {
      // Show what really happened (a refusal shows as one, not as a tick).
      const mid = toolMsgs.get(ev.toolId)!;
      toolMsgs.delete(ev.toolId);
      const cur = messages(bot.id, undefined, 200).find((x) => x.id === mid);
      const refused = Boolean(ev.isError) && /permission|not allowed|denied|declined|haven't granted|blocked/i.test(ev.text ?? "");
      patchMessage(bot.id, mid, { tool: { ...(cur?.tool ?? { name: "tool" }), result: clip(ev.text ?? "", 2000), isError: Boolean(ev.isError), status: refused ? "denied" : "done" } as any });
      emit("message.updated", { botId: bot.id, messageId: mid });
    } else if (ev.kind === "error") throw new Error(ev.text);
  }
  };
  try {
    try {
      await pass();
    } catch (e) {
      // The earlier conversation can't be continued (Codex / Claude no longer has it): start a fresh one once.
      if (!run.resume || produced || signal.aborted || !STALE_SESSION.test(errorText(e))) throw e;
      updateBot(bot.id, { cliSession: undefined });
      run.resume = undefined;
      const note = addMessage(bot.id, { role: "note", text: "Started a fresh conversation — the earlier one couldn't be continued.", status: "done" });
      emit("message", { botId: bot.id, message: note });
      await pass();
    }
  } finally {
    // Tools that never reported back (some programs don't) are marked done.
    for (const mid of toolMsgs.values()) {
      const cur = messages(bot.id, undefined, 200).find((x) => x.id === mid);
      if (cur?.tool?.status === "running") patchMessage(bot.id, mid, { tool: { ...cur.tool, status: "done" } });
      emit("message.updated", { botId: bot.id, messageId: mid });
    }
    // Stopped or failed half-way: keep what was said so far.
    const half = streaming as ReturnType<typeof addMessage> | null; // set inside pass()
    if (half) {
      patchMessage(bot.id, half.id, { text: streamed, status: signal.aborted ? "stopped" : "done" });
      emit("message.updated", { botId: bot.id, messageId: half.id, text: streamed });
      if (streamed) lastReply.set(bot.id, streamed);
    }
  }
  const b = getBot(bot.id);
  if (b) updateBot(bot.id, { unread: b.unread + 1, lastMessageAt: new Date().toISOString() });
}
