// Weekly audio overview: a new Staff Update starts the routine, Maus writes a
// two-host script, the phone's voices record it (stand-in bridge), it never
// passes the time limit, it's saved to Downloads (size checked), and the
// person is notified with a link that opens the Morning Brief screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "./_load.mjs";
import { fakeModel, startEngine, useModel } from "./_engine.mjs";

/** A silent 16-bit WAV of the given length. */
function wav(sec, rate) {
  const n = Math.round(sec * rate);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + n * 2, 4);
  h.write("WAVEfmt ", 8, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(n * 2, 40);
  return Buffer.concat([h, Buffer.alloc(n * 2)]);
}

test("script lines, WAV joining, word budget", async () => {
  const a = await load("src/audio-overview.ts");
  const w = await load("src/wav.ts");
  const lines = a.parseScript("A: Welcome to week 8.\nB: Big week! **Monday** has assembly.\nIt starts at 9.\nA: See https://example.com for more.");
  assert.deepEqual(lines.map((l) => l.speaker), ["A", "B", "A"]);
  assert.equal(lines[1].text, "Big week! Monday has assembly. It starts at 9.");
  assert.ok(!lines[2].text.includes("http"));
  assert.deepEqual(a.parseScript("Sam: Hi.\nJo: Hello.\nSam: Bye.").map((l) => l.speaker), ["A", "B", "A"]);
  // No speaker labels: one voice throughout (a message), not alternating hosts.
  assert.deepEqual(a.parseScript("First paragraph.\n\nSecond paragraph.").map((l) => l.speaker), ["A", "A"]);
  assert.ok(a.wordsFor(10) <= 1500, "10 minutes of speech");
  const joined = w.join([w.readWav(wav(1, 16000)), w.readWav(wav(2, 24000))], 0.5);
  assert.equal(joined.sampleRate, 16000);
  assert.equal(Math.round(w.seconds(joined) * 10) / 10, 3.5);
  assert.equal(Math.round(w.seconds(w.readWav(w.writeWav(joined))) * 10) / 10, 3.5);
});

async function fakeBridge() {
  const st = { synth: [], notify: [], saved: [] };
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      const send = (o) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      if (req.url === "/secret/encrypt") return send({ cipher: Buffer.from(body.plain).toString("base64") });
      if (req.url === "/secret/decrypt") return send({ plain: Buffer.from(body.cipher, "base64").toString() });
      if (req.url === "/voice/voices") return send({ engine: body.engine, ready: true, voices: [{ name: "af_heart", locale: "en-US" }, { name: "am_adam", locale: "en-US" }, { name: "fr_x", locale: "fr-FR" }] });
      if (req.url === "/voice/synthesize") {
        st.synth.push(body);
        // Half a second per word, at different rates per voice (they get converted).
        const words = body.text.split(/\s+/).length;
        fs.writeFileSync(body.out, wav(words * 0.5, body.voice === "am_adam" ? 22050 : 24000));
        return send({ ok: true });
      }
      if (st.old && (req.url === "/files/save-download" || req.url === "/voice/synthesize")) return (res.writeHead(404, { "content-type": "application/json" }), res.end(JSON.stringify({ error: `unknown ${req.url}` })));
      if (req.url === "/files/save-download") {
        st.saved.push(body);
        return send({ uri: "content://media/downloads/1", name: body.name, location: `Download/${body.folder}/${body.name}`, size: fs.statSync(body.path).size });
      }
      if (req.url === "/notify") st.notify.push(body);
      send({});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, st, close: () => server.close() };
}

const SCRIPT = Array.from({ length: 20 }, (_, i) => `${i % 2 ? "B" : "A"}: On day ${i + 1} there is something important happening for all the staff.`).join("\n");

test("new Staff Update → Maus writes it → recorded under the limit → Downloads + notification link", async () => {
  const br = await fakeBridge();
  const m = await fakeModel((body) => {
    const all = JSON.stringify(body.messages);
    const last = JSON.stringify(body.messages.at(-1));
    if (/Make this week's audio overview/.test(all) && !/Recording started/.test(last)) return { tool: "audio_overview_record", args: { title: "Week 8 audio overview", week: "Term 4 Week 8", staff_update_name: "Week 8 Staff Update", staff_update_link: "https://docs.google.com/document/d/abc", script: SCRIPT } };
    return { text: "ok" };
  });
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: br.url, MAUSDROID_BRIDGE_TOKEN: "x" } });
  try {
    await useModel(e, m.url);
    const st = (await e.call("/api/audio-overviews")).data;
    assert.equal(st.routine.title, "Weekly Audio Overview");
    assert.equal(st.routine.schedule.alert.type, "staff-update");
    assert.equal(st.routine.botId, (await e.call("/api/state")).data.bots.find((b) => b.name === "Maus").id, "the main assistant makes it");
    // A 1-minute limit so the cut-off is tested (the real limit is 10).
    await e.call("/api/audio-overviews/settings", "PUT", { maxMinutes: 1 });
    // The watcher raises this when a new Staff Update is in Drive.
    await e.call("/api/alerts/incoming", "POST", { type: "staff-update", source: "Google Drive", title: "New Staff Update: Week 8 Staff Update", body: "Drive file id: abc", id: "staff-update:abc", notify: false });
    const o = await e.until(async () => (await e.call("/api/audio-overviews")).data.overviews.find((x) => x.status !== "recording"), "recorded", 30000);
    assert.equal(o.status, "ready", o.error);
    assert.ok(o.seconds <= 60, `under the limit (${o.seconds}s)`);
    assert.ok(o.seconds >= 40, "uses most of the time");
    assert.ok(o.linesLeftOut > 0, "lines that don't fit are left out");
    // Two hosts, two voices; the closing line is added.
    const voices = new Set(br.st.synth.map((s) => s.voice));
    assert.deepEqual([...voices].sort(), ["af_heart", "am_adam"]);
    assert.ok(br.st.synth.some((s) => /full Staff Update/.test(s.text)));
    for (const s of br.st.synth) assert.ok(s.out.startsWith(e.dir), "recordings stay in MausDroid's own storage");
    // Saved to Downloads, size checked.
    assert.equal(o.downloads.location, "Download/MausDroid/Week 8 audio overview.wav");
    // Listed in Notifications (as an update: it doesn't buzz the phone unless updates are on) with a link to it.
    assert.ok(!br.st.notify.some((x) => x.type === "audio-overview"), "updates don't buzz the phone by default");
    const n = (await e.call("/api/alerts")).data.find((x) => x.type === "audio-overview");
    assert.equal(n.tier, "info");
    assert.equal(n.link, `audio:${o.id}`);
    assert.match(n.title, /Week 8 audio overview is ready/);
    // The audio plays (and can skip ahead).
    const r = await fetch(`http://127.0.0.1:${e.port}/api/files/${o.fileId}`, { headers: { authorization: "Bearer t", range: "bytes=0-99" } });
    assert.equal(r.status, 206);
    assert.equal((await r.arrayBuffer()).byteLength, 100);
    assert.equal(r.headers.get("content-type"), "audio/wav");
    // The same Staff Update doesn't start it twice.
    await e.call("/api/alerts/incoming", "POST", { type: "staff-update", source: "Google Drive", title: "New Staff Update: Week 8 Staff Update", body: "Drive file id: abc", id: "staff-update:abc", notify: false });
    await new Promise((res) => setTimeout(res, 1500));
    assert.equal((await e.call("/api/audio-overviews")).data.overviews.length, 1);
  } finally {
    await e.stop();
    m.close();
    br.close();
  }
});

test("save_to_downloads: a MausDroid file to Downloads, checked; older app gets a clear message", async () => {
  const br = await fakeBridge();
  const m = await fakeModel((body) => {
    const last = JSON.stringify(body.messages.at(-1));
    if (/save it/.test(last)) return { tool: "save_to_downloads", args: { file_id: globalThis.__fid, name: "Week 8 TAS Update.pdf" } };
    return { text: "done" };
  });
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: br.url, MAUSDROID_BRIDGE_TOKEN: "x" } });
  try {
    await useModel(e, m.url);
    const f = (await e.call("/api/files/json", "POST", { name: "tas.pdf", mime: "application/pdf", b64: Buffer.from("%PDF-1.4 test").toString("base64") })).data;
    globalThis.__fid = f.id;
    const maus = (await e.call("/api/state")).data.bots.find((b) => b.name === "Maus");
    await e.call(`/api/bots/${maus.id}/messages`, "POST", { text: "save it" });
    const t = await e.until(async () => (await e.call(`/api/bots/${maus.id}/messages`)).data.find((x) => x.tool?.name === "save_to_downloads" && x.tool.status !== "running")?.tool, "saved");
    assert.ok(!t.isError, t.result);
    assert.match(t.result, /Download\/MausDroid\/Week 8 TAS Update\.pdf/);
    assert.equal(br.st.saved[0].mime, "application/pdf");
    assert.equal((await e.call("/api/cards")).data.length, 0, "saving to the phone doesn't ask");
    // An older app without these features: a clear message, not a crash.
    br.st.old = true;
    const r = await e.call(`/api/files/${f.id}/save-to-downloads`, "POST", {});
    assert.match(r.data.error, /newer MausDroid app \(0\.11\.0/);
  } finally {
    await e.stop();
    m.close();
    br.close();
  }
});

test("watcher: each new Staff Update starts one overview", async () => {
  process.env.MAUSDROID_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "md-aud-"));
  const a = await load("src/audio-overview.ts");
  const file = { id: "f1", name: "Week 8 Staff Update", webViewLink: "https://x", modifiedTime: new Date().toISOString() };
  assert.equal(await a.checkForNewStaffUpdate(async () => ({ file })), "f1");
  assert.equal(await a.checkForNewStaffUpdate(async () => ({ file })), null, "not twice");
  assert.equal(await a.checkForNewStaffUpdate(async () => ({ file: null })), null);
  a.saveAudioSettings({ enabled: false });
  assert.equal(await a.checkForNewStaffUpdate(async () => ({ file: { ...file, id: "f2" } })), null, "switched off");
  assert.equal(a.saveAudioSettings({ maxMinutes: 25 }).maxMinutes, 10, "never more than 10 minutes");
});
