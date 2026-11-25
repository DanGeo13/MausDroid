// Models per bot: Claude short names and numbered ids, ChatGPT, local/API
// endpoints you add; Check; each bot really runs its own model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeModel, startEngine } from "./_engine.mjs";

test("each bot runs its own model; catalogue, check, custom endpoints", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-models-"));
  const bin = path.join(dir, "subs", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(dir, "subs", "lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "subs", "lib", "ld-musl-aarch64.so.1"), "");
  fs.mkdirSync(path.join(dir, "subs", "home", "claude", ".claude"), { recursive: true });
  fs.writeFileSync(path.join(dir, "subs", "home", "claude", ".claude", ".credentials.json"), "{}");
  // Stand-in Claude Code: answers with the model it was started with; refuses unknown models.
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh
model=default
while [ $# -gt 0 ]; do [ "$1" = "--model" ] && model="$2"; shift; done
case "$model" in nonsense*) echo '{"type":"result","is_error":true,"result":"model_not_found: nonsense-9"}'; exit 0;; esac
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"OK from '"$model"'"}]}}'
echo '{"type":"result","is_error":false,"session_id":"s"}'
`, { mode: 0o755 });
  const local = await fakeModel((body) => ({ text: `local answered with ${body.model}` }));
  // The local server's model list.
  const e = await startEngine({ dir });
  try {
    const cat = (await e.call("/api/models/claude")).data;
    const ids = cat.groups.flatMap((g) => g.models.map((m) => m.id));
    for (const m of ["haiku", "sonnet", "opus", "fable", "claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-4-1-20250805"]) assert.ok(ids.includes(m), m);

    await e.call("/api/settings/providers/claude", "PUT", { enabled: true });
    const [b1, b2, b3] = (await e.call("/api/state")).data.bots;
    await e.call(`/api/bots/${b1.id}`, "PATCH", { providerId: "claude", model: "haiku" });
    await e.call(`/api/bots/${b2.id}`, "PATCH", { providerId: "claude", model: "claude-opus-5-5" });

    // Your own endpoint (e.g. Ollama on the PC) for the third bot.
    const add = await e.call("/api/endpoints", "POST", { label: "PC Ollama", baseUrl: local.url.replace(/\/v1$/, ""), needsKey: false });
    assert.equal(add.status, 200);
    const epId = add.data.id;
    await e.call(`/api/settings/providers/${epId}`, "PUT", { enabled: true, defaultModel: "llama3.2" });
    await e.call(`/api/bots/${b3.id}`, "PATCH", { providerId: epId, model: "qwen2.5:7b" });
    assert.equal((await e.call("/api/endpoints", "POST", { label: "x", baseUrl: "ftp://nope" })).status, 400);

    for (const b of [b1, b2, b3]) await e.call(`/api/bots/${b.id}/messages`, "POST", { text: "hi" });
    await e.until(async () => (await e.call(`/api/bots/${b1.id}/messages`)).data.some((m) => m.text === "OK from haiku"), "bot 1 on haiku");
    await e.until(async () => (await e.call(`/api/bots/${b2.id}/messages`)).data.some((m) => m.text === "OK from claude-opus-5-5"), "bot 2 on Opus 5.5");
    await e.until(async () => (await e.call(`/api/bots/${b3.id}/messages`)).data.some((m) => m.text === "local answered with qwen2.5:7b"), "bot 3 on the local endpoint");

    const good = (await e.call("/api/models/check", "POST", { provider: "claude", model: "claude-fable-5-2" })).data;
    assert.equal(good.ok, true, good.detail);
    const bad = (await e.call("/api/models/check", "POST", { provider: "claude", model: "nonsense-9" })).data;
    assert.equal(bad.ok, false);
    assert.match(bad.detail, /isn't available for your plan/);
    const mine = (await e.call(`/api/models/${epId}`)).data.groups.find((g) => g.label === "Your models");
    assert.ok(mine.models.some((m) => m.id === "qwen2.5:7b"), "typed model remembered");

    assert.equal((await e.call("/api/endpoints/claude", "DELETE")).status, 400, "built-in AIs can't be removed");
    assert.equal((await e.call(`/api/endpoints/${epId}`, "DELETE")).status, 200);
    assert.ok(!(await e.call("/api/settings")).data.providers.some((p) => p.id === epId));
  } finally {
    await e.stop();
    local.close();
  }
});
