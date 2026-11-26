import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./store.ts";
import { getSecret } from "./secrets.ts";

/**
 * Skills: folders with a SKILL.md (name + description frontmatter, then
 * instructions), the same format Claude Code and OpenMausBot use. The
 * marketplace finds skills on GitHub and installs them from any repo.
 */
export interface Skill {
  name: string;
  description: string;
  source?: string;
  dir: string;
}

const root = () => path.dirname(dataPath("skills", ".keep"));
const API = "https://api.github.com";

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = { "user-agent": "MausDroid-skills", accept: "application/vnd.github+json" };
  const t = getSecret("github");
  if (t) h.authorization = `Bearer ${t}`;
  return h;
}

export function parseFrontmatter(md: string): { name?: string; description?: string; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return { name: meta.name, description: meta.description, body: m[2] };
}

export function listSkills(): Skill[] {
  const out: Skill[] = [];
  if (!fs.existsSync(root())) return out;
  for (const d of fs.readdirSync(root())) {
    const file = path.join(root(), d, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const fm = parseFrontmatter(fs.readFileSync(file, "utf8"));
    let source: string | undefined;
    try {
      source = JSON.parse(fs.readFileSync(path.join(root(), d, ".source.json"), "utf8")).source;
    } catch {
      /* hand-made skill */
    }
    out.push({ name: fm.name ?? d, description: fm.description ?? "", source, dir: path.join(root(), d) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function readSkill(name: string): string {
  const s = listSkills().find((x) => x.name === name);
  if (!s) throw new Error(`No skill called ${name}`);
  const md = fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8");
  const extra = fs.readdirSync(s.dir, { recursive: true } as any).map(String).filter((f) => f !== "SKILL.md" && !f.startsWith("."));
  return `${md}\n\n[Other files in this skill: ${extra.join(", ") || "none"}. Ask with skill_read using file= to open one.]`;
}

export function readSkillFile(name: string, file: string): string {
  const s = listSkills().find((x) => x.name === name);
  if (!s) throw new Error(`No skill called ${name}`);
  const p = path.resolve(s.dir, file);
  if (!p.startsWith(s.dir + path.sep)) throw new Error("That file is outside the skill folder.");
  return fs.readFileSync(p, "utf8");
}

export function saveSkill(name: string, md: string) {
  const safe = name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "skill";
  const dir = path.join(root(), safe);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), md);
  return safe;
}

export function removeSkill(name: string) {
  const s = listSkills().find((x) => x.name === name);
  if (s) fs.rmSync(s.dir, { recursive: true, force: true });
}

/** Marketplace search: GitHub repositories tagged for agent skills. */
export async function searchMarketplace(q: string) {
  const query = `${q ? `${q} ` : ""}topic:claude-skills OR topic:agent-skills OR topic:claude-code-skills`;
  const res = await fetch(`${API}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=30`, { headers: ghHeaders() });
  if (!res.ok) throw new Error(`GitHub search: HTTP ${res.status}${res.status === 403 ? " (rate limit: add a GitHub token in Settings)" : ""}`);
  const j = (await res.json()) as any;
  const featured = [{ full_name: "anthropics/skills", description: "Anthropic's official example skills", stargazers_count: null, html_url: "https://github.com/anthropics/skills" }];
  return [...featured, ...(j.items ?? [])].map((r: any) => ({ repo: r.full_name, description: r.description, stars: r.stargazers_count, url: r.html_url }));
}

function parseRepoRef(ref: string) {
  const m = ref.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").match(/^([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?(?:\/(.*))?$/);
  if (!m) throw new Error("Use owner/repo or a github.com link.");
  return { owner: m[1], repo: m[2], branch: m[3], sub: (m[4] ?? "").replace(/\/$/, "") };
}

/** Lists the skills (folders with SKILL.md) inside a GitHub repo. */
export async function listRepoSkills(ref: string) {
  const { owner, repo, branch, sub } = parseRepoRef(ref);
  let ref2 = branch;
  if (!ref2) {
    const r = await fetch(`${API}/repos/${owner}/${repo}`, { headers: ghHeaders() });
    if (!r.ok) throw new Error(`GitHub: HTTP ${r.status}`);
    ref2 = ((await r.json()) as any).default_branch;
  }
  const t = await fetch(`${API}/repos/${owner}/${repo}/git/trees/${ref2}?recursive=1`, { headers: ghHeaders() });
  if (!t.ok) throw new Error(`GitHub: HTTP ${t.status}`);
  const tree = ((await t.json()) as any).tree as { path: string; type: string; size?: number }[];
  const dirs = tree.filter((e) => e.type === "blob" && /(^|\/)SKILL\.md$/.test(e.path) && (!sub || e.path.startsWith(sub))).map((e) => path.posix.dirname(e.path));
  return { owner, repo, branch: ref2!, tree, dirs };
}

export async function installFromGitHub(ref: string, only?: string[]) {
  const { owner, repo, branch, tree, dirs } = await listRepoSkills(ref);
  const chosen = only?.length ? dirs.filter((d) => only.includes(d) || only.includes(path.posix.basename(d))) : dirs;
  if (!chosen.length) throw new Error("No SKILL.md found there.");
  if (chosen.length > 40) throw new Error(`That repo has ${chosen.length} skills — pick specific ones.`);
  const installed: string[] = [];
  for (const d of chosen) {
    const files = tree.filter((e) => e.type === "blob" && (d === "." ? !e.path.includes("/") || e.path === "SKILL.md" : e.path.startsWith(d + "/")) && (e.size ?? 0) < 1_000_000);
    if (files.length > 200) continue;
    const skillMd = await (await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${d === "." ? "" : d + "/"}SKILL.md`)).text();
    const fm = parseFrontmatter(skillMd);
    const name = saveSkill(fm.name ?? path.posix.basename(d === "." ? repo : d), skillMd);
    const dir = path.join(root(), name);
    for (const f of files) {
      const rel = d === "." ? f.path : f.path.slice(d.length + 1);
      if (rel === "SKILL.md") continue;
      const res = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${f.path}`);
      if (!res.ok) continue;
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
    }
    fs.writeFileSync(path.join(dir, ".source.json"), JSON.stringify({ source: `github.com/${owner}/${repo}/${d}`, branch }));
    installed.push(name);
  }
  return installed;
}

/** Skills that come with MausDroid (added once; your edits are kept). */
const BUILTIN_SKILLS: Record<string, string> = {
  gumtree: `---
name: gumtree
description: Search, watch and read Gumtree (Australia) listings in the background browser with the person's own login — Gumtree has no app connection. Use for "find on Gumtree", price checks, watching for new listings, and drafting listings or messages for approval.
---
# Gumtree (through the background browser)

Gumtree has no API or Composio toolkit, so use the phone's background browser (browser_open, browser_read, browser_scroll, browser_click, browser_type, browser_screenshot).

## Searching
- Open https://www.gumtree.com.au/s-QUERY/k0 (spaces as hyphens, e.g. /s-road-bike/k0). Add a location by opening the site and using its location box, or ask the person for their suburb once and remember it (memory_save).
- browser_read the results; scroll for more. For each useful listing give: title, price, suburb, posted time and the link. Point out obvious duplicates or likely scams (too-cheap prices, "shipping only", requests to pay outside Gumtree).
- To check a listing, open its link and read the description, condition and seller details.

## Watching for new listings
- Suggest a routine (routine_create, e.g. every 2 hours) that runs the same search and calls notify_user only for listings it hasn't reported before (keep the links you've seen in memory).

## Logging in
- Only when needed (messages, saved searches, posting): call browser_ask_login so the person signs in themselves in the browser. Never ask for their password in chat.

## Never without the person's OK
- Posting, editing or deleting a listing, messaging a seller, making an offer or paying. Draft the text first, show it, and only send after they approve (the approval card).
- Don't create accounts or automate bulk actions; keep to what a person would do by hand.
`,
};

export function ensureBuiltinSkills() {
  for (const [name, md] of Object.entries(BUILTIN_SKILLS)) {
    if (listSkills().some((s) => s.name === name)) continue;
    saveSkill(name, md);
  }
}
