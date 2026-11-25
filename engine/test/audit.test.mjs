// Weekly audit rules: scoring, safety gate, phases, dedupe, report, secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

const A = await load("src/audit.ts");
const base = (o = {}) => ({ name: "Price drop watcher", source_ecosystem: "meta-muse", source_url: "https://example.com/price-watch", summary: "Checks a product page daily and alerts when the price falls.", utility: 5, adoption: 4, scope_fit: 5, setup: 4, privacy: 5, phase: "phase-1-ready", primitives: ["routine_create", "web_fetch", "notify_user"], account_alias: "personal", action_type: "read-only", ...o });

test("scores out of 25; invalid criteria and phases rejected", () => {
  const s = A.scoreCandidate(base());
  assert.equal(s.total, 23);
  assert.equal(s.accepted, true);
  assert.equal(s.slug, "price-drop-watcher");
  assert.equal(A.scoreCandidate(base({ utility: 7 })).accepted, false);
  assert.equal(A.scoreCandidate(base({ phase: "phase-9" })).accepted, false);
  assert.equal(A.scoreCandidate(base({ account_alias: "work" })).accepted, false, "personal aliases only");
});

test("safety is a hard gate, even with a perfect score or a reworded description", () => {
  const flagged = A.scoreCandidate(base({ safety: { compass_login: true } }));
  assert.equal(flagged.accepted, false);
  assert.match(flagged.reasons[0], /Compass/);
  const sneaky = A.scoreCandidate(base({ name: "Inbox helper", summary: "Friendly helper that can auto-reply to Messenger chats for you.", safety: {} }));
  assert.equal(sneaky.accepted, false, "wording backstop catches Meta automation");
  assert.equal(A.scoreCandidate(base({ summary: "Saves your card CVV for faster checkout" })).accepted, false);
  assert.equal(A.scoreCandidate(base({ action_type: "unsupported" })).accepted, false);
});

test("dedupe by canonical URL, slug and similar name", () => {
  const wiki = [{ slug: "daily-weather-brief", name: "Daily weather brief", source_url: "https://github.com/acme/skills/tree/main/weather" }];
  const list = [
    A.scoreCandidate(base({ name: "Weather briefing", source_url: "https://www.github.com/Acme/skills" })),
    A.scoreCandidate(base({ name: "Daily Weather Brief" , source_url: "https://other.example/x" })),
    A.scoreCandidate(base({ name: "Price drop watcher" })),
    A.scoreCandidate(base({ name: "Price drop watcher", source_url: "https://example.com/price-watch/" })),
  ];
  const { kept, duplicates } = A.dedupe(list, wiki);
  assert.deepEqual(kept.map((k) => k.name), ["Price drop watcher"]);
  assert.equal(duplicates.length, 3);
});

test("report: top 20 table, phase-1 taps, overflow counts only from verified filings", () => {
  const scored = [];
  for (let i = 0; i < 23; i++) scored.push(A.scoreCandidate(base({ name: `Idea number ${i} ${"abcdefghijklmnopqrstuvw"[i]}x`, source_url: `https://example.com/${i}`, utility: (i % 5) + 1, phase: i % 2 ? "phase-2-queued" : "phase-1-ready", github_repo: i === 0 ? "acme/skills" : undefined })));
  scored.push(A.scoreCandidate(base({ name: "Bad", safety: { card_security_code: true } })));
  const ranked = A.rank(scored);
  assert.equal(ranked.length, 23);
  const overflow = ranked.slice(20);
  const rec = { runId: "r", startedAt: "2026-11-29T20:52:00Z", researchCutoffAt: "2026-11-29T20:57:00Z", scored, duplicates: [], wiki: { ok: true, detail: "x (private)" }, unavailable: ["Claude Duet (not reachable)"], filings: [{ slug: overflow[0].slug, ok: true, verified: true, detail: "ok", phase: overflow[0].phase }, { slug: overflow[1].slug, ok: false, verified: false, detail: "HTTP 500", phase: overflow[1].phase }] };
  const md = A.buildReport(rec);
  assert.equal((md.match(/^\| \d+ \|/gm) ?? []).length, 20, "20 rows");
  assert.match(md, /Wiki overflow \(ranked 21\+\): 1 filed of 3/);
  assert.match(md, /Rejected\n- Bad: Safety: exposes a CVV/);
  assert.match(md, /Claude Duet \(not reachable\)/);
  assert.match(md, /HTTP 500/);
  assert.match(md, /- acme\/skills/);
});

test("never writes credentials or card numbers to the wiki", () => {
  assert.equal(A.looksSecret("token ghp_abcdefghijklmnopqrstuvwxyz123456"), true);
  assert.equal(A.looksSecret("card 4111 1111 1111 1111"), true);
  assert.equal(A.looksSecret("A normal routine description"), false);
  const md = A.entryMarkdown(A.scoreCandidate(base()), "2026-11-30");
  for (const k of ["slug:", "name:", "source_ecosystem:", "source_url:", "discovered_date: 2026-11-30", "score: 23", "mausdroid_phase: phase-1-ready", "status: backlog", "primitives:", "account_alias: personal", "safety_check: pass", "## MausDroid alignment"]) assert.ok(md.includes(k), k);
});
