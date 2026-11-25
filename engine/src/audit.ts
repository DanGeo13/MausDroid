import { collection } from "./store.ts";
import { getSecret } from "./secrets.ts";
import { emit } from "./events.ts";
import { now } from "./util.ts";

/**
 * Weekly MausDroid Routine & Skill Audit. The bot researches; the engine
 * enforces the rules: scoring out of 25 with safety as a hard gate, phase
 * tags, deduplication against the wiki, filing to a PRIVATE GitHub wiki with
 * read-back verification, and a report built only from recorded data.
 */
export const AUDIT_SYSTEM = "weekly-audit";
export const WIKI_REPO = process.env.MAUSDROID_WIKI_REPO ?? "DanGeo13/mausdroid-routine-wiki";
const GH = process.env.MAUSDROID_GITHUB_API ?? "https://api.github.com";

export const SAFETY_FLAGS = {
  meta_account_control: "drives or autonomously controls a Meta (Facebook/Messenger/WhatsApp/Instagram/Marketplace) account",
  compass_login: "logs into Compass",
  card_security_code: "exposes a CVV or card security information",
  desktop_only_shell: "needs desktop-only shell execution",
  unapproved_sensitive_ops: "performs sensitive account operations without approval",
  unsafe_credentials: "handles credentials unsafely",
  unnecessary_personal_data: "exposes personal data unnecessarily",
} as const;
type Flag = keyof typeof SAFETY_FLAGS;

/** Backstop: wording that means a safety flag regardless of what the bot ticked. */
const SAFETY_WORDS: [Flag, RegExp][] = [
  ["meta_account_control", /\b(auto[- ]?(post|reply|message|list)|drive|control|automate|log ?in(to)?|bot for)\b[^.]{0,40}\b(facebook|messenger|whatsapp|instagram|marketplace|meta)\b|\b(facebook|messenger|whatsapp|instagram|marketplace)\b[^.]{0,40}\b(automation|auto[- ]?(post|reply|message)|scraper|bot)\b/i],
  ["compass_login", /\b(log ?in(to)?|sign ?in(to)?|scrape|automate)\b[^.]{0,30}\bcompass\b|\bcompass\b[^.]{0,30}\b(login|password|credentials)\b/i],
  ["card_security_code", /\b(cvv|cvc|card security code|security code of (the|your) card)\b/i],
  ["desktop_only_shell", /\b(desktop[- ]only|requires? (a )?(mac|windows|linux desktop)|powershell|applescript)\b/i],
  ["unsafe_credentials", /\b(store|save|paste|share)s? (your |the )?(password|api key|token)s? (in|into) (the )?(prompt|notes|wiki|chat|plain ?text)/i],
];

export interface Candidate {
  name: string;
  source_ecosystem: string;
  source_url: string;
  summary: string;
  utility: number;
  adoption: number;
  scope_fit: number;
  setup: number;
  privacy: number;
  phase: "phase-1-ready" | "phase-2-queued" | "phase-3-queued";
  primitives: string[];
  composio?: string[];
  account_alias?: string;
  github_repo?: string;
  action_type?: "read-only" | "user-approved" | "autonomous" | "unsupported";
  safety?: Partial<Record<Flag, boolean>>;
  alignment?: { what?: string; why?: string; integrations?: string; implementation?: string; workaround?: string; upgrade_path?: string; privacy?: string };
}

export interface Scored extends Candidate {
  slug: string;
  total: number;
  accepted: boolean;
  reasons: string[];
  rank?: number;
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 60);

export function canonicalUrl(u: string): string {
  try {
    const x = new URL(u.trim());
    let p = x.pathname.replace(/\/+$/, "").replace(/\.git$/, "");
    if (x.hostname.replace(/^www\./, "") === "github.com") p = p.split("/").slice(0, 3).join("/");
    return `${x.hostname.replace(/^www\./, "").toLowerCase()}${p.toLowerCase()}`;
  } catch {
    return u.trim().toLowerCase();
  }
}

const tokens = (s: string) => new Set(s.toLowerCase().replace(/[^\w\s]/g, " ").split(/\s+/).filter((t) => t.length > 2));
export function similar(a: string, b: string): boolean {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return false;
  const inter = [...A].filter((t) => B.has(t)).length;
  return inter / new Set([...A, ...B]).size >= 0.75;
}

const PHASES = ["phase-1-ready", "phase-2-queued", "phase-3-queued"];

/** Scores one candidate. Safety failing = rejected, whatever the score. */
export function scoreCandidate(c: Candidate): Scored {
  const reasons: string[] = [];
  const crit = { utility: c.utility, adoption: c.adoption, scope_fit: c.scope_fit, setup: c.setup, privacy: c.privacy };
  for (const [k, v] of Object.entries(crit)) if (!Number.isInteger(v) || v < 1 || v > 5) reasons.push(`${k} must be a whole number 1–5`);
  const total = Object.values(crit).reduce((a, v) => a + (Number(v) || 0), 0);
  const flags = new Set<Flag>(Object.entries(c.safety ?? {}).filter(([, v]) => v).map(([k]) => k as Flag));
  const text = `${c.name}. ${c.summary}. ${Object.values(c.alignment ?? {}).join(". ")}`;
  for (const [flag, re] of SAFETY_WORDS) if (re.test(text)) flags.add(flag);
  for (const f of flags) reasons.push(`Safety: ${SAFETY_FLAGS[f]}`);
  if (c.action_type === "unsupported") reasons.push("Unsupported or prohibited action");
  if (!PHASES.includes(c.phase)) reasons.push("phase must be phase-1-ready, phase-2-queued or phase-3-queued");
  if (!/^https?:\/\//.test(c.source_url ?? "")) reasons.push("needs a source URL");
  if (c.account_alias && !/^personal/i.test(c.account_alias)) reasons.push("research must use personal account aliases only");
  return { ...c, slug: slugify(c.name), total, accepted: reasons.length === 0, reasons };
}

export interface WikiEntry {
  slug: string;
  name: string;
  source_url: string;
  status?: string;
}

/** Removes repeats within this audit and against the wiki (URL, slug, similar name). */
export function dedupe(list: Scored[], wiki: WikiEntry[]): { kept: Scored[]; duplicates: { name: string; of: string }[] } {
  const kept: Scored[] = [];
  const duplicates: { name: string; of: string }[] = [];
  const seen: { slug: string; url: string; name: string }[] = wiki.map((w) => ({ slug: w.slug, url: canonicalUrl(w.source_url), name: w.name }));
  for (const c of list) {
    const url = canonicalUrl(c.source_url);
    const hit = seen.find((s) => s.slug === c.slug || (url && s.url === url) || similar(s.name, c.name));
    if (hit) duplicates.push({ name: c.name, of: hit.slug });
    else {
      kept.push(c);
      seen.push({ slug: c.slug, url, name: c.name });
    }
  }
  return { kept, duplicates };
}

// ---------------- Wiki (private GitHub repo) ----------------

function gh(path: string, init: RequestInit = {}) {
  const token = getSecret("github");
  if (!token) throw new Error("No GitHub token saved (Settings → Memory → GitHub token) with access to the private wiki repo.");
  return fetch(`${GH}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "MausDroid-audit", "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
}

/** The wiki must exist and be private; MausDroid never creates or writes a public one. */
export async function checkWiki(): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await gh(`/repos/${WIKI_REPO}`);
    if (r.status === 404) return { ok: false, detail: `Wiki repo ${WIKI_REPO} not found (or the token can't see it). Create it as a PRIVATE repo and give the token access.` };
    if (!r.ok) return { ok: false, detail: `GitHub said HTTP ${r.status}.` };
    const j = (await r.json()) as any;
    if (!j.private) return { ok: false, detail: `${WIKI_REPO} is PUBLIC. MausDroid only writes to a private wiki; nothing was filed.` };
    return { ok: true, detail: `${WIKI_REPO} (private)` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const unb64 = (s: string) => Buffer.from(s, "base64").toString("utf8");

/** Existing wiki entries (slug, name, source) from entries/*.md frontmatter. */
export async function wikiEntries(): Promise<WikiEntry[]> {
  const r = await gh(`/repos/${WIKI_REPO}/contents/entries`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`Couldn't list the wiki (HTTP ${r.status}).`);
  const files = ((await r.json()) as any[]).filter((f) => f.name.endsWith(".md"));
  const out: WikiEntry[] = [];
  for (const f of files.slice(0, 400)) {
    const one = await gh(`/repos/${WIKI_REPO}/contents/entries/${encodeURIComponent(f.name)}`);
    if (!one.ok) continue;
    const text = unb64(((await one.json()) as any).content ?? "");
    const fm = Object.fromEntries((text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "").split("\n").map((l) => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map((m) => [m![1], m![2].trim()]));
    out.push({ slug: fm.slug ?? f.name.replace(/\.md$/, ""), name: fm.name ?? "", source_url: fm.source_url ?? "", status: fm.status });
  }
  return out;
}

export function entryMarkdown(c: Scored, date: string): string {
  const a = c.alignment ?? {};
  const prims = c.primitives.length ? c.primitives.map((p) => `  - ${p}`).join("\n") : "  - none";
  return `---
slug: ${c.slug}
name: ${c.name.replace(/\n/g, " ")}
source_ecosystem: ${c.source_ecosystem}
source_url: ${c.source_url}
discovered_date: ${date}
score: ${c.total}
mausdroid_phase: ${c.phase}
status: backlog
primitives:
${prims}
account_alias: ${c.account_alias ?? "personal"}
safety_check: pass
---

## Summary
${c.summary}

## MausDroid alignment
- **What it does:** ${a.what ?? c.summary}
- **Why it's useful:** ${a.why ?? "—"}
- **Required integrations:** ${a.integrations ?? (c.composio?.join(", ") || "none")}
- **Existing MausDroid primitives:** ${c.primitives.join(", ") || "—"}
- **Implementation requirements:** ${a.implementation ?? "—"}
- **Phase 1 workaround:** ${a.workaround ?? "—"}
- **Upgrade path:** ${a.upgrade_path ?? "—"}
- **Privacy considerations:** ${a.privacy ?? "—"}
- **Action type:** ${c.action_type ?? "user-approved"}
`;
}

/** No credentials, tokens or card data may reach the wiki. */
export function looksSecret(text: string): boolean {
  return /\b(sk-[a-z0-9-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_\w{20,}|ak_[A-Za-z0-9]{16,}|xox[bp]-\w+|AKIA[0-9A-Z]{16}|tskey-\w+)\b|\b(?:\d[ -]?){13,19}\b|password\s*[:=]\s*\S+/i.test(text);
}

export async function fileEntry(c: Scored, date: string): Promise<{ slug: string; ok: boolean; verified: boolean; detail: string }> {
  const md = entryMarkdown(c, date);
  if (looksSecret(md)) return { slug: c.slug, ok: false, verified: false, detail: "Refused: the entry looks like it contains a credential or card number." };
  const path = `entries/${c.slug}.md`;
  const put = await gh(`/repos/${WIKI_REPO}/contents/${path}`, { method: "PUT", body: JSON.stringify({ message: `Audit ${date}: add ${c.slug}`, content: b64(md) }) });
  if (!put.ok) return { slug: c.slug, ok: false, verified: false, detail: `GitHub refused (HTTP ${put.status}${put.status === 422 ? ": an entry with this slug may already exist" : ""}).` };
  const back = await gh(`/repos/${WIKI_REPO}/contents/${path}`);
  const same = back.ok && unb64(((await back.json()) as any).content ?? "") === md;
  return { slug: c.slug, ok: true, verified: same, detail: same ? "Filed and read back ✓" : "Write accepted but read-back didn't match." };
}

// ---------------- Audit records ----------------

export interface AuditRecord {
  runId: string;
  startedAt: string;
  researchCutoffAt?: string;
  finishedAt?: string;
  scored: Scored[];
  duplicates: { name: string; of: string }[];
  filings: { slug: string; ok: boolean; verified: boolean; detail: string; phase?: string }[];
  wiki: { ok: boolean; detail: string } | null;
  unavailable: string[];
  report?: string;
}

const audits = collection<AuditRecord[]>("audits", []);
export const listAudits = () => audits.get().slice().reverse();
export const auditFor = (runId: string) => audits.get().find((a) => a.runId === runId);

export function upsertAudit(runId: string, patch: Partial<AuditRecord>): AuditRecord {
  let rec: AuditRecord | undefined;
  audits.update((l) => {
    rec = l.find((a) => a.runId === runId);
    if (!rec) {
      rec = { runId, startedAt: now(), scored: [], duplicates: [], filings: [], wiki: null, unavailable: [] };
      l.push(rec);
      if (l.length > 60) l.splice(0, l.length - 60);
    }
    Object.assign(rec, patch);
  });
  emit("audit", { runId });
  return rec!;
}

/** Ranks accepted candidates (score, then utility) and assigns rank numbers. */
export function rank(list: Scored[]): Scored[] {
  return list
    .filter((c) => c.accepted)
    .sort((a, b) => b.total - a.total || b.utility - a.utility || a.name.localeCompare(b.name))
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

const cell = (s: string) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The report, from recorded data only. */
export function buildReport(rec: AuditRecord, notes = ""): string {
  const ranked = rank(rec.scored);
  const top = ranked.slice(0, 20);
  const overflow = ranked.slice(20);
  const filedOk = rec.filings.filter((f) => f.ok && f.verified);
  const byPhase = (p: string) => filedOk.filter((f) => f.phase === p).length;
  const rejected = rec.scored.filter((c) => !c.accepted);
  const lines = [
    `# MausDroid Routine & Skill Audit — ${rec.startedAt.slice(0, 10)}`,
    "",
    `Research window: ${rec.startedAt.slice(11, 16)}–${(rec.researchCutoffAt ?? rec.startedAt).slice(11, 16)} UTC (5-minute cutoff). Wiki: ${rec.wiki?.detail ?? "not checked"}.`,
    "",
    "## Top 20",
    "",
    "| Rank | Routine / Skill | Source | Phase Tag | MausDroid Primitives | Composio / Account | Fit (1-5) | Wiki Slug |",
    "|---|---|---|---|---|---|---|---|",
    ...top.map((c) => `| ${c.rank} | ${cell(c.name)} (${c.total}/25) | [${cell(c.source_ecosystem)}](${c.source_url}) | ${c.phase} | ${cell(c.primitives.join(", "))} | ${cell([...(c.composio ?? []), c.account_alias ?? "personal"].join(" / "))} | ${c.scope_fit} | ${c.slug} |`),
    top.length ? "" : "_No accepted candidates._",
    "## Top 3 Phase 1 immediate taps",
    ...(ranked.filter((c) => c.phase === "phase-1-ready").slice(0, 3).map((c, i) => `${i + 1}. **${c.name}** — ${c.summary}`) || []),
    ranked.some((c) => c.phase === "phase-1-ready") ? "" : "_None this week._",
    "## Installable through the Skills marketplace",
    ...([...new Set(ranked.map((c) => c.github_repo).filter(Boolean))] as string[]).map((r) => `- ${r}`),
    ranked.some((c) => c.github_repo) ? "" : "_None._",
    `## Wiki overflow (ranked 21+): ${filedOk.length} filed of ${overflow.length}`,
    `- phase-1-ready: ${byPhase("phase-1-ready")} · phase-2-queued: ${byPhase("phase-2-queued")} · phase-3-queued: ${byPhase("phase-3-queued")}`,
    rec.duplicates.length ? `- Already in the wiki / repeats skipped: ${rec.duplicates.map((d) => `${d.name} (= ${d.of})`).join("; ")}` : "",
    "## Rejected",
    ...(rejected.length ? rejected.map((c) => `- ${c.name}: ${c.reasons.join("; ")}`) : ["_None._"]),
    "## Unavailable research sources",
    ...(rec.unavailable.length ? rec.unavailable.map((u) => `- ${u}`) : ["_None reported._"]),
    "## Wiki filing errors",
    ...(rec.filings.filter((f) => !f.ok || !f.verified).map((f) => `- ${f.slug}: ${f.detail}`).concat(rec.wiki && !rec.wiki.ok ? [`- Wiki unavailable: ${rec.wiki.detail}`] : []) || []),
    rec.filings.some((f) => !f.ok || !f.verified) || (rec.wiki && !rec.wiki.ok) ? "" : "_None._",
    notes ? `\n## Notes\n${notes}` : "",
  ];
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

export const RESEARCH_TOOLS = /^(web_search|web_fetch|browser_open|browser_read|browser_click|browser_scroll|composio__COMPOSIO_SEARCH_TOOLS|composio__COMPOSIO_MULTI_EXECUTE_TOOL|skills_market_search|tailnet_fetch)$/;

export const AUDIT_PROMPT = `Run the weekly MausDroid Routine & Skill Audit. You have a strict 5-minute research window; after it, research tools stop working, so be quick. Finish before 08:00.
1. Call audit_begin.
2. Research (personal account aliases only; don't assume integrations are connected) useful workflows, skills and capabilities for MausDroid from: Grok Bot, Meta Muse, OpenAI Dots, Claude Duet, n8n, Nod, GitHub claude-skills and agent-skills repositories, connected Composio apps, and the Skills marketplace (skills_market_search). Use web_search, web_fetch, browser tools and Composio search. Note any source you couldn't reach.
3. For each candidate, score utility, adoption signal, MausDroid scope fit, setup simplicity and privacy/safety (1–5 each), set safety flags honestly, mark the action type (read-only / user-approved / autonomous / unsupported), choose the phase (phase-1-ready = existing MausDroid capabilities; phase-2-queued = new integrations, Android capabilities or moderate changes; phase-3-queued = major engineering), list MausDroid primitives (e.g. notify_user, routine_create, calendar_create_event, web_fetch, composio apps), and fill the alignment fields. Never describe a rejected idea differently to get it through.
4. Call audit_score with all candidates (it applies the safety gate, removes duplicates against the wiki and ranks them).
5. Call audit_file_overflow to file every accepted candidate ranked 21 or lower in the private wiki.
6. Call audit_finish with unavailable sources and short notes; it returns the report built from the recorded data.
7. Call memory_save (scope "bot") with three lines: highest-value discoveries; top Phase 1 implementation; overflow counts and blockers.
8. Call notify_user (priority normal, title "Sunday Routine Audit Ready") with one sentence: the top Phase 1 recommendation and the total wiki overflow count.
If anything fails or is incomplete, say so plainly in the notification instead of presenting a successful audit.`;
