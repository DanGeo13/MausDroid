// End-to-end check of the built engine with a fake OpenAI-compatible model:
// chat → tool call → approval card → result → final answer, plus auth.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sse = (res, chunks) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
};

test("chat, tools and approvals work end to end", async () => {
  let calls = 0;
  const model = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      calls++;
      const msgs = JSON.parse(body).messages;
      const last = msgs[msgs.length - 1];
      if (calls === 1)
        return sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "memory_save", arguments: '{"note":"likes tea"}' } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]);
      if (calls === 2) {
        assert.equal(last.role, "tool");
        return sse(res, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c2", function: { name: "tailnet_fetch", arguments: '{"url":"http://127.0.0.1:1/x","method":"POST"}' } }] } }] }, { choices: [{ delta: {}, finish_reason: "tool_calls" }] }]);
      }
      return sse(res, [{ choices: [{ delta: { content: "All done " } }] }, { choices: [{ delta: { content: "✅" }, finish_reason: "stop" }] }]);
    });
  });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  const modelUrl = `http://127.0.0.1:${model.address().port}/v1`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-"));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const token = "testtoken";
  const eng = spawn(process.env.ENGINE_NODE ?? process.execPath, [...(process.env.ENGINE_NODE_ARGS ? process.env.ENGINE_NODE_ARGS.split(" ") : []), "dist/engine.cjs"], {
    env: { ...process.env, MAUSDROID_DATA_DIR: dir, MAUSDROID_PORT: String(port), MAUSDROID_TOKEN: token, MAUSDROID_UI_DIR: "dist/ui", MAUSDROID_TAILNET_PROXY: "127.0.0.1:1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  eng.stdout.on("data", (d) => (log += d));
  eng.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  const h = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = async (p, method = "GET", body) => {
    const r = await fetch(base + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => ({})) };
  };
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(base + "/api/whoami");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // Unauthenticated requests are refused; the UI page itself loads.
    assert.equal((await fetch(base + "/api/state")).status, 401);
    assert.match(await (await fetch(base + "/")).text(), /MausDroid/);

    const st = await call("/api/state");
    assert.equal(st.data.bots.length, 3);
    const bot = st.data.bots[0];

    await call("/api/settings/providers/local", "PUT", { enabled: true, baseUrl: modelUrl, defaultModel: "fake" });
    await call(`/api/bots/${bot.id}/messages`, "POST", { text: "remember I like tea, then post to my PC" });

    // Wait for the approval card for the risky tailnet POST.
    let card;
    for (let i = 0; i < 100 && !card; i++) {
      card = (await call("/api/cards")).data[0];
      if (!card) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(card, "approval card appeared");
    assert.equal(card.tool, "tailnet_fetch");
    await call(`/api/cards/${card.id}`, "POST", { allow: false });

    let msgs;
    for (let i = 0; i < 100; i++) {
      msgs = (await call(`/api/bots/${bot.id}/messages`)).data;
      if (msgs.some((m) => m.role === "assistant" && m.text.includes("All done"))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(msgs.some((m) => m.text.includes("All done ✅")), "final answer streamed");
    assert.ok(msgs.some((m) => m.tool?.name === "tailnet_fetch" && m.tool.status === "denied"), "denied tool recorded");
    const mem = (await call("/api/memory/about-me")).data.text;
    assert.match(mem, /likes tea/);

    // Digital assistant: the chosen bot answers and the answer comes back to the panel.
    const research = st.data.bots[1];
    await call("/api/settings/voice", "PUT", { assistantBotId: research.id });
    const who = (await call("/api/assistant")).data;
    assert.equal(who.botId, research.id);
    const ans = (await call("/api/assistant/ask", "POST", { text: "quick question" })).data;
    assert.equal(ans.botName, research.name);
    assert.match(ans.reply, /All done/);

    // Secrets never come back to the UI.
    await call("/api/settings/providers/openrouter", "PUT", { key: "sk-secret-123" });
    const s = JSON.stringify((await call("/api/settings")).data);
    assert.ok(!s.includes("sk-secret-123"));
    assert.ok(s.includes('"hasKey":true'));
  } catch (e) {
    console.error(log);
    throw e;
  } finally {
    eng.kill();
    model.close();
  }
});
