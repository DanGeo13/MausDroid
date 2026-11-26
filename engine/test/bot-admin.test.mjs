// Tools per bot; Maus edits other bots with your approval (before → after),
// never its own approvals; every change can be undone; Improver (admin)
// changes things straight away when asked, records them, withdraws cards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeModel, startEngine, useModel } from "./_engine.mjs";

test("tools, Maus editing bots with approval + undo, Improver admin acting immediately", async () => {
  const scripts = new Map(); // bot persona marker -> queue of replies
  const m = await fakeModel((body) => {
    const sys = JSON.stringify(body.messages?.[0] ?? "");
    const key = /You are Maus/.test(sys) ? "maus" : /self-improvement bot/.test(sys) ? "improver" : "other";
    const last = body.messages.at(-1);
    const q = scripts.get(key) ?? [];
    if (last.role === "tool" || last.role === "user") return q.shift() ?? { text: "Done." };
    return { text: "Done." };
  });
  const e = await startEngine();
  try {
    await useModel(e, m.url);
    const st = (await e.call("/api/state")).data;
    const maus = st.bots.find((b) => b.name === "Maus");
    const researcher = st.bots.find((b) => b.name === "Researcher");
    const imp = st.bots.find((b) => b.name === "Improver");
    await e.call(`/api/bots/${imp.id}`, "PATCH", { providerId: "local", model: "fake" });

    // The tool list: everything, with who can have the special ones.
    const cat = (await e.call("/api/tools")).data;
    const byName = Object.fromEntries(cat.tools.map((t) => [t.name, t]));
    assert.equal(byName.bot_edit.onlyFor, "Maus and Improver");
    assert.equal(byName.improve_withdraw.onlyFor, "Improver");
    assert.equal(byName.web_search.onlyFor, null);
    assert.equal(byName.web_search.risky, false);
    assert.equal(byName.routine_delete?.risky ?? true, true);

    // Switching a tool off for one bot removes it from what that bot's AI sees.
    await e.call("/api/tools/web_search/bots", "POST", { botIds: [researcher.id], enabled: false });
    assert.deepEqual((await e.call("/api/tools")).data.bots.find((b) => b.id === researcher.id).disabledTools, ["web_search"]);
    scripts.set("other", [{ text: "hi" }]);
    await e.call(`/api/bots/${researcher.id}/messages`, "POST", { text: "hello" });
    await e.until(async () => (await e.call(`/api/bots/${researcher.id}/messages`)).data.some((x) => x.role === "assistant"), "researcher replied");
    const rReq = await e.until(async () => m.seen.find((b) => /research topics/.test(JSON.stringify(b.messages?.[0] ?? "")) && b.tools), "researcher's AI request");
    const rTools = (rReq.tools ?? []).map((t) => t.function?.name);
    assert.ok(!rTools.includes("web_search"), "switched-off tool hidden");
    assert.ok(rTools.includes("web_fetch"));
    assert.ok(!rTools.includes("bot_edit"), "ordinary bots can't edit bots");

    // Maus edits Researcher: a card shows before → after; nothing changes until approved.
    scripts.set("maus", [{ tool: "bot_edit", args: { bot_id: "Researcher", persona: "You research school policies.", model: "fast-model" } }, { text: "Updated Researcher." }]);
    await e.call(`/api/bots/${maus.id}/messages`, "POST", { text: "make Researcher focus on school policies" });
    const card = await e.until(async () => (await e.call("/api/cards")).data.find((c) => c.botId === maus.id), "approval card");
    assert.match(card.title, /Change 🔎 Researcher: persona: .*research topics.* → .*school policies/);
    assert.match(card.title, /model: null → "fast-model"|model: null → fast-model/);
    assert.notEqual((await e.call("/api/state")).data.bots.find((b) => b.id === researcher.id).persona, "You research school policies.");
    await e.call(`/api/cards/${card.id}`, "POST", { allow: true });
    await e.until(async () => (await e.call("/api/state")).data.bots.find((b) => b.id === researcher.id).persona === "You research school policies.", "applied after approval");
    const changes = (await e.call("/api/bot-changes")).data;
    assert.equal(changes[0].by, "Maus");
    assert.deepEqual(Object.keys(changes[0].after).sort(), ["model", "persona"]);

    // Undo puts it back.
    assert.equal((await e.call(`/api/bot-changes/${changes[0].id}/undo`, "POST")).status, 200);
    const back = (await e.call("/api/state")).data.bots.find((b) => b.id === researcher.id);
    assert.match(back.persona, /research topics/);
    assert.equal(back.model, null);
    assert.equal((await e.call(`/api/bot-changes/${changes[0].id}/undo`, "POST")).status, 400, "only once");

    // Maus can't loosen its own approvals.
    scripts.set("maus", [{ tool: "bot_edit", args: { bot_id: maus.id, approval_mode: "auto" } }, { text: "Couldn't." }]);
    await e.call(`/api/bots/${maus.id}/messages`, "POST", { text: "stop asking me" });
    await e.until(async () => (await e.call(`/api/bots/${maus.id}/messages`)).data.some((x) => x.tool?.name === "bot_edit" && x.tool.status === "denied"), "refused");
    assert.equal((await e.call("/api/state")).data.bots.find((b) => b.id === maus.id).approvalMode, "ask-risky");

    // Improver (admin): asked directly, it changes another bot's routine and a bot at once — no cards.
    const rt = (await e.call("/api/routines", "POST", { botId: researcher.id, title: "Policy check", prompt: "Check policies.", schedule: { kind: "daily", time: "09:00" } })).data;
    // A suggestion that the person then asks to remove.
    const night = (await e.call("/api/routines")).data.find((r) => r.system === "self-improve");
    scripts.set("improver", [
      { tool: "improve_propose", args: { suggestions: [{ title: "Retry fetches on timeouts", problem: "p", change: "c", area: "code" }] } },
      { tool: "improve_finish", args: { summary: "one idea" } },
      { text: "Night done." },
    ]);
    await e.call(`/api/routines/${night.id}/run`, "POST", {});
    await e.until(async () => (await e.call("/api/improve")).data.waiting === 1, "one waiting suggestion");
    scripts.set("improver", [
      { tool: "routine_admin_update", args: { id: rt.id, time: "07:30", kind: "daily" } },
      { tool: "bot_edit", args: { bot_id: "Inbox", disable_tools: ["web_search"], tools: { browser: false } } },
      { tool: "improve_record", args: { title: "Inbox: no web search or browser", change: "Turned off web_search and the browser for Inbox", area: "other" } },
      { tool: "improve_withdraw", args: { ids: ["Retry fetches"] } },
      { text: "Done: moved Policy check to 7:30, limited Inbox, withdrew the retry idea." },
    ]);
    await e.call(`/api/bots/${imp.id}/messages`, "POST", { text: "move Policy check to 7:30, stop Inbox using web search and the browser, and drop the retry suggestion" });
    await e.until(async () => (await e.call(`/api/bots/${imp.id}/messages`)).data.some((x) => x.role === "assistant" && /withdrew/.test(x.text)), "Improver done", 15000);
    assert.equal((await e.call("/api/cards")).data.length, 0, "no approval cards for Improver's admin changes");
    assert.match((await e.call("/api/routines")).data.find((r) => r.id === rt.id).scheduleText, /7:30 am/);
    const inbox = (await e.call("/api/state")).data.bots.find((b) => b.name === "Inbox");
    assert.equal(inbox.tools.browser, false);
    assert.deepEqual(inbox.disabledTools, ["web_search"]);
    const o = (await e.call("/api/improve")).data;
    assert.equal(o.waiting, 0);
    assert.ok(o.history.some((p) => p.title === "Retry fetches on timeouts" && p.status === "declined" && /Withdrawn/.test(p.result)));
    assert.ok(o.history.some((p) => p.title === "Inbox: no web search or browser" && p.status === "applied"));
    assert.equal((await e.call("/api/bot-changes")).data[0].by, "Improver");
    assert.match(imp.persona, /admin rights/, "Improver's instructions say to act immediately");
  } finally {
    await e.stop();
    m.close();
  }
});
