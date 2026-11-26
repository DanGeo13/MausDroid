// Setting up cloud builds from the phone: the official Claude program makes a
// cloud key (stand-in here), MausDroid encrypts it with the repository's key
// and saves it as a GitHub secret; the checklist shows what's there.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { startEngine } from "./_engine.mjs";

const require = createRequire(import.meta.url);
const nacl = require("tweetnacl");
const { blake2b } = require("blakejs");

function openSealed(b64, kp) {
  const all = new Uint8Array(Buffer.from(b64, "base64"));
  const epk = all.slice(0, 32);
  const both = new Uint8Array(64);
  both.set(epk, 0);
  both.set(kp.publicKey, 32);
  const out = nacl.box.open(all.slice(32), blake2b(both, undefined, 24), epk, kp.secretKey);
  return out && Buffer.from(out).toString("utf8");
}

test("Connect with Claude saves an encrypted cloud key to GitHub; checklist", async () => {
  const repoKey = nacl.box.keyPair();
  const st = { secrets: {}, allowSecrets: true };
  const gh = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const send = (s, o) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(o ?? {})));
      if (req.headers.authorization !== "Bearer ghp_test") return send(401, {});
      if (!st.allowSecrets) return send(403, { message: "Resource not accessible by personal access token" });
      const u = new URL(req.url, "http://x").pathname;
      if (u === "/repos/me/app/actions/secrets/public-key") return send(200, { key_id: "k1", key: Buffer.from(repoKey.publicKey).toString("base64") });
      if (u === "/repos/me/app/actions/secrets" && req.method === "GET") return send(200, { secrets: Object.keys(st.secrets).map((name) => ({ name })) });
      const m = u.match(/^\/repos\/me\/app\/actions\/secrets\/([A-Z_]+)$/);
      if (m && req.method === "PUT") {
        const j = JSON.parse(b);
        st.secrets[m[1]] = j;
        return send(201, {});
      }
      send(404, {});
    });
  });
  await new Promise((r) => gh.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-cloud-"));
  const bin = path.join(dir, "subs", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(dir, "subs", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "subs", "lib", "ld-musl-aarch64.so.1"), "");
  fs.writeFileSync(path.join(dir, "subs", "lib", "libstdc++.so.6"), "");
  // Stand-in Claude program: `setup-token` shows Claude's page, reads the code, prints a long-lived key.
  fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/bin/sh
if [ "$1" = "setup-token" ]; then echo "Opening browser to sign in…"; echo "Browser didn't open? Use the url below to sign in:"; echo "https://claude.ai/oauth/authorize?code=true&client_id=z&response_type=code&scope=user:inference"; printf "Paste code here if prompted > "; read code; if [ "$code" != "GOODCODE" ]; then echo "Error: Invalid code" >&2; exit 1; fi; echo ""; echo "✓ Long-lived authentication token created successfully!"; echo "Your OAuth token (valid for 1 year):"; echo "sk-ant-oat01-cloudkey_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; echo "Store this token securely."; exit 0; fi
exit 0
`,
    { mode: 0o755 },
  );
  const e = await startEngine({ dir, env: { MAUSDROID_GITHUB_API: `http://127.0.0.1:${gh.address().port}`, MAUSDROID_CODE_REPO: "me/app" } });
  try {
    // No GitHub token yet: a clear message.
    let d = (await e.call("/api/improve/cloud")).data;
    assert.equal(d.checklist.githubToken, false);
    assert.equal((await e.call("/api/improve/cloud/connect", "POST")).status, 400);
    await e.call("/api/settings/github", "PUT", { token: "ghp_test" });
    d = (await e.call("/api/improve/cloud")).data;
    assert.deepEqual(d.checklist.secrets, { CLAUDE_CODE_OAUTH_TOKEN: false, CODEX_AUTH_JSON: false, OPENAI_API_KEY: false, MAUSDROID_UPDATE_KEY_PEM: false });

    // A wrong code: the program's reason is shown.
    await e.call("/api/improve/cloud/connect", "POST");
    await e.until(async () => (await e.call("/api/improve/cloud")).data.connect.needsCode, "asks for the code");
    assert.match((await e.call("/api/improve/cloud")).data.connect.loginUrl, /^https:\/\/claude\.ai\/oauth\/authorize/);
    await e.call("/api/improve/cloud/code", "POST", { code: "WRONG" });
    const bad = await e.until(async () => ((await e.call("/api/improve/cloud")).data.connect.stage === "error" ? (await e.call("/api/improve/cloud")).data.connect : null), "error shown");
    assert.match(bad.message, /Invalid code/);
    assert.equal(st.secrets.CLAUDE_CODE_OAUTH_TOKEN, undefined);

    // The right code: the key goes to GitHub, encrypted for the repository only.
    await e.call("/api/improve/cloud/connect", "POST");
    await e.until(async () => (await e.call("/api/improve/cloud")).data.connect.needsCode, "asks again");
    await e.call("/api/improve/cloud/code", "POST", { code: "GOODCODE" });
    const done = await e.until(async () => ((await e.call("/api/improve/cloud")).data.connect.stage === "done" ? (await e.call("/api/improve/cloud")).data : null), "connected");
    assert.match(done.connect.message, /Connected/);
    const saved = st.secrets.CLAUDE_CODE_OAUTH_TOKEN;
    assert.equal(saved.key_id, "k1");
    assert.ok(!saved.encrypted_value.includes("sk-ant"), "never sent in the clear");
    assert.equal(openSealed(saved.encrypted_value, repoKey), "sk-ant-oat01-cloudkey_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
    assert.equal(done.checklist.secrets.CLAUDE_CODE_OAUTH_TOKEN, true);
    assert.ok(!JSON.stringify(done).includes("sk-ant"), "the key is never shown on the screen");

    // The update signing key added from its file: checked, encrypted, saved.
    assert.equal((await e.call("/api/improve/cloud/secret", "POST", { name: "MAUSDROID_UPDATE_KEY_PEM", value: "not a key" })).status, 400);
    assert.equal((await e.call("/api/improve/cloud/secret", "POST", { name: "SOMETHING_ELSE", value: "x" })).status, 400);
    const pem = "-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgTEST\n-----END PRIVATE KEY-----";
    const added = (await e.call("/api/improve/cloud/secret", "POST", { name: "MAUSDROID_UPDATE_KEY_PEM", value: pem })).data;
    assert.equal(added.checklist.secrets.MAUSDROID_UPDATE_KEY_PEM, true);
    assert.equal(openSealed(st.secrets.MAUSDROID_UPDATE_KEY_PEM.encrypted_value, repoKey), `${pem}\n`);

    // A token without the Secrets permission: says exactly what to change.
    st.allowSecrets = false;
    d = (await e.call("/api/improve/cloud")).data;
    assert.match(d.checklist.problem, /Secrets: Read and write/);
  } finally {
    await e.stop();
    gh.close();
  }
});

test("Claude keys are read whole, even when wrapped, without the next words", async () => {
  const { load } = await import("./_load.mjs");
  const s = await load("src/subscriptions.ts");
  assert.equal(s.findClaudeKey("Your OAuth token:\nsk-ant-oat01-abcdefghijklmnopqrstuvwxyz\nStore this token securely."), "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz");
  assert.equal(s.findClaudeKey("token:\nsk-ant-oat01-abcdefghijklmnopqrstuv\nwxyz0123456789_-AB\n\nStore it."), "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789_-AB");
  assert.equal(s.findClaudeKey("Your token is sk-ant-oat01-abcdefghijklmnopqrstuvwxyz (keep it)\nNEXTLINE"), "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz");
  assert.equal(s.findClaudeKey("no key here"), null);
});

test("terminal screens are read as text: link whole, key never glued to the next word", async () => {
  const { load } = await import("./_load.mjs");
  const u = await load("src/util.ts");
  const s = await load("src/subscriptions.ts");
  const screen =
    "\x1b[2GBrowser\x1b[10Gdidn't\x1b[17Gopen?\r\r\n\x1b]8;id=x;https://claude.ai/oauth/authorize?Abc123_-XyZ456def789GHI\x07\x1b[38;5;246mhttps://claude.ai/oauth/authorize?Abc123_-XyZ456def789GHI\x1b[39m\x1b]8;;\x07\r\r\n\x1b[2GPaste\x1b[8Gcode\x1b[13Ghere\r\r\n";
  const t = u.terminalText(screen);
  assert.match(t, /https:\/\/claude\.ai\/oauth\/authorize\?Abc123_-XyZ456def789GHI(\s|$)/);
  assert.match(t, /Paste code here/);
  const done = "\x1b[2GYour\x1b[7GOAuth\x1b[13Gtoken:\x1b[20Gsk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\x1b[66GStore\x1b[72Gthis\r\r\n";
  assert.equal(s.findClaudeKey(u.terminalText(done)), "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
});

test("Connect with ChatGPT: a separate Codex login saved to GitHub; API key option", async () => {
  const repoKey = nacl.box.keyPair();
  const st = { secrets: {} };
  const gh = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const send = (s, o) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(o ?? {})));
      const u = new URL(req.url, "http://x").pathname;
      if (u === "/repos/me/app/actions/secrets/public-key") return send(200, { key_id: "k1", key: Buffer.from(repoKey.publicKey).toString("base64") });
      if (u === "/repos/me/app/actions/secrets" && req.method === "GET") return send(200, { secrets: Object.keys(st.secrets).map((name) => ({ name })) });
      const m = u.match(/^\/repos\/me\/app\/actions\/secrets\/([A-Z_]+)$/);
      if (m && req.method === "PUT") return (st.secrets[m[1]] = JSON.parse(b)), send(201, {});
      send(404, {});
    });
  });
  await new Promise((r) => gh.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-codex-"));
  const bin = path.join(dir, "subs", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(dir, "subs", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "subs", "lib", "ld-musl-aarch64.so.1"), "");
  fs.writeFileSync(path.join(dir, "subs", "lib", "libstdc++.so.6"), "");
  // Stand-in Codex: `login` prints the OpenAI page, then (after sign-in) saves auth.json in CODEX_HOME.
  fs.writeFileSync(path.join(bin, "codex"), `#!/bin/sh
if [ "$1" = "login" ]; then echo "Starting local login server on http://localhost:1455."; echo "If your browser did not open, navigate to this URL to authenticate:"; echo ""; echo "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback"; sleep 1; mkdir -p "$CODEX_HOME"; printf '{"tokens":{"id_token":"cloud-login"}}' > "$CODEX_HOME/auth.json"; echo "Successfully logged in"; exit 0; fi
exit 0
`, { mode: 0o755 });
  const e = await startEngine({ dir, env: { MAUSDROID_GITHUB_API: `http://127.0.0.1:${gh.address().port}`, MAUSDROID_CODE_REPO: "me/app" } });
  try {
    await e.call("/api/settings/github", "PUT", { token: "ghp_test" });
    await e.call("/api/improve/cloud/codex/connect", "POST");
    const d = await e.until(async () => ((await e.call("/api/improve/cloud")).data.codex.stage === "done" ? (await e.call("/api/improve/cloud")).data : null), "codex connected");
    assert.match(d.codex.message, /Connected/);
    assert.equal(openSealed(st.secrets.CODEX_AUTH_JSON.encrypted_value, repoKey), '{"tokens":{"id_token":"cloud-login"}}');
    assert.equal(d.checklist.secrets.CODEX_AUTH_JSON, true);
    // A separate login: the phone's own ChatGPT folder wasn't touched.
    const own = fs.readdirSync(path.join(dir, "subs"), { recursive: true }).filter((f) => String(f).endsWith("auth.json"));
    assert.deepEqual(own.map(String), [path.join("codex-cloud", "auth.json")]);

    // API key instead: checked first.
    assert.equal((await e.call("/api/improve/cloud/secret", "POST", { name: "OPENAI_API_KEY", value: "hello" })).status, 400);
    assert.equal((await e.call("/api/improve/cloud/secret", "POST", { name: "OPENAI_API_KEY", value: "sk-proj-abcdefghijklmnopqrstuvwxyz123456" })).status, 200);
    assert.equal(openSealed(st.secrets.OPENAI_API_KEY.encrypted_value, repoKey), "sk-proj-abcdefghijklmnopqrstuvwxyz123456\n");
  } finally {
    await e.stop();
    gh.close();
  }
});
