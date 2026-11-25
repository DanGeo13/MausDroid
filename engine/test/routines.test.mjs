// Routine engine end to end: options, runs and their honest status, alerts,
// duplicates, pause/resume, retries, missed runs, restart recovery, tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fakeModel, startEngine, useModel, wait } from "./_engine.mjs";

test("create all four kinds, preview, validation, update keeps id, pause/resume", async () => {
  const m = await fakeModel(() => ({ text: "done" }));
  const e = await startEngine();
  try {
    await useModel(e, m.url);
    const bot = (await e.call("/api/state")).data.bots[0];
    const mk = (title, schedule) => e.call("/api/routines", "POST", { botId: bot.id, title, prompt: "do it", schedule });
    const daily = await mk("Daily", { kind: "daily", time: "07:30", timeZone: "Australia/Sydney" });
    assert.equal(daily.status, 200);
    assert.match(daily.data.scheduleText, /Once a day at 7:30 am \(Australia\/Sydney\)/);
    assert.ok(daily.data.nextRunAt);
    assert.equal((await mk("Weekly", { kind: "weekly", days: [0], time: "07:52" })).status, 200);
    const alert = await mk("On alert", { kind: "alert", alert: { source: "Compass" } });
    assert.equal(alert.data.nextRunAt, null, "alert routines wait for events");
    assert.equal((await mk("Custom", { kind: "custom", custom: { mode: "interval", minutes: 30 } })).status, 200);
    const bad = await mk("Bad", { kind: "custom", custom: { mode: "interval", minutes: 5 } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /at least 15 minutes/);
    const geo = await mk("Geo", { kind: "geofence", geofence: { lat: -33.8, lng: 151.2, radiusM: 200, on: "enter" } });
    assert.equal(geo.status, 400, "geofence prepared but not active");

    const prev = await e.call("/api/routines/preview", "POST", { schedule: { kind: "weekly", days: [1, 3], time: "16:00" } });
    assert.equal(prev.data.upcoming.length, 3);
    assert.match(prev.data.text, /Monday, Wednesday at 4:00 pm/);

    const up = await e.call(`/api/routines/${daily.data.id}`, "PATCH", { title: "Daily brief", schedule: { kind: "daily", time: "06:45" } });
    assert.equal(up.data.id, daily.data.id, "same id after update");
    assert.match(up.data.scheduleText, /6:45 am/);
    const paused = await e.call(`/api/routines/${daily.data.id}/pause`, "POST", {});
    assert.equal(paused.data.enabled, false);
    assert.equal(paused.data.nextRunAt, null);
    const resumed = await e.call(`/api/routines/${daily.data.id}/resume`, "POST", {});
    assert.ok(resumed.data.nextRunAt);
  } finally {
    await e.stop();
    m.close();
  }
});

test("run now: queued → running → succeeded with the real result; failures retry", async () => {
  let fail = false;
  const m = await fakeModel(() => (fail ? { status: 500, error: "model down" } : { text: "Briefing sent", delay: 400 }));
  const e = await startEngine();
  try {
    await useModel(e, m.url);
    const bot = (await e.call("/api/state")).data.bots[0];
    const r = (await e.call("/api/routines", "POST", { botId: bot.id, title: "R", prompt: "go", schedule: { kind: "daily", time: "03:00" } })).data;
    const run = (await e.call(`/api/routines/${r.id}/run`, "POST", {})).data;
    assert.ok(["queued", "running"].includes(run.status), "not reported as done when it was only queued");
    await e.until(async () => (await e.call(`/api/routines/${r.id}/runs`)).data[0].status === "running", "running");
    const done = await e.until(async () => (await e.call(`/api/routines/${r.id}/runs`)).data.find((x) => x.status === "succeeded"), "succeeded");
    assert.equal(done.result, "Briefing sent");
    const det = (await e.call("/api/routines")).data.find((x) => x.id === r.id);
    assert.equal(det.lastResult.status, "succeeded");

    fail = true;
    await e.call(`/api/routines/${r.id}/run`, "POST", {});
    const failed = await e.until(async () => (await e.call(`/api/routines/${r.id}/runs`)).data.find((x) => x.status === "failed"), "failed");
    assert.match(failed.error, /model down|HTTP 500/);
    assert.ok(failed.retryAt, "a retry is scheduled");
  } finally {
    await e.stop();
    m.close();
  }
});

test("Upon Alert: matching alerts start it once; others and duplicates don't", async () => {
  const m = await fakeModel(() => ({ text: "Summarised" }));
  const e = await startEngine();
  try {
    await useModel(e, m.url);
    const bot = (await e.call("/api/state")).data.bots[0];
    const r = (await e.call("/api/routines", "POST", { botId: bot.id, title: "Compass watch", prompt: "Summarise it", schedule: { kind: "alert", alert: { source: "compass", minPriority: "normal" } } })).data;
    await e.call("/api/alerts/incoming", "POST", { title: "Weather", body: "rain", source: "BOM", notify: false });
    await e.call("/api/alerts/incoming", "POST", { title: "Low thing", body: "x", source: "Compass", priority: "low", notify: false });
    await e.call("/api/alerts/incoming", "POST", { id: "evt-1", title: "Excursion notice", body: "Year 9", source: "Compass", notify: false });
    await e.call("/api/alerts/incoming", "POST", { id: "evt-1", title: "Excursion notice", body: "Year 9", source: "Compass", notify: false });
    await e.until(async () => (await e.call(`/api/routines/${r.id}/runs`)).data.some((x) => x.status === "succeeded"), "alert run");
    await wait(500);
    const runs = (await e.call(`/api/routines/${r.id}/runs`)).data;
    assert.equal(runs.length, 1, "exactly one run");
    assert.equal(runs[0].trigger, "alert");
    assert.match(JSON.stringify(m.seen.at(-1).messages), /Excursion notice/);
  } finally {
    await e.stop();
    m.close();
  }
});

test("restart: interrupted runs fail honestly; missed runs catch up once (or skip); no duplicates", async () => {
  const m = await fakeModel(() => ({ text: "slow", delay: 5000 }));
  let e = await startEngine();
  const dir = e.dir;
  const port = e.port;
  try {
    await useModel(e, m.url);
    const bot = (await e.call("/api/state")).data.bots[0];
    const r = (await e.call("/api/routines", "POST", { botId: bot.id, title: "Long", prompt: "go", schedule: { kind: "daily", time: "03:00" } })).data;
    const r2 = (await e.call("/api/routines", "POST", { botId: bot.id, title: "Skipper", prompt: "go", schedule: { kind: "daily", time: "03:00", missedPolicy: "skip" } })).data;
    await e.call(`/api/routines/${r.id}/run`, "POST", {});
    await e.until(async () => (await e.call(`/api/routines/${r.id}/runs`)).data[0]?.status === "running", "running");
    await wait(400);
    await e.kill(); // app killed mid-run

    // While "off", both routines' next runs pass (1 hour ago).
    const file = path.join(dir, "routines.json");
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    const past = new Date(Date.now() - 3600_000).toISOString();
    for (const x of list) Object.assign(x, { nextRunAt: past, nextKey: `test@${past}` });
    fs.writeFileSync(file, JSON.stringify(list));

    e = await startEngine({ dir, port });
    const runs = await e.until(async () => {
      const rs = (await e.call(`/api/routines/${r.id}/runs`)).data;
      return rs.some((x) => x.trigger === "catch-up") ? rs : null;
    }, "catch-up run");
    const interrupted = runs.find((x) => x.trigger === "manual");
    assert.equal(interrupted.status, "failed");
    assert.match(interrupted.error, /restarted/);
    const skipped = (await e.call(`/api/routines/${r2.id}/runs`)).data;
    assert.equal(skipped[0].status, "missed");
    const det = (await e.call("/api/routines")).data.find((x) => x.id === r.id);
    assert.ok(new Date(det.nextRunAt) > new Date(), "moved on to the next occurrence");
    // Restarting again doesn't run the same occurrence twice.
    await e.stop();
    e = await startEngine({ dir, port });
    await wait(1500);
    const again = (await e.call(`/api/routines/${r.id}/runs`)).data.filter((x) => x.key === `test@${past}`);
    assert.equal(again.length, 1, "occurrence ran once");
  } finally {
    await e.stop();
    m.close();
  }
});

test("bots manage only their own routines; updates and deletes need approval", async () => {
  let step = 0;
  let otherId = "";
  let ownId = "";
  const m = await fakeModel((body) => {
    step++;
    const last = JSON.stringify(body.messages.at(-1));
    if (step === 1) return { tool: "routine_create", args: { title: "Mine", prompt: "x", kind: "weekly", days: [1], time: "09:00" } };
    if (step === 2) {
      ownId = last.match(/id (rt_[a-f0-9]+)/)?.[1] ?? "";
      return { tool: "routine_update", args: { id: otherId, title: "Hijack" } };
    }
    if (step === 3) return { tool: "routine_update", args: { id: ownId, title: "Mine v2" } };
    if (step === 4) return { tool: "routine_list", args: {} };
    return { text: "finished" };
  });
  const e = await startEngine();
  try {
    await useModel(e, m.url);
    const [b1, b2] = (await e.call("/api/state")).data.bots;
    await e.call(`/api/bots/${b1.id}`, "PATCH", { approvalMode: "auto" });
    otherId = (await e.call("/api/routines", "POST", { botId: b2.id, title: "Theirs", prompt: "y", schedule: { kind: "daily", time: "05:00" } })).data.id;
    await e.call(`/api/bots/${b1.id}/messages`, "POST", { text: "set it up" });
    // Even in "never ask" mode, changing a routine asks (Allow once / Always allow this type).
    const card = await e.until(async () => (await e.call("/api/cards")).data[0], "approval card");
    assert.equal(card.tool, "routines:change");
    assert.match(card.toolLabel, /routines/);
    await e.call(`/api/cards/${card.id}`, "POST", { allow: true }); // once (the hijack attempt is then refused by ownership)
    const card2 = await e.until(async () => (await e.call("/api/cards")).data[0], "second card");
    await e.call(`/api/cards/${card2.id}`, "POST", { allow: true, always: true });
    await e.until(async () => (await e.call(`/api/bots/${b1.id}/messages`)).data.some((x) => x.text === "finished"), "done");
    const msgs = (await e.call(`/api/bots/${b1.id}/messages`)).data;
    assert.ok(msgs.some((x) => x.tool?.name === "routine_update" && /belongs to you/.test(x.tool.result ?? "")), "can't change another bot's routine");
    const all = (await e.call("/api/routines")).data;
    assert.equal(all.find((x) => x.id === otherId).title, "Theirs");
    assert.equal(all.find((x) => x.id === ownId).title, "Mine v2");
    const b1now = (await e.call("/api/state")).data.bots.find((b) => b.id === b1.id);
    assert.ok(b1now.alwaysAllow.includes("routines:change"), "always-allow saved for that type only");
    assert.match(JSON.stringify(m.seen.at(-1).messages), /"title": "Mine v2"|Mine v2/);
  } finally {
    await e.stop();
    m.close();
  }
});
