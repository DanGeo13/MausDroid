// Calls with Maus: only Maus; never during calendar events or lock-outs;
// unreadable/no calendar = no ring; answer/decline/missed; hourly limit;
// you calling Maus.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fakeModel, startEngine, useModel, wait } from "./_engine.mjs";
import { fakeComposio } from "./_composio.mjs";

async function fakeBridge() {
  const st = { rings: [] };
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      const send = (o) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      if (req.url === "/secret/encrypt") return send({ cipher: Buffer.from(body.plain).toString("base64") });
      if (req.url === "/secret/decrypt") return send({ plain: Buffer.from(body.cipher, "base64").toString() });
      if (req.url === "/call/ring") st.rings.push(body);
      send({});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, st, close: () => server.close() };
}

test("calls: only Maus, calendar + lock-out rules, answer/decline/missed, limit, you call Maus", async () => {
  const br = await fakeBridge();
  const cal = { busy: false, fail: false };
  const c = await fakeComposio({
    accounts: [{ id: "ca1", alias: "personal", toolkit: "googlecalendar" }],
    tools: { GOOGLECALENDAR_LIST_CALENDARS: [], GOOGLECALENDAR_EVENTS_LIST: ["calendarId", "timeMin", "timeMax", "singleEvents"] },
    handlers: {
      GOOGLECALENDAR_LIST_CALENDARS: () => ({ items: [{ id: "me", summary: "Personal", accessRole: "owner" }] }),
      GOOGLECALENDAR_EVENTS_LIST: (a) => {
        if (cal.fail) throw new Error("503 unavailable");
        return { items: cal.busy ? [{ summary: "Year 9 English", start: { dateTime: a.timeMin }, end: { dateTime: a.timeMax } }] : [{ summary: "Holiday", start: { date: "2026-01-01" } }] };
      },
    },
  });
  let script = [];
  const m = await fakeModel((body) => {
    const last = JSON.stringify(body.messages.at(-1));
    if (last.includes("phone call with you")) return { text: "Sure, your next class is at 11." };
    const next = script.shift();
    return next ?? { text: "ok" };
  });
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: br.url, MAUSDROID_BRIDGE_TOKEN: "x", MAUSDROID_COMPOSIO_API: c.url, MAUSDROID_CALL_RING_MS: "1500" } });
  try {
    await useModel(e, m.url);
    await e.call("/api/calls/settings", "PUT", { lockouts: [] });
    const info = (await e.call("/api/calls")).data;
    const bots = (await e.call("/api/state")).data.bots;
    const maus = bots.find((b) => b.name === "Maus");
    const other = bots.find((b) => b.name !== "Maus");
    assert.equal(info.bot.id, maus.id, "calls belong to Maus");

    // No calendar connected yet → no ring.
    let may = (await e.call("/api/calls/may")).data;
    assert.equal(may.ok, false);
    assert.match(may.reason, /calendar/i);
    await e.call("/api/composio/key", "POST", { key: "ak_test" });
    await e.call("/api/calendars");
    may = (await e.call("/api/calls/may")).data;
    assert.equal(may.ok, true, may.reason);

    // Only Maus has the call tool.
    script = [{ tool: "call_user", args: { reason: "hi" } }];
    await e.call(`/api/bots/${other.id}/messages`, "POST", { text: "call me" });
    const res = await e.until(async () => (await e.call(`/api/bots/${other.id}/messages`)).data.find((x) => x.tool?.name === "call_user" && x.tool.status !== "running")?.tool, "other bot tool");
    assert.match(res.result, /Unknown tool/);
    assert.equal(br.st.rings.length, 0);

    // Busy in the calendar → no ring, quiet note.
    cal.busy = true;
    let r = (await e.call("/api/calls/test", "POST", { reason: "Reminder" })).data;
    assert.equal(r.state, "blocked");
    assert.match(r.detail, /Year 9 English/);
    cal.busy = false;
    cal.fail = true;
    r = (await e.call("/api/calls/test", "POST", { reason: "Reminder" })).data;
    assert.equal(r.state, "blocked");
    assert.match(r.detail, /Couldn't check your calendar/);
    cal.fail = false;

    // Lock-out time (all day, every day) → no ring.
    await e.call("/api/calls/settings", "PUT", { lockouts: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59", label: "Test lock-out" }] });
    r = (await e.call("/api/calls/test", "POST", { reason: "Reminder" })).data;
    assert.match(r.detail, /lock-out/);
    await e.call("/api/calls/settings", "PUT", { lockouts: [] });
    assert.equal(br.st.rings.length, 0, "never rang while busy/locked out/unverifiable");

    // Free: Maus calls through its tool and you answer.
    script = [{ tool: "call_user", args: { reason: "Your 3pm meeting moved", opening_line: "Quick heads up about 3pm." } }];
    await e.call(`/api/bots/${maus.id}/messages`, "POST", { text: "check my day" });
    const ring = await e.until(async () => br.st.rings[0], "phone rings");
    assert.equal(ring.reason, "Your 3pm meeting moved");
    await e.call(`/api/calls/${ring.callId}/answer`, "POST", { answer: true });
    const answered = await e.until(async () => (await e.call(`/api/bots/${maus.id}/messages`)).data.find((x) => x.tool?.name === "call_user" && x.tool.status === "done")?.tool, "tool result");
    assert.match(answered.result, /answered/);
    const turn = (await e.call(`/api/calls/${ring.callId}/turn`, "POST", { text: "when is my next class" })).data;
    assert.equal(turn.reply, "Sure, your next class is at 11.");
    await e.call(`/api/calls/${ring.callId}/end`, "POST", {});

    // Decline, then missed.
    const p1 = e.call("/api/calls/test", "POST", { reason: "Second" });
    const ring2 = await e.until(async () => br.st.rings[1], "second ring");
    await e.call(`/api/calls/${ring2.callId}/answer`, "POST", { answer: false });
    assert.equal((await p1).data.state, "declined");
    const missed = (await e.call("/api/calls/test", "POST", { reason: "Third" })).data;
    assert.equal(missed.state, "missed");
    assert.ok((await e.call("/api/alerts")).data.some((a) => /Missed call/.test(a.title)));

    // Hourly limit (3): the fourth is refused.
    const limited = (await e.call("/api/calls/test", "POST", { reason: "Fourth" })).data;
    assert.equal(limited.state, "blocked");
    assert.match(limited.detail, /limit 3/);

    // You call Maus.
    const out = (await e.call("/api/calls/start", "POST", {})).data;
    assert.equal(out.direction, "outgoing");
    assert.equal((await e.call(`/api/calls/${out.id}/turn`, "POST", { text: "hello" })).data.reply, "Sure, your next class is at 11.");
  } finally {
    await e.stop();
    m.close();
    c.close();
    br.close();
  }
});
