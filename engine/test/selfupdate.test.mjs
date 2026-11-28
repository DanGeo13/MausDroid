// Improver changing DanDroid's own program: a cloud build (GitHub Actions +
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
  const st = { dispatches: [], prs: {}, failed: new Set(), merges: [], closed: [], next: 1, step: null, questions: {}, succeeded: new Set(), branches: new Set(), opened: [] };
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
        return send(200, { workflow_runs: st.dispatches.map((d, i) => ({ id: i + 1, display_title: `Improve ${d.inputs.id}`, html_url: `https://github.example/run/${i}`, status: st.failed.has(d.inputs.id) || st.succeeded.has(d.inputs.id) ? "completed" : "in_progress", conclusion: st.failed.has(d.inputs.id) ? "failure" : st.succeeded.has(d.inputs.id) ? "success" : null })).reverse() });
      const jobs = u.pathname.match(/^\/repos\/me\/app\/actions\/runs\/(\d+)\/jobs$/);
      if (jobs) return send(200, { jobs: [{ steps: st.step ? [{ name: "Check inputs and secret", status: "completed" }, { name: st.step, status: "in_progress" }] : [] }] });
      const qf = u.pathname.match(/^\/repos\/me\/app\/contents\/\.improver\/questions-(\d+)\.md$/);
      if (qf) {
        const id = (u.searchParams.get("ref") ?? "").replace(/^improve\//, "").replace(/-questions$/, "");
        const q = st.questions[`${id}:${qf[1]}`];
        return q ? send(200, { content: Buffer.from(q).toString("base64") }) : send(404, { message: "Not Found" });
      }
      const br = u.pathname.match(/^\/repos\/me\/app\/branches\/(.+)$/);
      if (br) return st.branches.has(decodeURIComponent(br[1])) ? send(200, { name: decodeURIComponent(br[1]) }) : send(404, { message: "Branch not found" });
      if (u.pathname === "/repos/me/app/pulls" && req.method === "POST") {
        const j = JSON.parse(b);
        const id = j.head.replace(/^improve\//, "");
        st.opened.push(j);
        st.prs[id] = { number: st.next++, html_url: `https://github.example/pr/${id}`, state: "open", merged_at: null };
        return send(201, st.prs[id]);
      }
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
    assert.equal(d.inputs.platform, "claude", "GitHub + Claude Code is the default platform");
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

    // 2b. GitHub didn't let the run open the pull request: the branch is there, so the phone opens it, then installs.
    script = [{ tool: "improve_build", args: { title: "Bigger buttons", spec: "Make buttons bigger." } }, { text: "ok" }];
    await e.call(`/api/bots/${imp.id}/messages`, "POST", { text: "bigger buttons" });
    await e.until(async () => gh.st.dispatches.length === 3, "build for 2b");
    const id2b = gh.st.dispatches[2].inputs.id;
    gh.st.branches.add(`improve/${id2b}`);
    gh.st.succeeded.add(id2b);
    await e.until(async () => gh.st.merges.length === 3, "opened by the phone and installed", 15000);
    assert.equal(gh.st.opened[0].head, `improve/${id2b}`);
    assert.equal(gh.st.opened[0].base, "main");
    assert.match(gh.st.opened[0].title, /Improver: Bigger buttons/);

    // 3. A failed build is reported, nothing installed.
    script = [{ tool: "improve_build", args: { title: "Break things", spec: "x" } }, { text: "ok" }];
    await e.call(`/api/bots/${imp.id}/messages`, "POST", { text: "do a risky change" });
    await e.until(async () => gh.st.dispatches.length === 4, "fourth build");
    gh.st.failed.add(gh.st.dispatches[3].inputs.id);
    const failed = await e.until(async () => (await e.call("/api/improve")).data.history.find((p) => p.id === gh.st.dispatches[3].inputs.id && p.status === "failed"), "failure noticed", 15000);
    assert.match(failed.result, /cloud build failure/);
    assert.equal(gh.st.merges.length, 3);
    const alerts = (await e.call("/api/alerts")).data;
    assert.ok(alerts.some((a) => /couldn't be built/.test(a.title)));
  } finally {
    await e.stop();
    m.close();
    gh.close();
  }
});

test("cloud builds: progress lines, a question comes back, answers carry it on; platform off keeps suggestions", async () => {
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
    const msgs = async () => (await e.call(`/api/bots/${imp.id}/messages`)).data;

    // GitHub + Codex chosen as the coding platform.
    await e.call("/api/improve/settings", "PUT", { codingPlatform: "github-codex" });
    const p = (await e.call("/api/improve/build", "POST", { title: "Dark mode toggle", spec: "Add a dark mode toggle to Appearance." })).data;
    assert.equal(p.status, "building");
    assert.equal(gh.st.dispatches[0].inputs.platform, "codex");
    assert.ok((await msgs()).some((x) => x.role === "note" && /Dark mode toggle: Started in the cloud with Codex on GitHub/.test(x.text)));

    // Progress in plain words, in Improver's chat (no AI turn needed).
    gh.st.step = "Codex makes the change";
    await e.until(async () => (await msgs()).some((x) => x.role === "note" && /Codex is making the change/.test(x.text)), "progress line");
    gh.st.step = "Build and test like the phone (Node 18, no Intl/WebAssembly/TextDecoder)";
    await e.until(async () => (await msgs()).some((x) => x.role === "note" && /Running every test/.test(x.text)), "tests progress");

    // The developer asks something: Improver is told, you're notified; the card shows it.
    script = [{ text: "Quick question from the developer: should dark mode follow the phone's setting by default? (suggested: yes)" }];
    gh.st.questions[`${p.id}:1`] = "1. Should dark mode follow the phone setting by default? (suggested: yes)";
    await e.until(async () => (await e.call("/api/improve")).data.building[0]?.build?.questions, "question picked up");
    await e.until(async () => (await msgs()).some((x) => x.role === "assistant" && /Quick question/.test(x.text)), "Improver asks in chat");
    assert.ok((await e.call("/api/alerts")).data.some((a) => /Question about "Dark mode toggle"/.test(a.title) && a.priority === "high"));

    // You answer in Improver's chat; it passes the answer on and the build carries on.
    script = [{ tool: "improve_build_answer", args: { id: p.id, answers: "1. Yes, follow the phone." } }, { text: "Passed on — it's carrying on." }];
    await e.call(`/api/bots/${imp.id}/messages`, "POST", { text: "yes follow the phone" });
    await e.until(async () => gh.st.dispatches.length === 2, "build continued");
    const again = gh.st.dispatches[1].inputs;
    assert.equal(again.id, p.id);
    assert.equal(again.attempt, "2");
    assert.equal(again.platform, "codex", "the same platform carries on");
    assert.match(again.answers, /follow the phone setting[\s\S]*Yes, follow the phone/);
    assert.equal((await e.call(`/api/improve/${p.id}/answer`, "POST", { answers: "again" })).status, 400, "not waiting any more");

    gh.finish(p.id);
    await e.until(async () => gh.st.merges.length === 1, "installed", 15000);
    assert.ok((await msgs()).some((x) => x.role === "note" && /built and every test passed — installing/.test(x.text)));

    // Platform off: program changes are only kept as suggestions.
    await e.call("/api/improve/settings", "PUT", { codingPlatform: "off" });
    const kept = (await e.call("/api/improve/build", "POST", { title: "Something", spec: "x" })).data;
    assert.equal(kept.status, "shown");
    assert.equal(gh.st.dispatches.length, 2);
  } finally {
    await e.stop();
    m.close();
    gh.close();
  }
});

test("rollback: back to an earlier version kept on the phone; the left version is set aside", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "md-engines-"));
  const version = JSON.parse(fs.readFileSync(new URL("../../version.json", import.meta.url), "utf8")).engine;
  for (const v of ["0.8.1", "0.8.2", "0.8.3", version]) {
    fs.mkdirSync(path.join(root, v), { recursive: true });
    fs.writeFileSync(path.join(root, v, "engine.cjs"), "");
  }
  fs.writeFileSync(path.join(root, "current.txt"), version);
  fs.writeFileSync(path.join(root, "trial.txt"), version);
  fs.writeFileSync(path.join(root, "bad.txt"), "0.8.3\n");
  const e = await startEngine({ env: { MAUSDROID_ENGINES_DIR: root, MAUSDROID_RESTART_DELAY_MS: "300" } });
  let exited = false;
  try {
    const v = (await e.call("/api/improve")).data.versions;
    assert.equal(v.running, version);
    assert.deepEqual((await e.call("/api/update")).data.versions, v);
    assert.deepEqual(v.versions.map((x) => x.version), [version, "0.8.3", "0.8.2", "0.8.1"]);
    assert.equal(v.canRollBack, true);
    assert.equal((await e.call("/api/improve/rollback", "POST", { version: "0.1.0" })).status, 400, "only versions on the phone");
    const r = (await e.call("/api/improve/rollback", "POST", {})).data;
    assert.deepEqual(r, { from: version, to: "0.8.2" });
    assert.equal(fs.readFileSync(path.join(root, "current.txt"), "utf8"), "0.8.2");
    assert.equal(fs.readFileSync(path.join(root, "manual-version.txt"), "utf8"), "0.8.2");
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
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("over-the-air update reports when the phone has nothing ready to install", async () => {
  let restarting = false;
  const phone = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/update/status") return res.end(JSON.stringify({ engineVersion: "0.17.0", state: "up to date" }));
    if (req.url === "/update/apply") return res.end(JSON.stringify({ restarting }));
    res.end("{}");
  });
  await new Promise((resolve) => phone.listen(0, "127.0.0.1", resolve));
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: `http://127.0.0.1:${phone.address().port}` } });
  try {
    assert.equal((await e.call("/api/update")).data.state, "up to date");
    assert.equal((await e.call("/api/update/apply", "POST", {})).status, 409);
    restarting = true;
    assert.deepEqual(await e.call("/api/update/apply", "POST", {}), { status: 200, data: { restarting: true } });
  } finally {
    await e.stop();
    phone.close();
  }
});
