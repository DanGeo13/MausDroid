// Notifications read from apps you choose (Meta's Muse): stored once, codes
// never kept, "Upon Alert" routines start, bots can read them, and Improver
// reviews the first ones automatically and sees them in its nightly check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeModel, startEngine, useModel } from "./_engine.mjs";

test("Muse notifications: stored, routines, bots, Improver review", async () => {
  const m = await fakeModel((body) => {
    const all = JSON.stringify(body.messages);
    const last = body.messages.at(-1);
    if (/Review these notifications from Meta's Muse/.test(all) && last.role !== "tool") return { tool: "phone_notifications", args: { app: "Muse" } };
    if (/Review these notifications from Meta's Muse/.test(all)) return { text: "Muse anticipates follow-ups and plans; suggested two routines." };
    return { text: "ok" };
  });
  const e = await startEngine({ env: { MAUSDROID_FIRST_REVIEW_MS: "500" } });
  try {
    await useModel(e, m.url);
    const st = (await e.call("/api/state")).data;
    const imp = st.bots.find((b) => b.name === "Improver");
    await e.call(`/api/bots/${imp.id}`, "PATCH", { providerId: "local", model: "fake" });
    const maus = st.bots.find((b) => b.name === "Maus");
    const rt = (await e.call("/api/routines", "POST", { botId: maus.id, title: "Muse follow-up", prompt: "Act on Muse nudges.", schedule: { kind: "alert", alert: { type: "phone-notification", source: "Muse" } } })).data;

    const t0 = Date.now() - 3600_000;
    const items = [
      { key: "k1", pkg: "com.meta.muse", app: "Muse", title: "Dinner with Sam tonight", text: "Want me to book a table for 7pm?", postedAt: t0, pending: true },
      { key: "k2", pkg: "com.meta.muse", app: "Muse", title: "Leave by 8:10", text: "Traffic is heavier than usual on your way to school.", postedAt: t0 + 60_000, pending: true },
      { key: "k3", pkg: "com.meta.muse", app: "Muse", title: "Your code", text: "Card 4111 1111 1111 1111 expires soon", postedAt: t0 + 120_000, pending: true },
    ];
    const r = (await e.call("/api/notifications/incoming", "POST", { items })).data;
    assert.equal(r.added, 2, "the card number one is never kept");
    // The same ones again (re-read): no duplicates.
    assert.equal((await e.call("/api/notifications/incoming", "POST", { items })).data.added, 0);

    const d = (await e.call("/api/notifications/phone")).data;
    assert.deepEqual(d.counts, { Muse: 2 });
    assert.equal(d.recent[0].title, "Leave by 8:10");
    assert.equal(d.recent[1].pending, true);

    // "Upon Alert" routines for phone notifications start (once per notification).
    await e.until(async () => (await e.call(`/api/routines/${rt.id}/runs`)).data.length >= 2, "routine ran for each");
    assert.equal((await e.call(`/api/routines/${rt.id}/runs`)).data.length, 2);

    // Improver reviews the first ones automatically, reading them with its tool.
    await e.until(async () => (await e.call(`/api/bots/${imp.id}/messages`)).data.some((x) => x.role === "assistant" && /Muse anticipates/.test(x.text)), "first review", 15000);
    const msgs = (await e.call(`/api/bots/${imp.id}/messages`)).data;
    const ask = msgs.find((x) => x.role === "user" && /Review these notifications from Meta's Muse/.test(x.text));
    assert.match(ask.text, /\(2; 2 were still pending\)/);
    assert.match(ask.text, /Dinner with Sam tonight/);
    assert.match(ask.text, /never acts in Meta's apps/);
    const tool = msgs.find((x) => x.tool?.name === "phone_notifications");
    assert.match(tool.tool.result, /Leave by 8:10/);
    assert.ok(!/4111/.test(JSON.stringify(msgs)));

    // A new one later doesn't start another automatic review; the button does.
    await e.call("/api/notifications/incoming", "POST", { items: [{ key: "k4", pkg: "com.meta.muse", app: "Muse", title: "Gym at 6?", text: "You usually go on Thursdays.", postedAt: Date.now() }] });
    const reviews = () => e.call(`/api/bots/${imp.id}/messages`).then((x) => x.data.filter((y) => y.role === "user" && /Review these notifications/.test(y.text)).length);
    await new Promise((res) => setTimeout(res, 900));
    assert.equal(await reviews(), 1);
    assert.equal((await e.call("/api/notifications/review", "POST")).data.reviewed, 3);
    await e.until(async () => (await reviews()) === 2, "second review on request");

    // Improver's nightly evidence includes them as examples of anticipating needs.
    const ev = await e.until(async () => {
      const night = (await e.call("/api/routines")).data.find((x) => x.system === "self-improve");
      return night;
    }, "night routine");
    assert.ok(ev);
  } finally {
    await e.stop();
    m.close();
  }
});

test("Improver evidence includes Muse examples", async () => {
  const { load } = await import("./_load.mjs");
  process.env.MAUSDROID_DATA_DIR = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "md-pn-"));
  const p = await load("src/phone-notifications.ts");
  p.addIncoming([{ key: "a", pkg: "com.meta.muse", app: "Muse", title: "Pack sports gear", text: "Sport is on Wednesday.", postedAt: Date.now() }, { key: "b", pkg: "com.other", app: "Other", title: "x", text: "y", postedAt: Date.now() }]);
  const ex = p.assistantExamples(7);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].title, "Pack sports gear");
});
