// Morning Brief end to end with stand-in Google services: Staff Update choice,
// sport sheet (duplicate / missing week), failed calendar, holidays, publish,
// approve/dismiss proposed events.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeModel, startEngine, useModel } from "./_engine.mjs";
import { fakeComposio } from "./_composio.mjs";

function world() {
  const created = [];
  return {
    created,
    tabs: ["Instructions", "Week 6", "Week 7 ", "Copy of Week 7"],
    accounts: [
      { id: "ca_cal", alias: "personal", toolkit: "googlecalendar" },
      { id: "ca_drive", alias: "personal", toolkit: "googledrive" },
      { id: "ca_sheets", alias: "personal", toolkit: "googlesheets" },
    ],
    tools: {
      GOOGLEDRIVE_FIND_FILE: ["q", "pageSize", "orderBy"],
      GOOGLESHEETS_GET_SPREADSHEET_INFO: ["spreadsheet_id"],
      GOOGLESHEETS_BATCH_GET: ["spreadsheet_id", "ranges"],
      GOOGLECALENDAR_LIST_CALENDARS: [],
      GOOGLECALENDAR_EVENTS_LIST: ["calendarId", "timeMin", "timeMax", "singleEvents", "orderBy", "q"],
      GOOGLECALENDAR_CREATE_EVENT: ["calendar_id", "summary", "start_datetime", "event_duration_hour", "event_duration_minutes"],
    },
    handlers: {
      GOOGLEDRIVE_FIND_FILE(a) {
        if (a.q.includes("fullText")) return { files: [{ id: "minutes", name: "Meeting minutes", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-25T01:00:00Z" }] };
        return { files: [
          { id: "su7", name: "Staff Update T4W7", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-23T21:00:00Z", webViewLink: "https://docs.google.com/document/d/su7" },
          { id: "su6", name: "Staff Update T4W6", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-16T21:00:00Z" },
          { id: "copy", name: "Copy of Staff Update T4W7", mimeType: "application/vnd.google-apps.document", modifiedTime: "2026-11-24T21:00:00Z" },
        ] };
      },
      GOOGLESHEETS_GET_SPREADSHEET_INFO() {
        return { sheets: this.tabs.map((t) => ({ properties: { title: t } })) };
      },
      GOOGLESHEETS_BATCH_GET(a) {
        assert.equal(a.ranges[0], "'Week 7 '!A1:Z300", "reads the original week 7 tab, quoted");
        return { valueRanges: [{ values: [["Staff", "Mon", "Thursday"], ["D. Geoghegan", "", "Soccer - Oval"], ["A. Other", "", "Chess"]] }] };
      },
      GOOGLECALENDAR_LIST_CALENDARS() {
        return { items: [{ id: "me", summary: "Personal", accessRole: "owner", primary: true }, { id: "broken", summary: "Broken", accessRole: "reader" }] };
      },
      GOOGLECALENDAR_EVENTS_LIST(a) {
        if (a.calendarId === "broken") throw new Error("403 forbidden");
        return { items: [...created.filter((e) => a.q && e.summary === a.q), ...(a.q ? [] : [{ summary: "Staff meeting", start: { dateTime: "2026-11-26T15:30:00+11:00" }, htmlLink: "https://cal/1" }])] };
      },
      GOOGLECALENDAR_CREATE_EVENT(a) {
        const ev = { id: `e${created.length + 1}`, summary: a.summary, start: { dateTime: new Date(a.start_datetime).toISOString() } };
        created.push(ev);
        return { id: ev.id };
      },
    },
  };
}

test("Morning Brief: facts, warnings, publish, approve proposals", async () => {
  const w = world();
  for (const k of Object.keys(w.handlers)) w.handlers[k] = w.handlers[k].bind(w);
  const c = await fakeComposio(w);
  const e = await startEngine({ env: { MAUSDROID_COMPOSIO_API: c.url, TZ: "Australia/Sydney" } });
  try {
    await e.call("/api/composio/key", "POST", { key: "ak_test" });
    await e.call("/api/brief/settings", "PUT", {
      prefs: { sportSheet: "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit", identifiers: ["Geoghegan"], confirmed: ["sportSheet", "identifiers"] },
      terms: { terms: [{ name: "Term 4", start: "2026-10-12", end: "2026-12-16", confirmed: true }], days: [{ name: "Staff development day", start: "2026-11-27", end: "2026-11-27", kind: "pupil-free", confirmed: true }] },
    });
    const p = (await e.call("/api/brief/prepare", "POST", { date: "2026-11-26" })).data;
    assert.equal(p.day.schoolDay, true);
    assert.equal(p.day.week, 7);
    assert.equal(p.staffUpdate.name, "Staff Update T4W7", "this week's, not last week's or a copy");
    assert.equal(p.staffUpdate.link, "https://docs.google.com/document/d/su7", "source link kept");
    assert.equal(p.sport.sheet, "Week 7");
    assert.deepEqual(p.sport.rows, [["D. Geoghegan", "Soccer - Oval"]]);
    assert.ok(p.warnings.some((x) => /Duplicate week 7 tabs/.test(x)));
    assert.ok(p.warnings.some((x) => /Broken/.test(x)), "failed calendar reported");
    assert.ok(p.schedule.some((x) => x.title === "Staff meeting"));
    assert.ok(p.prefs.assumed.includes("holidays") && !p.prefs.assumed.includes("identifiers"), "assumed vs confirmed");

    // Holiday detection.
    const hol = (await e.call("/api/brief/prepare", "POST", { date: "2026-11-27" })).data;
    assert.equal(hol.day.schoolDay, false);
    assert.match(hol.day.reason, /pupil free/);

    // Missing week: next week's tab isn't there → warning, no rows, never week 7's.
    w.tabs = ["Week 6", "Week 7"];
    const missing = (await e.call("/api/brief/prepare", "POST", { date: "2026-12-03" })).data;
    assert.equal(missing.sport.sheet, null);
    assert.deepEqual(missing.sport.rows, []);
    assert.ok(missing.warnings.some((x) => /Week 8 sport sheet isn't published yet/.test(x)));

    // Publish (as the Morning Brief bot does) and approve/dismiss proposals.
    let step = 0;
    const m = await fakeModel(() => {
      step++;
      if (step === 1)
        return {
          tool: "morning_brief_publish",
          args: {
            date: "2026-11-26",
            summary: "Thursday, week 7. Staff meeting 3:30. Your sport: Soccer - Oval.",
            staff_update_summary: "Reports due Friday.",
            proposed_events: [
              { summary: "Reports due", start: "2026-11-28T09:00", duration_minutes: 30 },
              { summary: "Optional PD", start: "2026-12-01T15:30" },
            ],
          },
        };
      return { text: "Brief published." };
    });
    await useModel(e, m.url);
    await e.call("/api/calendars");
    await e.call("/api/calendars/destination", "PUT", { accountId: "ca_cal", calendarId: "me" });
    const bot = (await e.call("/api/state")).data.bots[0];
    await e.call(`/api/bots/${bot.id}/messages`, "POST", { text: "brief please" });
    const list = await e.until(async () => {
      const l = (await e.call("/api/briefings")).data;
      return l.length ? l : null;
    }, "briefing published");
    const br = (await e.call(`/api/briefings/${list[0].id}`)).data;
    assert.equal(br.staffUpdate.summary, "Reports due Friday.");
    assert.equal(br.sport.sheet, "Week 7");
    assert.equal(br.proposedEvents.length, 2);
    assert.ok(br.proposedEvents.every((x) => x.status === "proposed"), "nothing added without approval");
    assert.equal(w.created.length, 0);
    const alert = (await e.call("/api/alerts")).data.find((a) => a.type === "briefing");
    assert.equal(alert.link, `briefing:${br.id}`, "notification opens the full briefing");
    const ok = (await e.call(`/api/briefings/${br.id}/events/${br.proposedEvents[0].id}`, "POST", { approve: true })).data;
    assert.equal(ok.status, "added");
    assert.equal(w.created.length, 1);
    const no = (await e.call(`/api/briefings/${br.id}/events/${br.proposedEvents[1].id}`, "POST", { approve: false })).data;
    assert.equal(no.status, "dismissed");
    assert.equal(w.created.length, 1);
    m.close();
  } finally {
    await e.stop();
    c.close();
  }
});
