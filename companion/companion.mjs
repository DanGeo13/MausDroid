#!/usr/bin/env node
// MausDroid computer companion: lets bots on your phone use Claude Code,
// Codex and Gemini CLI (with your subscriptions) installed on this computer.
// Reach it over Tailscale. Start:  node companion.mjs
// It prints a pairing token; paste it in the phone under Settings → AI.
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = Number(process.env.MAUSDROID_COMPANION_PORT ?? 8790);
const HOST = process.env.MAUSDROID_COMPANION_HOST ?? "0.0.0.0";
const dir = path.join(os.homedir(), ".mausdroid-companion");
fs.mkdirSync(dir, { recursive: true });
const tokenFile = path.join(dir, "token");
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(24).toString("base64url"), { mode: 0o600 });
const TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
const WORK = process.env.MAUSDROID_WORKDIR ?? path.join(dir, "work");
fs.mkdirSync(WORK, { recursive: true });

function args(run) {
  if (run.engine === "claude") {
    const mcp = JSON.stringify({ mcpServers: { mausdroid: { type: "http", url: run.mcpUrl, headers: { authorization: `Bearer ${run.mcpToken}` } } } });
    const a = ["-p", run.prompt, "--output-format", "stream-json", "--verbose", "--mcp-config", mcp, "--permission-prompt-tool", "mcp__mausdroid__approval_prompt", "--append-system-prompt", run.systemPrompt];
    if (run.model && run.model !== "default") a.push("--model", run.model);
    if (run.resume) a.push("--resume", run.resume);
    return ["claude", a];
  }
  if (run.engine === "gemini") {
    // Project settings in the work folder give Gemini CLI the phone's tools (MCP).
    const g = path.join(WORK, ".gemini");
    fs.mkdirSync(g, { recursive: true });
    fs.writeFileSync(path.join(g, "settings.json"), JSON.stringify({ mcpServers: { mausdroid: { httpUrl: run.mcpUrl, headers: { Authorization: `Bearer ${run.mcpToken}` }, trust: true } } }));
    const a = ["-p", `${run.systemPrompt}\n\n${run.prompt}`, "--output-format", "stream-json", "--yolo"];
    if (run.model && run.model !== "default") a.push("-m", run.model);
    return ["gemini", a];
  }
  const base = ["exec", "--json", "--skip-git-repo-check", "-c", `mcp_servers.mausdroid.url="${run.mcpUrl}"`, "-c", `mcp_servers.mausdroid.bearer_token_env_var="MAUSDROID_MCP_TOKEN"`];
  if (run.model && run.model !== "default") base.push("-m", run.model);
  for (const img of run.images ?? []) base.push("-i", img);
  return ["codex", run.resume ? ["exec", "resume", run.resume, ...base.slice(1), run.prompt] : [...base, `${run.systemPrompt}\n\n${run.prompt}`]];
}

const ok = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

http
  .createServer({ maxHeaderSize: 65536 }, (req, res) => {
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!ok(auth, TOKEN)) return res.writeHead(401).end("bad token");
    if (req.method === "GET" && req.url === "/health") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, host: os.hostname() }));
    if (req.method !== "POST" || req.url !== "/run") return res.writeHead(404).end();
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let run;
      try {
        run = JSON.parse(body);
      } catch {
        return res.writeHead(400).end("bad json");
      }
      if (!["claude", "codex", "gemini"].includes(run.engine)) return res.writeHead(400).end("unknown engine");
      // Files attached on the phone arrive with the request; save them in the work folder.
      for (const f of run.files ?? []) {
        const dest = path.resolve(WORK, f.path);
        if (!dest.startsWith(path.resolve(WORK) + path.sep)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(f.b64, "base64"));
      }
      for (const img of run.images ?? []) if (!path.resolve(WORK, img).startsWith(path.resolve(WORK) + path.sep)) return res.writeHead(400).end("bad image path");
      const [cmd, a] = args(run);
      const child = spawn(cmd, a, { cwd: WORK, shell: process.platform === "win32", env: { ...process.env, MAUSDROID_MCP_TOKEN: String(run.mcpToken ?? "") }, stdio: ["ignore", "pipe", "pipe"] });
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      child.stdout.pipe(res, { end: false });
      let err = "";
      child.stderr.on("data", (d) => (err = (err + d).slice(-2000)));
      child.on("error", (e) => res.end(JSON.stringify({ type: "result", is_error: true, result: `${cmd} not found on this computer: ${e.message}` }) + "\n"));
      child.on("close", (code) => {
        if (code && !res.writableEnded) res.write(JSON.stringify(run.engine === "claude" ? { type: "result", is_error: true, result: err || `exit ${code}` } : run.engine === "gemini" ? { type: "result", status: "error", error: { message: err || `exit ${code}` } } : { type: "error", message: err || `exit ${code}` }) + "\n");
        res.end();
      });
      req.on("close", () => !child.killed && child.kill());
    });
  })
  .listen(PORT, HOST, () => {
    console.log(`MausDroid companion on port ${PORT}`);
    console.log(`Pairing token: ${TOKEN}`);
    console.log("On the phone: Settings → AI → Claude Code or Codex → Run on: My computer → address http://<this-computer's-tailscale-name>:" + PORT);
  });
