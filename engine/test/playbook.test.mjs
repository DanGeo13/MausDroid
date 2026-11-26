// The playbook: documents (Markdown or Word) with the person's rules, kept on
// the phone; the main assistant follows them, looks up long ones, adds
// corrections with a change log; nothing else is changed. Sample content only.
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { fakeModel, startEngine, useModel } from "./_engine.mjs";

/** A minimal .docx (zip with word/document.xml), built here so no real document is needed. */
function makeDocx(bodyXml) {
  const xml = Buffer.from(`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`);
  const data = zlib.deflateRawSync(xml);
  const name = Buffer.from("word/document.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(xml.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(xml.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const cdStart = local.length + name.length + data.length;
  const cd = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(cdStart, 16);
  return Buffer.concat([local, name, data, cd, eocd]);
}
const p = (t, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ""}<w:r><w:t>${t}</w:t></w:r></w:p>`;

const PLAYBOOK = `# How Sam's assistant works with Sam

## Conversation
- Keep replies short. Ask ONE clear question if something's missing.
- Tilly never says "Great question!".

## Email
- Never delete email: archive only.

## Change log
- 2026-01-01: Playbook created.
`;

test("playbook: import, followed by the main assistant, reference lookups, corrections with a change log", async () => {
  let mausScript = [];
  const m = await fakeModel((body) => {
    const sys = JSON.stringify(body.messages?.[0] ?? "");
    if (/You are Maus/.test(sys)) return mausScript.shift() ?? { text: "ok" };
    return { text: "ok" };
  });
  const e = await startEngine();
  try {
    await useModel(e, m.url);
    const bots = (await e.call("/api/state")).data.bots;
    const maus = bots.find((b) => b.name === "Maus");
    const researcher = bots.find((b) => b.name === "Researcher");
    const memoryBefore = (await e.call("/api/memory/about-me")).data;

    // A short Markdown playbook → always followed; a long Word guide → reference.
    const md = (await e.call("/api/playbook/import", "POST", { name: "sam-playbook.md", b64: Buffer.from(PLAYBOOK).toString("base64") })).data;
    assert.equal(md.mode, "always");
    const long = "Check the timetable source first, then the calendar. ".repeat(400);
    const docx = makeDocx(p("Method", "Heading1") + p("1. Listen and restate the job.") + `<w:tbl><w:tr><w:tc>${p("Job")}</w:tc><w:tc>${p("Source")}</w:tc></w:tr></w:tbl>` + p(long));
    const ref = (await e.call("/api/playbook/import", "POST", { name: "Sam guide.docx", b64: docx.toString("base64") })).data;
    assert.equal(ref.mode, "reference");
    const text = (await e.call(`/api/playbook/${ref.id}/text`)).data.text;
    assert.match(text, /^# Method\n1\. Listen and restate the job\.\n\| Job \| Source \|/);
    assert.equal((await e.call("/api/playbook/import", "POST", { name: "x.bin", b64: Buffer.from([0, 1, 2, 0, 3, 4, 0, 5, 6, 7, 8, 9, 0, 1, 2, 3, 4, 5, 6, 7, 8]).toString("base64") })).status, 400);

    // Maus gets the playbook in its instructions (and the reference list); Researcher doesn't.
    mausScript = [{ text: "hi" }];
    await e.call(`/api/bots/${maus.id}/messages`, "POST", { text: "hello" });
    await e.call(`/api/bots/${researcher.id}/messages`, "POST", { text: "hello" });
    const mausReq = await e.until(async () => m.seen.find((b) => /You are Maus/.test(JSON.stringify(b.messages?.[0] ?? ""))), "Maus asked");
    const sys = JSON.stringify(mausReq.messages[0]);
    assert.match(sys, /The person's playbook/);
    assert.match(sys, /Never delete email: archive only/);
    assert.match(sys, /Tilly.{0,6}\), that now means you, Maus/);
    assert.match(sys, new RegExp(`Sam guide\\.docx \\(id ${ref.id}\\)`));
    assert.ok(!sys.includes("Check the timetable source first"), "reference documents aren't pasted in every time");
    const resReq = await e.until(async () => m.seen.find((b) => /research topics/.test(JSON.stringify(b.messages?.[0] ?? ""))), "Researcher asked");
    assert.ok(!JSON.stringify(resReq.messages[0]).includes("playbook"), "other bots don't get it by default");
    assert.ok(!(resReq.tools ?? []).some((t) => t.function?.name?.startsWith("playbook_")));

    // A correction: added under the right section, with a change-log line; codes refused.
    mausScript = [{ tool: "playbook_add", args: { section: "Email", rule: "Legal mail is never archived automatically." } }, { tool: "playbook_add", args: { section: "Money", rule: "Account 4111 1111 1111 1111 is the spending card." } }, { tool: "playbook_read", args: { id: ref.id } }, { text: "Saved." }];
    await e.call(`/api/bots/${maus.id}/messages`, "POST", { text: "remember: never auto-archive legal mail" });
    await e.until(async () => (await e.call(`/api/bots/${maus.id}/messages`)).data.some((x) => x.role === "assistant" && x.text === "Saved."), "Maus done");
    const updated = (await e.call(`/api/playbook/${md.id}/text`)).data.text;
    assert.match(updated, /## Email\n- Never delete email: archive only\.\n- Legal mail is never archived automatically\.\n/);
    assert.match(updated, /## Change log\n- \d{4}-\d{2}-\d{2}: added to Email \(Maus\): Legal mail is never archived automatically\.\n- 2026-01-01: Playbook created\./);
    assert.ok(!updated.includes("4111"));
    const msgs = (await e.call(`/api/bots/${maus.id}/messages`)).data;
    assert.ok(msgs.some((x) => x.tool?.name === "playbook_add" && x.tool.isError && /code or account number/.test(x.tool.result)));
    assert.ok(msgs.some((x) => x.tool?.name === "playbook_read" && /Check the timetable source first/.test(x.tool.result)), "reference document read when needed");

    // Every bot, if chosen.
    await e.call("/api/playbook/settings", "PUT", { appliesTo: "all" });
    m.seen.length = 0;
    await e.call(`/api/bots/${researcher.id}/messages`, "POST", { text: "again" });
    const res2 = await e.until(async () => m.seen.find((b) => /research topics/.test(JSON.stringify(b.messages?.[0] ?? ""))), "Researcher asked again");
    assert.match(JSON.stringify(res2.messages[0]), /Never delete email/);

    // Improver review; removing a document; nothing else touched.
    const imp = (await e.call("/api/state")).data.bots.find((b) => b.name === "Improver");
    assert.equal((await e.call("/api/playbook/review", "POST")).data.botId, imp.id);
    assert.ok((await e.call(`/api/bots/${imp.id}/messages`)).data.some((x) => x.role === "user" && /Review the person's playbook/.test(x.text)));
    await e.call(`/api/playbook/${ref.id}`, "DELETE");
    assert.deepEqual((await e.call("/api/playbook")).data.docs.map((x) => x.name), ["sam-playbook.md"]);
    assert.deepEqual((await e.call("/api/memory/about-me")).data, memoryBefore, "memory untouched");
    assert.equal((await e.call("/api/state")).data.bots.length, bots.length, "bots untouched");
  } finally {
    await e.stop();
    m.close();
  }
});
