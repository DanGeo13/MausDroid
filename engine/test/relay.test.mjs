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
  const eng = spawn(process.env.ENGINE_NODE ?? process.execPath, [...(process.env.ENGINE_NODE_ARGS ? process.env.ENGINE_NODE_ARGS.split(" ") : []), "dist/engine.cjs"], {
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
    assert.match(page, /DanDroid/, "UI served through relay");

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
    assert.ok(st.bots.length >= 3);
  } finally {
    eng.kill();
  }
});

test("website relay: the PC shows a QR, the phone scans it (or types the code)", async (t) => {
  try {
    await fetch(RELAY);
  } catch {
    t.skip("no relay running");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-"));
  const port = 20000 + Math.floor(Math.random() * 1000);
  const eng = spawn(process.env.ENGINE_NODE ?? process.execPath, [...(process.env.ENGINE_NODE_ARGS ? process.env.ENGINE_NODE_ARGS.split(" ") : []), "dist/engine.cjs"], {
    env: { ...process.env, MAUSDROID_DATA_DIR: dir, MAUSDROID_PORT: String(port), MAUSDROID_TOKEN: "tok", MAUSDROID_UI_DIR: "dist/ui" },
    stdio: "ignore",
  });
  const local = async (p, method = "GET", body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { authorization: "Bearer tok", "content-type": "application/json" }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  const pcPage = async () => {
    const html = await (await fetch(RELAY + "/")).text();
    assert.match(html, /Link this device to DanDroid/);
    assert.match(html, /<svg/, "shows a QR code");
    return html.match(/const code="([A-Z0-9]{8})"/)[1];
  };
  try {
    for (let i = 0; i < 50; i++) {
      try {
        await fetch(`http://127.0.0.1:${port}/api/whoami`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    // Before the website is on: a clear message.
    assert.equal((await local("/api/pair/link", "POST", { text: "ABCD-2345" })).status, 400);
    await local("/api/website", "PUT", { relayUrl: RELAY, enabled: true, password: "correct horse" });

    // 1. The PC opens the website and shows a QR code; it's waiting.
    const code = await pcPage();
    const waiting = await (await fetch(`${RELAY}/p/${code}`, { headers: { accept: "application/json" } })).json();
    assert.deepEqual(waiting, { waiting: true });

    // 2. The phone scans it.
    const linked = await local("/api/pair/link", "POST", { text: `${RELAY}/p/${code}` });
    assert.equal(linked.status, 200, JSON.stringify(linked.data));

    // 3. The PC gets its personal page with a one-time pairing code — once.
    const got = await (await fetch(`${RELAY}/p/${code}`, { headers: { accept: "application/json" } })).json();
    assert.match(got.link, new RegExp(`^${RELAY.replace(/[.]/g, "\\.")}/d/[^/]+/#pair=`));
    assert.deepEqual(await (await fetch(`${RELAY}/p/${code}`, { headers: { accept: "application/json" } })).json(), { waiting: true }, "handed over only once");
    const base = got.link.split("#")[0];
    const pcode = got.link.split("#pair=")[1];
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
      ok = (await fetch(base)).status === 200;
      if (!ok) await new Promise((r) => setTimeout(r, 500));
    }
    const pr = await fetch(base + "api/pair/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pcode, name: "Test PC" }) });
    assert.equal(pr.status, 200, "the PC is linked");
    const dev = pr.headers.get("set-cookie").split(";")[0];
    assert.equal((await fetch(base + "api/state", { headers: { cookie: dev } })).status, 401, "password still needed");

    // Typed code works too; a used code can't be reused; another website's QR is refused.
    const code2 = await pcPage();
    assert.equal((await local("/api/pair/link", "POST", { text: `${code2.slice(0, 4).toLowerCase()}-${code2.slice(4)}` })).status, 200);
    const reuse = await local("/api/pair/link", "POST", { text: code2 });
    assert.equal(reuse.status, 400);
    assert.match(reuse.data.error, /already used/);
    const other = await local("/api/pair/link", "POST", { text: "https://evil.example.com/p/ABCD2345" });
    assert.match(other.data.error, /different website/);
    assert.match((await local("/api/pair/link", "POST", { text: "hello" })).data.error, /8 letters/);
    // Someone can't post a link to a different site for a PC to open.
    const hijack = await fetch(`${RELAY}/p/${await pcPage()}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ link: "https://evil.example.com/#pair=x" }) });
    assert.equal(hijack.status, 400);
    assert.equal((await local("/api/devices")).data.length, 1);
  } finally {
    eng.kill();
  }
});
