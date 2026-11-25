// The weekly audit routine end to end: research cutoff, scoring, wiki filing
// to a private repo (verified), report, memory, notification; incomplete
// runs and public repos are reported honestly.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fakeModel, startEngine, useModel, wait } from "./_engine.mjs";

async function fakeGitHub(isPrivate = true) {
  const files = { "entries/existing-idea.md": "---\nslug: existing-idea\nname: Existing idea\nsource_url: https://example.com/existing\n---\n" };
  const repo = { private: isPrivate };
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const send = (s, o) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      if (req.headers.authorization !== "Bearer ghp_test") return send(401, {});
      const u = new URL(req.url, "http://x").pathname;
      if (u === "/repos/me/wiki") return send(200, { private: repo.private });
      if (u === "/repos/me/wiki/contents/entries" && req.method === "GET") return send(200, Object.keys(files).map((f) => ({ name: f.split("/")[1] })));
      const m = u.match(/^\/repos\/me\/wiki\/contents\/(.+)$/);
      if (m && req.method === "GET") return files[decodeURIComponent(m[1])] ? send(200, { content: Buffer.from(files[decodeURIComponent(m[1])]).toString("base64") }) : send(404, {});
      if (m && req.method === "PUT") {
        const p = decodeURIComponent(m[1]);
        if (files[p]) return send(422, {});
        files[p] = Buffer.from(JSON.parse(b).content, "base64").toString("utf8");
        return send(201, {});
      }
      send(404, {});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, files, repo, close: () => server.close() };
}

const cand = (i, o = {}) => ({ name: `Candidate ${String.fromCharCode(65 + i)} ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey", "xray"][i]}`, source_ecosystem: "github", source_url: `https://example.com/c${i}`, summary: "Useful routine", utility: 5 - (i % 5), adoption: 3, scope_fit: 4, setup: 4, privacy: 5, phase: i % 3 === 0 ? "phase-1-ready" : i % 3 === 1 ? "phase-2-queued" : "phase-3-queued", primitives: ["notify_user"], account_alias: "personal", action_type: "user-approved", ...o });

test("weekly audit: cutoff, score, file overflow (private wiki), report, memory, notify; incomplete run reported", async () => {
  const gh = await fakeGitHub(true);
  let step = 0;
  let mode = "full";
  let candidates = [...Array.from({ length: 23 }, (_, i) => cand(i)), cand(23, { name: "Existing idea", source_url: "https://example.com/existing" }), cand(22, { name: "Marketplace autoposter", summary: "Auto-post listings to Facebook Marketplace" })];
  const m = await fakeModel(async () => {
    step++;
    if (mode === "lazy") return { text: "Done, everything looks great!" };
    switch (step) {
      case 1: return { tool: "audit_begin", args: {} };
      case 2: await wait(1500); return { tool: "web_search", args: { query: "claude skills" } };
      case 3: return { tool: "audit_score", args: { candidates } };
      case 4: return { tool: "audit_file_overflow", args: {} };
      case 5: return { tool: "audit_finish", args: { unavailable_sources: ["Claude Duet: no public page found"], notes: "Quick week." } };
      case 6: return { tool: "memory_save", args: { scope: "bot", note: "Top: Candidate A. Phase 1: Candidate A. Overflow 3 filed." } };
      case 7: return { tool: "notify_user", args: { title: "Sunday Routine Audit Ready", body: "Top Phase 1: Candidate A alpha; 3 wiki overflow entries filed.", priority: "normal" } };
      default: return { text: "Audit complete." };
    }
  });
  const e = await startEngine({ env: { MAUSDROID_GITHUB_API: gh.url, MAUSDROID_WIKI_REPO: "me/wiki" } });
  try {
    await useModel(e, m.url);
    await e.call("/api/settings/github", "PUT", { token: "ghp_test" });
    const r = (await e.call("/api/routines")).data.find((x) => x.system === "weekly-audit");
    assert.ok(r, "audit routine created");
    assert.equal(r.scheduleText, "Once a week: Sunday at 7:52 am (Australia/Sydney)");
    assert.equal(r.deadline, "08:00");
    // Shorten the research window for the test (1.2 s instead of 5 min).
    await e.call(`/api/routines/${r.id}`, "PATCH", { researchCutoffMinutes: 0.02 });
    const bot = (await e.call("/api/state")).data.bots.find((b) => b.id === r.botId);
    await e.call(`/api/bots/${bot.id}`, "PATCH", { approvalMode: "auto" });
    await e.call(`/api/routines/${r.id}/run`, "POST", {});
    const run = await e.until(async () => (await e.call(`/api/routines/${r.id}/runs`)).data.find((x) => ["succeeded", "failed"].includes(x.status)), "audit run finished", 30000);
    assert.equal(run.status, "succeeded", run.error);
    const msgs = (await e.call(`/api/bots/${bot.id}/messages`)).data;
    assert.ok(msgs.some((x) => x.tool?.name === "web_search" && x.tool.status === "denied" && /Research cutoff/.test(x.tool.result)), "research stops at the cutoff");
    // 25 candidates: 1 duplicate of the wiki, 1 unsafe → 23 accepted → 3 overflow filed.
    const filed = Object.keys(gh.files).filter((f) => f !== "entries/existing-idea.md");
    assert.equal(filed.length, 3);
    assert.match(gh.files[filed[0]], /safety_check: pass/);
    const report = msgs.find((x) => x.tool?.name === "audit_finish").tool.result;
    assert.match(report, /3 filed of 3/);
    assert.match(report, /Marketplace autoposter: Safety/);
    assert.match(report, /Claude Duet: no public page found/);
    const alert = (await e.call("/api/alerts")).data.find((a) => a.title.includes("Sunday Routine Audit Ready"));
    assert.ok(alert, "notification sent");
    const mem = (await e.call(`/api/memory/${bot.id}`)).data.text;
    assert.match(mem, /Overflow 3 filed/);

    // A run that doesn't actually do the audit is reported as incomplete, not successful.
    mode = "lazy";
    await e.call(`/api/routines/${r.id}/run`, "POST", {});
    const lazy = await e.until(async () => {
      const runs = (await e.call(`/api/routines/${r.id}/runs`)).data;
      return runs[0].id !== run.id && ["succeeded", "failed"].includes(runs[0].status) ? runs[0] : null;
    }, "lazy run finished", 20000);
    assert.equal(lazy.status, "failed");
    assert.match(lazy.error, /incomplete/);
    assert.ok((await e.call("/api/alerts")).data.some((a) => /Audit.*failed/.test(a.title)), "told about the failure");

    // A public wiki is never written to.
    gh.repo.private = false;
    candidates = Array.from({ length: 22 }, (_, i) => cand(i, { name: `Novel${i} gizmo${i} widget${i}`, source_url: `https://example.org/n${i}` }));
    mode = "full";
    step = 2;
    const before = Object.keys(gh.files).length;
    await e.call(`/api/routines/${r.id}`, "PATCH", { researchCutoffMinutes: 5 });
    await e.call(`/api/routines/${r.id}/run`, "POST", {});
    await e.until(async () => (await e.call(`/api/bots/${bot.id}/messages`)).data.some((x) => x.tool?.name === "audit_file_overflow" && /PUBLIC/.test(x.tool.result ?? "")), "public repo refused", 20000).catch(async (err) => { console.log(JSON.stringify((await e.call(`/api/bots/${bot.id}/messages`)).data.slice(-6).map((x) => [x.role, x.tool?.name, (x.tool?.result ?? x.text ?? "").slice(0, 200)]), null, 1)); throw err; });
    assert.equal(Object.keys(gh.files).length, before);
  } finally {
    await e.stop();
    m.close();
    gh.close();
  }
});
