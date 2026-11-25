// Schedule maths: the four options, legacy kinds, time zones and daylight saving.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

const S = await load("src/schedule.ts");
const SYD = "Australia/Sydney";
const iso = (o) => o?.at.toISOString();

test("once a day: local time, next day after it passed", () => {
  const s = { kind: "daily", time: "07:30", timeZone: SYD };
  // 2026-06-10 07:00 Sydney (AEST, UTC+10) = 2026-06-09T21:00Z
  assert.equal(iso(S.nextOccurrence(s, new Date("2026-06-09T21:00:00Z"))), "2026-06-09T21:30:00.000Z");
  assert.equal(iso(S.nextOccurrence(s, new Date("2026-06-09T21:30:00Z"))), "2026-06-10T21:30:00.000Z", "never twice the same day");
});

test("once a day across daylight saving (Sydney)", () => {
  const s = { kind: "daily", time: "07:30", timeZone: SYD };
  // DST starts Sun 4 Oct 2026: 07:30 is UTC+11 from then on.
  assert.equal(iso(S.nextOccurrence(s, new Date("2026-10-03T00:00:00Z"))), "2026-10-03T20:30:00.000Z");
  // DST ends Sun 5 Apr 2026: back to UTC+10.
  assert.equal(iso(S.nextOccurrence(s, new Date("2026-04-04T23:00:00Z"))), "2026-04-05T21:30:00.000Z");
});

test("a time that doesn't exist on DST-start day moves forward; repeated time runs once", () => {
  const spring = { kind: "daily", time: "02:30", timeZone: SYD };
  const o = S.nextOccurrence(spring, new Date("2026-10-03T12:00:00Z"));
  assert.equal(o.at.toISOString(), "2026-10-03T16:30:00.000Z", "03:30 local (UTC+11)");
  const autumn = { kind: "daily", time: "02:30", timeZone: SYD };
  const first = S.nextOccurrence(autumn, new Date("2026-04-04T12:00:00Z"));
  const second = S.nextOccurrence(autumn, first.at);
  assert.notEqual(first.key, second.key);
  assert.ok(second.at - first.at > 20 * 3600_000, "next run is the following day, not an hour later");
});

test("once a week: several weekdays, recurrence", () => {
  const s = { kind: "weekly", days: [0], time: "07:52", timeZone: SYD };
  // Wed 2 Dec 2026 → Sun 6 Dec 2026 07:52 AEDT (UTC+11) = 5 Dec 20:52Z
  const a = S.nextOccurrence(s, new Date("2026-12-02T00:00:00Z"));
  assert.equal(iso(a), "2026-12-05T20:52:00.000Z");
  const b = S.nextOccurrence(s, a.at);
  assert.equal(b.at - a.at, 7 * 86400_000);
  const multi = { kind: "weekly", days: [1, 3, 5], time: "16:00", timeZone: SYD };
  const days = [];
  let t = new Date("2026-12-06T00:00:00Z");
  for (let i = 0; i < 4; i++) {
    const o = S.nextOccurrence(multi, t);
    days.push(S.withTimeZone(SYD, () => o.at.getDay()));
    t = o.at;
  }
  assert.deepEqual(days, [1, 3, 5, 1]);
});

test("custom: interval ≥15 min, specific dates, recurring with window", () => {
  assert.deepEqual(S.validateSchedule({ kind: "custom", custom: { mode: "interval", minutes: 5 } }), ["Intervals must be at least 15 minutes."]);
  const iv = S.nextOccurrence({ kind: "custom", custom: { mode: "interval", minutes: 30 } }, new Date("2026-06-01T10:07:00Z"));
  assert.equal(iso(iv), "2026-06-01T10:30:00.000Z");
  const dates = { kind: "custom", timeZone: SYD, custom: { mode: "dates", dates: ["2026-12-24T09:00", "2026-12-01T08:00"] } };
  assert.equal(iso(S.nextOccurrence(dates, new Date("2026-11-25T00:00:00Z"))), "2026-11-30T21:00:00.000Z");
  assert.equal(S.nextOccurrence(dates, new Date("2026-12-25T00:00:00Z")), null, "finished");
  const rec = { kind: "custom", timeZone: SYD, custom: { mode: "recurring", everyDays: 1, times: ["08:00", "15:00"], days: [1, 2, 3, 4, 5] } };
  const r1 = S.nextOccurrence(rec, new Date("2026-12-04T22:00:00Z")); // Sat 5 Dec 09:00 Sydney
  assert.equal(S.withTimeZone(SYD, () => `${r1.at.getDay()} ${r1.at.getHours()}`), "1 8", "skips the weekend");
  const win = { kind: "interval", minutes: 60, timeZone: SYD, window: { start: "09:00", end: "17:00" } };
  const w = S.nextOccurrence(win, new Date("2026-06-01T08:30:00Z")); // 18:30 Sydney
  assert.equal(S.withTimeZone(SYD, () => w.at.getHours()), 9, "waits for the window");
});

test("legacy once/interval/daily/weekly still work", () => {
  assert.equal(iso(S.nextOccurrence({ kind: "once", at: "2030-01-01T00:00:00Z" }, new Date("2029-01-01T00:00:00Z"))), "2030-01-01T00:00:00.000Z");
  assert.ok(S.nextOccurrence({ kind: "interval", minutes: 15 }, new Date()));
  assert.ok(S.nextOccurrence({ kind: "daily", time: "09:00" }, new Date()));
});

test("alert and geofence are event-based; previews read well", () => {
  assert.equal(S.nextOccurrence({ kind: "alert", alert: { source: "Compass" } }, new Date()), null);
  assert.deepEqual(S.validateSchedule({ kind: "geofence", geofence: { lat: -33.8, lng: 151.2, radiusM: 50, on: "enter" } }), ["Radius must be between 100 m and 50 km."]);
  assert.equal(S.describeSchedule({ kind: "weekly", days: [0], time: "07:52", timeZone: SYD }), "Once a week: Sunday at 7:52 am (Australia/Sydney)");
  assert.equal(S.describeSchedule({ kind: "weekly", days: [1, 2, 3, 4, 5], time: "16:00" }), "Once a week: weekdays at 4:00 pm");
  assert.equal(S.describeSchedule({ kind: "alert", alert: { type: "app-event", source: "Compass", minPriority: "high" } }), 'Upon alert: app-event alerts from "Compass" high+ priority');
  assert.match(S.describeSchedule({ kind: "custom", custom: { mode: "recurring", everyDays: 2, times: ["08:00"] } }), /Every 2 days at 8:00 am/);
});
