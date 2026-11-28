// device_location through a stand-in Android bridge: granted, denied,
// permanently denied, stale, unavailable, accuracy, indicator; geofence
// events reach "Upon Alert" routines (Android geofencing itself is off).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fakeModel, startEngine, useModel, wait } from "./_engine.mjs";

async function fakeBridge() {
  const st = { next: null, delay: 0, calls: [] };
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", async () => {
      const body = b ? JSON.parse(b) : {};
      st.calls.push(req.url);
      const send = (o) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      if (req.url === "/secret/encrypt") return send({ cipher: Buffer.from(body.plain).toString("base64") });
      if (req.url === "/secret/decrypt") return send({ plain: Buffer.from(body.cipher, "base64").toString() });
      if (req.url === "/location/permission") return send({ permission: st.next?.permission ?? "granted" });
      if (req.url === "/location/get") {
        st.lastBody = body;
        if (st.delay) await wait(st.delay);
        return send(st.next);
      }
      send({});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, st, close: () => server.close() };
}

test("device_location: approvals, real fixes only, clear errors, visible indicator", async () => {
  const br = await fakeBridge();
  const m = await fakeModel((body) => {
    const last = JSON.stringify(body.messages.at(-1));
    if (last.includes("where am i")) return { tool: "device_location", args: { reason: "leave-now reminder" } };
    return { text: "ok" };
  });
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: br.url, MAUSDROID_BRIDGE_TOKEN: "x" } });
  try {
    await useModel(e, m.url);
    const bot = (await e.call("/api/state")).data.bots[0];
    const ask = async (next, { approve = true, delay = 0 } = {}) => {
      br.st.next = next;
      br.st.delay = delay;
      const before = (await e.call(`/api/bots/${bot.id}/messages`)).data.length;
      await e.call(`/api/bots/${bot.id}/messages`, "POST", { text: "where am i" });
      const card = await e.until(async () => (await e.call("/api/cards")).data[0], "approval");
      assert.equal(card.tool, "location");
      assert.match(card.title, /leave-now reminder/);
      await e.call(`/api/cards/${card.id}`, "POST", { allow: approve });
      if (delay) {
        const act = await e.until(async () => (await e.call("/api/location")).data.active[0], "indicator while active");
        assert.match(act.requester, /Maus/, "names who asked");
      }
      return e.until(async () => (await e.call(`/api/bots/${bot.id}/messages`)).data.slice(before).find((x) => x.tool?.name === "device_location" && x.tool.status !== "running")?.tool, "tool result");
    };
    const ok = await ask({ latitude: -33.86, longitude: 151.2, accuracy_m: 12, timestamp: new Date().toISOString(), provider: "fused", permission: "granted", stale: false }, { delay: 800 });
    const r = JSON.parse(ok.result);
    assert.equal(r.provider, "fused");
    assert.equal(r.accuracy_m, 12);
    assert.ok(r.timestamp);
    assert.equal(br.st.lastBody.maxAgeMs, 120000, "freshness threshold 2 minutes");
    assert.equal((await e.call("/api/location")).data.active.length, 0, "indicator cleared when done");

    const stale = JSON.parse((await ask({ latitude: -33.8, longitude: 151.1, accuracy_m: 40, timestamp: "2026-01-01T00:00:00Z", provider: "network", permission: "granted", stale: true, note: "No fresh fix" })).result);
    assert.equal(stale.stale, true, "an older real fix is marked stale");

    const denied = await ask({ permission: "denied", error: "permission_denied", latitude: 1, longitude: 2 });
    assert.equal(denied.isError, true);
    assert.ok(!/"latitude"/.test(denied.result), "no coordinates with an error");
    assert.match(denied.result, /said no/);
    assert.match((await ask({ permission: "permanently_denied", error: "permission_permanently_denied" })).result, /blocked for DanDroid/);
    assert.match((await ask({ permission: "granted", error: "location_off" })).result, /turned off/);

    // Saying no to the approval means no request reaches the phone.
    const calls = br.st.calls.filter((c) => c === "/location/get").length;
    const refused = await ask({ latitude: 0, longitude: 0, permission: "granted" }, { approve: false });
    assert.equal(refused.status, "denied");
    assert.equal(br.st.calls.filter((c) => c === "/location/get").length, calls);

    const uses = (await e.call("/api/location")).data.recent;
    assert.ok(uses.length >= 5);
    assert.ok(!JSON.stringify(uses).includes("151."), "no coordinates kept");
  } finally {
    await e.stop();
    m.close();
    br.close();
  }
});

test("geofence: prepared but off; geofence events can drive Upon Alert routines once", async () => {
  const m = await fakeModel(() => ({ text: "Welcome home routine done" }));
  const e = await startEngine();
  try {
    await useModel(e, m.url);
    const bot = (await e.call("/api/state")).data.bots[0];
    const geo = await e.call("/api/routines", "POST", { botId: bot.id, title: "Home", prompt: "x", schedule: { kind: "geofence", geofence: { lat: -33.8, lng: 151.2, radiusM: 200, on: "enter" } } });
    assert.equal(geo.status, 400);
    assert.match(geo.data.error, /not switched on/);
    const r = (await e.call("/api/routines", "POST", { botId: bot.id, title: "Arrived", prompt: "Say hi", schedule: { kind: "alert", alert: { type: "geofence", contains: "home" } } })).data;
    for (let i = 0; i < 2; i++) await e.call("/api/alerts/incoming", "POST", { id: "gf-1", type: "geofence", title: "Entered home", body: "enter", source: "geofence", notify: false });
    await e.until(async () => (await e.call(`/api/routines/${r.id}/runs`)).data.some((x) => x.status === "succeeded"), "geofence-triggered run");
    await wait(400);
    assert.equal((await e.call(`/api/routines/${r.id}/runs`)).data.length, 1, "duplicate event ignored");
  } finally {
    await e.stop();
    m.close();
  }
});
