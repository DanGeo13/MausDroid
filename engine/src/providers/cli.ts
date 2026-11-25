import { spawn } from "node:child_process";
import readline from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { getSecret } from "../secrets.ts";
import type { ProviderConfig } from "../settings.ts";
import { isSignedIn, programCommand, programEnv, workDir, writeGeminiSettings, SUBS, type SubId } from "../subscriptions.ts";

/**
 * Subscription engines: the official Claude Code, Codex and Gemini CLI
 * programs, signed in with your own account. They run their own agent loop;
 * MausDroid gives them its tools (browser, connected apps, alerts…) over MCP
 * and turns their permission prompts into approval cards.
 *
 * Where: on this phone first; if that isn't possible, on your computer
 * through the MausDroid companion (when one is set up).
 */
export interface CliRun {
  engine: "claude" | "codex" | "gemini";
  prompt: string;
  model?: string;
  resume?: string;
  mcpUrl: string;
  mcpToken: string;
  systemPrompt: string;
}

export interface CliEvent {
  kind: "text" | "tool" | "tool_result" | "session" | "done" | "error";
  text?: string;
  name?: string;
  input?: unknown;
  sessionId?: string;
}

const engineFor = (sub: SubId): CliRun["engine"] => (sub === "chatgpt" ? "codex" : sub);

export function cliArgs(run: CliRun): string[] {
  if (run.engine === "claude") {
    const mcp = JSON.stringify({ mcpServers: { mausdroid: { type: "http", url: run.mcpUrl, headers: { authorization: `Bearer ${run.mcpToken}` } } } });
    const args = ["-p", run.prompt, "--output-format", "stream-json", "--verbose", "--mcp-config", mcp,
      "--permission-prompt-tool", "mcp__mausdroid__approval_prompt", "--append-system-prompt", run.systemPrompt];
    if (run.model && run.model !== "default") args.push("--model", run.model);
    if (run.resume) args.push("--resume", run.resume);
    return args;
  }
  if (run.engine === "codex") {
    const base = ["exec", "--json", "--skip-git-repo-check", "-c", `mcp_servers.mausdroid.url="${run.mcpUrl}"`,
      "-c", `mcp_servers.mausdroid.bearer_token="${run.mcpToken}"`];
    if (run.model && run.model !== "default") base.push("-m", run.model);
    return run.resume ? ["exec", "resume", run.resume, ...base.slice(1), run.prompt] : [...base, `${run.systemPrompt}\n\n${run.prompt}`];
  }
  // Gemini CLI: MCP server comes from its settings file; context is included in the prompt.
  const args = ["-p", `${run.systemPrompt}\n\n${run.prompt}`, "--output-format", "stream-json", "--yolo"];
  if (run.model && run.model !== "default") args.push("-m", run.model);
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
    if (ev.type === "assistant")
      for (const b of ev.message?.content ?? []) {
        if (b.type === "text") out.push({ kind: "text", text: b.text });
        if (b.type === "tool_use") out.push({ kind: "tool", name: b.name, input: b.input });
      }
    if (ev.type === "user")
      for (const b of ev.message?.content ?? [])
        if (b.type === "tool_result") out.push({ kind: "tool_result", text: typeof b.content === "string" ? b.content : JSON.stringify(b.content).slice(0, 2000) });
    if (ev.type === "result") {
      if (ev.session_id) out.push({ kind: "session", sessionId: ev.session_id });
      out.push(ev.is_error ? { kind: "error", text: ev.result ?? "Claude reported an error" } : { kind: "done" });
    }
  } else if (engine === "codex") {
    if (ev.type === "thread.started") out.push({ kind: "session", sessionId: ev.thread_id });
    if (ev.type === "item.completed") {
      const it = ev.item ?? {};
      if (it.type === "agent_message") out.push({ kind: "text", text: it.text });
      else if (it.type === "command_execution") out.push({ kind: "tool", name: "shell", input: { command: it.command } }, { kind: "tool_result", text: String(it.aggregated_output ?? "").slice(0, 2000) });
      else if (it.type === "mcp_tool_call") out.push({ kind: "tool", name: it.tool, input: it.arguments });
    }
    if (ev.type === "turn.completed") out.push({ kind: "done" });
    if (ev.type === "turn.failed" || ev.type === "error") out.push({ kind: "error", text: ev.error?.message ?? ev.message ?? "ChatGPT (Codex) error" });
  } else {
    const flush = () => {
      if (acc.text.trim()) out.push({ kind: "text", text: acc.text.trim() });
      acc.text = "";
    };
    if (ev.type === "init" && ev.session_id) out.push({ kind: "session", sessionId: ev.session_id });
    if (ev.type === "message" && ev.role === "assistant") acc.text += ev.content ?? "";
    if (ev.type === "tool_use") {
      flush();
      out.push({ kind: "tool", name: String(ev.tool_name ?? ev.name ?? "tool").replace(/^mcp_mausdroid_/, ""), input: ev.parameters ?? ev.args });
    }
    if (ev.type === "tool_result") out.push({ kind: "tool_result", text: String(ev.output ?? ev.result ?? "").slice(0, 2000) });
    if (ev.type === "error") out.push({ kind: "error", text: ev.message ?? "Gemini error" });
    if (ev.type === "result") {
      flush();
      out.push(ev.status === "error" ? { kind: "error", text: ev.error?.message ?? "Gemini reported an error" } : { kind: "done" });
    }
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
  if (sub === "gemini") writeGeminiSettings({ url: run.mcpUrl, token: run.mcpToken });
  const [cmd, args] = programCommand(sub, cliArgs(run));
  const child = spawn(cmd, args, { cwd: workDir(), env: programEnv(sub), stdio: ["ignore", "pipe", "pipe"] });
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

export async function* runCli(p: ProviderConfig, run: Omit<CliRun, "engine">, signal: AbortSignal): AsyncGenerator<CliEvent> {
  const sub = p.subId!;
  const full: CliRun = { ...run, engine: engineFor(sub) };
  const acc = { text: "" };
  const canComputer = Boolean(p.computerUrl);
  const phoneReady = p.runOn !== "computer" && isSignedIn(sub);
  if (!phoneReady && !canComputer) {
    throw new Error(`Sign in to ${SUBS[sub].label} first: Settings → AI → ${SUBS[sub].label} → Sign in.`);
  }
  let source: AsyncGenerator<string>;
  if (phoneReady) {
    try {
      source = runOnPhone(sub, full, signal);
      const first = await source.next();
      if (!first.done) for (const e of parseCliLine(full.engine, first.value, acc)) yield e;
    } catch (e) {
      if (!canComputer) throw e;
      yield { kind: "tool", name: "switching to your computer", input: { reason: String((e as Error).message).slice(0, 200) } };
      source = runOnComputer(p, full, signal);
    }
  } else source = runOnComputer(p, full, signal);
  for await (const line of source) for (const e of parseCliLine(full.engine, line, acc)) yield e;
  if (acc.text.trim()) yield { kind: "text", text: acc.text.trim() };
}
