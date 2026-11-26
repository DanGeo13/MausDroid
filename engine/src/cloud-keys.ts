import { spawn, type ChildProcess } from "node:child_process";
import nacl from "tweetnacl";
import { blake2b } from "blakejs";
import { emit } from "./events.ts";
import { getSecret } from "./secrets.ts";
import { findClaudeKey, install, programCommand, programEnv, workDir } from "./subscriptions.ts";
import { CODE_REPO } from "./selfupdate.ts";

/**
 * Setting up cloud builds from the phone (nothing to install on a computer):
 *  - "Connect": the official Claude program on the phone makes a separate,
 *    long-lived key for cloud builds (`claude setup-token`, sign in on
 *    Claude's own page), and MausDroid saves it straight into the GitHub
 *    repository's secrets — it's never shown or copied by hand.
 *  - A checklist of what cloud builds need.
 */
const GH = process.env.MAUSDROID_GITHUB_API ?? "https://api.github.com";

function gh(p: string, init: RequestInit = {}) {
  const token = getSecret("github");
  if (!token) throw new Error("Save a GitHub token first (Settings → Memory → GitHub token).");
  return fetch(`${GH}${p}`, { ...init, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "MausDroid-improver", "content-type": "application/json", ...(init.headers ?? {}) }, signal: AbortSignal.timeout(30_000) });
}

/** libsodium's sealed box (what GitHub requires for secrets): anyone can seal, only the repo can open. */
export function sealedBox(message: string, publicKeyB64: string): string {
  const pk = new Uint8Array(Buffer.from(publicKeyB64, "base64"));
  const eph = nacl.box.keyPair();
  const both = new Uint8Array(64);
  both.set(eph.publicKey, 0);
  both.set(pk, 32);
  const nonce = blake2b(both, undefined, 24);
  const boxed = nacl.box(new Uint8Array(Buffer.from(message, "utf8")), nonce, pk, eph.secretKey);
  const out = new Uint8Array(32 + boxed.length);
  out.set(eph.publicKey, 0);
  out.set(boxed, 32);
  return Buffer.from(out).toString("base64");
}

const permissionHelp = "Your GitHub token needs “Secrets: Read and write” for the MausDroid repository (github.com → Settings → Developer settings → Fine-grained tokens → edit the token).";

/** Saves a secret in the repository (encrypted on the phone with the repository's key). */
export async function saveRepoSecret(name: string, value: string) {
  const k = await gh(`/repos/${CODE_REPO}/actions/secrets/public-key`);
  if (k.status === 403 || k.status === 404) throw new Error(`GitHub refused (HTTP ${k.status}). ${permissionHelp}`);
  if (!k.ok) throw new Error(`GitHub said HTTP ${k.status}.`);
  const { key, key_id } = (await k.json()) as { key: string; key_id: string };
  const r = await gh(`/repos/${CODE_REPO}/actions/secrets/${name}`, { method: "PUT", body: JSON.stringify({ encrypted_value: sealedBox(value, key), key_id }) });
  if (r.status === 403 || r.status === 404) throw new Error(`GitHub refused (HTTP ${r.status}). ${permissionHelp}`);
  if (!r.ok) throw new Error(`GitHub said HTTP ${r.status} saving ${name}.`);
}

export const NEEDED = ["CLAUDE_CODE_OAUTH_TOKEN", "CODEX_AUTH_JSON", "OPENAI_API_KEY", "MAUSDROID_UPDATE_KEY_PEM"] as const;

/** What cloud builds need, and what's there (secret names only — values can't be read). */
export async function checklist() {
  const out: { githubToken: boolean; secrets: Record<string, boolean> | null; problem?: string; repo: string } = { githubToken: Boolean(getSecret("github")), secrets: null, repo: CODE_REPO };
  if (!out.githubToken) return { ...out, problem: "No GitHub token saved yet (Settings → Memory → GitHub token)." };
  try {
    const r = await gh(`/repos/${CODE_REPO}/actions/secrets?per_page=100`);
    if (r.status === 403 || r.status === 404) return { ...out, problem: permissionHelp };
    if (!r.ok) return { ...out, problem: `GitHub said HTTP ${r.status}.` };
    const names = new Set((((await r.json()) as any).secrets ?? []).map((s: any) => s.name));
    out.secrets = Object.fromEntries(NEEDED.map((n) => [n, names.has(n)]));
  } catch (e) {
    out.problem = (e as Error).message;
  }
  return out;
}

// ---------------- Connect: a Claude key for cloud builds ----------------

export interface ConnectState {
  stage: "idle" | "signing-in" | "saving" | "done" | "error";
  message?: string;
  loginUrl?: string;
  needsCode?: boolean;
}
let state: ConnectState = { stage: "idle" };
let child: ChildProcess | null = null;
let watchdog: NodeJS.Timeout | null = null;
export const connectState = () => state;
const set = (p: Partial<ConnectState>) => {
  state = { ...state, ...p };
  emit("improve.changed", {});
};
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

export async function startConnect(openUrl: (url: string) => Promise<void>) {
  if (!getSecret("github")) throw new Error("Save a GitHub token first (Settings → Memory → GitHub token).");
  child?.kill();
  set({ stage: "signing-in", message: "Opening Claude's sign-in page…", loginUrl: undefined, needsCode: false });
  try {
    await install("claude");
  } catch (e) {
    return set({ stage: "error", message: `The Claude program couldn't be set up on this phone: ${(e as Error).message}` });
  }
  const [cmd, args] = programCommand("claude", ["setup-token"]);
  const c = spawn(cmd, args, { cwd: workDir(), env: programEnv("claude") });
  child = c;
  let log = "";
  let opened = false;
  let saved = false;
  const onData = (d: Buffer) => {
    log = (log + stripAnsi(d.toString("utf8"))).slice(-8000);
    const compact = log.replace(/\n(?=\S)/g, (m, off) => (/[A-Za-z0-9%&=._~:/?#-]$/.test(log.slice(0, off)) ? "" : m));
    const tok = findClaudeKey(log);
    if (tok && !saved) {
      saved = true;
      if (watchdog) clearTimeout(watchdog);
      set({ stage: "saving", message: "Saving the key to GitHub…", needsCode: false, loginUrl: undefined });
      void saveRepoSecret("CLAUDE_CODE_OAUTH_TOKEN", tok)
        .then(() => set({ stage: "done", message: "Connected ✓ — cloud builds can use your Claude subscription." }))
        .catch((e) => set({ stage: "error", message: (e as Error).message }))
        .finally(() => c.kill());
      return;
    }
    const url = compact.match(/https:\/\/[^\s"'<>]+(oauth|authorize)[^\s"'<>]*/)?.[0];
    const needsCode = /paste|authorization code|enter.*code/i.test(log);
    if (url) set({ loginUrl: url, needsCode });
    if (url && !opened) {
      opened = true;
      set({ message: "Sign in on Claude's page that opened, then paste the code here." });
      void openUrl(url).catch(() => {});
    }
  };
  c.stdout?.on("data", onData);
  c.stderr?.on("data", onData);
  c.on("error", (e) => set({ stage: "error", message: `The Claude program couldn't start on this phone (${e.message}).` }));
  c.on("close", (code) => {
    if (child === c) child = null;
    if (state.stage === "signing-in") {
      const reason = log.split("\n").map((l) => l.trim()).filter(Boolean).reverse().find((l) => /error|couldn't|failed|invalid|expired|denied|not accepted|wasn't/i.test(l));
      set({ stage: "error", message: `${reason ?? `It didn't finish (exit ${code}).`} Tap Connect to try again.`, loginUrl: undefined, needsCode: false });
    }
  });
}

export function connectCode(code: string) {
  if (!child?.stdin) throw new Error("Nothing is waiting for a code. Tap Connect again.");
  child.stdin.write(`${code.trim()}\n`);
  set({ message: "Checking the code…", needsCode: false });
  if (watchdog) clearTimeout(watchdog);
  watchdog = setTimeout(() => {
    if (state.stage !== "signing-in") return;
    child?.kill();
    set({ stage: "error", message: "Claude didn't answer within 90 seconds. Tap Connect to try again." });
  }, 90_000);
}

export function cancelConnect() {
  child?.kill();
  child = null;
  set({ stage: "idle", message: undefined, loginUrl: undefined, needsCode: false });
}

/** Keys you add from a file or by pasting (e.g. the update signing key); only these names. */
export async function addSecret(name: string, value: string) {
  if (!(NEEDED as readonly string[]).includes(name) || name === "CLAUDE_CODE_OAUTH_TOKEN") throw new Error("That key can't be added here.");
  const v = value.trim();
  if (name === "MAUSDROID_UPDATE_KEY_PEM" && !/^-----BEGIN (EC )?PRIVATE KEY-----[\s\S]+-----END (EC )?PRIVATE KEY-----$/.test(v)) throw new Error("That isn't the update signing key file (update-signing-key.pem).");
  if (name === "CODEX_AUTH_JSON") {
    try {
      JSON.parse(v);
    } catch {
      throw new Error("That isn't a Codex auth.json file.");
    }
  }
  if (!v) throw new Error("Empty.");
  await saveRepoSecret(name, `${v}\n`);
}
