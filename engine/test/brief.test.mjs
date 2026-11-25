// Morning Brief rules: Staff Update choice, sport worksheet choice, Thursday rows, school days.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

const B = await load("src/brief-logic.ts");
const now = new Date("2026-11-23T20:00:00Z");
const days = (n) => new Date(now.getTime() - n * 86400_000).toISOString();
const doc = "application/vnd.google-apps.document";

test("Staff Update: picks this week's, warns on missing or several", () => {
  const files = [
    { id: "1", name: "Staff Update T4W7", mimeType: doc, modifiedTime: days(1) },
    { id: "2", name: "Staff Update T4W6", mimeType: doc, modifiedTime: days(8) },
    { id: "3", name: "Copy of Staff Update T4W7", mimeType: doc, modifiedTime: days(1) },
    { id: "4", name: "Minutes", mimeType: doc, modifiedTime: days(2), contentMatch: true },
    { id: "5", name: "Staff Update folder", mimeType: "application/vnd.google-apps.folder", modifiedTime: days(0) },
  ];
  const p = B.rankStaffUpdates(files, now, { term: 4, week: 7 });
  assert.equal(p.best.id, "1");
  assert.equal(p.warnings.length, 0);
  assert.ok(!p.alternatives.some((f) => f.id === "5"), "folders ignored");
  const none = B.rankStaffUpdates([{ id: "9", name: "Staff Update T3W2", mimeType: doc, modifiedTime: days(60) }], now, { term: 4, week: 7 });
  assert.equal(none.best, null);
  assert.match(none.warnings[0], /No current Staff Update/);
  assert.match(B.rankStaffUpdates([], now).warnings[0], /No Staff Update found/);
  const two = B.rankStaffUpdates([
    { id: "a", name: "Staff Update", mimeType: doc, modifiedTime: days(1) },
    { id: "b", name: "Weekly Staff Update", mimeType: "application/pdf", modifiedTime: days(2) },
  ], now);
  assert.match(two.warnings[0], /Several possible Staff Updates/);
});

test("Sport sheet: untidy names, duplicates, never last week's", () => {
  assert.equal(B.normaliseSheetName("  Copy of  Copy of Week  5 "), "week 5");
  const names = ["Week 5", "Week 6 ", "Copy of Week 6", "Wk7 (1)", "Instructions"];
  const p6 = B.pickSportSheet(names, 6);
  assert.equal(p6.sheet, "Week 6 ");
  assert.deepEqual(p6.duplicates, ["Copy of Week 6"]);
  assert.match(p6.warnings[0], /Duplicate week 6 tabs/);
  assert.equal(B.pickSportSheet(names, 7).sheet, "Wk7 (1)");
  const missing = B.pickSportSheet(names, 8);
  assert.equal(missing.sheet, null);
  assert.match(missing.warnings[0], /Week 8 sport sheet isn't published yet \(latest tab is week 7\)\. Not using an older week/);
  assert.equal(B.pickSportSheet(["T4W3", "T3W3"], 3, 4).sheet, "T4W3", "term-aware");
});

test("Thursday rows for the person", () => {
  const values = [["Sport matrix"], ["Staff", "Monday", "Thursday "], ["J. Smith", "x", "Netball - Court 2"], ["D. Geoghegan", "", "Soccer - Oval"], ["", "", ""]];
  const r = B.extractThursday(values, ["Geoghegan"]);
  assert.deepEqual(r.rows, [["D. Geoghegan", "Soccer - Oval"]]);
  assert.equal(r.column, "Thursday");
  assert.match(B.extractThursday(values, ["Nobody"]).warnings[0], /isn't on this week's sport sheet/);
});

test("School days from confirmed term dates; holidays and pupil-free days", () => {
  const t = {
    terms: [{ name: "Term 4", start: "2026-10-12", end: "2026-12-16", confirmed: true }],
    days: [
      { name: "Staff development day", start: "2026-11-27", end: "2026-11-27", kind: "pupil-free", confirmed: true },
      { name: "Presentation night", start: "2026-12-02", end: "2026-12-02", kind: "event", confirmed: false },
    ],
  };
  const d = (s) => new Date(`${s}T09:00:00`);
  const wk = B.dayStatus(d("2026-11-26"), t);
  assert.equal(wk.schoolDay, true);
  assert.equal(wk.week, 7);
  assert.equal(B.dayStatus(d("2026-11-27"), t).schoolDay, false);
  assert.match(B.dayStatus(d("2026-11-28"), t).reason, /Weekend/);
  assert.match(B.dayStatus(d("2026-12-21"), t).reason, /School holidays/);
  assert.deepEqual(B.dayStatus(d("2026-12-02"), t).events, ["Presentation night"]);
  const unset = B.dayStatus(d("2026-11-26"), { terms: [], days: [] });
  assert.equal(unset.unconfirmed, true, "assumptions are flagged");
});
