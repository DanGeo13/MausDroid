// Only what needs you interrupts you: approvals, questions, missed calls,
// reply-needed messages and urgent things buzz the phone and count on the
// bell; updates are listed quietly; other apps' notifications are records.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startEngine } from "./_engine.mjs";

test("notifications: tiers, bell counts only what needs you, phone gets only those, no repeats", async () => {
  const pushed = [];
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      if (req.url === "/notify") pushed.push(body);
      if (req.url === "/secret/encrypt") return res.end(JSON.stringify({ cipher: Buffer.from(body.plain).toString("base64") }));
      if (req.url === "/secret/decrypt") return res.end(JSON.stringify({ plain: Buffer.from(body.cipher, "base64").toString() }));
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: `http://127.0.0.1:${server.address().port}`, MAUSDROID_BRIDGE_TOKEN: "x" } });
  try {
    const before = (await e.call("/api/state")).data.unreadAlerts;
    // Lots of other apps' notifications: recorded, never counted.
    const items = Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, pkg: "com.meta.muse", app: "Muse", title: `Nudge ${i}`, text: "Something", postedAt: Date.now() + i }));
    await e.call("/api/notifications/incoming", "POST", { items });
    await e.call("/api/alerts/incoming", "POST", { title: "Morning Brief ready", body: "Tap to open", type: "briefing" });
    await e.call("/api/alerts/incoming", "POST", { title: "Server is down", body: "Needs a restart", priority: "high" });
    await e.call("/api/alerts/incoming", "POST", { title: "Server is down", body: "Needs a restart", priority: "high" });
    const s = (await e.call("/api/state")).data;
    assert.equal(s.unreadAlerts - before, 1, "only the urgent one counts, once");
    const list = (await e.call("/api/alerts")).data;
    assert.equal(list.filter((a) => a.title === "Server is down").length, 1, "the same unread alert isn't repeated");
    assert.equal(list.find((a) => a.title === "Server is down").tier, "act");
    assert.equal(list.find((a) => a.title === "Morning Brief ready").tier, "info");
    assert.ok(list.filter((a) => a.type === "phone-notification").every((a) => a.tier === "log"));
    assert.deepEqual(pushed.map((p) => p.title), ["Server is down"], "only what needs you reaches the phone");
    // Updates can be turned on (silently).
    await e.call("/api/settings/general", "PUT", { notifyUpdates: true });
    await e.call("/api/alerts/incoming", "POST", { title: "Audio overview ready", body: "Tap to listen", type: "audio-overview" });
    assert.equal(pushed.at(-1).title, "Audio overview ready");
    assert.equal(pushed.at(-1).silent, true);
    // Mark read / clear.
    assert.equal((await e.call("/api/alerts/read", "POST", {})).data.unread, 0);
    const cleared = (await e.call("/api/alerts/clear", "POST", { tier: "log" })).data.cleared;
    assert.ok(cleared >= 30);
    assert.ok((await e.call("/api/alerts")).data.every((a) => a.tier !== "log"));
  } finally {
    await e.stop();
    server.close();
  }
});
