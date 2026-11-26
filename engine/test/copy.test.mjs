// "Copy" on chat messages: markdown → plain text, and the real Chat screen
// (every bot uses it) shows a visible 'Copy message' button that fills the clipboard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url).pathname;
async function bundle(entry, extra = {}) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mdcopy-")), "m.mjs");
  await build({ entryPoints: [path.join(root, entry)], bundle: true, platform: "browser", target: "node18", format: "esm", outfile: out, logLevel: "error",
    jsx: "automatic", jsxImportSource: "preact", nodePaths: [path.join(root, "node_modules")], ...extra });
  return import(pathToFileURL(out).href);
}

test("markdownToPlain: clean text, bullets, tables, links, code", async () => {
  const { markdownToPlain, messageCopyText, cardCopyText, systemShowsCopyNotice } = await bundle("../ui/src/copy.ts");
  const md = "# Plan\n\nSome **bold** and *soft* text with `code` and [a site](https://example.com/x).\n\n- one\n* two\n1. first\n\n| Name | Qty |\n|------|-----|\n| Tea | 2 |\n\n```js\nconst a = **1**;\n```\n";
  assert.equal(markdownToPlain(md), "Plan\n\nSome bold and soft text with code and https://example.com/x.\n\n• one\n• two\n1. first\n\n| Name | Qty |\n| Tea | 2 |\n\nconst a = **1**;");
  assert.ok(!markdownToPlain("## Hi **there**").includes("#"));
  assert.equal(markdownToPlain(""), "");
  // image-only messages copy the file name; nothing at all → empty (button hidden)
  assert.equal(messageCopyText({ role: "user", text: "", attachments: [{ name: "cat.jpg" }] }), "cat.jpg");
  assert.equal(messageCopyText({ role: "user", text: "look", attachments: [{ name: "cat.jpg" }] }), "look");
  assert.equal(messageCopyText({ role: "assistant", text: "" }), "");
  assert.equal(messageCopyText({ role: "user", text: "keep **this** as typed" }), "keep **this** as typed");
  assert.match(messageCopyText({ role: "tool", text: "", tool: { name: "web_fetch", input: { url: "u" }, result: "ok" } }), /web_fetch[\s\S]*"url": "u"[\s\S]*→ ok/);
  assert.equal(cardCopyText({ title: "Send email", detail: "To: a@b.c" }), "Send email\n\nTo: a@b.c");
  assert.equal(systemShowsCopyNotice("Mozilla/5.0 (Linux; Android 13; Pixel)"), true);
  assert.equal(systemShowsCopyNotice("Mozilla/5.0 (Linux; Android 12; Pixel)"), false);
  const { renderMarkdown } = await bundle("../ui/src/markdown.tsx");
  assert.match(renderMarkdown("```\nx\n```"), /<pre><button[^>]*class="code-copy"[^>]*>Copy<\/button><code>x\n<\/code><\/pre>/);
});

// ---- a tiny DOM, just enough to render the real Chat screen with Preact ----
class Node_ {
  constructor(name, type = 1) { this.nodeName = name; this.localName = name.toLowerCase(); this.nodeType = type; this.childNodes = []; this.parentNode = null; this.attrs = {}; this.listeners = {}; this.style = {}; this.data = ""; this.innerHTML = ""; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] ?? null : null; }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join(""); }
  set textContent(v) { this.childNodes = []; if (v) this.appendChild(new Node_("#text", 3)).data = String(v); }
  appendChild(c) { return this.insertBefore(c, null); }
  insertBefore(c, ref) { c.parentNode?.removeChild(c); const i = ref ? this.childNodes.indexOf(ref) : -1; if (i < 0) this.childNodes.push(c); else this.childNodes.splice(i, 0, c); c.parentNode = this; return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
  remove() { this.parentNode?.removeChild(this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  removeAttribute(k) { delete this.attrs[k]; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(n, f) { (this.listeners[n.toLowerCase()] ??= []).push(f); }
  removeEventListener(n, f) { const l = this.listeners[n.toLowerCase()]; if (l) this.listeners[n.toLowerCase()] = l.filter((x) => x !== f); }
  scrollIntoView() {}
  focus() {}
  all(f, out = []) { for (const c of this.childNodes) { if (c.nodeType === 1) { if (f(c)) out.push(c); c.all(f, out); } } return out; }
  // Preact only sets `onclick` style props if they exist on the node, else it uses the event name as written.
  get onclick() { return null; } get ontouchstart() { return null; } get oncontextmenu() { return null; }
  get onchange() { return null; } get oninput() { return null; } get onkeydown() { return null; } get onpaste() { return null; }
  get ondragover() { return null; } get ondrop() { return null; }
}
const click = async (el) => {
  for (const f of el.listeners.click ?? []) await f.call(el, { type: "click", target: el, stopPropagation() {}, preventDefault() {} });
  await new Promise((r) => setTimeout(r, 20));
};

test("the real Chat screen: every message has a visible 'Copy message' button that copies plain text", async () => {
  const clip = [];
  const body = new Node_("BODY");
  const doc = { body, createElement: (n) => new Node_(n.toUpperCase()), createElementNS: (_ns, n) => new Node_(n), createTextNode: (t) => { const n = new Node_("#text", 3); n.data = String(t); return n; }, execCommand: () => false, documentElement: new Node_("HTML") };
  const setG = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  setG("document", doc);
  setG("window", { matchMedia: () => ({ matches: false }) });
  setG("navigator", { userAgent: "Mozilla/5.0 (Linux; Android 12; Pixel)", clipboard: { writeText: async (t) => void clip.push(t) } });
  setG("fetch", async () => { throw new Error("offline"); });
  // One bundle, so Chat and the Preact that renders it are the same copy.
  const { Chat, render, h } = await bundle("../ui/src/chat.tsx", { entryPoints: undefined, stdin: { contents: `export { Chat } from "../ui/src/chat.tsx"; export { render, h } from "preact";`, resolveDir: root, loader: "js" } });
  const at = new Date().toISOString();
  const messages = [
    { id: "1", role: "user", text: "Hello **there**", at },
    { id: "2", role: "assistant", text: "## Plan\n- **Buy** tea\n- See [site](https://example.com)\n\n```\nnpm test\n```", at, status: "done" },
    { id: "3", role: "assistant", text: "still typing", at, status: "streaming" },
    { id: "4", role: "user", text: "", at, attachments: [{ id: "f1", name: "cat.jpg", mime: "image/jpeg", size: 10, kind: "image" }] },
    { id: "5", role: "note", text: "Switched model", at },
    { id: "6", role: "assistant", text: "Oops: something failed", at, status: "error" },
  ];
  const cards = [{ id: "c1", kind: "approval", botId: "b1", title: "Send email", detail: "To: a@b.c", tool: "send_email" }];
  const bot = { id: "b1", name: "Maus", emoji: "🐭", color: "#6c5cff", skills: [] };
  const screen = new Node_("DIV");
  body.appendChild(screen);
  render(h(Chat, { bot, messages, cards, busy: false, onBack() {}, onEdit() {}, refresh() {}, voiceOk: false, remote: false }), screen);
  await new Promise((r) => setTimeout(r, 50));

  const buttons = () => screen.all((e) => e.attrs["aria-label"] === "Copy message");
  // Message rows in order: person, bot (markdown), bot (still streaming), file-only, error
  // (the fake DOM doesn't parse the markdown's HTML, so rows are picked by position).
  const rows = screen.all((e) => /\bmsg\b/.test(e.attrs.class ?? ""));
  assert.equal(rows.length, 5);
  const hostOf = (text) => rows[{ Hello: 0, Buy: 1, "still typing": 2, file: 3, Oops: 4 }[text]];
  const btnIn = (el) => el.all((e) => e.attrs["aria-label"] === "Copy message");
  // user message, bot markdown message, error message, file-only message, note, approval card: each has one; the streaming one doesn't
  assert.equal(btnIn(hostOf("Hello")).length, 1);
  assert.equal(btnIn(hostOf("Buy")).length, 1);
  assert.equal(btnIn(hostOf("still typing")).length, 0);
  assert.equal(btnIn(hostOf("Oops")).length, 1);
  assert.equal(btnIn(hostOf("file")).length, 1);
  assert.equal(buttons().length, 6); // user, bot, file-only, note, error, approval card
  for (const b of buttons()) assert.equal(b.attrs.type, "button"); // real, always-rendered buttons (no hover-only CSS)

  await click(btnIn(hostOf("Hello"))[0]);
  assert.equal(clip.at(-1), "Hello **there**"); // the person's own words, exactly as typed
  await click(btnIn(hostOf("file"))[0]);
  assert.equal(clip.at(-1), "cat.jpg");
  await click(btnIn(hostOf("Buy"))[0]);
  assert.equal(clip.at(-1), "Plan\n• Buy tea\n• See https://example.com\n\nnpm test");
  const card = screen.all((e) => e.attrs.class === "card").pop();
  await click(btnIn(card)[0]);
  assert.equal(clip.at(-1), "Send email\n\nTo: a@b.c");
  assert.equal(body.all((e) => e.className === "toast").length > 0, true); // Android 12: we show the 'Copied' toast
  // the code block has its own Copy button
  assert.match(rows[1].all((e) => e.innerHTML).map((e) => e.innerHTML).join(""), /class="code-copy"/);
  render(null, screen);
});
