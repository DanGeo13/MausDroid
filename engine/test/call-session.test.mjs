// Live calls: greeting by name and time of day, speaking the reply piece by
// piece before the AI has finished, interrupting Maus by talking, listening
// problems shown and spoken instead of silently ignored.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fakeModel, startEngine, useModel, wait } from "./_engine.mjs";
import { load } from "./_load.mjs";

/** A stand-in phone: speech takes 120 ms per piece; listening returns scripted words. */
async function fakePhone() {
  const st = { says: [], heard: [], speakingUntil: 0, interrupt: false, interrupted: 0, listenError: null, stops: 0, callMode: [] };
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", async () => {
      const body = b ? JSON.parse(b) : {};
      const send = (o) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      const speaking = () => Date.now() < st.speakingUntil;
      switch (req.url) {
        case "/secret/encrypt": return send({ cipher: Buffer.from(body.plain).toString("base64") });
        case "/secret/decrypt": return send({ plain: Buffer.from(body.cipher, "base64").toString() });
        case "/voice/say": {
          if (body.flush) st.speakingUntil = 0;
          st.says.push({ text: body.text, at: Date.now(), engine: body.engine, voice: body.voice });
          st.speakingUntil = Math.max(Date.now(), st.speakingUntil) + 120;
          return send({});
        }
        case "/voice/state": return send({ speaking: speaking() });
        case "/voice/await-speech": {
          await wait(Math.min(body.maxMs ?? 250, 40));
          if (st.interrupt && speaking()) {
            st.interrupt = false;
            st.interrupted++;
            st.speakingUntil = 0; // the phone stops talking at once
            return send({ speech: true, speaking: false });
          }
          return send({ speech: false, speaking: speaking() });
        }
        case "/voice/listen": {
          if (st.listenError) return send({ text: "", error: st.listenError, code: 9 });
          const next = st.heard.shift();
          await wait(next === undefined ? 400 : 30);
          return send(next === undefined ? { text: "", missed: true } : { text: next });
        }
        case "/voice/stop": st.stops++; st.speakingUntil = 0; return send({});
        case "/voice/call-mode": st.callMode.push(body.on); return send({});
        default:
          // An app before the phrase player: these don't exist (Android answers 404).
          if (/^\/speech\/|^\/voice\/(local-available|listen-local|hold-listen)$/.test(req.url)) return (res.writeHead(404, { "content-type": "application/json" }), res.end(JSON.stringify({ error: `unknown ${req.url}` })));
          return send({});
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, st, close: () => server.close() };
}

test("live call: greets by name, streams speech early, can be interrupted, ends on bye", async () => {
  const ph = await fakePhone();
  let firstPieceSaidBeforeEnd = null;
  const m = await fakeModel((body) => {
    const last = JSON.stringify(body.messages.at(-1));
    if (!last.includes("phone call with Dan")) return { text: "ok" };
    if (!last.includes("weather"))
      return {
        chunks: ["Your next class", " is at 11, in room 4.", " After that", " you're free until lunch."],
        chunkDelay: 250,
        onChunk: (i) => {
          if (i === 3) firstPieceSaidBeforeEnd = ph.st.says.some((s) => /next class is at 11/.test(s.text));
        },
      };
    // A long answer that gets interrupted after the first piece.
    return { chunks: ["Well, there are lots of things to say about the weather,", " first", " the", " clouds", " and", " then", " the", " rain."], chunkDelay: 400, onChunk: (i) => i === 1 && (ph.st.interrupt = true) };
  });
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: ph.url, MAUSDROID_BRIDGE_TOKEN: "x" } });
  try {
    await useModel(e, m.url);
    await e.call("/api/calls/settings", "PUT", { userName: "Dan" });
    await e.call("/api/settings/voice", "PUT", { ttsEngine: "org.example.kokoro", voiceName: "bf_emma", pitch: 1.1 });
    ph.st.heard.push("What's my next class?", "Tell me about the weather");
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    // Greeting by name for the time of day, in the chosen voice.
    await e.until(async () => ph.st.says.length > 0, "greeting");
    assert.match(ph.st.says[0].text, /Dan/);
    assert.match(ph.st.says[0].text, /morning|afternoon|evening|late|Hey|G'day|Hi/i);
    assert.equal(ph.st.says[0].engine, "org.example.kokoro");
    assert.equal(ph.st.says[0].voice, "bf_emma");
    assert.deepEqual(ph.st.callMode, [true]);

    // The first piece is spoken before the AI has finished its answer.
    await e.until(async () => ph.st.says.some((s) => /until lunch/.test(s.text)), "whole answer spoken", 15000).catch(async (err) => { console.log("SAYS", JSON.stringify(ph.st.says.map((s) => s.text)), JSON.stringify((await e.call(`/api/calls/${c.id}/live`)).data), JSON.stringify((await e.call(`/api/bots/${c.botId}/messages`)).data.map((x) => [x.role, x.status, x.text.slice(0, 80)]))); throw err; });
    assert.equal(firstPieceSaidBeforeEnd, true, "spoke before the reply finished");
    const pieces = ph.st.says.slice(1).map((s) => s.text);
    assert.ok(pieces.length >= 2, `spoken in pieces: ${JSON.stringify(pieces)}`);
    let live = (await e.call(`/api/calls/${c.id}/live`)).data;
    assert.deepEqual(live.lines[1], { who: "you", text: "What's my next class?" });
    assert.match(live.lines[2].text, /room 4.*lunch/);

    // Interrupt: Maus stops at once, drops the rest, and listens.
    await e.until(async () => ph.st.interrupted === 1, "interrupted", 15000);
    ph.st.heard.push("Never mind, bye");
    await e.until(async () => (await e.call(`/api/calls/${c.id}/live`)).data.phase === "ended", "call ended", 15000);
    live = (await e.call(`/api/calls/${c.id}/live`)).data;
    const weather = live.lines.find((l) => /weather/.test(l.text) && l.who === "maus");
    assert.ok(weather?.interrupted, "marked interrupted");
    assert.ok(!ph.st.says.some((s) => /rain/.test(s.text)), "the rest of the answer was dropped");
    assert.match(live.lines.at(-1).text, /Bye Dan/);
    assert.equal(live.interruptions, 1);
    assert.deepEqual(ph.st.callMode, [true, false]);
    assert.equal((await e.call(`/api/calls/${c.id}`)).data.state, "ended");
    const msgs = (await e.call(`/api/bots/${c.botId}/messages`)).data;
    assert.ok(msgs.some((x) => x.role === "assistant" && x.status === "stopped"), "the AI was stopped too");
  } finally {
    await e.stop();
    m.close();
    ph.close();
  }
});

test("live call: a listening problem is shown and spoken, not treated as silence", async () => {
  const ph = await fakePhone();
  const m = await fakeModel(() => ({ text: "ok" }));
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: ph.url, MAUSDROID_BRIDGE_TOKEN: "x" } });
  try {
    await useModel(e, m.url);
    ph.st.listenError = "MausDroid needs microphone permission (Settings → Voice & assistant → Microphone).";
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => (await e.call(`/api/calls/${c.id}/live`)).data.phase === "ended", "ended", 10000);
    const live = (await e.call(`/api/calls/${c.id}/live`)).data;
    assert.match(live.note, /microphone permission/);
    assert.ok(ph.st.says.some((s) => /can't hear you.*microphone permission/.test(s.text)));
  } finally {
    await e.stop();
    m.close();
    ph.close();
  }
});

test("hang up stops speech and ends the call", async () => {
  const ph = await fakePhone();
  const m = await fakeModel(() => ({ text: "ok" }));
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: ph.url, MAUSDROID_BRIDGE_TOKEN: "x" } });
  try {
    await useModel(e, m.url);
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => ph.st.says.length > 0, "greeting");
    await e.call(`/api/calls/${c.id}/end`, "POST", {});
    await e.until(async () => (await e.call(`/api/calls/${c.id}/live`)).data.phase === "ended", "ended", 10000);
    assert.ok(ph.st.stops >= 1);
    assert.equal((await e.call(`/api/calls/${c.id}`)).data.state, "ended");
  } finally {
    await e.stop();
    m.close();
    ph.close();
  }
});

test("greetings and speech pieces", async () => {
  const s = await load("src/call-session.ts");
  const at = (h) => new Date(2026, 10, 25, h, 10);
  assert.match(s.greeting("Dan", at(8), () => 0), /^Morning, Dan!$/);
  assert.match(s.greeting("Dan", at(14), () => 0), /Afternoon, Dan/);
  assert.match(s.greeting("Dan", at(19), () => 0), /Evening, Dan/);
  assert.match(s.greeting("Dan", at(23), () => 0), /up late/);
  // Never the same greeting twice in a row.
  assert.notEqual(s.greeting("Dan", at(8), () => 0), s.greeting("Dan", at(8), () => 0));
  assert.equal(s.greeting("", at(8), () => 0.99).includes("undefined"), false);
  assert.match(s.shortGreeting("Dan", at(9), () => 0), /^Morning, Dan$/);

  const c = new s.SpeechChunker();
  // The first piece comes early, at a comma.
  assert.deepEqual(c.push("Sure thing, your next class"), ["Sure thing, your next class"].filter(() => false));
  assert.deepEqual(c.push(" is at 11, "), ["Sure thing, your next class is at 11,"]);
  assert.deepEqual(c.push("in room 4. After"), ["in room 4."]);
  assert.deepEqual(c.push(" that, nothing"), [], "only the first piece is cut at commas");
  assert.equal(c.flush(), "After that, nothing");
  const d = new s.SpeechChunker();
  assert.deepEqual(d.push("It costs $3.50 today. "), ["It costs $3.50 today."], "decimals aren't sentence ends");
  const long = new s.SpeechChunker();
  long.push("word ".repeat(10));
  const out = long.push("word ".repeat(30));
  assert.ok(out.length >= 1 && out[0].length <= 160);

  const cli = await load("src/providers/cli.ts");
  const ev = cli.parseCliLine("claude", JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } }), { text: "" });
  assert.deepEqual(ev, [{ kind: "delta", text: "Hel" }]);
  assert.ok(cli.cliArgs({ engine: "claude", prompt: "x", systemPrompt: "s", mcpUrl: "u", mcpToken: "t" }).includes("--include-partial-messages"));
});

test("goodbyes", async () => {
  const s = await load("src/call-session.ts");
  for (const t of ["bye", "Okay, bye!", "Never mind, bye", "See you", "Thanks, talk later", "hang up"]) assert.ok(s.isGoodbye(t), t);
  for (const t of ["Say bye to Tom for me when you message him later today", "What's the weather", "byes are hard"]) assert.ok(!s.isGoodbye(t), t);
});
