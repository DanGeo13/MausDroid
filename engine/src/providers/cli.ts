import { spawn } from "node:child_process";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { getSecret } from "../secrets.ts";
import type { ProviderConfig } from "../settings.ts";
import fs from "node:fs";
import path from "node:path";
import { describe, exportTo, filePath, type Attachment } from "../files.ts";
import { isSignedIn, programCommand, programEnv, workDir, SUBS, type SubId } from "../subscriptions.ts";

/**
 * Subscription engines: the official Claude Code and Codex programs, signed in with your own account. They run their own agent loop;
 * MausDroid gives them its tools (browser, connected apps, alerts…) over MCP
 * and turns their permission prompts into approval cards.
 *
 * Where: on this phone first; if that isn't possible, on your computer
 * through the MausDroid companion (when one is set up).
 */
export interface CliRun {
  engine: "claude" | "codex";
  prompt: string;
  model?: string;
  resume?: string;
  mcpUrl: string;
  mcpToken: string;
  systemPrompt: string;
  /** Relative paths (in the work folder) of pictures, given to Codex as images. */
  images?: string[];
  /** For a computer: the attached files themselves (the companion saves them). */
  files?: { path: string; b64: string }[];
}

export interface CliEvent {
  kind: "text" | "delta" | "tool" | "tool_result" | "session" | "done" | "error";
  text?: string;
  /** Links a tool call to its result. */
  toolId?: string;
  isError?: boolean;
  name?: string;
  input?: unknown;
  sessionId?: string;
}

const engineFor = (sub: SubId): CliRun["engine"] => (sub === "chatgpt" ? "codex" : "claude");

/** Tools Claude Code may use without asking: all of MausDroid's (it gates them itself) and its own read-only ones. */
export const CLI_ALLOWED_TOOLS = ["mcp__mausdroid", "Read", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "TodoWrite", "NotebookRead"];
/** Claude Code's own tools that could change things outside MausDroid's approvals: off. */
export const CLI_DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "KillShell", "BashOutput"];
const CLI_READ_ONLY = new Set(CLI_ALLOWED_TOOLS.filter((t) => t !== "mcp__mausdroid"));

/**
 * When Claude Code asks permission for a tool anyway: MausDroid's tools and
 * read-only tools are allowed (MausDroid's own gate still checks its tools);
 * anything else (running commands, editing files) asks the person once.
 */
export function cliPermission(toolName: string): "allow" | "ask" {
  const t = String(toolName);
  if (t.startsWith("mcp__mausdroid__")) return "allow";
  if (CLI_READ_ONLY.has(t)) return "allow";
  return "ask";
}

export function cliArgs(run: CliRun): string[] {
  if (run.engine === "claude") {
    const mcp = JSON.stringify({ mcpServers: { mausdroid: { type: "http", url: run.mcpUrl, headers: { authorization: `Bearer ${run.mcpToken}` } } } });
    const args = ["-p", run.prompt, "--output-format", "stream-json", "--verbose", "--mcp-config", mcp,
      "--append-system-prompt", run.systemPrompt, "--include-partial-messages",
      // One approval layer: Claude Code doesn't ask (its own prompts got in the way of simple reads);
      // MausDroid's tools ask you themselves when something would be sent, changed, deleted, bought or posted.
      // Claude Code's own command-running and file-writing tools are switched off entirely.
      "--permission-mode", "bypassPermissions", "--disallowedTools", ...CLI_DISALLOWED_TOOLS,
      "--allowedTools", ...CLI_ALLOWED_TOOLS];
    if (run.model && run.model !== "default") args.push("--model", run.model);
    if (run.resume) args.push("--resume", run.resume);
    return args;
  }
  const args = ["exec", ...(run.resume ? ["resume", run.resume] : []), "--json", "--skip-git-repo-check",
    // Connected apps for MausDroid bots must go through the phone's approval layer.
    "--disable", "apps",
    "-c", `mcp_servers.mausdroid.url=${JSON.stringify(run.mcpUrl)}`,
    "-c", 'mcp_servers.mausdroid.bearer_token_env_var="MAUSDROID_MCP_TOKEN"',
    // MausDroid checks the bot's current permissions on each call. Codex exec can't show approval prompts.
    "-c", 'mcp_servers.mausdroid.default_tools_approval_mode="approve"',
    "-c", "mcp_servers.mausdroid.tool_timeout_sec=600"];
  if (run.model && run.model !== "default") args.push("-m", run.model);
  for (const img of run.images ?? []) args.push("-i", img);
  args.push(run.resume ? run.prompt : `${run.systemPrompt}\n\n${run.prompt}`);
  return args;
}

/** Turns one line of the program's JSON output into MausDroid events. */
export function parseCliLine(engine: CliRun["engine"], line: string, acc: { text: string }): CliEvent[] {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return [];
  }
  const out: CliEvent[] = [];
  if (engine === "claude") {
    if (ev.type === "system" && ev.session_id) out.push({ kind: "session", sessionId: ev.session_id });
    // Word-by-word text as Claude writes it (the whole text still follows in an "assistant" event).
    if (ev.type === "stream_event" && ev.event?.type === "content_block_delta" && ev.event.delta?.type === "text_delta" && ev.event.delta.text) out.push({ kind: "delta", text: ev.event.delta.text });
    if (ev.type === "assistant")
      for (const b of ev.message?.content ?? []) {
        if (b.type === "text") out.push({ kind: "text", text: b.text });
        if (b.type === "tool_use") out.push({ kind: "tool", name: b.name, input: b.input, toolId: b.id });
      }
    if (ev.type === "user")
      for (const b of ev.message?.content ?? [])
        if (b.type === "tool_result") out.push({ kind: "tool_result", toolId: b.tool_use_id, isError: Boolean(b.is_error), text: typeof b.content === "string" ? b.content : (Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("\n") : JSON.stringify(b.content)).slice(0, 2000) });
    if (ev.type === "result") {
      if (ev.session_id) out.push({ kind: "session", sessionId: ev.session_id });
      out.push(ev.is_error ? { kind: "error", text: ev.result ?? "Claude reported an error" } : { kind: "done" });
    }
  } else if (engine === "codex") {
    if (ev.type === "thread.started") out.push({ kind: "session", sessionId: ev.thread_id });
    const it = ev.item ?? {};
    if (it.type === "mcp_tool_call" && (ev.type === "item.started" || ev.type === "item.completed")) {
      if (ev.type === "item.started") out.push({ kind: "tool", name: it.tool, input: it.arguments, toolId: it.id });
      else {
        const result = it.result?.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
        out.push({ kind: "tool_result", toolId: it.id, isError: it.status === "failed" || Boolean(it.error), text: (it.error?.message || result || "").slice(0, 2000) });
      }
    }
    if (ev.type === "item.completed") {
      if (it.type === "agent_message") out.push({ kind: "text", text: it.text });
      else if (it.type === "command_execution") out.push({ kind: "tool", name: "shell", input: { command: it.command } }, { kind: "tool_result", text: String(it.aggregated_output ?? "").slice(0, 2000) });
    }
    if (ev.type === "turn.completed") out.push({ kind: "done" });
    if (ev.type === "turn.failed" || ev.type === "error") out.push({ kind: "error", text: ev.error?.message ?? ev.message ?? "ChatGPT (Codex) error" });
  }
  return out;
}

async function* lines(stream: AsyncIterable<string>) {
  for await (const l of stream) yield l;
}

/** On a paired computer through its companion (streams NDJSON lines). */
async function* runOnComputer(p: ProviderConfig, run: CliRun, signal: AbortSignal): AsyncGenerator<string> {
  const res = await fetch(`${p.computerUrl!.replace(/\/$/, "")}/run`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${getSecret(`computer:${p.id}`) ?? ""}` },
    body: JSON.stringify(run),
  });
  if (!res.ok || !res.body) throw new Error(`Your computer said: HTTP ${res.status} ${await res.text()}`);
  const reader = (res.body as any).getReader();
  const dec = new StringDecoder("utf8");
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.write(Buffer.from(value));
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) yield buf;
}

async function* runOnPhone(sub: SubId, run: CliRun, signal: AbortSignal): AsyncGenerator<string> {
  const [cmd, args] = programCommand(sub, cliArgs(run));
  const child = spawn(cmd, args, { cwd: workDir(), env: { ...programEnv(sub), MAUSDROID_MCP_TOKEN: run.mcpToken }, stdio: ["ignore", "pipe", "pipe"] });
  signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const started = new Promise<void>((ok, fail) => {
    child.once("spawn", ok);
    child.once("error", fail);
  });
  await started;
  yield* lines(readline.createInterface({ input: child.stdout }));
  const code: number = await new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on("close", r)));
  if (code !== 0 && !signal.aborted) throw new Error(`${SUBS[sub].program} stopped (code ${code}): ${stderr.slice(-600)}`);
}

/** Adds attached files to the prompt; on a computer the files travel with the request. */
function withFiles(run: CliRun, list: Attachment[], forComputer: boolean): CliRun {
  if (!list.length) return run;
  let rels: string[];
  let files: CliRun["files"];
  if (forComputer) {
    let total = 0;
    files = [];
    rels = [];
    for (const a of list) {
      if ((total += a.size) > 40_000_000) break;
      const rel = path.join("attachments", `${a.id.slice(5, 11)}-${a.name}`);
      files.push({ path: rel, b64: fs.readFileSync(filePath(a)).toString("base64") });
      rels.push(rel);
    }
  } else rels = exportTo(workDir(), list);
  const lines = list.map((a, i) => (rels[i] ? `- ${rels[i]} — ${describe(a)}` : null)).filter(Boolean);
  const images = list.map((a, i) => (a.kind === "image" && rels[i] ? rels[i] : null)).filter(Boolean) as string[];
  return {
    ...run,
    images: run.engine === "codex" ? images : undefined,
    files,
    prompt: `${run.prompt}\n\nAttached files (open them with your tools; paths are relative to the current folder):\n${lines.join("\n")}`,
  };
}

export async function* runCli(p: ProviderConfig, run: Omit<CliRun, "engine"> & { attachments?: Attachment[] }, signal: AbortSignal): AsyncGenerator<CliEvent> {
  const sub = p.subId!;
  const { attachments = [], ...rest } = run;
  const base: CliRun = { ...rest, engine: engineFor(sub) };
  const acc = { text: "" };
  const canComputer = Boolean(p.computerUrl);
  const phoneReady = p.runOn !== "computer" && isSignedIn(sub);
  if (!phoneReady && !canComputer) {
    throw new Error(`Sign in to ${SUBS[sub].label} first: Settings → AI → ${SUBS[sub].label} → Sign in.`);
  }
  let source: AsyncGenerator<string>;
  let full = withFiles(base, attachments, !phoneReady);
  if (phoneReady) {
    try {
      source = runOnPhone(sub, full, signal);
      const first = await source.next();
      if (!first.done) for (const e of parseCliLine(full.engine, first.value, acc)) yield e;
    } catch (e) {
      if (!canComputer) throw e;
      yield { kind: "tool", name: "switching to your computer", input: { reason: String((e as Error).message).slice(0, 200) } };
      full = withFiles(base, attachments, true);
      source = runOnComputer(p, full, signal);
    }
  } else source = runOnComputer(p, full, signal);
  for await (const line of source) for (const e of parseCliLine(full.engine, line, acc)) yield e;
  if (acc.text.trim()) yield { kind: "text", text: acc.text.trim() };
}
