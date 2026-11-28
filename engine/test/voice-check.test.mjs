// Voice self-checks: MausDroid speaks test sentences silently, the phone's
// on-device recognizer listens (stand-in here), and clarity and speed are
// scored against the person's success criteria. Improver sees the results
// each night and can suggest a voice fix, applied only when approved.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { load } from "./_load.mjs";
import { fakeModel, startEngine, useModel, wait } from "./_engine.mjs";

test("scoring: word error rate, normalising, judging against criteria", async () => {
  const v = await load("src/voice-check.ts");
  assert.equal(v.wordErrorRate("Your next class is at 11:15 in room 4.", "your next class is at eleven 15 in room four"), 0);
  assert.equal(v.wordErrorRate("It's at room four", "its at room 4"), 0);
  assert.ok(Math.abs(v.wordErrorRate("one two three four", "one too three") - 0.5) < 1e-9);
  assert.equal(v.wordErrorRate("", ""), 0);
  const c = v.DEFAULT_CRITERIA;
  assert.deepEqual(v.judge({ clarity: 0.97, wps: 2.6 }, c), []);
  assert.match(v.judge({ clarity: 0.6, wps: 4.5 }, c).join(" "), /clarity 60%.*too fast: 4\.5/);
  assert.match(v.judge({ firstAudioMs: 1200, interruptMs: 300 }, c).join(" "), /first audio 1200 ms.*interruption 300 ms/);
  assert.deepEqual(v.missedWords("How did Odette's show go, Dan?", "how did a death eo show go done"), ["Odette", "Dan"]);
});

async function fakePhone() {
  const st = { checks: [], voices: [{ name: "pt_voice", locale: "pt-BR" }, { name: "en_good", locale: "en-GB" }, { name: "en_fast", locale: "en-US" }, { name: "en_online", locale: "en-AU", network: true }] };
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", async () => {
      const body = b ? JSON.parse(b) : {};
      const send = (o) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      if (req.url === "/secret/encrypt") return send({ cipher: Buffer.from(body.plain).toString("base64") });
      if (req.url === "/secret/decrypt") return send({ plain: Buffer.from(body.cipher, "base64").toString() });
      if (req.url === "/voice/voices") return send({ voices: st.voices });
      if (req.url === "/voice/self-check") {
        st.checks.push(body);
        const text = body.text ?? st.recording ?? "";
        const words = text.split(/\s+/).filter(Boolean).length;
        // pt_voice reads English with Portuguese sounds; en_fast is too quick; speed scales with rate.
        let heard = body.voice === "pt_voice" ? "ayo is your way keep all that tms says" : text;
        if (st.mishear) heard = heard.replace(new RegExp(st.mishear, "gi"), "a death");
        const wps = (body.voice === "en_fast" ? 4.4 : 2.6) * (body.rate ?? 1);
        return send({ heard, speechMs: Math.round((words / wps) * 1000), audioMs: 0 });
      }
      send({});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, st, close: () => server.close() };
}

test("self-check, audition, Improver suggests a voice fix that applies only when approved", async () => {
  const ph = await fakePhone();
  let step = 0;
  let evidence = "";
  const m = await fakeModel(async (body) => {
    const sys = JSON.stringify(body.messages?.[0] ?? "");
    const last = body.messages?.at(-1);
    if (!/self-improvement bot/.test(sys)) return { text: "ok" };
    if (last?.role === "tool" && /voiceQuality/.test(JSON.stringify(last))) evidence = JSON.stringify(last);
    if (last?.role !== "tool" && step > 0) step = 0;
    step++;
    if (step === 1) return { tool: "improve_evidence", args: {} };
    if (step === 2) return { tool: "voice_audition", args: {} };
    if (step === 3) return { tool: "improve_propose", args: { suggestions: [{ title: "Switch to a clearer English voice", problem: "Clarity 20%: English read with Portuguese sounds.", change: "Use en_good.", area: "voice", risk: "low", voice_patch: { voice: "en_good" } }] } };
    if (step === 4) return { tool: "improve_finish", args: { summary: "One voice fix." } };
    return { text: "Done." };
  });
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: ph.url, MAUSDROID_BRIDGE_TOKEN: "x" } });
  try {
    await useModel(e, m.url);
    await e.call("/api/settings/voice", "PUT", { ttsEngine: "io.github.vrivrixd.phonon", voiceName: "pt_voice", rate: 1 });
    // Criteria are saved (a percentage is understood).
    const crit = (await e.call("/api/voice/criteria", "PUT", { clarity: 90, maxWps: 3.2 })).data;
    assert.equal(crit.clarity, 0.9);
    assert.equal(crit.maxWps, 3.2);
    await e.call("/api/voice/criteria", "PUT", { clarity: 0.95, maxWps: 3.0 });
    // Check now: the Portuguese-sounding voice fails clarity, silently tested with the current settings.
    const bad = (await e.call("/api/voice/check", "POST", {})).data;
    assert.equal(bad.pass, false);
    assert.ok(bad.clarity < 0.5);
    assert.match(bad.problems.join(" "), /clarity/);
    assert.equal(ph.st.checks.at(-1).engine, "io.github.vrivrixd.phonon");
    assert.equal(ph.st.checks.at(-1).voice, "pt_voice");
    // Audition: English offline voices (plus the current one), best first; nothing changed.
    const ranked = (await e.call("/api/voice/audition", "POST", {})).data;
    assert.equal(ranked[0].voice, "en_good");
    assert.equal(ranked[0].pass, true);
    assert.ok(!ranked.some((r) => r.voice === "en_online"), "voices that need internet are skipped");
    assert.equal(ranked.at(-1).voice, "pt_voice");
    assert.equal((await e.call("/api/settings")).data.voice.voiceName, "pt_voice", "audition changes nothing");
    // Too fast: the audition also tries a slower speed for it.
    const summary = (await e.call("/api/voice/checks")).data;
    assert.ok(summary.results.length >= 4);
    assert.ok(summary.summary.checks >= 4);
    // Improver's night: sees voiceQuality, auditions, suggests a voice fix.
    const imp = (await e.call("/api/state")).data.bots.find((b) => b.name === "Improver");
    await e.call(`/api/bots/${imp.id}`, "PATCH", { providerId: "local", model: "fake", approvalMode: "auto" });
    const routine = (await e.call("/api/routines")).data.find((r) => r.system === "self-improve");
    await e.call(`/api/routines/${routine.id}/run`, "POST", {});
    await e.until(async () => (await e.call(`/api/routines/${routine.id}/runs`)).data.find((x) => ["succeeded", "failed"].includes(x.status)), "night run", 30000);
    assert.match(evidence, /voiceQuality/);
    assert.match(evidence, /clarity/);
    await e.call("/api/improve/reveal", "POST");
    const card = (await e.call("/api/improve")).data.shown.find((p) => p.area === "voice");
    assert.ok(card, "a voice card");
    assert.equal(card.voicePatch.after.voice, "en_good");
    assert.equal((await e.call("/api/settings")).data.voice.voiceName, "pt_voice", "nothing changes until approved");
    const done = (await e.call(`/api/improve/${card.id}/approve`, "POST")).data;
    assert.equal(done.status, "applied");
    assert.equal((await e.call("/api/settings")).data.voice.voiceName, "en_good");
    // Now it passes.
    assert.equal((await e.call("/api/voice/check", "POST", {})).data.pass, true);
    // A name it keeps mishearing shows up for Improver as a pronunciation candidate.
    ph.st.mishear = "Odette";
    for (let k = 0; k < 2; k++) await e.call("/api/voice/check", "POST", { text: "How did Odette's show go?" });
    const sum = (await e.call("/api/voice/checks")).data.summary;
    assert.deepEqual(sum.oftenMisheard[0], { word: "Odette", times: 2 });
  } finally {
    await e.stop();
    m.close();
    ph.close();
  }
});
