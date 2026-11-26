// Improver changing MausDroid's own program: a cloud build (GitHub Actions +
// Claude Code) → pull request → installed (merged) automatically for direct
// requests, or by tapping Install for nightly suggestions; failed builds are
// reported; rollback to an earlier version kept on the phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeModel, startEngine, useModel, wait } from "./_engine.mjs";

async function fakeGitHub() {
  const st = { dispatches: [], prs: {}, failed: new Set(), merges: [], closed: [], next: 1 };
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const send = (s, o) => (res.writeHead(s, { "content-type": "application/json" }), res.end(JSON.stringify(o ?? {})));
      if (req.headers.authorization !== "Bearer ghp_test") return send(401, { message: "Bad credentials" });
      const u = new URL(req.url, "http://x");
      if (u.pathname === "/repos/me/app/actions/workflows/improver.yml/dispatches" && req.method === "POST") {
        st.dispatches.push(JSON.parse(b));
        return send(204);
      }
      if (u.pathname === "/repos/me/app/actions/workflows/improver.yml/runs")
        return send(200, { workflow_runs: st.dispatches.map((d, i) => ({ display_title: `Improve ${d.inputs.id}`, html_url: `https://github.example/run/${i}`, status: st.failed.has(d.inputs.id) ? "completed" : "in_progress", conclusion: st.failed.has(d.inputs.id) ? "failure" : null })) });
      if (u.pathname === "/repos/me/app/pulls" && req.method === "GET") {
        const id = (u.searchParams.get("head") ?? "").split("improve/")[1];
        const pr = st.prs[id];
        return send(200, pr ? [pr] : []);
      }
      const m = u.pathname.match(/^\/repos\/me\/app\/pulls\/(\d+)(\/merge)?$/);
      if (m) {
        const pr = Object.values(st.prs).find((p) => p.number === Number(m[1]));
        if (m[2] && req.method === "PUT") {
          st.merges.push(pr.number);
          pr.merged_at = new Date().toISOString();
          pr.state = "closed";
          return send(200, { merged: true });
        }
        if (req.method === "PATCH") {
          st.closed.push(pr.number);
          pr.state = "closed";
          return send(200, {});
        }
      }
      send(404, { message: "Not Found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // The cloud build "finishes": a pull request appears for that id.
  const finish = (id) => (st.prs[id] = { number: st.next++, html_url: `https://github.example/pr/${id}`, state: "open", merged_at: null });
  return { url: `http://127.0.0.1:${server.address().port}`, st, finish, close: () => server.close() };
}

test("cloud builds: direct request installs itself; nightly code card builds then installs on tap; failures reported", async () => {
  const gh = await fakeGitHub();
  let script = [];
  const m = await fakeModel((body) => {
    const sys = JSON.stringify(body.messages?.[0] ?? "");
    if (!/self-improvement bot/.test(sys)) return { text: "ok" };
    return script.shift() ?? { text: "Done." };
  });
  const e = await startEngine({ env: { MAUSDROID_GITHUB_API: gh.url, MAUSDROID_CODE_REPO: "me/app", MAUSDROID_BUILD_POLL_MS: "300" } });
  try {
    await useModel(e, m.url);
    await e.call("/api/settings/github", "PUT", { token: "ghp_test" });
    const imp = (await e.call("/api/state")).data.bots.find((b) => b.name === "Improver");
    await e.call(`/api/bots/${imp.id}`, "PATCH", { providerId: "local", model: "fake" });

    // 1. Asked directly: Improver starts a cloud build; when it's ready (tests passed) it installs by itself.
    script = [{ tool: "improve_build", args: { title: "Add a tools page", spec: "Settings → Tools lists every tool with on/off per bot." } }, { text: "Building it now." }];
    await e.call(`/api/bots/${imp.id}/messages`, "POST", { text: "add a tools page" });
    await e.until(async () => gh.st.dispatches.length === 1, "build started");
    const d = gh.st.dispatches[0];
    assert.equal(d.ref, "main");
    assert.match(d.inputs.id, /^imp_[a-z0-9]+$/);
    assert.match(d.inputs.request, /Settings → Tools lists every tool/);
    let o = (await e.call("/api/improve")).data;
    assert.equal(o.building.length, 1);
    assert.equal(o.building[0].title, "Add a tools page");
    gh.finish(d.inputs.id);
    await e.until(async () => gh.st.merges.length === 1, "installed automatically", 15000);
    o = (await e.call("/api/improve")).data;
    const done = o.history.find((p) => p.id === d.inputs.id);
    assert.equal(done.status, "applied");
    assert.match(done.result, /Installed/);
    assert.equal(done.build.prUrl, `https://github.example/pr/${d.inputs.id}`);

    // 2. A nightly code suggestion: Approve builds it, then it waits for Install.
    const night = (await e.call("/api/routines")).data.find((r) => r.system === "self-improve");
    script = [
      { tool: "improve_propose", args: { suggestions: [{ title: "Retry slow pages", problem: "web_fetch times out", change: "Retry once after 5 s", area: "code" }] } },
      { tool: "improve_finish", args: { summary: "one" } },
      { text: "ok" },
    ];
    await e.call(`/api/routines/${night.id}/run`, "POST", {});
    await e.until(async () => (await e.call("/api/improve")).data.waiting === 1, "suggestion waiting");
    await e.call("/api/improve/reveal", "POST");
    const card = (await e.call("/api/improve")).data.shown[0];
    assert.equal((await e.call(`/api/improve/${card.id}/approve`, "POST")).data.status, "building");
    await e.until(async () => gh.st.dispatches.length === 2, "second build started");
    gh.finish(card.id);
    const ready = await e.until(async () => (await e.call("/api/improve")).data.shown.find((p) => p.id === card.id && p.build?.prUrl), "ready to install", 15000);
    assert.equal(gh.st.merges.length, 1, "not installed without the tap");
    assert.equal((await e.call(`/api/improve/${ready.id}/approve`, "POST")).data.status, "applied");
    assert.equal(gh.st.merges.length, 2);

    // 3. A failed build is reported, nothing installed.
    script = [{ tool: "improve_build", args: { title: "Break things", spec: "x" } }, { text: "ok" }];
    await e.call(`/api/bots/${imp.id}/messages`, "POST", { text: "do a risky change" });
    await e.until(async () => gh.st.dispatches.length === 3, "third build");
    gh.st.failed.add(gh.st.dispatches[2].inputs.id);
    const failed = await e.until(async () => (await e.call("/api/improve")).data.history.find((p) => p.id === gh.st.dispatches[2].inputs.id && p.status === "failed"), "failure noticed", 15000);
    assert.match(failed.result, /cloud build failure/);
    assert.equal(gh.st.merges.length, 2);
    const alerts = (await e.call("/api/alerts")).data;
    assert.ok(alerts.some((a) => /couldn't be built/.test(a.title)));
  } finally {
    await e.stop();
    m.close();
    gh.close();
  }
});

test("rollback: back to an earlier version kept on the phone; the left version is set aside", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "md-engines-"));
  const version = JSON.parse(fs.readFileSync(new URL("../../version.json", import.meta.url), "utf8")).engine;
  for (const v of ["0.8.1", "0.8.2", version]) {
    fs.mkdirSync(path.join(root, v), { recursive: true });
    fs.writeFileSync(path.join(root, v, "engine.cjs"), "");
  }
  fs.writeFileSync(path.join(root, "current.txt"), version);
  fs.writeFileSync(path.join(root, "trial.txt"), version);
  const e = await startEngine({ env: { MAUSDROID_ENGINES_DIR: root, MAUSDROID_RESTART_DELAY_MS: "300" } });
  let exited = false;
  try {
    const v = (await e.call("/api/improve")).data.versions;
    assert.equal(v.running, version);
    assert.deepEqual(v.versions.map((x) => x.version), [version, "0.8.2", "0.8.1"]);
    assert.equal(v.canRollBack, true);
    assert.equal((await e.call("/api/improve/rollback", "POST", { version: "0.1.0" })).status, 400, "only versions on the phone");
    const r = (await e.call("/api/improve/rollback", "POST", {})).data;
    assert.deepEqual(r, { from: version, to: "0.8.2" });
    assert.equal(fs.readFileSync(path.join(root, "current.txt"), "utf8"), "0.8.2");
    assert.match(fs.readFileSync(path.join(root, "bad.txt"), "utf8"), new RegExp(version.replace(/\./g, "\\.")));
    assert.ok(!fs.existsSync(path.join(root, "trial.txt")));
    // The engine stops so the app restarts it on the older version.
    for (let i = 0; i < 40 && !exited; i++) {
      try {
        await fetch(`${e.base}/api/whoami`);
        await wait(100);
      } catch {
        exited = true;
      }
    }
    assert.ok(exited, "engine restarted");
  } finally {
    if (!exited) await e.stop();
  }
});
