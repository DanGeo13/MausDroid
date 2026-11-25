// Calendars across accounts: discovery, read-only vs writable, explicit
// destination, write test, duplicate prevention, failed and verified writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine } from "./_engine.mjs";
import { fakeComposio } from "./_composio.mjs";

function calendarWorld() {
  const events = {}; // `${account}|${calendar}` -> [event]
  let n = 0;
  return {
    accounts: [
      { id: "ca_personal", alias: "personal", toolkit: "googlecalendar" },
      { id: "ca_work", alias: "work", toolkit: "googlecalendar" },
      { id: "ca_drive", alias: "personal", toolkit: "googledrive" },
    ],
    tools: {
      GOOGLECALENDAR_LIST_CALENDARS: [],
      GOOGLECALENDAR_EVENTS_LIST: ["calendarId", "timeMin", "timeMax", "q", "singleEvents"],
      GOOGLECALENDAR_CREATE_EVENT: ["calendar_id", "summary", "start_datetime", "event_duration_hour", "event_duration_minutes", "timezone", "description", "location"],
      GOOGLECALENDAR_DELETE_EVENT: ["calendar_id", "event_id"],
    },
    events,
    failWrites: false,
    handlers: {
      GOOGLECALENDAR_LIST_CALENDARS(_a, acct) {
        if (acct === "ca_work") throw new Error("403 Forbidden: insufficient permissions");
        return { items: [
          { id: "me@gmail.com", summary: "Personal", accessRole: "owner", primary: true },
          { id: "cmw@group.calendar.google.com", summary: "CMW", accessRole: "writer" },
          { id: "holidays@group.v.calendar.google.com", summary: "Holidays in Australia", accessRole: "reader" },
        ] };
      },
      GOOGLECALENDAR_EVENTS_LIST(a, acct) {
        const list = events[`${acct}|${a.calendarId}`] ?? [];
        return { items: list.filter((e) => new Date(e.start.dateTime) >= new Date(a.timeMin) && new Date(e.start.dateTime) <= new Date(a.timeMax)) };
      },
      GOOGLECALENDAR_CREATE_EVENT(a, acct) {
        if (this.failWrites) throw new Error("500 backend error");
        const key = `${acct}|${a.calendar_id}`;
        const ev = { id: `ev${++n}`, summary: a.summary, start: { dateTime: new Date(a.start_datetime).toISOString() }, htmlLink: `https://calendar.google.com/event?eid=${n}` };
        (events[key] ??= []).push(ev);
        return { id: ev.id };
      },
      GOOGLECALENDAR_DELETE_EVENT(a, acct) {
        const key = `${acct}|${a.calendar_id}`;
        events[key] = (events[key] ?? []).filter((e) => e.id !== a.event_id);
        return {};
      },
    },
  };
}

test("calendars across accounts, destination, write test, duplicates, verified writes", async () => {
  const world = calendarWorld();
  world.handlers.GOOGLECALENDAR_CREATE_EVENT = world.handlers.GOOGLECALENDAR_CREATE_EVENT.bind(world);
  const c = await fakeComposio(world);
  const e = await startEngine({ env: { MAUSDROID_COMPOSIO_API: c.url } });
  try {
    assert.equal((await e.call("/api/composio/key", "POST", { key: "ak_test" })).status, 200);
    const d = (await e.call("/api/calendars")).data;
    assert.equal(d.calendars.length, 3, "all calendars of the personal account");
    const cmw = d.calendars.find((x) => x.name === "CMW");
    assert.equal(cmw.accountAlias, "personal");
    assert.equal(cmw.writable, true, "shared CMW calendar with edit rights is writable");
    assert.equal(d.calendars.find((x) => x.name.startsWith("Holidays")).writable, false);
    assert.equal(d.problems.length, 1);
    assert.match(d.problems[0].error, /no permission/);
    assert.equal(d.destination, null, "never assumes the default calendar");

    // Without a chosen destination, creating is refused with a clear reason.
    const none = await e.call("/api/calendars/events", "POST", { summary: "X", start: "2026-12-01T09:00" });
    assert.match(none.data.error, /No destination calendar chosen/);

    // Read-only can't be the destination.
    const ro = d.calendars.find((x) => !x.writable);
    assert.equal((await e.call("/api/calendars/destination", "PUT", { accountId: ro.accountId, calendarId: ro.calendarId })).status, 400);
    assert.equal((await e.call("/api/calendars/destination", "PUT", { accountId: cmw.accountId, calendarId: cmw.calendarId })).status, 200);

    const t = (await e.call("/api/calendars/test-write", "POST", {})).data;
    assert.equal(t.ok, true, t.detail);
    assert.equal((world.events[`ca_personal|${cmw.calendarId}`] ?? []).length, 0, "test event removed");
    const exec = c.calls.filter((x) => x.path.includes("/tools/execute/GOOGLECALENDAR_CREATE_EVENT"));
    assert.equal(exec.at(-1).body.version, "20251101_00", "uses the tool's current version");
    assert.equal(exec.at(-1).body.connected_account_id, "ca_personal", "uses the chosen account");
    assert.equal(exec.at(-1).body.arguments.calendar_id, cmw.calendarId, "right calendar, right input name");

    const ev = { summary: "Year 9 excursion", start: "2026-12-03T09:00", durationMinutes: 90 };
    const r1 = (await e.call("/api/calendars/events", "POST", ev)).data;
    assert.equal(r1.status, "created");
    assert.equal(r1.verified, true);
    assert.match(r1.calendar, /CMW \(personal\)/);
    const r2 = (await e.call("/api/calendars/events", "POST", ev)).data;
    assert.equal(r2.status, "duplicate", "same title and time isn't added twice");
    assert.equal(world.events[`ca_personal|${cmw.calendarId}`].length, 1);

    // Writing to a read-only calendar by name is refused before calling Google.
    const roTry = await e.call("/api/calendars/events", "POST", { ...ev, summary: "Other", calendar: "Holidays in Australia" });
    assert.match(roTry.data.error, /read-only/);

    world.failWrites = true;
    const r3 = (await e.call("/api/calendars/events", "POST", { summary: "Parent night", start: "2026-12-04T18:00" })).data;
    assert.equal(r3.status, "failed");
    assert.equal(r3.verified, false);
  } finally {
    await e.stop();
    c.close();
  }
});
