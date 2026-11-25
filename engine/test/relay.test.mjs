// Website relay flow against a running `wrangler dev` (skipped if none):
// phone connects → QR pairing → password → state through the relay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const RELAY = process.env.RELAY_URL ?? "http://127.0.0.1:8787";

test("website relay: QR pairing + password", async (t) => {
  try {
    await fetch(RELAY);
  } catch {
    t.skip("no relay running");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-"));
  const port = 19000 + Math.floor(Math.random() * 1000);
  const eng = spawn(process.env.ENGINE_NODE ?? process.execPath, ["dist/engine.cjs"], {
    env: { ...process.env, MAUSDROID_DATA_DIR: dir, MAUSDROID_PORT: String(port), MAUSDROID_TOKEN: "tok", MAUSDROID_UI_DIR: "dist/ui" },
    stdio: "ignore",
  });
  const local = (p, method = "GET", body) =>
    fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: body && JSON.stringify(body) }).then((r) => r.json());
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/whoami`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await local("/api/website", "PUT", { relayUrl: RELAY, enabled: true, password: "correct horse" });
    const pair = await local("/api/pair/create", "POST", {});
    assert.match(pair.link, /\/d\/[^/]+\/#pair=/);
    const base = pair.link.split("#")[0];
    const code = pair.link.split("#pair=")[1];

    // Wait for the phone's long-poll to be connected.
    let page;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(base);
      if (r.status === 200) {
        page = await r.text();
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.match(page, /MausDroid/, "UI served through relay");

    // Not paired: refused.
    assert.equal((await fetch(base + "api/state")).status, 401);

    const pr = await fetch(base + "api/pair/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Test PC" }) });
    assert.equal(pr.status, 200);
    const dev = pr.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(base + "api/state", { headers: { cookie: dev } })).status, 401, "password still needed");

    // The code works once only.
    const again = await fetch(base + "api/pair/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, name: "Thief" }) });
    assert.equal(again.status, 500);

    const bad = await fetch(base + "api/login", { method: "POST", headers: { cookie: dev, "content-type": "application/json" }, body: JSON.stringify({ password: "wrong" }) });
    assert.equal(bad.status, 401);
    const good = await fetch(base + "api/login", { method: "POST", headers: { cookie: dev, "content-type": "application/json" }, body: JSON.stringify({ password: "correct horse" }) });
    assert.equal(good.status, 200);
    const sess = good.headers.get("set-cookie").split(";")[0];
    const st = await (await fetch(base + "api/state", { headers: { cookie: `${dev}; ${sess}` } })).json();
    assert.equal(st.bots.length, 3);
  } finally {
    eng.kill();
  }
});
