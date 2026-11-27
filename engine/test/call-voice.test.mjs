// Live calls with the phrase player (Phonon through the phone's voice engine):
// delivery cues as playback metadata, the beat before answering, waiting
// out an unfinished thought, hands-free interruption with a microphone
// pre-roll, and "hold on a sec" with per-bot resume by name (side talk
// never reaches the transcript or any AI).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { fakeModel, startEngine, useModel, wait } from "./_engine.mjs";
import { load } from "./_load.mjs";

test("cues, turn-end, beat, hold and wake words", async () => {
  const s = await load("src/speech-style.ts");
  // Cues become playback items; the spoken words and transcript never contain them.
  assert.deepEqual(s.planPhrase("{faster}Right, let's go. {pause 400}{react mm-hmm} {lower}Then the rest."), [
    { kind: "speech", text: "Right, let's go.", rate: 1.08 },
    { kind: "pause", ms: 400 },
    { kind: "clip", name: "mm-hmm" },
    { kind: "speech", text: "Then the rest.", rate: 1.08, pitch: 0.95 },
  ]);
  assert.deepEqual(s.planPhrase("{slower}{higher}Careful now."), [{ kind: "speech", text: "Careful now.", rate: 0.92, pitch: 1.05 }]);
  assert.deepEqual(s.planPhrase("{rate 9}{pitch 0.1}Clamped."), [{ kind: "speech", text: "Clamped.", rate: 1.25, pitch: 0.85 }]);
  // Each phrase starts normal again.
  assert.deepEqual(s.planPhrase("Plain phrase."), [{ kind: "speech", text: "Plain phrase." }]);
  // Broken or unknown cues: normal speech, cue text never spoken.
  assert.deepEqual(s.planPhrase("{shout}Hello {pause abc}there {react giggle}friend."), [{ kind: "speech", text: "Hello there friend." }]);
  assert.equal(s.stripCues("It's at 3:15 {pause 300} in room 4. {faster}Bring the form"), "It's at 3:15 in room 4. Bring the form");
  assert.equal(s.stripCues("Half a cue {pau"), "Half a cue");
  // Expressive sounds, Sophon-style: {laugh} {chuckle} {sigh} {breath}, and tags other models write.
  assert.deepEqual(s.planPhrase("That's brilliant {laugh} honestly."), [{ kind: "speech", text: "That's brilliant" }, { kind: "clip", name: "laugh" }, { kind: "speech", text: "honestly." }]);
  assert.deepEqual(s.planPhrase("{sigh}Okay, the bad news."), [{ kind: "clip", name: "sigh" }, { kind: "speech", text: "Okay, the bad news." }]);
  assert.deepEqual(s.planPhrase("Well [laughs] that's one way. <sigh> *chuckles*").map((i) => i.kind === "clip" ? i.name : i.kind), ["speech", "laugh", "speech", "sigh", "chuckle"]);
  assert.equal(s.stripCues("Well [laughs] that's one way. {breath}"), "Well that's one way.");
  // Turn-end.
  for (const t of ["The other thing is…", "and then I went to the", "So I was thinking, um", "I need you to,"]) assert.equal(s.turnFinished(t), false, t);
  for (const t of ["What's my next class?", "Book it for Friday.", "Thanks", "no"]) assert.equal(s.turnFinished(t), true, t);
  // The beat: quick for a quick exchange, more room when reflective.
  assert.ok(s.beatMs("yes") >= 200 && s.beatMs("yes") <= 250);
  assert.ok(s.beatMs("what time is it?") >= 200 && s.beatMs("what time is it?") <= 350);
  assert.ok(s.beatMs("why do you think I should change jobs?") > 350);
  // Hold requests.
  for (const t of ["Hold on a sec", "hang on", "Wait a second please", "one moment", "hold on, Maus", "give me a minute"]) assert.ok(s.isHoldRequest(t), t);
  for (const t of ["hold on to the tickets for me", "wait until Friday to book it", "I can't wait for the holidays"]) assert.ok(!s.isHoldRequest(t), t);
  // Wake by the held bot's own name only.
  assert.deepEqual(s.wakeFrom("Maus", "Maus"), { action: "wake" });
  assert.deepEqual(s.wakeFrom("Maus, continue", "Maus"), { action: "continue" });
  assert.deepEqual(s.wakeFrom("hey maus carry on", "Maus"), { action: "continue" });
  assert.deepEqual(s.wakeFrom("Maus, what's on tomorrow?", "Maus"), { action: "ask", question: "what's on tomorrow?" });
  assert.equal(s.wakeFrom("Researcher, continue", "Maus"), null);
  assert.equal(s.wakeFrom("I told Maus about it", "Maus"), null);
  assert.equal(s.wakeFrom("Mausoleum tour", "Maus"), null);
  const cs = await load("src/call-session.ts");
  const ph = [{ seq: 0, text: "First sentence." }, { seq: 1, text: "Then a longer one," }, { seq: 2, text: "which keeps going" }, { seq: 3, text: "to here." }];
  assert.equal(cs.sentenceStart(ph, 2), 1, "continue starts the interrupted sentence again");
  assert.equal(cs.sentenceStart(ph, 0), 0);
  assert.equal(cs.sentenceStart(ph, 3), 1);
});

/** A stand-in phone with the phrase player: 150 ms per item, scripted listening. */
async function newPhone() {
  const st = { enq: [], heard: [], holdHeard: [], listens: [], stops: 0, speakingUntil: 0, current: null, interruptAt: null, interrupted: 0, sayCalls: 0 };
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
        case "/speech/enqueue": {
          // The first request of a burst can be slow to arrive (a busy phone): order must still hold.
          if (st.slowFirst && !st.slowDone && body.turn?.startsWith("callturn")) { st.slowDone = true; await wait(150); }
          if (body.flush) st.speakingUntil = 0;
          st.enq.push({ ...body, at: Date.now() });
          st.speakingUntil = Math.max(Date.now(), st.speakingUntil) + 150 * body.items.length;
          const last = body.items.at(-1);
          st.current = body.turn ? { turn: body.turn, seq: last?.seq ?? 0 } : null;
          return send({ queued: body.items.length });
        }
        case "/speech/stop": { st.stops++; const was = speaking() ? st.current : st.lastStopped ?? null; st.speakingUntil = 0; if (was) st.lastStopped = was; return send({ stopped: st.lastStopped ?? null, fraction: st.fraction ?? 1 }); }
        case "/speech/clear-stopped": st.lastStopped = null; return send({});
        case "/speech/state": return send({ speaking: speaking(), current: speaking() ? st.current : null, lastStopped: st.lastStopped ?? null, firstAudioMs: 140 });
        case "/speech/warm": return send({});
        case "/voice/say": st.sayCalls++; return send({});
        case "/voice/speak": (st.plainSpeak ??= []).push(body); return send({});
        case "/voice/state": return send({ speaking: speaking() });
        case "/voice/local-available": return send({ onDevice: !st.noLocal });
        case "/voice/await-speech": {
          await wait(30);
          if (st.interruptAt && st.interruptAt() && speaking()) {
            st.interruptAt = null;
            st.interrupted++;
            st.lastStopped = st.current; // the phone stops at once and remembers where
            st.speakingUntil = 0;
            return send({ speech: true, speaking: false });
          }
          return send({ speech: false, speaking: speaking() });
        }
        case "/voice/listen":
        case "/voice/listen-local": {
          const next = st.heard.shift();
          st.listens.push({ route: req.url, preroll: body.prerollMs ?? 0, text: next, service: body.service });
          await wait(next === undefined ? 300 : 20);
          return send(next === undefined ? { text: "", missed: true } : { text: next });
        }
        case "/voice/hold-listen": {
          // Like the phone: on-device only, and only words containing the held bot's name come back.
          await wait(20);
          const next = st.holdHeard.shift();
          if (next === undefined) { await wait(200); return send({ text: "" }); }
          return send({ text: new RegExp(`(^|\\W)${body.name}(\\W|$)`, "i").test(next) ? next : "" });
        }
        default: return send({});
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, st, close: () => server.close() };
}

async function callWith(script, env = {}) {
  const ph = await newPhone();
  const asked = [];
  const m = await fakeModel((body) => {
    const last = JSON.stringify(body.messages.at(-1));
    if (!last.includes("phone call with Dan")) return { text: "ok" };
    asked.push(last);
    return script(last, ph);
  });
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: ph.url, MAUSDROID_BRIDGE_TOKEN: "x", ...env } });
  await useModel(e, m.url);
  await e.call("/api/calls/settings", "PUT", { userName: "Dan" });
  await e.call("/api/settings/voice", "PUT", { ttsEngine: "ai.gradium.phonon.tts", voiceName: "alba", pitch: 1 });
  const done = async () => {
    if (process.env.DEBUG_CALL) {
      const calls = (await e.call("/api/calls")).data;
      const lv = (await e.call("/api/calls")).data;
      console.log("CALLS", JSON.stringify(lv).slice(0, 600));
      console.log("LISTENS", JSON.stringify(ph.st.listens), "\nENQ", JSON.stringify(ph.st.enq.map((q) => [q.turn, q.flush, q.items.map((i) => i.text ?? i.kind)])), "\nINTERRUPTED", ph.st.interrupted, "\nASKED", asked.length, "\nLOG", e.log().slice(-1500));
    }
    await e.stop();
    m.close();
    ph.close();
  };
  return { ph, m, e, asked, done };
}

const live = async (e, id) => (await e.call(`/api/calls/${id}/live`)).data;

test("call: cues are playback-only, beat before speaking, unfinished thoughts wait", async () => {
  const { ph, e, asked, done } = await callWith((last) => {
    if (last.includes("other thing")) return { chunks: ["{faster}Sure thing.", " {pause 300}It's at 3:15", " in room 4.", " {react mm-hmm}"], chunkDelay: 60 };
    return { text: "ok" };
  });
  try {
    ph.st.heard.push("I need the room, and the other thing is…", "when does the exam start?");
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => ph.st.enq.some((q) => q.turn?.startsWith("callturn") && q.items.some((i) => i.kind === "clip")), "reply queued", 15000);
    // While they paused mid-thought (a long one), a soft "mm-hmm", as a listener would.
    assert.ok(ph.st.enq.some((q) => q.turn === "nod" && q.items[0].name === "mm-hmm"));
    const l = await live(e, c.id);
    // The trailing thought was waited for and joined.
    const mine = l.lines.filter((x) => x.who === "you").map((x) => x.text);
    assert.deepEqual(mine, ["I need the room, and the other thing is… when does the exam start?"]);
    assert.equal(asked.length, 1, "one request to the AI, after the thought was finished");
    // Transcript has no cues; the phone got them as items.
    const said = l.lines.filter((x) => x.who === "maus").at(-1).text;
    assert.equal(said, "Sure thing. It's at 3:15 in room 4.");
    const turnItems = ph.st.enq.filter((q) => q.turn?.startsWith("callturn")).flatMap((q) => q.items);
    assert.deepEqual(turnItems.map((i) => i.kind), ["pause", "speech", "pause", "speech", "clip"]);
    assert.equal(turnItems[3].text, "It's at 3:15 in room 4.");
    assert.equal(turnItems[3].rate, undefined, "next phrase back to normal speed");
    assert.equal(turnItems[1].rate, 1.08);
    assert.equal(turnItems[1].text, "Sure thing.");
    assert.ok(!turnItems.some((i) => i.kind === "speech" && /[{}]/.test(i.text)));
    // The beat: a short silence in front of the first phrase (prepared meanwhile), within the expected range.
    assert.ok(turnItems[0].ms > 0 && turnItems[0].ms <= 400, `beat ${turnItems[0].ms} ms`);
    // The voice chosen in Settings (Phonon) is used.
    assert.equal(ph.st.enq.at(-1).engine, "ai.gradium.phonon.tts");
    assert.equal(ph.st.sayCalls, 0, "everything goes through the phrase player");
    // Spoken-style rules and cue guide went to the AI with the turn.
    assert.match(asked[0], /natural contractions/);
    assert.match(asked[0], /pause 300/);
  } finally {
    await done();
  }
});

test("call: talking over Maus stops it, keeps your first word, drops the stale reply", async () => {
  const { ph, e, asked, done } = await callWith((last, p) => {
    if (last.includes("book Friday")) return { text: "Fine, Friday then." };
    if (last.includes("weather")) return { chunks: ["Well, the weather is a long story.", " First the clouds.", " Then the wind.", " Then the rain.", " Then more."], chunkDelay: 250, onChunk: (i) => i === 1 && (p.st.interruptAt = () => true) };
    return { text: "Fine, Friday then." };
  });
  try {
    ph.st.heard.push("Tell me about the weather", "Actually, book Friday.");
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => (await live(e, c.id)).lines.some((x) => x.who === "maus" && /Friday then/.test(x.text)), "answered the new request", 15000);
    assert.equal(ph.st.interrupted, 1);
    const after = ph.st.listens.find((x) => x.text === "Actually, book Friday.");
    assert.equal(after.route, "/voice/listen-local", "on-device listening right after the interruption");
    assert.equal(ph.st.listens[0].route, "/voice/listen-local", "every turn listens on the phone itself when it can (no default speech app, no beeps)");
    assert.equal(after.preroll, 500, "with half a second of pre-roll so the first word is kept");
    // The rest of the weather answer never reached the phone after the interruption.
    const weatherTurn = ph.st.enq.find((q) => q.items.some((i) => /weather is a long story/.test(i.text ?? ""))).turn;
    const lastWeather = ph.st.enq.filter((q) => q.turn === weatherTurn).at(-1).at;
    const reqAt = Date.now();
    assert.ok(!ph.st.enq.some((q) => q.turn === weatherTurn && q.items.some((i) => /Then more/.test(i.text ?? ""))), "stale chunks dropped");
    assert.ok(lastWeather < reqAt);
    assert.ok(ph.st.stops >= 1, "queued audio cleared");
    const l = await live(e, c.id);
    assert.ok(l.lines.find((x) => /weather is a long story/.test(x.text)).interrupted);
    assert.equal(asked.length, 2);
    // Playback-aware: the AI was told what was actually heard, and what wasn't.
    assert.match(asked[1], /They heard: \\"Well, the weather is a long story\./);
    assert.doesNotMatch(asked[1], /They heard: \\"[^\\]*Then more/, "only what was really heard");
  } finally {
    await done();
  }
});

test("call: hold on, side talk stays private, another bot's name doesn't wake it, its name + continue resumes the sentence", async () => {
  const { ph, e, asked, done } = await callWith((last, p) => {
    // Interrupted while the Tuesday sentence (phrase 1) is playing.
    if (last.includes("timetable")) return { chunks: ["Monday is maths.", " Tuesday is a long day,", " with science first", " and then sport.", " Wednesday is short.", " Thursday is sport."], chunkDelay: 200, onChunk: (i) => i === 1 && (p.st.interruptAt = () => p.st.current?.seq === 1) };
    return { text: "ok" };
  });
  try {
    const bots = (await e.call("/api/state")).data.bots;
    assert.ok(bots.length >= 2, "two bots configured");
    ph.st.heard.push("Read me my timetable", "hold on a sec");
    // While on hold: side talk, the other bot's name, then Maus + continue.
    ph.st.holdHeard.push("Yeah I'll be there in five, tell Mum", "Researcher, continue", "", "Maus, continue");
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => (await live(e, c.id)).phase === "on-hold", "on hold", 15000);
    const askedOnHold = asked.length;
    await e.until(async () => ph.st.enq.some((q) => q.flush && q.items.some((i) => /Tuesday is a long day/.test(i.text ?? "")) && q.turn?.startsWith("callturn")), "resumed", 15000);
    const resumed = ph.st.enq.find((q) => q.flush && q.turn?.startsWith("callturn") && q.items.some((i) => /Tuesday/.test(i.text ?? "")));
    // From the start of the interrupted sentence ("Tuesday is a long day, with science first…"), not "Monday".
    assert.equal(resumed.items[0].text, "Tuesday is a long day, with science first and then sport.");
    assert.ok(!resumed.items.some((i) => /Monday/.test(i.text ?? "")));
    const l = await live(e, c.id);
    const text = JSON.stringify(l.lines);
    assert.ok(!/tell Mum/.test(text), "side talk never in the transcript");
    assert.ok(!/Researcher, continue/.test(text), "another bot's name stays on hold, not shown");
    assert.ok(/Maus, continue/.test(text));
    assert.equal(asked.length, askedOnHold, "nothing sent to the AI while on hold or to resume");
    assert.ok(!asked.some((a) => /tell Mum/.test(a)));
  } finally {
    await done();
  }
});

test("call: on hold, the bot's name + a new question starts a new turn and drops the old reply", async () => {
  const { ph, e, asked, done } = await callWith((last, p) => {
    if (last.includes("timetable")) return { chunks: ["Monday is maths.", " Tuesday is science.", " Wednesday is art.", " Thursday is sport."], chunkDelay: 250, onChunk: (i) => i === 1 && (p.st.interruptAt = () => true) };
    if (last.includes("lunch")) return { text: "Lunch is at 12:40." };
    return { text: "ok" };
  });
  try {
    ph.st.heard.push("Read me my timetable", "hang on");
    ph.st.holdHeard.push("Maus, when is lunch?");
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => (await live(e, c.id)).lines.some((x) => /12:40/.test(x.text)), "new answer", 15000);
    assert.ok(asked.at(-1).includes("when is lunch?"));
    assert.ok(!ph.st.enq.some((q) => q.items.some((i) => /Thursday is sport/.test(i.text ?? ""))), "the rest of the old reply was dropped");
  } finally {
    await done();
  }
});

test("call: the name alone wakes it; then 'continue' resumes", async () => {
  const { ph, e, asked, done } = await callWith((last, p) => {
    if (last.includes("timetable")) return { chunks: ["Monday is maths.", " Tuesday is science.", " Wednesday is art."], chunkDelay: 250, onChunk: (i) => i === 1 && (p.st.interruptAt = () => true) };
    return { text: "ok" };
  });
  try {
    ph.st.heard.push("Read me my timetable", "one moment please", "continue");
    ph.st.holdHeard.push("Maus");
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => ph.st.enq.some((q) => q.flush && q.turn?.startsWith("callturn") && q.items.some((i) => /Tuesday is science/.test(i.text ?? ""))), "resumed after wake", 15000);
    assert.ok((await live(e, c.id)).lines.some((x) => x.who === "maus" && x.text === "Yes?"));
    assert.equal(asked.length, 1, "no new AI request for continue");
  } finally {
    await done();
  }
});

test("settings: natural speech switches; read-aloud and voice chats use the phrase player; instructions stay out of the chat", async () => {
  const { ph, e, m, done } = await callWith(() => ({ text: "ok" }));
  try {
    const st0 = (await e.call("/api/settings")).data;
    assert.equal(st0.voice.speech, undefined, "defaults: everything on");
    // Read aloud (Test voice / replies): phrases with cues through the player, in the chosen engine.
    await e.call("/api/voice/speak", "POST", { text: "Hi! {pause 250}This is how your bots sound now. {react mm-hmm}" });
    const q = ph.st.enq.at(-1);
    assert.deepEqual(q.items.map((i) => i.kind), ["speech", "pause", "speech", "clip"]);
    assert.equal(q.engine, "ai.gradium.phonon.tts");
    assert.ok(!q.items.some((i) => /[{}]/.test(i.text ?? "")));
    // Compare voices: the sample plays in the chosen engine, with expressive sounds.
    await e.call("/api/voice/sample", "POST", { engine: "org.example.kokoro" });
    const sample = ph.st.enq.at(-1);
    assert.equal(sample.engine, "org.example.kokoro");
    assert.ok(sample.items.some((i) => i.kind === "clip" && i.name === "chuckle"));
    // Listening sounds off: no clip.
    await e.call("/api/settings/voice", "PUT", { speech: { reactions: false } });
    await e.call("/api/voice/speak", "POST", { text: "Sure. {react mm-hmm}" });
    assert.ok(!ph.st.enq.at(-1).items.some((i) => i.kind === "clip"));
    // Natural delivery off: the plain voice as before, cues never spoken.
    await e.call("/api/settings/voice", "PUT", { speech: { natural: false } });
    const before = ph.st.enq.length;
    await e.call("/api/voice/speak", "POST", { text: "Plain {pause 300}speech." });
    assert.equal(ph.st.enq.length, before);
    assert.equal(ph.st.plainSpeak.at(-1).text, "Plain speech.");
    const saved = (await e.call("/api/settings")).data.voice.speech;
    assert.equal(saved.natural, false);
    assert.equal(saved.reactions, false);
    await e.call("/api/settings/voice", "PUT", { speech: { natural: true, reactions: true, beat: "quick" } });
    assert.equal((await e.call("/api/settings")).data.voice.speech.beat, "quick");
    // A voice chat: the spoken-style guidance goes to the AI, not into your chat bubble.
    const maus = (await e.call("/api/state")).data.bots.find((b) => b.name === "Maus");
    await e.call(`/api/bots/${maus.id}/voice`, "POST", { text: "what's on today" });
    const msgs = (await e.call(`/api/bots/${maus.id}/messages`)).data;
    const mine = msgs.filter((m) => m.role === "user").at(-1);
    assert.equal(mine.text, "what's on today", "nothing extra shown in the chat");
    const sent = await e.until(async () => m.seen.find((b) => JSON.stringify(b.messages.at(-1)).includes("what's on today")), "sent to the AI");
    assert.match(JSON.stringify(sent.messages.at(-1)), /natural contractions/, "the AI gets the spoken-style guidance");
  } finally {
    await done();
  }
});

test("call: with voice hold off, 'hold on' is just a question", async () => {
  const { ph, e, asked, done } = await callWith((last) => (last.includes("hold on") ? { text: "Sure, I'm here." } : { text: "ok" }));
  try {
    await e.call("/api/settings/voice", "PUT", { speech: { holdByVoice: false }, recognizer: "com.google.android.googlequicksearchbox/com.google.android.voicesearch.serviceapi.GoogleRecognitionService" });
    ph.st.noLocal = true; // a phone without on-device recognition
    ph.st.heard.push("hold on a sec");
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => asked.length === 1, "asked the AI", 15000);
    assert.notEqual((await live(e, c.id)).phase, "on-hold");
    // The speech service chosen in Settings is the one asked to listen (not the phone's default, e.g. Grok).
    assert.equal(ph.st.listens[0].route, "/voice/listen");
    assert.match(ph.st.listens[0].service, /^com\.google\.android\.googlequicksearchbox\//);
  } finally {
    await done();
  }
});

test("methodology: interruption intent, what was heard, patience, corrections, early start", async () => {
  const s = await load("src/speech-style.ts");
  for (const t of ["yeah", "Mm-hmm.", "uh huh", "go on", "right, okay", "yep yep"]) assert.equal(s.interruptionKind(t), "backchannel", t);
  for (const t of ["Wait, wait, wait.", "stop", "no no", "hang on"]) assert.equal(s.interruptionKind(t), "yield", t);
  for (const t of ["cancel that", "Never mind.", "forget it"]) assert.equal(s.interruptionKind(t), "cancel", t);
  for (const t of ["Under $300, please", "Actually, no, make it Friday."]) assert.equal(s.interruptionKind(t), "content", t);
  assert.ok(!s.isHoldRequest("Wait, wait, wait."), "wait wait means stop and listen, not hold");
  assert.ok(s.isHoldRequest("hang on a sec"));
  assert.equal(s.turnFinished("Actually, no, make it Friday."), true);
  assert.equal(s.turnFinished("Can you organise my"), false);
  assert.equal(s.turnFinished("I was thinking, umm..."), false);
  const ph = [{ seq: 0, text: "The best card is the 4070." }, { seq: 1, text: "It costs about eight hundred dollars and runs cool." }];
  assert.deepEqual(s.heardText(ph, { seq: 1, fraction: 0.5 }), { heard: "The best card is the 4070. It costs about eight hundred", unheard: "dollars and runs cool." });
  assert.deepEqual([s.silenceFor("quick"), s.silenceFor("normal"), s.silenceFor("relaxed")], [450, 700, 1000]);
  assert.equal(s.toolWords("composio__GOOGLECALENDAR_EVENTS_LIST"), "checking your calendar");
  const c = new s.SpeechChunker();
  assert.deepEqual(c.push("So the main thing to remember about"), []);
  // The first words before any punctuation; the last word waits until it's complete (more letters may follow).
  assert.equal(c.early(), "So the main thing to remember");
});

test("call: 'yeah' while it talks carries on (no new AI request); 'wait, wait' stops and listens", async () => {
  const { ph, e, asked, done } = await callWith((last, p) => {
    if (last.includes("timetable")) return { chunks: ["Monday is maths.", " Tuesday is science.", " Wednesday is art.", " Thursday is sport."], chunkDelay: 220, onChunk: (i) => i === 1 && (p.st.interruptAt = () => p.st.current?.seq === 1) };
    if (last.includes("Friday")) return { text: "Friday is a free day." };
    return { text: "ok" };
  });
  try {
    ph.st.heard.push("Read me my timetable", "yeah");
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => ph.st.enq.some((q) => q.flush && q.turn?.startsWith("callturn") && q.items.some((i) => /Tuesday is science/.test(i.text ?? ""))), "carried on after 'yeah'", 15000);
    assert.equal(asked.length, 1, "a backchannel isn't a new request");
    assert.ok(!(await live(e, c.id)).lines.some((x) => x.who === "you" && x.text === "yeah"), "not added as a request");
    // "Wait, wait, wait": stop and listen (no hold, no AI); what they say next gets the context.
    ph.st.interruptAt = () => true;
    ph.st.heard.push("Wait, wait, wait.", "What about Friday?");
    await e.until(async () => asked.length === 2, "next request", 15000);
    assert.notEqual((await live(e, c.id)).phase, "on-hold");
    assert.match(asked[1], /What about Friday\?/);
    assert.match(asked[1], /You were interrupted mid-reply/);
  } finally {
    await done();
  }
});

test("call: a slow job says 'let me check', keeps working when you talk, gives progress, and 'cancel that' stops it", async () => {
  const { ph, e, asked, done } = await callWith((last) => {
    if (last.includes("monitor")) return { text: "The best monitor is the Dell.", delay: 6000 };
    if (last.includes("GPU")) return { text: "The best one under $300 is the 4060.", delay: 4500 };
    if (last.includes("$300")) return { text: "Got it, under $300." };
    return { text: "ok" };
  }, { MAUSDROID_CALL_PROGRESS_MS: "1500" });
  try {
    ph.st.heard.push("Find me a good GPU");
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => (await live(e, c.id)).lines.some((x) => x.who === "maus" && /check|look|On it/i.test(x.text)), "acknowledged quickly", 8000);
    await e.until(async () => (await live(e, c.id)).lines.some((x) => x.who === "maus" && /^Still /.test(x.text)), "a progress update", 8000);
    // You talk while it works: the job isn't cancelled; your words go with the context.
    ph.st.interruptAt = () => true;
    ph.st.speakingUntil = Date.now() + 2000;
    ph.st.heard.push("Under $300, please");
    await e.until(async () => asked.length === 2, "your update was passed on", 15000);
    assert.match(asked[1], /still working in the background on: \\"Find me a good GPU\\"/);
    await e.until(async () => (await live(e, c.id)).lines.some((x) => /4060/.test(x.text)), "the job's answer still came", 15000);
    // "Cancel that" while a job runs: it's stopped and its answer never comes.
    ph.st.heard.push("And a monitor too");
    await e.until(async () => asked.length === 3, "monitor job", 15000);
    await e.until(async () => (await live(e, c.id)).lines.filter((x) => x.who === "maus" && /check|look|On it/i.test(x.text)).length >= 2, "acknowledged", 8000);
    ph.st.interruptAt = () => true;
    ph.st.speakingUntil = Date.now() + 2000;
    ph.st.heard.push("cancel that");
    await e.until(async () => (await live(e, c.id)).lines.some((x) => x.text === "Okay, I've stopped that."), "stopped", 15000);
    await wait(6500);
    assert.ok(!(await live(e, c.id)).lines.some((x) => /Dell/.test(x.text)), "the cancelled job's answer never came");
    assert.equal(asked.length, 3, "cancel isn't sent to the AI");
  } finally {
    await done();
  }
});

test("speech reaches the phone in order even when a request is slow; emotional tone cues; human style for every bot; call any bot", async () => {
  const s = await load("src/speech-style.ts");
  assert.deepEqual(s.planPhrase("{excited}We got it!"), [{ kind: "speech", text: "We got it!", rate: 1.1, pitch: 1.07 }]);
  assert.deepEqual(s.planPhrase("{gentle}I'm sorry, that's hard."), [{ kind: "speech", text: "I'm sorry, that's hard.", rate: 0.93, pitch: 0.97 }]);
  assert.match(s.HUMAN_STYLE, /silently check your first instinct/);
  const { ph, e, m, done } = await callWith((last) => (last.includes("long one") ? { chunks: ["One two three four five six seven", " eight. Then nine.", " And ten."], chunkDelay: 5 } : { text: "ok" }));
  try {
    ph.st.slowFirst = true;
    ph.st.heard.push("give me a long one");
    const c = (await e.call("/api/calls/start", "POST", {})).data;
    await e.call(`/api/calls/${c.id}/run`, "POST", {});
    await e.until(async () => ph.st.enq.some((q) => q.items.some((i) => /ten/.test(i.text ?? ""))), "all spoken", 15000);
    const said = ph.st.enq.filter((q) => q.turn?.startsWith("callturn")).flatMap((q) => q.items.filter((i) => i.kind === "speech").map((i) => i.text)).join(" ");
    assert.match(said, /^One two three four five six seven eight\. Then nine\. And ten\.$|^One two three four five six seven eight\. Then nine\.\s+And ten\.$/, `in order: ${said}`);
    await e.call(`/api/calls/${c.id}/end`, "POST", {});
    // Every bot gets the human style in its instructions.
    const bots = (await e.call("/api/state")).data.bots;
    const researcher = bots.find((b) => b.name !== "Maus" && !b.hidden);
    await e.call(`/api/bots/${researcher.id}/messages`, "POST", { text: "hello there" });
    const req = await e.until(async () => m.seen.find((b) => JSON.stringify(b.messages).includes("hello there")), "researcher asked");
    assert.match(JSON.stringify(req), /silently check your first instinct/);
    // Calls with any bot, from its chat.
    const c2 = (await e.call("/api/calls/start", "POST", { botId: researcher.id })).data;
    assert.equal(c2.botId, researcher.id);
    await e.call(`/api/calls/${c2.id}/end`, "POST", {});
  } finally {
    await done();
  }
});
