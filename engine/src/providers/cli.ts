import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { config } from "../config.ts";
import { dataPath } from "../store.ts";
import { getSecret } from "../secrets.ts";
import type { ProviderConfig } from "../settings.ts";

/**
 * Subscription engines: the real Claude Code and Codex programs, signed in
 * with your own Claude or ChatGPT account. They run their own agent loop.
 * MausDroid gives them its tools (browser, Composio apps, alerts…) over MCP
 * and routes their permission prompts to approval cards on your phone.
 *
 * Where they run:
 *  - "computer": on a paired PC/Mac through the MausDroid companion (reliable).
 *  - "phone": on this phone (experimental; binaries downloaded on first use).
 */
export interface CliRun {
  engine: "claude" | "codex";
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

export function cliArgs(run: CliRun): { cmd: string; args: string[] } {
  if (run.engine === "claude") {
    const mcp = JSON.stringify({ mcpServers: { mausdroid: { type: "http", url: run.mcpUrl, headers: { authorization: `Bearer ${run.mcpToken}` } } } });
    const args = ["-p", run.prompt, "--output-format", "stream-json", "--verbose", "--mcp-config", mcp,
      "--permission-prompt-tool", "mcp__mausdroid__approval_prompt", "--append-system-prompt", run.systemPrompt];
    if (run.model && run.model !== "default") args.push("--model", run.model);
    if (run.resume) args.push("--resume", run.resume);
    return { cmd: "claude", args };
  }
  const base = ["exec", "--json", "--skip-git-repo-check", "-c", `mcp_servers.mausdroid.url="${run.mcpUrl}"`,
    "-c", `mcp_servers.mausdroid.bearer_token="${run.mcpToken}"`];
  if (run.model && run.model !== "default") base.push("-m", run.model);
  const args = run.resume ? [...base.slice(0, 1), "resume", run.resume, ...base.slice(1), run.prompt] : [...base, `${run.systemPrompt}\n\n${run.prompt}`];
  return { cmd: "codex", args };
}

/** Turns one line of Claude Code / Codex JSON output into MausDroid events. */
export function parseCliLine(engine: CliRun["engine"], line: string): CliEvent[] {
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
        if (b.type === "tool_result")
          out.push({ kind: "tool_result", text: typeof b.content === "string" ? b.content : JSON.stringify(b.content).slice(0, 2000) });
    if (ev.type === "result") {
      if (ev.session_id) out.push({ kind: "session", sessionId: ev.session_id });
      out.push(ev.is_error ? { kind: "error", text: ev.result ?? "Claude Code reported an error" } : { kind: "done" });
    }
  } else {
    if (ev.type === "thread.started") out.push({ kind: "session", sessionId: ev.thread_id });
    if (ev.type === "item.completed") {
      const it = ev.item ?? {};
      if (it.type === "agent_message") out.push({ kind: "text", text: it.text });
      else if (it.type === "command_execution") out.push({ kind: "tool", name: "shell", input: { command: it.command } }, { kind: "tool_result", text: String(it.aggregated_output ?? "").slice(0, 2000) });
      else if (it.type === "mcp_tool_call") out.push({ kind: "tool", name: it.tool, input: it.arguments });
    }
    if (ev.type === "turn.completed") out.push({ kind: "done" });
    if (ev.type === "turn.failed" || ev.type === "error") out.push({ kind: "error", text: ev.error?.message ?? ev.message ?? "Codex error" });
  }
  return out;
}

/** Runs the engine on a paired computer through its companion (streams NDJSON lines). */
async function* runOnComputer(p: ProviderConfig, run: CliRun, signal: AbortSignal): AsyncGenerator<string> {
  if (!p.computerUrl) throw new Error("Pair a computer first (Settings → Computers), or switch this engine to run on the phone.");
  const res = await fetch(`${p.computerUrl.replace(/\/$/, "")}/run`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${getSecret(`computer:${p.id}`) ?? ""}` },
    body: JSON.stringify(run),
  });
  if (!res.ok || !res.body) throw new Error(`Computer companion: HTTP ${res.status} ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf.trim()) yield buf;
}

/** Folder holding downloaded on-phone engine binaries. */
export const phoneBinDir = () => path.dirname(dataPath("bin", "x"));

async function* runOnPhone(run: CliRun, signal: AbortSignal): AsyncGenerator<string> {
  const { cmd, args } = cliArgs(run);
  const bin = path.join(phoneBinDir(), cmd);
  if (!fs.existsSync(bin)) throw new Error(`${cmd} is not installed on this phone yet. Open Settings → AI → ${cmd === "claude" ? "Claude Code" : "Codex"} → Install on phone.`);
  const home = dataPath("cli-home", ".keep");
  const child = spawn(bin, args, {
    cwd: path.dirname(home),
    env: {
      ...process.env,
      HOME: path.dirname(home),
      TMPDIR: path.dirname(dataPath("tmp", "x")),
      // The phone has no /etc/resolv.conf for these Linux programs, so all
      // their internet traffic goes through MausDroid's local proxy instead.
      HTTPS_PROXY: `http://127.0.0.1:${config.port + 3}`,
      HTTP_PROXY: `http://127.0.0.1:${config.port + 3}`,
      NO_PROXY: "127.0.0.1,localhost",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
  const rl = readline.createInterface({ input: child.stdout });
  for await (const line of rl) yield line;
  const code: number = await new Promise((r) => (child.exitCode !== null ? r(child.exitCode) : child.on("close", r)));
  if (code !== 0 && !signal.aborted) throw new Error(`${cmd} exited with code ${code}: ${stderr.slice(-800)}`);
}

export async function* runCli(p: ProviderConfig, run: CliRun, signal: AbortSignal): AsyncGenerator<CliEvent> {
  const lines = p.runOn === "phone" ? runOnPhone(run, signal) : runOnComputer(p, run, signal);
  for await (const line of lines) for (const e of parseCliLine(run.engine, line)) yield e;
}
