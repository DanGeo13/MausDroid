import { addMessage, getBot, history, patchMessage, setHistory, updateBot, type Bot } from "./bots.ts";
import { emit } from "./events.ts";
import { provider, settings, type ProviderConfig } from "./settings.ts";
import { getSecret } from "./secrets.ts";
import { anthropicTurn } from "./providers/anthropic.ts";
import { openaiTurn } from "./providers/openai.ts";
import { runCli } from "./providers/cli.ts";
import { describeSkills, memoryContext, toolsFor, type Tool } from "./tools/index.ts";
import { requestApproval } from "./approvals.ts";
import { clip, errorText } from "./util.ts";
import { config } from "./config.ts";
import { fmtLong } from "./time.ts";
import { mcpTokenFor } from "./mcp-server.ts";
import { bridge, bridgeAvailable } from "./bridge.ts";
import type { Block, ModelTurn, Msg } from "./types.ts";

const MAX_STEPS = 40;
const running = new Map<string, AbortController>();
const queues = new Map<string, { text: string; source: string; images?: { mediaType: string; data: string }[] }[]>();

export const isBusy = (botId: string) => running.has(botId);
export const busyBots = () => [...running.keys()];

/** Lets the Android shell keep the CPU awake (screen off) only while a bot works. */
function tellShellBusy() {
  if (bridgeAvailable()) void bridge("/busy", { busy: running.size > 0 }).catch(() => {});
}

export function stopBot(botId: string) {
  running.get(botId)?.abort();
  queues.delete(botId);
}

export function resolveProvider(bot: Bot): ProviderConfig {
  const s = settings();
  const id = bot.providerId ?? s.defaultProvider ?? s.providers.find((p) => p.enabled)?.id;
  const p = id ? provider(id) : undefined;
  if (!p || !p.enabled) throw new Error("No AI is set up for this bot yet. Open Settings → AI and turn one on (Gemini and OpenRouter have free options).");
  return p;
}

export function systemPrompt(bot: Bot, extra = ""): string {
  const s = settings();
  const when = fmtLong(new Date(), s.timeZone);
  return [
    bot.persona || `You are ${bot.name}, a helpful assistant.`,
    `\n\nYou are ${bot.name}, one of the person's bots in MausDroid, an agent app running on their Android phone. It is ${when} (${s.timeZone}).`,
    "Work step by step with your tools. Prefer the quickest reliable tool (web_fetch before the browser; connected apps before the browser).",
    "Anything that sends, buys, posts, deletes or changes things for the person is paused for their approval automatically; just call the tool.",
    "Never type passwords, card numbers or one-time codes yourself: if a site needs a login use browser_ask_login.",
    "For Facebook, Messenger and WhatsApp never drive the person's account in the browser (it can get them banned); draft text for them to send instead.",
    "Reply in plain, friendly language. Keep answers short unless asked for detail.",
    describeSkills(bot.skills),
    memoryContext(bot.id),
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
export function sendToBot(botId: string, text: string, source = "you", images?: { mediaType: string; data: string }[]) {
  const bot = getBot(botId);
  if (!bot) throw new Error("No such bot");
  const msg = addMessage(botId, { role: "user", text, source, status: "done" });
  updateBot(botId, { lastMessageAt: msg.at });
  emit("message", { botId, message: msg });
  const q = queues.get(botId) ?? [];
  q.push({ text: source === "you" ? text : `[${source}] ${text}`, source, images });
  queues.set(botId, q);
  if (!running.has(botId)) void drain(botId);
  return msg;
}

async function drain(botId: string) {
  const ctl = new AbortController();
  running.set(botId, ctl);
  emit("bot.busy", { botId, busy: true });
  tellShellBusy();
  try {
    while ((queues.get(botId) ?? []).length && !ctl.signal.aborted) {
      const batch = queues.get(botId)!.splice(0);
      const bot = getBot(botId);
      if (!bot) break;
      try {
        const p = resolveProvider(bot);
        if (p.kind === "cli-claude" || p.kind === "cli-codex") await runCliTurn(bot, p, batch.map((b) => b.text).join("\n\n"), ctl.signal);
        else await runApiTurn(bot, p, batch, ctl.signal);
      } catch (e) {
        if (ctl.signal.aborted) break;
        const m = addMessage(botId, { role: "assistant", text: `⚠️ ${errorText(e)}`, status: "error" });
        emit("message", { botId, message: m });
      }
    }
  } finally {
    running.delete(botId);
    emit("bot.busy", { botId, busy: false });
    tellShellBusy();
    if (ctl.signal.aborted) {
      const m = addMessage(botId, { role: "note", text: "Stopped.", status: "stopped" });
      emit("message", { botId, message: m });
    }
  }
}

async function runApiTurn(bot: Bot, p: ProviderConfig, batch: { text: string; images?: { mediaType: string; data: string }[] }[], signal: AbortSignal) {
  const h = history(bot.id);
  const content: Block[] = [];
  for (const b of batch) {
    content.push({ type: "text", text: b.text });
    for (const img of b.images ?? []) content.push({ type: "image", ...img });
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
  const reason = tool.risk?.(call.input) ?? null;
  const mustAsk = bot.approvalMode === "ask-all" ? true : bot.approvalMode === "ask-risky" ? Boolean(reason) : false;
  if (mustAsk) {
    const r = await requestApproval(bot.id, call.name, reason ?? `Use ${call.name}`, clip(JSON.stringify(call.input, null, 1), 1200), signal);
    if (!r.allow) {
      finish("You said no.", true, "denied");
      return { type: "tool_result", toolUseId: call.id, content: "The person declined this action. Do not retry it; ask what they would like instead.", isError: true };
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

async function runCliTurn(bot: Bot, p: ProviderConfig, text: string, signal: AbortSignal) {
  const mcpBase = p.runOn === "phone" ? `http://127.0.0.1:${config.port}` : settings().tailscale.enabled ? `http://${settings().tailscale.hostname}` : `http://127.0.0.1:${config.port}`;
  const run = {
    engine: p.kind === "cli-claude" ? ("claude" as const) : ("codex" as const),
    prompt: text,
    model: bot.model ?? p.defaultModel,
    resume: bot.cliSession,
    mcpUrl: `${mcpBase}/mcp/${bot.id}`,
    mcpToken: mcpTokenFor(bot.id),
    systemPrompt: systemPrompt(bot, "\n\nMausDroid's tools (browser on the phone, connected apps, alerts, memory, routines) are available through the mausdroid MCP server."),
  };
  let current: ReturnType<typeof addMessage> | null = null;
  for await (const ev of runCli(p, run, signal)) {
    if (ev.kind === "session" && ev.sessionId) updateBot(bot.id, { cliSession: ev.sessionId });
    else if (ev.kind === "text" && ev.text) {
      current = addMessage(bot.id, { role: "assistant", text: ev.text, status: "done" });
      emit("message", { botId: bot.id, message: current });
    } else if (ev.kind === "tool") {
      const m = addMessage(bot.id, { role: "tool", text: "", tool: { name: ev.name ?? "tool", input: ev.input, status: "done" } });
      emit("message", { botId: bot.id, message: m });
    } else if (ev.kind === "error") throw new Error(ev.text);
  }
  const b = getBot(bot.id);
  if (b) updateBot(bot.id, { unread: b.unread + 1, lastMessageAt: new Date().toISOString() });
}
