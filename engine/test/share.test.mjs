// Sharing from other apps: everything goes to Maus, which forwards it to the
// routine(s) it fits; "share" alert routines run by themselves; no repeats.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeModel, startEngine, useModel } from "./_engine.mjs";
import { load } from "./_load.mjs";

test("share: to Maus, forwarded by context, automatic share routines, no repeats", async () => {
  let ids = {};
  const m = await fakeModel((body) => {
    const all = JSON.stringify(body.messages);
    if (!all.includes("Shared with you from another app")) return { text: "Done." };
    const sid = all.match(/share id (share_[a-z0-9]+)/)[1];
    const tools = body.messages.filter((x) => x.role === "tool").length;
    if (tools === 0) return { tool: "routine_forward", args: { share_id: sid, routine_id: ids.recipes, note: "It's a recipe video" } };
    if (tools === 1) return { tool: "routine_forward", args: { share_id: sid, routine_id: ids.videos, note: "also a video" } };
    return { text: "Sent it to your Recipes routine." };
  });
  const e = await startEngine();
  try {
    await useModel(e, m.url);
    const bots = (await e.call("/api/state")).data.bots;
    const maus = bots.find((b) => b.name === "Maus");
    const researcher = bots.find((b) => b.name === "Researcher");
    ids.recipes = (await e.call("/api/routines", "POST", { botId: researcher.id, title: "Recipes", prompt: "Save recipes to my recipe list.", schedule: { kind: "weekly", days: [0], time: "18:00" } })).data.id;
    ids.videos = (await e.call("/api/routines", "POST", { botId: researcher.id, title: "Video notes", prompt: "Summarise shared YouTube videos.", schedule: { kind: "alert", alert: { type: "share", source: "YouTube" } } })).data.id;

    const r = await e.call("/api/share", "POST", { text: "Best pasta ever https://www.youtube.com/watch?v=abc123" });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.botId, maus.id, "goes to Maus");
    assert.equal(r.data.kind, "YouTube video");
    assert.deepEqual(r.data.urls, ["https://www.youtube.com/watch?v=abc123"]);

    // The share routine runs by itself; Maus forwards to Recipes.
    const autoRun = await e.until(async () => (await e.call(`/api/routines/${ids.videos}/runs`)).data[0], "automatic share routine ran");
    assert.equal(autoRun.trigger, "alert");
    const fwd = await e.until(async () => (await e.call(`/api/routines/${ids.recipes}/runs`)).data[0], "forwarded run", 15000);
    assert.equal(fwd.trigger, "share");
    const researcherMsgs = (await e.call(`/api/bots/${researcher.id}/messages`)).data;
    assert.ok(researcherMsgs.some((x) => x.role === "user" && /youtube\.com\/watch\?v=abc123/.test(x.text) && /recipe video/.test(x.text)), "the routine got the link and the reason");

    // Forwarding to the automatic routine is refused as a repeat; only one run of each.
    await e.until(async () => (await e.call(`/api/bots/${maus.id}/messages`)).data.some((x) => x.role === "assistant" && /Recipes routine/.test(x.text)), "Maus replied", 15000);
    const mausMsgs = (await e.call(`/api/bots/${maus.id}/messages`)).data;
    assert.ok(mausMsgs.some((x) => x.tool?.name === "routine_forward" && /already has it/.test(x.tool.result)), "the repeat was refused");
    assert.ok(mausMsgs.some((x) => x.role === "user" && x.source === "share" && /Video notes.*already runs automatically/.test(x.text)), "Maus is told which routines already run");
    assert.equal((await e.call(`/api/routines/${ids.recipes}/runs`)).data.length, 1);
    assert.equal((await e.call(`/api/routines/${ids.videos}/runs`)).data.length, 1);
    const shares = (await e.call("/api/shares")).data;
    assert.equal(shares[0].forwarded.length, 1);
    assert.equal(shares[0].forwarded[0].title, "Recipes");

    assert.equal((await e.call("/api/share", "POST", { text: "  " })).status, 400);
  } finally {
    await e.stop();
    m.close();
  }
});

test("share kinds", async () => {
  const s = await load("src/share.ts");
  assert.equal(s.shareKind("https://youtu.be/xyz"), "YouTube video");
  assert.equal(s.shareKind("look https://www.tiktok.com/@a/video/1"), "TikTok video");
  assert.equal(s.shareKind("https://www.instagram.com/reel/abc/"), "Instagram post");
  assert.equal(s.shareKind("https://m.facebook.com/watch?v=1"), "Facebook post");
  assert.equal(s.shareKind("https://example.com/news"), "web page");
  assert.equal(s.shareKind("", [{ name: "a.jpg", mime: "image/jpeg" }]), "photo");
  assert.equal(s.shareKind("", [{ name: "a.mp4", mime: "video/mp4" }]), "video");
  assert.equal(s.shareKind("just some words"), "text");
});
