// Starts a real engine (built dist) with a stand-in OpenAI-compatible model whose replies a test controls.
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fakeModel(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", async () => {
      const body = JSON.parse(b);
      seen.push(body);
      const out = await handler(body, seen.length);
      if (out?.status) {
        res.writeHead(out.status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: out.error ?? "fail" } }));
      }
      if (out?.delay) await wait(out.delay);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (out?.tool) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${seen.length}`, function: { name: out.tool, arguments: JSON.stringify(out.args ?? {}) } }] } }] })}\n\n`);
      else if (out?.chunks) {
        // Streams the reply in pieces, like a real model.
        for (const [i, c] of out.chunks.entries()) {
          if (res.destroyed || res.socket?.destroyed) return;
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c }, ...(i === out.chunks.length - 1 ? { finish_reason: "stop" } : {}) }] })}\n\n`);
          out.onChunk?.(i);
          await wait(out.chunkDelay ?? 100);
        }
      } else res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: out?.text ?? "ok" }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => server.close() };
}

export async function startEngine({ dir, port, env = {} } = {}) {
  dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "md-eng-"));
  port ??= 22000 + Math.floor(Math.random() * 3000);
  const proc = spawn(process.env.ENGINE_NODE ?? process.execPath, [...(process.env.ENGINE_NODE_ARGS ? process.env.ENGINE_NODE_ARGS.split(" ") : []), "dist/engine.cjs"], {
    env: { ...process.env, MAUSDROID_DATA_DIR: dir, MAUSDROID_PORT: String(port), MAUSDROID_TOKEN: "t", MAUSDROID_UI_DIR: "dist/ui", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    try {
      await fetch(`${base}/api/whoami`);
      break;
    } catch {
      await wait(100);
    }
  }
  const call = async (p, method = "GET", body) => {
    const r = await fetch(base + p, { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    return { status: r.status, data };
  };
  const until = async (fn, what, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await fn();
      if (v) return v;
      await wait(100);
    }
    throw new Error(`timed out waiting for: ${what}\n${log.slice(-2000)}`);
  };
  const stop = async () => {
    proc.kill("SIGTERM");
    await new Promise((r) => proc.once("exit", r));
  };
  const kill = async () => {
    proc.kill("SIGKILL");
    await new Promise((r) => proc.once("exit", r));
  };
  return { dir, port, base, call, until, stop, kill, log: () => log };
}

export async function useModel(e, url) {
  await e.call("/api/settings/providers/local", "PUT", { enabled: true, baseUrl: url, defaultModel: "fake" });
  await e.call("/api/settings/general", "PUT", { defaultProvider: "local" });
}
