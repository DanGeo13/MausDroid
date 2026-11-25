// Sign-in and chat through subscription programs, using stand-in programs
// that behave like Claude Code and Codex (real logins need a phone + account).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("Claude and ChatGPT: sign in by login, then chat", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-subs-"));
  const bin = path.join(dir, "subs", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(dir, "subs", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "subs", "lib", "ld-musl-aarch64.so.1"), "");
  fs.writeFileSync(path.join(dir, "subs", "lib", "libstdc++.so.6"), "");
  // Stand-in Codex: `login` prints the OpenAI sign-in link and saves auth; `exec` answers.
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh
if [ "$1" = "login" ]; then echo "Starting local login server on http://localhost:1455."; echo "If your browser did not open, navigate to this URL to authenticate:"; echo "https://auth.openai.com/oauth/authorize?client_id=x&redirect_uri=http%3A%2F%2Flocalhost%3A1455"; sleep 1; mkdir -p "$HOME/.codex"; echo '{}' > "$HOME/.codex/auth.json"; echo "Successfully logged in"; exit 0; fi
echo '{"type":"thread.started","thread_id":"t1"}'
for a in "$@"; do case "$a" in attachments/*) [ -f "$a" ] && echo '{"type":"item.completed","item":{"type":"agent_message","text":"I can open the picture"}}';; esac; done
echo '{"type":"item.completed","item":{"type":"agent_message","text":"Hello from ChatGPT subscription"}}'
echo '{"type":"turn.completed"}'
`, { mode: 0o755 });
  // Stand-in Claude Code: setup-token shows the Claude page, takes the code, prints a sign-in token.
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh
if [ "$1" = "setup-token" ]; then echo "Browser didn't open? Use the url below to sign in:"; echo "https://claude.ai/oauth/authorize?code=true&client_id=z&response_type=code"; echo "Paste code here if prompted >"; read code; [ "$code" = "CLAUDECODE" ] || exit 4; echo "Your OAuth token (valid for 1 year):"; echo "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef"; exit 0; fi
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || { echo '{"type":"result","is_error":true,"result":"not signed in"}'; exit 0; }
echo '{"type":"system","subtype":"init","session_id":"c1"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Hello from Claude subscription"}]}}'
echo '{"type":"result","is_error":false,"session_id":"c1"}'
`, { mode: 0o755 });

  const port = 20000 + Math.floor(Math.random() * 1000);
  const eng = spawn(process.env.ENGINE_NODE ?? process.execPath, [...(process.env.ENGINE_NODE_ARGS ? process.env.ENGINE_NODE_ARGS.split(" ") : []), "dist/engine.cjs"], {
    env: { ...process.env, MAUSDROID_DATA_DIR: dir, MAUSDROID_PORT: String(port), MAUSDROID_TOKEN: "t", MAUSDROID_UI_DIR: "dist/ui" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  eng.stdout.on("data", (d) => (log += d));
  eng.stderr.on("data", (d) => (log += d));
  const call = async (p, method = "GET", body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: "Bearer t", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  const until = async (fn, what) => {
    for (let i = 0; i < 100; i++) {
      const v = await fn();
      if (v) return v;
      await wait(100);
    }
    throw new Error(`timed out: ${what}`);
  };
  try {
    await until(() => fetch(`http://127.0.0.1:${port}/api/whoami`).then(() => true, () => false), "engine up");
    const settings = await call("/api/settings");
    const ids = settings.providers.map((p) => p.id);
    for (const gone of ["anthropic", "openai", "claude-code", "codex"]) assert.ok(!ids.includes(gone), `${gone} API-key preset removed`);
    assert.deepEqual(ids.slice(0, 2), ["claude", "chatgpt"]);
    assert.ok(!ids.includes("gemini"), "Gemini removed");
    assert.ok(settings.providers.slice(0, 2).every((p) => p.kind === "subscription" && !p.needsKey), "subscriptions need no key");

    // ChatGPT: sign-in shows the official OpenAI page, then completes.
    await call("/api/subs/chatgpt/signin", "POST", {});
    const s1 = await until(async () => (await call("/api/subs")).find((s) => s.id === "chatgpt" && s.loginUrl), "chatgpt login url");
    assert.match(s1.loginUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize/);
    await until(async () => (await call("/api/subs")).find((s) => s.id === "chatgpt").stage === "signed-in", "chatgpt signed in");
    const st = await call("/api/settings");
    assert.equal(st.providers.find((p) => p.id === "chatgpt").enabled, true);
    assert.equal(st.defaultProvider, "chatgpt", "first sign-in becomes the default");

    // Claude: Claude page + pasted code → token kept (never shown in settings).
    await call("/api/subs/claude/signin", "POST", {});
    const s3 = await until(async () => (await call("/api/subs")).find((s) => s.id === "claude" && s.loginUrl), "claude login url");
    assert.match(s3.loginUrl, /^https:\/\/claude\.ai\/oauth\/authorize/);
    await call("/api/subs/claude/code", "POST", { code: "CLAUDECODE" });
    await until(async () => (await call("/api/subs")).find((s) => s.id === "claude").stage === "signed-in", "claude signed in");
    assert.ok(!JSON.stringify(await call("/api/settings")).includes("sk-ant-oat01"), "token never sent to the screen");

    // Chat with each subscription.
    const bots = (await call("/api/state")).bots;
    await call(`/api/bots/${bots[0].id}/messages`, "POST", { text: "hi" });
    await until(async () => (await call(`/api/bots/${bots[0].id}/messages`)).some((m) => m.text === "Hello from ChatGPT subscription"), "chatgpt reply");
    await call(`/api/bots/${bots[2].id}`, "PATCH", { providerId: "claude" });
    await call(`/api/bots/${bots[2].id}/messages`, "POST", { text: "hi" });
    await until(async () => (await call(`/api/bots/${bots[2].id}/messages`)).some((m) => m.text === "Hello from Claude subscription"), "claude reply");

    // Files reach the official program: copied into its folder, pictures passed as images.
    const pic = await call("/api/files/json", "POST", { name: "photo.png", mime: "image/png", b64: Buffer.from("png").toString("base64") });
    await call(`/api/bots/${bots[0].id}/messages`, "POST", { text: "look", attachments: [pic.id] });
    await until(async () => (await call(`/api/bots/${bots[0].id}/messages`)).some((m) => m.text === "I can open the picture"), "codex got the picture");

    // Signing out removes the login.
    await call("/api/subs/chatgpt/signout", "POST", {});
    assert.equal((await call("/api/subs")).find((s) => s.id === "chatgpt").stage, "installed");
  } catch (e) {
    console.error(log.slice(-3000));
    throw e;
  } finally {
    eng.kill();
  }
});
