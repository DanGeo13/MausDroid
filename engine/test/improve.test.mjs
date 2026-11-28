// The Improver: nightly check (10-minute limit, 5-minute research cutoff),
// at most 5 suggestions, nothing changes until approved, midday reveal,
// routine/skill fixes applied exactly as shown, code fixes handed to the bot.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeModel, startEngine, useModel } from "./_engine.mjs";
import { load } from "./_load.mjs";

const SKILL = "---\nname: tidy-notes\ndescription: Tidy meeting notes into actions and dates.\n---\nTurn notes into a short list of actions with owners and dates.";

test("improver: setup, max 5, refusals, approve / not now / dismiss, code hand-off, incomplete run", async () => {
  let mode = "night";
  let step = 0;
  let routineId = "";
  const m = await fakeModel(async (body) => {
    const sys = JSON.stringify(body.messages?.[0] ?? "");
    const last = body.messages?.[body.messages.length - 1];
    if (/DanDroid's self-improvement bot/.test(sys) && mode === "apply") return { text: "Made branch improve/retry-note with the fix and a test. Nothing pushed." };
    if (!/DanDroid's self-improvement bot/.test(sys)) return { text: "hello" };
    if (mode === "lazy") return { text: "All good!" };
    if (last?.role !== "tool" && step > 0) step = 0;
    step++;
    const s = (title, area, extra = {}) => ({ title, problem: `Problem for ${title}`, change: `Change for ${title}`, area, risk: "low", ...extra });
    switch (step) {
      case 1: return { tool: "improve_evidence", args: {} };
      case 2: return { tool: "improve_propose", args: { suggestions: [
        s("Give the flaky routine more time", "routine", { routine_patch: { routine_id: routineId, timeout_minutes: 25, prompt: "Check the school site and summarise changes." } }),
        s("Add a tidy notes skill", "skill", { skill: { name: "tidy-notes", content: SKILL } }),
        s("Retry web fetch on timeouts", "code"),
        s("Store the API key in the prompt", "other", { change: "password: hunter2" }),
        s("Retry web fetch on timeouts", "code"),
        s("Shorter morning summary", "other"),
        s("Mute low alerts at night", "other"),
        s("Sixth idea that is one too many", "other"),
      ] } };
      case 3: return { tool: "improve_finish", args: { summary: "Five fixes: routine timeout, notes skill, fetch retry, two tweaks." } };
      default: return { text: "Done." };
    }
  });
  const e = await startEngine();
  try {
    await useModel(e, m.url);
    const st = (await e.call("/api/state")).data;
    const imp = st.bots.find((b) => b.name === "Improver");
    assert.ok(imp, "Improver bot created");
    assert.equal(imp.providerId, "claude");
    assert.equal(imp.model, "claude-opus-5-5");
    const routine = (await e.call("/api/routines")).data.find((r) => r.system === "self-improve");
    assert.equal(routine.botId, imp.id);
    assert.equal(routine.timeoutMinutes, 10);
    assert.equal(routine.scheduleText.startsWith("Once a day"), true, routine.scheduleText);
    assert.match(routine.scheduleText, /2:30 am/);
    // Existing bots untouched; only the Improver gets improve_* tools.
    const maus = st.bots.find((b) => b.name === "Maus");
    assert.ok(maus);
    // A routine with a problem for Improver to fix.
    routineId = (await e.call("/api/routines", "POST", { botId: maus.id, title: "School site check", prompt: "Check the site.", schedule: { kind: "daily", time: "09:00" } })).data.id;

    await e.call(`/api/bots/${imp.id}`, "PATCH", { providerId: "local", model: "fake", approvalMode: "auto" });
    await e.call(`/api/routines/${routine.id}/run`, "POST", {});
    const run = await e.until(async () => (await e.call(`/api/routines/${routine.id}/runs`)).data.find((x) => ["succeeded", "failed"].includes(x.status)), "night run", 20000);
    assert.equal(run.status, "succeeded", run.error);
    const impReq = m.seen.find((b) => /self-improvement bot/.test(JSON.stringify(b.messages?.[0] ?? "")));
    const toolNames = (impReq.tools ?? []).map((t) => t.function?.name);
    assert.ok(toolNames.includes("improve_propose"));

    await e.call(`/api/bots/${maus.id}/messages`, "POST", { text: "hi" });
    await e.until(async () => m.seen.some((b) => !/self-improvement bot/.test(JSON.stringify(b.messages?.[0] ?? ""))), "Maus turn");
    const mausReq = m.seen.find((b) => !/self-improvement bot/.test(JSON.stringify(b.messages?.[0] ?? "")));
    assert.ok(!(mausReq.tools ?? []).some((t) => t.function?.name?.startsWith("improve_")), "other bots don't get improve tools");

    const msgs = (await e.call(`/api/bots/${imp.id}/messages`)).data;
    const proposeResult = msgs.find((x) => x.tool?.name === "improve_propose").tool.result;
    assert.match(proposeResult, /Recorded 5/);
    assert.match(proposeResult, /credential/);
    assert.match(proposeResult, /repeats "Retry web fetch on timeouts"/);
    assert.match(proposeResult, /only 5 suggestions a night/);

    // Nothing has changed yet and nothing is shown before the show time.
    let o = (await e.call("/api/improve")).data;
    assert.equal(o.waiting, 5);
    assert.equal(o.shown.length, 0);
    assert.equal((await e.call("/api/routines")).data.find((r) => r.id === routineId).timeoutMinutes, 15);
    assert.ok(!(await e.call("/api/skills")).data.some((s) => s.name === "tidy-notes"));
    assert.match(o.lastNight.summary, /Five fixes/);

    await e.call("/api/improve/reveal", "POST");
    o = (await e.call("/api/improve")).data;
    assert.equal(o.shown.length, 5);
    const byTitle = (t) => o.shown.find((p) => p.title.startsWith(t));

    // Routine fix: applied exactly as shown.
    const rp = byTitle("Give the flaky");
    assert.deepEqual(rp.routinePatch.after, { prompt: "Check the school site and summarise changes.", timeoutMinutes: 25 });
    const a1 = (await e.call(`/api/improve/${rp.id}/approve`, "POST")).data;
    assert.equal(a1.status, "applied", a1.result);
    const changed = (await e.call("/api/routines")).data.find((r) => r.id === routineId);
    assert.equal(changed.timeoutMinutes, 25);
    assert.equal(changed.prompt, "Check the school site and summarise changes.");
    assert.equal((await e.call(`/api/improve/${rp.id}/approve`, "POST")).status, 500, "can't approve twice");

    // Skill fix.
    const a2 = (await e.call(`/api/improve/${byTitle("Add a tidy").id}/approve`, "POST")).data;
    assert.equal(a2.status, "applied");
    assert.ok((await e.call("/api/skills")).data.some((s) => s.name === "tidy-notes"));

    // Not now / dismiss.
    assert.equal((await e.call(`/api/improve/${byTitle("Shorter").id}/snooze`, "POST")).data.status, "waiting");
    assert.equal((await e.call(`/api/improve/${byTitle("Mute").id}/dismiss`, "POST")).data.status, "declined");

    // Code fix: built in the cloud — without a GitHub token it says exactly what's missing.
    const code = byTitle("Retry web fetch");
    const built = (await e.call(`/api/improve/${code.id}/approve`, "POST")).data;
    assert.equal(built.status, "failed");
    assert.match(built.result, /Couldn't start the cloud build: Save a GitHub token/);

    // Other changes: handed to Improver; finishes as applied.
    mode = "apply";
    const other = (await e.call("/api/improve")).data.shown.find((p) => p.title.startsWith("Shorter")) ?? { id: byTitle("Shorter").id };
    assert.equal((await e.call(`/api/improve/${other.id}/approve`, "POST")).data.status, "applying");
    const done = await e.until(async () => (await e.call("/api/improve")).data.history.find((p) => p.id === other.id && p.status !== "applying"), "change done", 15000);
    assert.equal(done.status, "applied");
    assert.match(done.result, /improve\/retry-note/);
    const handoff = (await e.call(`/api/bots/${imp.id}/messages`)).data.find((x) => x.role === "user" && /APPROVED/.test(x.text));
    assert.match(handoff.text, /Shorter morning summary/);

    // A night that doesn't record its result is reported as incomplete.
    mode = "lazy";
    await e.call(`/api/routines/${routine.id}/run`, "POST", {});
    const run2 = await e.until(async () => (await e.call(`/api/routines/${routine.id}/runs`)).data.find((x) => x.id !== run.id && ["succeeded", "failed"].includes(x.status)), "lazy run", 20000);
    assert.equal(run2.status, "failed");
    assert.match(run2.error, /incomplete/);

    // Settings: night time moves the routine; off pauses it.
    await e.call("/api/improve/settings", "PUT", { nightTime: "03:15", enabled: false });
    const r3 = (await e.call("/api/routines")).data.find((r) => r.system === "self-improve");
    assert.match(r3.scheduleText, /3:15 am/);
    assert.equal(r3.enabled, false);
    assert.equal((await e.call("/api/improve/settings", "PUT", { showTime: "noon" })).status, 400);
  } finally {
    await e.stop();
    m.close();
  }
});

test("improver: suggestions wait for the show time, one notification a day", async () => {
  process.env.MAUSDROID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-imp-"));
  const imp = await load("src/improve.ts");
  assert.equal(imp.showDateFor(new Date(2026, 10, 25, 3, 0), "12:00"), "2026-11-25");
  assert.equal(imp.showDateFor(new Date(2026, 10, 25, 13, 0), "12:00"), "2026-11-26");
  const r = imp.addSuggestions("run_x", [{ title: "Fix a thing", problem: "p", change: "c", area: "other" }]);
  assert.equal(r.added.length, 1);
  const day = r.added[0].showFrom;
  const [y, mo, d] = day.split("-").map(Number);
  assert.equal((await imp.revealDue(new Date(y, mo - 1, d, 11, 59))).length, 0, "not before midday");
  assert.equal((await imp.revealDue(new Date(y, mo - 1, d, 12, 0))).length, 1, "shown at midday");
  assert.equal(imp.improveSettings().lastRevealDate, day);
  assert.equal((await imp.revealDue(new Date(y, mo - 1, d, 12, 1))).length, 0, "only once");
});
