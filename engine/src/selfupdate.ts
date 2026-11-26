import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";
import { getSecret } from "./secrets.ts";
import { clip } from "./util.ts";

/**
 * Self-improvement of MausDroid's own program:
 *  - builds: Improver asks a Claude Code session in the cloud (GitHub
 *    Actions, .github/workflows/improver.yml) to make a change; it edits the
 *    source, runs every test and opens a pull request. Installing it (merging)
 *    publishes a signed engine update that the phone installs by itself.
 *  - rollback: switch back to any earlier engine version kept on the phone,
 *    instantly. (An update that doesn't start is rolled back automatically.)
 */
export const CODE_REPO = process.env.MAUSDROID_CODE_REPO ?? "DanGeo13/MausDroid";
const GH = process.env.MAUSDROID_GITHUB_API ?? "https://api.github.com";
const WORKFLOW = "improver.yml";

// ---------------- Versions on the phone, rollback ----------------

/** Where the phone keeps engine versions (…/engines/<version>/ui is the UI folder). */
export function enginesRoot(): string | null {
  const ui = process.env.MAUSDROID_UI_DIR;
  if (!ui || config.platform !== "android") return process.env.MAUSDROID_ENGINES_DIR ?? null;
  return path.dirname(path.dirname(ui));
}

const cmp = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

export function engineVersions() {
  const root = enginesRoot();
  const running = config.version;
  if (!root || !fs.existsSync(root)) return { running, canRollBack: false, versions: [] as { version: string; bad: boolean; running: boolean }[] };
  const bad = fs.existsSync(path.join(root, "bad.txt")) ? fs.readFileSync(path.join(root, "bad.txt"), "utf8").split("\n").map((x) => x.trim()).filter(Boolean) : [];
  const versions = fs
    .readdirSync(root)
    .filter((d) => /^\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(root, d, "engine.cjs")))
    .sort((a, b) => cmp(b, a))
    .map((v) => ({ version: v, bad: bad.includes(v), running: v === running }));
  return { running, canRollBack: versions.some((v) => !v.running && cmp(v.version, running) < 0), versions };
}

let restarting = false;
/**
 * Goes back to an earlier engine (default: the newest one older than the
 * running one). The running version is set aside so it isn't downloaded
 * again; MausDroid restarts in a couple of seconds.
 */
export function rollBack(to?: string): { from: string; to: string } {
  const root = enginesRoot();
  if (!root) throw new Error("Rolling back works in the Android app.");
  const { running, versions } = engineVersions();
  const target = to ? versions.find((v) => v.version === to) : versions.find((v) => cmp(v.version, running) < 0);
  if (!target) throw new Error(to ? `Version ${to} isn't on the phone. Kept versions: ${versions.map((v) => v.version).join(", ") || "none"}.` : "There's no earlier version on the phone to go back to.");
  if (target.version === running) throw new Error(`${running} is already running.`);
  if (restarting) throw new Error("Already restarting.");
  if (cmp(target.version, running) < 0) fs.appendFileSync(path.join(root, "bad.txt"), `${running}\n`);
  // Going forward again: that version is no longer set aside.
  const badFile = path.join(root, "bad.txt");
  if (fs.existsSync(badFile)) fs.writeFileSync(badFile, fs.readFileSync(badFile, "utf8").split("\n").filter((x) => x.trim() && x.trim() !== target.version).map((x) => `${x}\n`).join(""));
  fs.writeFileSync(path.join(root, "current.txt"), target.version);
  for (const f of ["trial.txt", "trial-started.txt"]) fs.rmSync(path.join(root, f), { force: true });
  restarting = true;
  // The app restarts the engine when it stops; give the reply time to reach the screen first.
  setTimeout(() => process.exit(0), Number(process.env.MAUSDROID_RESTART_DELAY_MS ?? 2500));
  return { from: running, to: target.version };
}

// ---------------- Cloud builds ----------------

function gh(p: string, init: RequestInit = {}) {
  const token = getSecret("github");
  if (!token) throw new Error("Save a GitHub token first (Settings → Memory → GitHub token) with access to the MausDroid repository (Actions, Contents and Pull requests: read and write).");
  return fetch(`${GH}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "MausDroid-improver", "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
}

async function ghJson(p: string, init: RequestInit = {}) {
  const r = await gh(p, init);
  const text = await r.text();
  let j: any = {};
  try {
    j = text ? JSON.parse(text) : {};
  } catch {
    /* not JSON */
  }
  if (!r.ok) throw new Error(`GitHub said HTTP ${r.status}${j?.message ? `: ${j.message}` : ""}`);
  return j;
}

/** Starts the cloud Claude Code build for a change (again with answers, if it asked questions). */
export type Agent = "claude" | "codex";
export const AGENT_NAMES: Record<Agent, string> = { claude: "Claude Code", codex: "Codex" };

export async function startBuild(id: string, request: string, answers = "", attempt = 1, agent: Agent = "claude") {
  await ghJson(`/repos/${CODE_REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { id, request: clip(request, 6000), answers: clip(answers, 4000), attempt: String(attempt), platform: agent } }),
  });
}

export interface BuildState {
  state: "building" | "question" | "ready" | "failed" | "merged" | "closed";
  prNumber?: number;
  prUrl?: string;
  runUrl?: string;
  detail?: string;
  /** Plain-words progress of the cloud work ("Running every test"). */
  progress?: string;
  questions?: string;
}

const STEP_WORDS: [RegExp, string][] = [
  [/Claude Code makes the change/, "Claude Code is making the change"],
  [/Codex makes the change/, "Codex is making the change"],
  [/Write the instructions/, "Writing up the job"],
  [/Questions for the person/, "Checking whether it needs anything from you"],
  [/Only the engine/, "Checking only allowed parts changed"],
  [/Next engine version/, "Numbering the new version"],
  [/Build and test/, "Running every test (like on your phone)"],
  [/Open the pull request/, "Getting it ready to install"],
];
const stepWords = (name: string) => STEP_WORDS.find(([re]) => re.test(name))?.[1] ?? "Setting up";

/** Where a build is: running (and which step), asking you something, ready to install, or failed. */
export async function buildState(id: string, attempt = 1, title = ""): Promise<BuildState> {
  const owner = CODE_REPO.split("/")[0];
  const prs = await ghJson(`/repos/${CODE_REPO}/pulls?state=all&head=${owner}:improve/${id}`);
  const pr = Array.isArray(prs) ? prs[0] : null;
  if (pr) {
    if (pr.merged_at) return { state: "merged", prNumber: pr.number, prUrl: pr.html_url };
    if (pr.state === "closed") return { state: "closed", prNumber: pr.number, prUrl: pr.html_url };
    return { state: "ready", prNumber: pr.number, prUrl: pr.html_url };
  }
  const q = await gh(`/repos/${CODE_REPO}/contents/.improver/questions-${attempt}.md?ref=${encodeURIComponent(`improve/${id}-questions`)}`);
  if (q.ok) {
    const j = (await q.json()) as any;
    return { state: "question", questions: clip(Buffer.from(String(j.content ?? ""), "base64").toString("utf8").trim(), 3000) };
  }
  const runs = await ghJson(`/repos/${CODE_REPO}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30`);
  const run = (runs.workflow_runs ?? []).find((r: any) => String(r.display_title ?? r.name ?? "").includes(id));
  // The build finished and saved its branch, but GitHub doesn't let its own runs open pull requests
  // (a repository setting, off by default): the phone opens it with your token instead.
  if (run && run.status === "completed" && run.conclusion === "success") {
    const br = await gh(`/repos/${CODE_REPO}/branches/${encodeURIComponent(`improve/${id}`)}`);
    if (br.ok) {
      const created = await ghJson(`/repos/${CODE_REPO}/pulls`, { method: "POST", body: JSON.stringify({ title: `Improver: ${clip(title || id, 70)}`, head: `improve/${id}`, base: "main", body: `Built by the cloud coding agent from a request made through MausDroid's Improver (${id}). All tests passed.` }) });
      return { state: "ready", prNumber: created.number, prUrl: created.html_url };
    }
  }
  if (run && run.status === "completed" && run.conclusion !== "success") return { state: "failed", runUrl: run.html_url, detail: `The cloud build ${run.conclusion} (tests failing, no change made, or it ran out of time).` };
  let progress = run ? "Waiting for a cloud computer" : "Starting";
  if (run && run.status === "in_progress") {
    try {
      const jobs = await ghJson(`/repos/${CODE_REPO}/actions/runs/${run.id}/jobs`);
      const steps = (jobs.jobs?.[0]?.steps ?? []) as { name: string; status: string }[];
      const cur = steps.find((x) => x.status === "in_progress") ?? steps.filter((x) => x.status === "completed").at(-1);
      if (cur) progress = stepWords(cur.name);
    } catch {
      /* progress is optional */
    }
  }
  return { state: "building", runUrl: run?.html_url, progress };
}

/** Installs a finished build: merges its pull request, which publishes the update. */
export async function mergeBuild(prNumber: number) {
  await ghJson(`/repos/${CODE_REPO}/pulls/${prNumber}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash" }) });
}

export async function closeBuild(prNumber: number) {
  await ghJson(`/repos/${CODE_REPO}/pulls/${prNumber}`, { method: "PATCH", body: JSON.stringify({ state: "closed" }) });
}
