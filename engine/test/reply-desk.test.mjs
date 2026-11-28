// Reply Desk, the Copy/Play/Share row's routes, and Resources. A stand-in
// phone records what would open on Android (WhatsApp with the text, the
// clipboard, conversations); a stand-in Composio plays Gmail.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { load } from "./_load.mjs";
import { fakeModel, startEngine, useModel, wait } from "./_engine.mjs";
import { fakeComposio } from "./_composio.mjs";

async function fakePhone() {
  const st = { sent: [], clip: [], opened: [], installed: ["com.whatsapp", "com.facebook.orca", "com.android.chrome"] };
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const body = b ? JSON.parse(b) : {};
      const send = (o) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
      if (req.url === "/secret/encrypt") return send({ cipher: Buffer.from(body.plain).toString("base64") });
      if (req.url === "/secret/decrypt") return send({ plain: Buffer.from(body.cipher, "base64").toString() });
      if (req.url === "/share/send") return st.sent.push(body), send({ ok: true });
      if (req.url === "/clipboard") return st.clip.push(body.text), send({ ok: true });
      if (req.url === "/conversation/open") return st.opened.push(body), send({ opened: body.key ? "conversation" : "app" });
      if (req.url === "/apps/installed") return send({ installed: body.packages.filter((p) => st.installed.includes(p)) });
      send({});
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, st, close: () => server.close() };
}

test("needs-reply judgement and email sign-off removal", async () => {
  const rd = await load("src/reply-desk.ts");
  assert.equal(rd.needsReply({ text: "Are you free Saturday?", sender: "Sam" }).likely, true);
  assert.equal(rd.needsReply({ text: "Your order shipped", sender: "Store notifications", email: true }).likely, false);
  assert.equal(rd.needsReply({ text: "lol", sender: "Footy group", group: true }).likely, false);
  assert.equal(rd.needsReply({ text: "Dan, can you bring chairs", sender: "Footy group", group: true }, "Dan").likely, true);
  assert.equal(rd.needsReply({ text: "3 new messages", sender: "Sam" }).likely, false);
  assert.equal(rd.stripSignOff("Sounds good, see you then.\n\nCheers,\nDan", "Dan"), "Sounds good, see you then.");
  assert.equal(rd.stripSignOff("Great, thanks.\n\nKind regards,\nDan Smith"), "Great, thanks.");
  assert.equal(rd.stripSignOff("Line one\nhttps://example.com/a\n\nThanks", "Dan"), "Line one\nhttps://example.com/a");
});

test("Reply Desk: one card per conversation, one reminder, any bot shows the same card, WhatsApp/Messenger handoff stays pending", async () => {
  const ph = await fakePhone();
  const m = await fakeModel(async (body) => {
    const last = body.messages?.at(-1);
    const id = /card (rd_[\w-]+)/.exec(JSON.stringify(body.messages))?.[1];
    if (last?.role === "user" && id) return { tool: "reply_desk_show", args: { id } };
    return { text: "Here it is." };
  });
  const e = await startEngine({ env: { MAUSDROID_BRIDGE_URL: ph.url, MAUSDROID_BRIDGE_TOKEN: "x" } });
  try {
    await useModel(e, m.url);
    const wa = { key: "0|com.whatsapp|1|sam", pkg: "com.whatsapp", app: "WhatsApp", title: "Sam", text: "Are you coming Saturday?", conversation: "Sam", messages: [{ who: "Sam", text: "Hey" }, { who: "Sam", text: "Are you coming Saturday?" }] };
    await e.call("/api/notifications/incoming", "POST", { items: [{ ...wa, postedAt: Date.now() - 60_000 }] });
    await e.until(async () => (await e.call("/api/replies")).data.items.length === 1, "WhatsApp card");
    // A second message in the same chat updates the same card: no duplicate, no second reminder.
    await e.call("/api/notifications/incoming", "POST", { items: [{ ...wa, text: "Need to know by 6?", postedAt: Date.now() }] });
    await wait(300);
    let items = (await e.call("/api/replies")).data.items;
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.service, "whatsapp");
    assert.equal(it.sender, "Sam");
    assert.equal(it.preview, true, "messaging apps give previews");
    assert.equal(it.text, "Need to know by 6?");
    assert.ok(it.context.length >= 2);
    assert.equal(it.likely, true);
    const reminders = (await e.call("/api/alerts")).data.filter((a) => a.link === `replydesk:${it.id}` || /Sam may need a reply/.test(a.title));
    assert.equal(reminders.length, 1, "one reminder per conversation");
    assert.equal((await e.call("/api/state")).data.pendingReplies, 1);

    // Any bot shows the same card in its own chat.
    const bots = (await e.call("/api/state")).data.bots.slice(0, 2);
    assert.equal(bots.length, 2);
    for (const b of bots) {
      await e.call(`/api/bots/${b.id}`, "PATCH", { providerId: "local", model: "fake", approvalMode: "auto" });
      await e.call(`/api/bots/${b.id}/messages`, "POST", { text: `Show me the card ${it.id}` });
      await e.until(async () => (await e.call(`/api/bots/${b.id}/messages`)).data.some((x) => x.card?.id === it.id), `card in ${b.name}`);
      const card = (await e.call(`/api/bots/${b.id}/messages`)).data.find((x) => x.card);
      assert.deepEqual(card.card, { kind: "reply", id: it.id });
    }

    // WhatsApp opens with the exact text (line breaks and links kept); it stays pending.
    const reply = "Yes, I'll be there!\nDetails: https://example.com/game?id=4&x=1";
    await e.call(`/api/replies/${it.id}/whatsapp`, "POST", { text: reply });
    assert.deepEqual(ph.st.sent.at(-1), { kind: "whatsapp", text: reply });
    let now = (await e.call(`/api/replies/${it.id}`)).data;
    assert.equal(now.status, "pending");
    assert.equal(now.draft.text, reply);
    assert.ok(now.openedAt);
    assert.equal(now.serviceInfo.accent, "#25D366");

    // Messenger: no prefill, so the draft is kept for Copy reply + Open conversation.
    await e.call("/api/notifications/incoming", "POST", { items: [{ key: "0|com.facebook.orca|2|jo", pkg: "com.facebook.orca", app: "Messenger", title: "Jo", text: "What time tomorrow?", postedAt: Date.now() }] });
    await e.until(async () => (await e.call("/api/replies")).data.items.some((x) => x.service === "messenger"), "Messenger card");
    const ms = (await e.call("/api/replies")).data.items.find((x) => x.service === "messenger");
    assert.equal((await e.call(`/api/replies/${ms.id}`)).data.serviceInfo.reply, "copy");
    const msText = "About 10?\nSee you";
    await e.call(`/api/replies/${ms.id}/copied`, "POST", { text: msText });
    assert.equal(ph.st.clip.at(-1), msText);
    await e.call(`/api/replies/${ms.id}/open`, "POST", {});
    assert.equal(ph.st.opened.at(-1).key, "0|com.facebook.orca|2|jo", "opens that exact conversation");
    now = (await e.call(`/api/replies/${ms.id}`)).data;
    assert.equal(now.status, "pending", "copying/opening leaves it pending");
    assert.equal(now.draft.text, msText, "draft still there to copy again");

    // Decisions: Handled, No reply needed, Snooze.
    await e.call(`/api/replies/${ms.id}/mark`, "POST", { status: "snoozed", snooze: "hour" });
    assert.ok((await e.call("/api/replies?status=snoozed")).data.items.some((x) => x.id === ms.id));
    await e.call(`/api/replies/${it.id}/mark`, "POST", { status: "handled" });
    assert.equal((await e.call("/api/replies")).data.items.length, 0);
    // A new question after it was handled reopens the same card (one reminder again).
    await e.call("/api/notifications/incoming", "POST", { items: [{ ...wa, text: "Also, can you bring snacks?", postedAt: Date.now() + 1000 }] });
    await e.until(async () => (await e.call("/api/replies")).data.items.some((x) => x.id === it.id), "reopened");
    assert.equal((await e.call("/api/replies?status=all")).data.items.filter((x) => x.service === "whatsapp").length, 1);

    // Share row routes: targets in order, prefilled WhatsApp, Messenger copy + open, Chrome readable view.
    const t = (await e.call("/api/share/targets")).data;
    assert.equal(t.chrome, true);
    assert.deepEqual(t.apps.map((a) => a.id), ["whatsapp", "messenger", "sms", "email", "other"]);
    assert.equal(t.apps.find((a) => a.id === "messenger").prefill, false);
    await e.call("/api/share/app", "POST", { app: "whatsapp", text: reply });
    assert.deepEqual(ph.st.sent.at(-1), { kind: "whatsapp", text: reply });
    const r = (await e.call("/api/share/app", "POST", { app: "messenger", pkg: "com.facebook.orca", prefill: false, text: reply })).data;
    assert.equal(r.done, "copied-and-opened");
    assert.equal(ph.st.clip.at(-1), reply);
    const v = (await e.call("/api/share/view", "POST", { title: "Plan", text: "# Plan\n\n- one\n- [link](https://example.com)" })).data;
    assert.equal(ph.st.sent.at(-1).kind, "url");
    assert.equal(ph.st.sent.at(-1).pkg, "com.android.chrome");
    const page = await fetch(v.url).then((x) => x.text());
    assert.match(page, /<h1>Plan<\/h1>/);
    assert.match(page, /href="https:\/\/example.com"/);
  } finally {
    await e.stop();
    m.close();
    ph.close();
  }
});

test("Email: sends only the approved final text (signature added, no sign-off); edits need fresh approval", async () => {
  const sent = [];
  const c = await fakeComposio({
    accounts: [{ id: "ca_gmail", toolkit: "gmail", alias: "Gmail" }],
    tools: { GMAIL_FETCH_EMAILS: ["query", "max_results"], GMAIL_REPLY_TO_THREAD: ["thread_id", "message_body", "recipient_email"], GMAIL_LIST_SEND_AS: ["user_id"], GMAIL_FETCH_MESSAGE_BY_THREAD_ID: ["thread_id"] },
    handlers: {
      GMAIL_FETCH_EMAILS: () => ({ messages: [{ messageId: "m1", threadId: "t1", sender: "Alex Smith <alex@example.com>", subject: "Excursion forms", messageText: "Could you send the forms by Friday?", messageTimestamp: new Date().toISOString() }, { messageId: "m2", threadId: "t2", sender: "Newsletter <noreply@shop.example>", subject: "Sale", messageText: "Big sale", messageTimestamp: new Date().toISOString() }] }),
      GMAIL_LIST_SEND_AS: () => ({ sendAs: [{ isPrimary: true, signature: "<div>Dan<br>Year 5 teacher</div>" }] }),
      GMAIL_FETCH_MESSAGE_BY_THREAD_ID: () => ({ messages: [] }),
      GMAIL_REPLY_TO_THREAD: (args) => (sent.push(args), { id: "sent1" }),
    },
  });
  const e = await startEngine({ env: { MAUSDROID_COMPOSIO_API: c.url } });
  try {
    await e.call("/api/composio/key", "POST", { key: "ak_test" });
    const r = (await e.call("/api/replies/refresh", "POST", {})).data;
    assert.equal(r.added, 2);
    const all = (await e.call("/api/replies?status=all")).data.items;
    const it = all.find((x) => x.subject === "Excursion forms");
    assert.equal(it.likely, true);
    assert.equal(it.preview, false);
    assert.equal(all.find((x) => x.subject === "Sale").likely, false);
    // Checking again doesn't duplicate.
    await e.call("/api/replies/refresh", "POST", {});
    assert.equal((await e.call("/api/replies?status=all")).data.items.length, 2);

    const draft = "Hi Alex,\n\nYes — attached here: https://example.com/forms\n\nCheers,\nDan";
    const pv = (await e.call(`/api/replies/${it.id}/preview`, "POST", { text: draft })).data;
    assert.equal(pv.body, "Hi Alex,\n\nYes — attached here: https://example.com/forms\n\nDan\nYear 5 teacher");
    // No approval yet: refused.
    assert.equal((await e.call(`/api/replies/${it.id}/send`, "POST", { text: draft, to: "alex@example.com" })).status >= 400, true);
    assert.equal(sent.length, 0);
    await e.call(`/api/replies/${it.id}/approve`, "POST", { text: draft, to: "alex@example.com" });
    // Edited after approving: refused.
    assert.equal((await e.call(`/api/replies/${it.id}/send`, "POST", { text: draft + " Thanks!", to: "alex@example.com" })).status >= 400, true);
    // Approved text, different recipient: refused.
    await e.call(`/api/replies/${it.id}/approve`, "POST", { text: draft, to: "alex@example.com" });
    assert.equal((await e.call(`/api/replies/${it.id}/send`, "POST", { text: draft, to: "someone@else.com" })).status >= 400, true);
    assert.equal(sent.length, 0);
    // Saving an edit clears the approval too.
    await e.call(`/api/replies/${it.id}/approve`, "POST", { text: draft, to: "alex@example.com" });
    await e.call(`/api/replies/${it.id}/draft`, "PUT", { text: draft + "!", to: "alex@example.com" });
    assert.equal((await e.call(`/api/replies/${it.id}/send`, "POST", { text: draft, to: "alex@example.com" })).status >= 400, true);
    // Approve, then send the exact text: goes out once, with the signature.
    await e.call(`/api/replies/${it.id}/approve`, "POST", { text: draft, to: "alex@example.com" });
    const done = (await e.call(`/api/replies/${it.id}/send`, "POST", { text: draft, to: "alex@example.com" })).data;
    assert.equal(done.status, "handled");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].thread_id, "t1");
    assert.equal(sent[0].recipient_email, "alex@example.com");
    assert.equal(sent[0].message_body, pv.body);
    assert.doesNotMatch(sent[0].message_body, /Cheers/);
  } finally {
    await e.stop();
    c.close();
  }
});

test("Resources: links from replies with keywords, archive stays searchable, delete by keyword", async () => {
  const m = await fakeModel(async (body) => {
    const last = body.messages?.at(-1);
    if (last?.role === "user" && /Christmas/.test(JSON.stringify(last))) return { text: "Try [Gift ideas](https://gifts.example/kids) and https://toys.example/lego." };
    if (last?.role === "user" && /Bali/.test(JSON.stringify(last))) return { text: "See https://travel.example/bali" };
    return { text: "ok" };
  });
  const e = await startEngine({});
  try {
    await useModel(e, m.url);
    const bot = (await e.call("/api/state")).data.bots[0];
    await e.call(`/api/bots/${bot.id}`, "PATCH", { providerId: "local", model: "fake" });
    await e.call(`/api/bots/${bot.id}/messages`, "POST", { text: "Find Christmas presents for Odette" });
    await e.until(async () => (await e.call("/api/resources")).data.items.length === 2, "two links saved");
    await e.call(`/api/bots/${bot.id}/messages`, "POST", { text: "Links for our Bali holiday please" });
    await e.until(async () => (await e.call("/api/resources")).data.items.length === 3, "third link");
    const xmas = (await e.call("/api/resources?keyword=christmas")).data;
    assert.equal(xmas.items.length, 2);
    assert.equal(xmas.items.find((x) => x.url === "https://gifts.example/kids").title, "Gift ideas");
    assert.ok(xmas.items[0].keywords.includes("odette"));
    assert.ok(xmas.keywords.some((k) => k.keyword === "christmas" && k.count === 2));
    // Archived: out of the main list, still found by search (and by bots).
    const bali = (await e.call("/api/resources?q=bali")).data.items[0];
    await e.call(`/api/resources/${bali.id}/archive`, "POST", { archived: true });
    assert.equal((await e.call("/api/resources")).data.items.length, 2);
    assert.equal((await e.call("/api/resources?q=bali&archived=all")).data.items[0].id, bali.id);
    assert.equal((await e.call("/api/resources?archived=1")).data.items.length, 1);
    // "Don't worry about that, you can delete it": a batch by keyword.
    const del = (await e.call("/api/resources/delete", "POST", { keyword: "christmas" })).data;
    assert.equal(del.deleted.length, 2);
    assert.equal((await e.call("/api/resources?archived=all")).data.items.length, 1);
  } finally {
    await e.stop();
    m.close();
  }
});
