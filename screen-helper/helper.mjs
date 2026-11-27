#!/usr/bin/env node
// Screen Helper's Mac helper: runs Codex (signed in with your ChatGPT account) for the Chrome extension.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.SCREEN_HELPER_PORT ?? 8791);
const HOME = path.join(os.homedir(), ".screen-helper");
const WORK = path.join(HOME, "work");
fs.mkdirSync(WORK, { recursive: true });

const tokenFile = path.join(HOME, "token");
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(12).toString("hex"), { mode: 0o600 });
const TOKEN = fs.readFileSync(tokenFile, "utf8").trim();

const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EFFORT = /^[a-z]{2,12}$/;

let modelCache = null;
function listModels() {
  if (modelCache) return Promise.resolve(modelCache);
  return new Promise((resolve) => {
    const child = spawn("codex", ["debug", "models"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve([]));
    child.on("close", () => {
      try {
        modelCache = JSON.parse(out).models
          .filter((m) => m.visibility === "list" && m.input_modalities?.includes("image"))
          .map((m) => ({
            id: m.slug,
            name: m.display_name,
            efforts: (m.supported_reasoning_levels ?? []).map((r) => r.effort),
            defaultEffort: m.default_reasoning_level,
          }));
      } catch {
        modelCache = [];
      }
      resolve(modelCache);
    });
  });
}

const sameToken = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const SESSION_ID = /^[0-9a-zA-Z-]{8,64}$/;

function codexArgs({ prompt, imagePath, threadId, model, effort }) {
  const common = [
    "--json",
    "--skip-git-repo-check",
    "-c", 'sandbox_mode="read-only"',
    "-c", 'approval_policy="never"',
    ...(model ? ["-m", model] : []),
    ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
  ];
  const image = imagePath ? ["-i", imagePath] : [];
  if (threadId) return ["exec", "resume", ...common, threadId, prompt];
  return ["exec", ...common, prompt, ...image];
}

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (d) => {
      size += d.length;
      if (size > limit) { reject(new Error("too large")); req.destroy(); }
      else chunks.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

http
  .createServer(async (req, res) => {
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!sameToken(auth, TOKEN)) return res.writeHead(401).end("bad pairing code");
    if (req.method === "GET" && req.url === "/health") return res.writeHead(200).end("ok");
    if (req.method === "GET" && req.url === "/models") {
      return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await listModels()));
    }
    if (req.method !== "POST" || req.url !== "/ask") return res.writeHead(404).end();

    let ask;
    try {
      ask = JSON.parse(await readBody(req));
    } catch {
      return res.writeHead(400).end("bad request");
    }
    if (typeof ask.prompt !== "string" || !ask.prompt) return res.writeHead(400).end("missing prompt");
    if (ask.threadId && !SESSION_ID.test(ask.threadId)) return res.writeHead(400).end("bad thread id");
    if (ask.model && !SLUG.test(ask.model)) return res.writeHead(400).end("bad model name");
    if (ask.effort && !EFFORT.test(ask.effort)) return res.writeHead(400).end("bad effort");

    let imagePath;
    if (ask.imageBase64) {
      imagePath = path.join(WORK, `screen-${Date.now()}.png`);
      fs.writeFileSync(imagePath, Buffer.from(ask.imageBase64, "base64"));
    }

    const child = spawn("codex", codexArgs({ prompt: ask.prompt, imagePath, threadId: ask.threadId, model: ask.model, effort: ask.effort }), {
      cwd: WORK,
      stdio: ["ignore", "pipe", "pipe"],
    });
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    child.stdout.pipe(res, { end: false });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.on("error", (e) => {
      const message = e.code === "ENOENT" ? "Codex isn't installed. Run: npm install -g @openai/codex" : e.message;
      res.end(JSON.stringify({ type: "error", message }) + "\n");
    });
    child.on("close", (code) => {
      if (imagePath) fs.rm(imagePath, { force: true }, () => {});
      if (res.writableEnded) return;
      if (code) res.write(JSON.stringify({ type: "error", message: stderr.trim() || `Codex stopped (exit ${code})` }) + "\n");
      res.end();
    });
    res.on("close", () => {
      if (!res.writableEnded) child.kill();
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`Screen Helper is running. Keep this window open.`);
    console.log(`Pairing code: ${TOKEN}`);
  });
