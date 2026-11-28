// Podcast: two chosen hosts (female A, male B), delivery cues applied per
// phrase, segments with speaker / timestamp / source, hands-free
// "pause, explain that last bit" and "continue" from the saved position,
// and tapping a line to jump there.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { load } from "./_load.mjs";
import { fakeModel, startEngine, useModel, wait } from "./_engine.mjs";

function wav(sec, rate = 24000) {
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

test("source quotes, jumps, segments, commands", async () => {
  const a = await load("src/audio-overview.ts");
  const p = await load("src/podcast-session.ts");
  assert.deepEqual(a.splitSource('A: The fete is on Friday. {source "Fete: Friday 2pm"}'), { text: "A: The fete is on Friday.", quote: "Fete: Friday 2pm" });
  assert.deepEqual(a.splitSource("B: No source here."), { text: "B: No source here." });
  assert.equal(a.sourceJump("https://school.example/news", "Fete: Friday 2pm on the oval"), "https://school.example/news#:~:text=Fete%3A%20Friday%202pm%20on%20the%20oval");
  assert.equal(a.sourceJump("https://docs.google.com/document/d/abc/edit", "Fete"), undefined, "Google Docs can't jump to a quote: replay only");
  assert.equal(a.sourceJump(undefined, "x"), undefined);
  const d = await load("src/downloads.ts");
  assert.equal(d.driveIdFrom("https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz_-123/edit"), "1AbCdEfGhIjKlMnOpQrStUvWxYz_-123");
  assert.equal(d.driveIdFrom("https://drive.google.com/file/d/1ZZZZZZZZZZZZZZZZZZZZZZZZZ/view"), "1ZZZZZZZZZZZZZZZZZZZZZZZZZ");
  assert.equal(d.driveIdFrom("https://drive.google.com/open?id=1YYYYYYYYYYYYYYYYYYYYYYYYY"), "1YYYYYYYYYYYYYYYYYYYYYYYYY");
  assert.equal(d.driveIdFrom("https://school.example/news"), undefined);
  const segs = [
    { speaker: "A", host: "female", text: "one", startMs: 0, endMs: 2000 },
    { speaker: "B", host: "male", text: "two", startMs: 2350, endMs: 5000 },
    { speaker: "A", host: "female", text: "three", startMs: 5350, endMs: 8000 },
  ];
  assert.equal(p.segmentAt(segs, 4000).seg.text, "two");
  assert.equal(p.segmentAt(segs, 5600).seg.text, "two", "just after a handoff, 'that last bit' is the previous line");
  assert.equal(p.segmentAt(segs, 7000).seg.text, "three");
  assert.equal(p.segmentAt(segs, 7000).prev.text, "two");
  assert.match(p.sourceAround("x".repeat(3000) + "Fete: Friday 2pm" + "y".repeat(3000), "Fete: Friday 2pm"), /^x+Fete: Friday 2pmy+$/);
  assert.equal(p.commandFrom("Pause, explain that last bit"), "explain");
  assert.equal(p.commandFrom("what does that mean?"), "explain");
  assert.equal(p.commandFrom("Continue"), "continue");
  assert.equal(p.commandFrom("ok carry on"), "continue");
  assert.equal(p.commandFrom("say that again"), "repeat");
  assert.equal(p.commandFrom("pause"), "pause");
  assert.equal(p.commandFrom("stop listening"), "stop");
  const w = await load("src/wav.ts");
  const b = w.breath("breath", 24000);
  const sg2 = w.breath("sigh", 24000);
  assert.ok(Math.abs(w.seconds(b) - 0.38) < 0.01 && Math.abs(w.seconds(sg2) - 0.75) < 0.01);
  const peak = (p2) => p2.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  assert.ok(peak(b) > 300 && peak(b) <= 2600, "a soft, audible breath");
  assert.ok(Math.abs(sg2.samples.at(-1)) < 50, "fades out");
});

async function fakePhone() {
  const st = { synth: [], enq: [], listenQ: [], playStart: 0, playFrom: 0, playing: false, stopped: -1, interrupt: false, interrupted: 0, saved: [], deleted: [], n: 0 };
  const position = () => (st.playing ? st.playFrom + (Date.now() - st.playStart) : -1);
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", async () => {
      const body = b ? JSON.parse(b) : {};
      const send = (o) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      switch (req.url) {
        case "/secret/encrypt": return send({ cipher: Buffer.from(body.plain).toString("base64") });
        case "/secret/decrypt": return send({ plain: Buffer.from(body.cipher, "base64").toString() });
        case "/voice/voices": return send({ voices: [{ name: "alba", locale: "en-GB" }, { name: "marius", locale: "en-GB" }, { name: "cosette", locale: "en-GB" }] });
        case "/voice/synthesize": {
          st.synth.push(body);
          const words = body.text.split(/\s+/).length;
          fs.writeFileSync(body.out, wav(words * 0.3 / (body.sonicRate ?? 1)));
          return send({ ok: true });
        }
        case "/files/save-download": st.saved.push(body); return send({ uri: `content://media/downloads/${++st.n}`, name: body.name, location: `Download/${body.folder}/${body.name}`, size: fs.statSync(body.path).size });
        case "/files/delete-download": st.deleted.push(body.uri); return send({ deleted: true });
        case "/pdf/open": (st.opened ??= []).push(body); return send({});
        case "/voice/self-check": (st.selfChecks ??= []).push(body); return send({ heard: "Big week coming up!", speechMs: 1200 });
        case "/pdf/find": return send({ pages: body.quotes.map((q) => (/Reports/.test(q) ? 2 : /carnival/i.test(q) ? 0 : -1)), canSearch: true, pageCount: 3 });
        case "/map.pdf": res.writeHead(200, { "content-type": "application/pdf" }); return res.end("%PDF-1.4 fake carnival map");
        case "/page.html": res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>newsletter</html>");
        case "/speech/enqueue": {
          st.enq.push(body);
          const audio = body.items.find((i) => i.kind === "audio");
          if (audio) Object.assign(st, { playing: true, playStart: Date.now(), playFrom: audio.startMs });
          else st.playing = false;
          return send({ queued: body.items.length });
        }
        case "/speech/state": return send({ speaking: st.playing, positionMs: position(), stoppedAtMs: st.stopped });
        case "/speech/stop": if (st.playing) st.stopped = position(); st.playing = false; return send({});
        case "/voice/local-available": return send({ onDevice: true });
        case "/voice/await-speech": {
          await wait(30);
          if (st.interrupt && st.playing) {
            st.interrupt = false;
            st.interrupted++;
            st.stopped = position();
            st.playing = false;
            return send({ speech: true, speaking: false });
          }
          return send({ speech: false, speaking: st.playing });
        }
        case "/voice/listen-local":
        case "/voice/listen": {
          const t = st.listenQ.shift();
          await wait(t === undefined ? 200 : 20);
          return send({ text: t ?? "", missed: t === undefined });
        }
        default: return send({});
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, st, close: () => server.close() };
}

const SCRIPT = [
  `A: {faster}Big week coming up! {source "Athletics carnival: Tuesday"}`,
  `B: {react mm-hmm} Wait, the carnival's on Tuesday? {source "Athletics carnival: Tuesday"}`,
  `A: Yep, Tuesday at the oval. {pause 300} {lower}Bring a hat.`,
  `B: {slower}And reports are due Friday. {source "Reports due Friday 4pm"}`,
].join("\n");
const SOURCE = "Staff Update Week 8.\nAthletics carnival: Tuesday, all staff on duty from 9am at the oval.\nReports due Friday 4pm in Sentral.";

test("podcast: chosen hosts, per-phrase cues, segments; hands-free explain and continue from the saved spot", async () => {
  const ph = await fakePhone();
  const asked = [];
  const m = await fakeModel((body) => {
    const last = JSON.stringify(body.messages.at(-1));
    const all = JSON.stringify(body.messages);
    if (/I paused and asked/.test(last)) {
      asked.push(last);
      return { text: "The carnival's on Tuesday {pause 200} and all staff are on duty from 9." };
    }
    if (/Make this week's audio overview/.test(all) && !/Recording started/.test(last)) return { tool: "audio_overview_record", args: { title: /Week 9/.test(all.slice(-4000)) ? "Week 9 audio overview" : "Week 8 audio overview", script: SCRIPT, staff_update_link: "https://school.example/news/week-8", source_text: SOURCE, resources: [{ name: "Carnival map", url: `${ph.url}/map.pdf` }, { name: "Newsletter", url: `${ph.url}/page.html` }] } };

    return { text: "ok" };
  });
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: ph.url, MAUSDROID_BRIDGE_TOKEN: "x" } });
  try {
    await useModel(e, m.url);
    await e.call("/api/settings/voice", "PUT", { ttsEngine: "ai.gradium.phonon.tts", voiceName: "cosette" });
    await e.call("/api/audio-overviews/settings", "PUT", { voiceFemale: "alba", voiceMale: "marius", saveToDownloads: false });
    // The routine's prompt asks for a real two-host conversation with cues and sources.
    const routine = (await e.call("/api/audio-overviews")).data.routine;
    assert.match(routine.prompt, /follow-up questions/);
    assert.match(routine.prompt, /Vary who leads/);
    assert.match(routine.prompt, /\{source "a short exact quote/);
    assert.match(routine.prompt, /source_text/);
    // A new Staff Update: Maus writes the conversation and records it.
    await e.call("/api/alerts/incoming", "POST", { type: "staff-update", source: "Google Drive", title: "New Staff Update: Week 8", body: "Drive file id: w8", id: "staff-update:w8", notify: false });
    const id = (await e.until(async () => (await e.call("/api/audio-overviews")).data.overviews[0], "recording started", 15000)).id;
    const o = await e.until(async () => (await e.call("/api/audio-overviews")).data.overviews.find((x) => x.id === id && x.status !== "recording"), "recorded", 20000);
    assert.equal(o.status, "ready", o.error);
    // Host A = the female voice, host B = the male voice; clean handoffs.
    const byVoice = (v) => ph.st.synth.filter((s) => s.voice === v).map((s) => s.text);
    assert.ok(byVoice("alba").some((t) => /Big week coming up/.test(t)));
    assert.ok(byVoice("marius").some((t) => /carnival's on Tuesday/.test(t)));
    assert.ok(!byVoice("alba").some((t) => /reports are due/i.test(t)));
    // Cues: per phrase, both directions; reactions recorded with the speaker's voice; never spoken as words.
    assert.equal(ph.st.synth.find((s) => /Big week/.test(s.text)).sonicRate, 1.08);
    assert.equal(ph.st.synth.find((s) => /Bring a hat/.test(s.text)).sonicPitch, 0.95);
    assert.equal(ph.st.synth.find((s) => /reports are due/i.test(s.text)).sonicRate, 0.92);
    assert.equal(ph.st.synth.find((s) => /Yep, Tuesday/.test(s.text)).sonicRate, undefined, "no cue: normal");
    assert.ok(ph.st.synth.some((s) => s.text === "Mm-hmm." && s.voice === "marius"));
    assert.ok(!ph.st.synth.some((s) => /[{}]|source/.test(s.text)));
    // Segments: speaker, timestamps in order, clean text, source quote + jump link.
    const sg = o.segments;
    assert.deepEqual(sg.map((x) => x.host), ["female", "male", "female", "male"]);
    // Natural handoffs (Dia2-style pacing): quicker after a question, a pause at every change of speaker.
    for (let i = 1; i < sg.length; i++) assert.ok(sg[i].startMs - sg[i - 1].endMs >= 140, "a pause at each handoff");
    assert.ok(Math.abs(sg[2].startMs - sg[1].endMs - 220) <= 30, "a quick answer after a question");
    assert.ok(Math.abs(sg[3].startMs - sg[2].endMs - 350) <= 30, "an ordinary handoff");
    // Word timings across each line.
    assert.equal(sg[2].words.map((w) => w.w).join(" "), sg[2].text);
    assert.equal(sg[2].words[0].ms, sg[2].startMs);
    assert.ok(sg[2].words.every((w, i, a) => i === 0 || w.ms > a[i - 1].ms) && sg[2].words.at(-1).ms < sg[2].endMs);
    assert.equal(sg[2].text, "Yep, Tuesday at the oval. Bring a hat.");
    assert.equal(sg[3].source.quote, "Reports due Friday 4pm");
    assert.match(sg[3].source.url, /^https:\/\/school\.example\/news\/week-8#:~:text=Reports%20due%20Friday%204pm$/);
    assert.equal(sg[2].source, undefined);
    assert.equal(o.hasSource, true);
    // Self-check: the episode's first line is recognised offline and compared with the script.
    await e.until(async () => (ph.st.selfChecks ?? []).length > 0, "podcast self-check");
    assert.equal(ph.st.selfChecks[0].startMs, sg[0].startMs);
    assert.equal(ph.st.selfChecks[0].endMs, sg[0].endMs);
    const pc = await e.until(async () => (await e.call("/api/voice/checks")).data.results.find((r) => r.kind === "podcast"), "podcast check recorded");
    assert.equal(pc.clarity, 1);

    // Hands-free: play, then "pause, explain that last bit" while the third line plays.
    ph.st.listenQ.push("Pause, explain that last bit");
    await e.call(`/api/audio-overviews/${id}/listen`, "POST", { fromMs: sg[2].startMs + 1600 });
    await e.until(async () => ph.st.enq.some((q) => q.items.some((i) => i.kind === "audio")), "playing");
    await wait(300);
    ph.st.interrupt = true;
    await e.until(async () => asked.length === 1, "asked to explain", 15000);
    const saved = ph.st.stopped;
    assert.ok(saved >= sg[2].startMs + 1600);
    // It explained from the segment just heard and the source.
    assert.match(asked[0], /Yep, Tuesday at the oval\. Bring a hat\./);
    assert.match(asked[0], /The last words heard before pausing: \\"…[^\\]*\w/, "the exact words heard before the pause");
    assert.match(asked[0], /all staff on duty from 9am/);
    await e.until(async () => ph.st.enq.some((q) => q.items.some((i) => /all staff are on duty/.test(i.text ?? ""))), "answer spoken");
    const ans = ph.st.enq.find((q) => q.items.some((i) => /all staff are on duty/.test(i.text ?? "")));
    assert.ok(ans.items.some((i) => i.kind === "pause"), "the answer's cues are playback items");
    assert.equal((await e.call(`/api/audio-overviews/${id}/listen`)).data.state, "paused");
    // "Continue": resumes from the saved spot.
    ph.st.listenQ.push("Continue");
    await e.until(async () => ph.st.enq.filter((q) => q.items.some((i) => i.kind === "audio")).length === 2, "resumed", 15000);
    const resumed = ph.st.enq.filter((q) => q.items.some((i) => i.kind === "audio"))[1].items[0];
    assert.equal(resumed.startMs, saved);
    // Tapping a transcript line jumps there.
    await e.call(`/api/audio-overviews/${id}/listen`, "POST", { fromMs: sg[1].startMs });
    await e.until(async () => ph.st.enq.filter((q) => q.items.some((i) => i.kind === "audio")).length === 3, "jumped");
    assert.equal(ph.st.enq.filter((q) => q.items.some((i) => i.kind === "audio"))[2].items[0].startMs, sg[1].startMs);
    await e.call(`/api/audio-overviews/${id}/listen/stop`, "POST", {});

    // Sources as PDFs in their own Downloads folder; each quote placed on its page.
    assert.deepEqual(o.pdfs.map((p) => [p.name, p.location, p.kind]), [["Carnival map.pdf", "Download/DanDroid Review Podcast/Carnival map.pdf", "resource"]]);
    assert.match(o.pdfNote, /Newsletter isn't a PDF/, "a web page stays a link");
    assert.equal(sg[0].source.page, 0);
    assert.equal(sg[0].source.pdf, o.pdfs[0].fileId);
    assert.equal(sg[3].source.page, 2);
    const firstUris = o.pdfs.map((p) => p.uri);
    // The next overview: the previous one's PDFs are deleted from the phone.
    await e.call("/api/alerts/incoming", "POST", { type: "staff-update", source: "Google Drive", title: "New Staff Update: Week 9", body: "Drive file id: w9", id: "staff-update:w9", notify: false });
    await e.until(async () => (await e.call("/api/audio-overviews")).data.overviews.some((x) => x.title === "Week 9 audio overview" && x.status === "ready"), "second overview", 20000);
    const after = (await e.call("/api/audio-overviews")).data.overviews;
    assert.deepEqual(ph.st.deleted, firstUris);
    assert.deepEqual(after.find((x) => x.id === id).pdfs, []);
    assert.equal(after.find((x) => x.title === "Week 9 audio overview").pdfs.length, 1, "the new overview keeps its own");
    assert.equal((await e.call(`/api/files/${firstUris.length && o.pdfs[0].fileId}/info`)).status, 404, "the app's own copy is gone too");
  } finally {
    await e.stop();
    m.close();
    ph.close();
  }
});

test("podcast: a Google Doc source is saved as a PDF (exported through Drive) and quotes point at its pages", async () => {
  const { fakeComposio } = await import("./_composio.mjs");
  const ph = await fakePhone();
  const exports = [];
  const c = await fakeComposio({
    accounts: [{ id: "ca_drive", toolkit: "googledrive", alias: "work" }],
    tools: { GOOGLEDRIVE_DOWNLOAD_FILE: ["file_id", "mime_type"] },
    handlers: {
      GOOGLEDRIVE_DOWNLOAD_FILE: (args) => {
        exports.push(args);
        if (args.mime_type !== "application/pdf") throw new Error("expected a PDF export");
        return { file: { s3url: `${ph.url}/map.pdf` } };
      },
    },
  });
  const DOC = "https://docs.google.com/document/d/1StaffUpdateWeek8xxxxxxxxxxx/edit";
  const m = await fakeModel((body) => {
    const all = JSON.stringify(body.messages);
    const last = JSON.stringify(body.messages.at(-1));
    if (/Make this week's audio overview/.test(all) && !/Recording started/.test(last)) return { tool: "audio_overview_record", args: { title: "Week 8 audio overview", script: SCRIPT, staff_update_name: "Week 8 Staff Update", staff_update_link: DOC, source_text: SOURCE } };
    return { text: "ok" };
  });
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: ph.url, MAUSDROID_BRIDGE_TOKEN: "x", MAUSDROID_COMPOSIO_API: c.url } });
  try {
    await useModel(e, m.url);
    await e.call("/api/composio/key", "POST", { key: "ak_test" });
    await e.call("/api/audio-overviews/settings", "PUT", { saveToDownloads: false });
    await e.call("/api/alerts/incoming", "POST", { type: "staff-update", source: "Google Drive", title: "New Staff Update: Week 8", body: "Drive file id: 1StaffUpdateWeek8xxxxxxxxxxx", id: "staff-update:d8", notify: false });
    const o = await e.until(async () => (await e.call("/api/audio-overviews")).data.overviews.find((x) => x.status !== "recording"), "recorded", 20000);
    assert.equal(o.status, "ready", o.error);
    assert.equal(exports[0].file_id, "1StaffUpdateWeek8xxxxxxxxxxx");
    assert.deepEqual(o.pdfs.map((p) => [p.name, p.location, p.kind]), [["Week 8 Staff Update.pdf", "Download/DanDroid Review Podcast/Week 8 Staff Update.pdf", "source"]]);
    const sg = o.segments;
    assert.equal(sg[3].source.page, 2);
    assert.equal(sg[3].source.pdf, o.pdfs[0].fileId);
    assert.equal(sg[3].source.url, undefined, "no web jump for a Google Doc; the PDF is used instead");
    // Tapping the source opens DanDroid's PDF viewer at that page with the quote.
    const r = await e.call(`/api/audio-overviews/${o.id}/source`, "POST", { index: 3 });
    assert.equal(r.status, 200);
    assert.equal(ph.st.opened[0].page, 2);
    assert.equal(ph.st.opened[0].quote, "Reports due Friday 4pm");
    assert.ok(ph.st.opened[0].path.startsWith(e.dir));
  } finally {
    await e.stop();
    m.close();
    c.close();
    ph.close();
  }
});
