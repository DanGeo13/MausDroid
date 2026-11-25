// Files of any type: upload (streamed and JSON), attach to a message, and
// check what the AI receives (picture as image, text inline, others noted).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

test("attach images, JSON, PDF and more", async () => {
  const seen = [];
  const model = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      seen.push(JSON.parse(b));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Got your files" }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise((r) => model.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-files-"));
  const port = 21000 + Math.floor(Math.random() * 1000);
  const eng = spawn(process.env.ENGINE_NODE ?? process.execPath, [...(process.env.ENGINE_NODE_ARGS ? process.env.ENGINE_NODE_ARGS.split(" ") : []), "dist/engine.cjs"], {
    env: { ...process.env, MAUSDROID_DATA_DIR: dir, MAUSDROID_PORT: String(port), MAUSDROID_TOKEN: "t", MAUSDROID_UI_DIR: "dist/ui" },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const H = { authorization: "Bearer t" };
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`${base}/api/whoami`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // Streamed upload (how the app sends big files).
    assert.equal((await fetch(`${base}/api/files`, { method: "POST", body: PNG, headers: { "content-type": "image/png", "x-file-name": "pic.png" } })).status, 401, "uploads need sign-in");
    const img = await (await fetch(`${base}/api/files`, { method: "POST", body: PNG, headers: { ...H, "content-type": "image/png", "x-file-name": encodeURIComponent("my pic.png") } })).json();
    assert.equal(img.kind, "image");
    assert.equal(img.size, PNG.length);
    const back = Buffer.from(await (await fetch(`${base}/api/files/${img.id}`, { headers: H })).arrayBuffer());
    assert.ok(back.equals(PNG), "file comes back unchanged");
    // JSON upload (small files).
    const j = await (await fetch(`${base}/api/files/json`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ name: "data.json", b64: Buffer.from('{"term":3,"due":"Friday"}').toString("base64") }) })).json();
    assert.equal(j.kind, "text");
    const pdf = await (await fetch(`${base}/api/files/json`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ name: "Policy.pdf", b64: Buffer.from("%PDF-1.4 fake").toString("base64") }) })).json();
    assert.equal(pdf.kind, "document");
    const vid = await (await fetch(`${base}/api/files/json`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ name: "clip.mp4", b64: Buffer.from("fake").toString("base64") }) })).json();
    assert.equal(vid.kind, "video");

    await fetch(`${base}/api/settings/providers/local`, { method: "PUT", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ enabled: true, baseUrl: `http://127.0.0.1:${model.address().port}/v1`, defaultModel: "fake" }) });
    const bot = (await (await fetch(`${base}/api/state`, { headers: H })).json()).bots[0];
    await fetch(`${base}/api/bots/${bot.id}/messages`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ text: "what are these?", attachments: [img.id, j.id, pdf.id, vid.id] }) });
    for (let i = 0; i < 50 && !seen.length; i++) await new Promise((r) => setTimeout(r, 100));
    const user = seen[0].messages.find((m) => m.role === "user");
    const parts = JSON.stringify(user.content);
    assert.match(parts, /data:image\/png;base64,/, "picture sent as an image");
    assert.match(parts, /\\"due\\": \\"Friday\\"|"due": "Friday"|due.*Friday/, "JSON sent as text");
    assert.match(parts, /Policy\.pdf.*file_read/, "PDF noted with file_read");
    assert.match(parts, /clip\.mp4 \(video/, "video noted");
    const msgs = await (await fetch(`${base}/api/bots/${bot.id}/messages`, { headers: H })).json();
    assert.equal(msgs.find((m) => m.role === "user").attachments.length, 4, "message shows its attachments");

    // Assistant: what's on screen plus a screenshot travel with the question.
    const shot = await (await fetch(`${base}/api/files/json`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ name: "screenshot.jpg", mime: "image/jpeg", b64: PNG.toString("base64") }) })).json();
    const ans = await (await fetch(`${base}/api/assistant/ask`, { method: "POST", headers: { ...H, "content-type": "application/json" }, body: JSON.stringify({ text: "summarise this page", attachments: [shot.id], screen: { app: "Chrome", url: "https://example.com/news", text: "Big headline about rain" } }) })).json();
    assert.equal(ans.reply, "Got your files");
    const asked = JSON.stringify(seen[seen.length - 1].messages.filter((m) => m.role === "user").pop().content);
    assert.match(asked, /Screen context/);
    assert.match(asked, /in Chrome, page https:\/\/example\.com\/news/);
    assert.match(asked, /Big headline about rain/);
    assert.match(asked, /data:image\/jpeg;base64/, "screenshot included as an image");
  } finally {
    eng.kill();
    model.close();
  }
});
