import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import nacl from "tweetnacl";
import { blake2b } from "blakejs";
import { emit } from "./events.ts";
import { getSecret } from "./secrets.ts";
import { findClaudeKey, install, programCommand, programEnv, workDir } from "./subscriptions.ts";
import { CODE_REPO } from "./selfupdate.ts";
import { terminalText } from "./util.ts";
import { dataPath } from "./store.ts";
export { terminalText };

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
let inTerminal = false;
/** What Claude's program printed after the code was sent (to spot its answer). */
let afterCode = "";
let codeSent = false;
let lastLog = "";
const hideKeys = (t: string) => t.replace(/sk-ant-[0-9A-Za-z_-]{6,}/g, "sk-ant-…(hidden)");
const lastLines = (t: string, n = 5) =>
  hideKeys(t)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /[A-Za-z]{3}/.test(l) && !/^[╭╰│─\s]+$/.test(l))
    .slice(-n)
    .join(" · ")
    .slice(0, 400);
let noLinkTimer: NodeJS.Timeout | null = null;
let watchdog: NodeJS.Timeout | null = null;
export const connectState = () => state;
const set = (p: Partial<ConnectState>) => {
  state = { ...state, ...p };
  emit("improve.changed", {});
};
const stripAnsi = terminalText;

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
  // `claude setup-token` only shows its sign-in link in a terminal: run it inside MausDroid's terminal helper.
  const helper = process.env.MAUSDROID_NATIVE_DIR ? path.join(process.env.MAUSDROID_NATIVE_DIR, "libtsbridge.so") : process.env.MAUSDROID_PTY_HELPER;
  inTerminal = Boolean(helper && fs.existsSync(helper));
  const c = inTerminal ? spawn(helper!, ["pty", cmd, ...args], { cwd: workDir(), env: { ...programEnv("claude"), TERM: "xterm-256color" } }) : spawn(cmd, args, { cwd: workDir(), env: programEnv("claude") });
  // A fresh Claude install shows welcome screens (theme, notes) first: press Enter until the link appears.
  if (inTerminal) {
    let nudges = 0;
    const nudge = setInterval(() => {
      if (state.stage !== "signing-in" || state.loginUrl || child !== c || ++nudges > 8) return clearInterval(nudge);
      c.stdin?.write("\r");
    }, Number(process.env.MAUSDROID_CONNECT_NUDGE_MS ?? 3000));
  }
  // Never wait silently: if no link shows up, say what the program printed.
  if (noLinkTimer) clearTimeout(noLinkTimer);
  noLinkTimer = setTimeout(() => {
    if (state.stage !== "signing-in" || state.loginUrl) return;
    const said = log.split("\n").map((l) => l.trim()).filter((l) => /[A-Za-z]{3}/.test(l)).slice(-4).join(" · ");
    c.kill();
    set({ stage: "error", message: `Claude's program didn't show a sign-in link${said ? ` (it said: ${said.slice(0, 300)})` : " (it printed nothing)"}. Tap Connect to try again, and send this message to your developer session if it keeps happening.` });
  }, Number(process.env.MAUSDROID_CONNECT_LINK_MS ?? 25_000));
  child = c;
  let log = "";
  let opened = false;
  let saved = false;
  afterCode = "";
  codeSent = false;
  const onData = (d: Buffer) => {
    const text = stripAnsi(d.toString("utf8"));
    log = (log + text).slice(-8000);
    lastLog = log;
    if (codeSent) afterCode = (afterCode + text).slice(-8000);
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
    // Claude's answer to the code: in a terminal the program stays open after an error, so read it here.
    if (codeSent && !saved && state.stage === "signing-in") {
      const err = afterCode.split("\n").map((l) => l.trim()).find((l) => /✘|OAuth error|error:|wasn't accepted|expired|invalid code|denied/i.test(l));
      if (err) {
        if (watchdog) clearTimeout(watchdog);
        set({ stage: "error", message: `${hideKeys(err).replace(/^✘\s*/, "")} Tap Connect to try again (each code works once).`, loginUrl: undefined, needsCode: false });
        c.kill();
        return;
      }
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
  const c = child;
  afterCode = "";
  codeSent = true;
  // A terminal expects Enter as "\r"; a plain pipe a newline.
  c.stdin!.write(`${code.trim()}${inTerminal ? "\r" : "\n"}`);
  set({ message: "Checking the code…", needsCode: false });
  if (watchdog) clearTimeout(watchdog);
  // If Claude shows one more screen (e.g. "press Enter"), nudge once.
  const nudge = setTimeout(() => {
    if (state.stage === "signing-in" && child === c && inTerminal) c.stdin?.write("\r");
  }, Number(process.env.MAUSDROID_CONNECT_AFTER_NUDGE_MS ?? 40_000));
  watchdog = setTimeout(() => {
    clearTimeout(nudge);
    if (state.stage !== "signing-in") return;
    const said = lastLines(afterCode || lastLog);
    console.log(`[connect-claude] no key after the code; Claude's screen said: ${said}`);
    child?.kill();
    set({ stage: "error", message: `Claude didn't finish within 2 minutes${said ? ` — its screen said: “${said}”` : " and printed nothing after the code"}. Tap Connect to try again with a new code, and send this message to your developer session if it happens again.` });
  }, Number(process.env.MAUSDROID_CONNECT_CODE_MS ?? 120_000));
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
  if (name === "OPENAI_API_KEY" && !/^sk-[A-Za-z0-9_-]{20,}$/.test(v)) throw new Error("That doesn't look like an OpenAI API key (they start with sk-).");
  if (!v) throw new Error("Empty.");
  await saveRepoSecret(name, `${v}\n`);
}

// ---------------- Connect: a ChatGPT (Codex) login for cloud builds ----------------

let codexState: ConnectState = { stage: "idle" };
let codexChild: ChildProcess | null = null;
export const codexConnectState = () => codexState;
const setCodex = (p: Partial<ConnectState>) => {
  codexState = { ...codexState, ...p };
  emit("improve.changed", {});
};

/** A separate Codex login just for cloud builds (the phone's own ChatGPT sign-in isn't touched). */
export const codexCloudHome = () => path.dirname(dataPath("subs", "codex-cloud", ".keep"));

/** Signs in to ChatGPT with the official Codex program (its own folder), then saves the login to GitHub as CODEX_AUTH_JSON. */
export async function startCodexConnect(openUrl: (url: string) => Promise<void>) {
  if (!getSecret("github")) throw new Error("Save a GitHub token first (Settings → Memory → GitHub token).");
  codexChild?.kill();
  setCodex({ stage: "signing-in", message: "Opening the ChatGPT sign-in page…", loginUrl: undefined, needsCode: false });
  try {
    await install("chatgpt");
  } catch (e) {
    return setCodex({ stage: "error", message: `The Codex program couldn't be set up on this phone: ${(e as Error).message}` });
  }
  const home = codexCloudHome();
  fs.mkdirSync(home, { recursive: true });
  fs.rmSync(path.join(home, "auth.json"), { force: true });
  const [cmd, args] = programCommand("chatgpt", ["login"]);
  const c = spawn(cmd, args, { cwd: workDir(), env: { ...programEnv("chatgpt"), CODEX_HOME: home } });
  codexChild = c;
  let log = "";
  let opened = false;
  const giveUp = setTimeout(() => {
    if (codexState.stage !== "signing-in") return;
    c.kill();
    setCodex({ stage: "error", message: `The ChatGPT sign-in didn't finish within 5 minutes${lastLines(log) ? ` (Codex said: “${lastLines(log)}”)` : ""}. Tap Connect with ChatGPT to try again.`, loginUrl: undefined });
  }, Number(process.env.MAUSDROID_CODEX_CONNECT_MS ?? 300_000));
  const onData = (d: Buffer) => {
    log = (log + terminalText(d.toString("utf8"))).slice(-8000);
    const url = log.match(/https:\/\/auth\.openai\.com\/[^\s"'<>]+/)?.[0];
    if (url && !opened) {
      opened = true;
      setCodex({ loginUrl: url, message: "Sign in on the ChatGPT page that opened. MausDroid finishes by itself when you're done." });
      void openUrl(url).catch(() => {});
    }
  };
  c.stdout?.on("data", onData);
  c.stderr?.on("data", onData);
  c.on("error", (e) => setCodex({ stage: "error", message: `The Codex program couldn't start on this phone (${e.message}).` }));
  c.on("close", (code) => {
    clearTimeout(giveUp);
    if (codexChild === c) codexChild = null;
    if (codexState.stage !== "signing-in") return;
    const auth = path.join(home, "auth.json");
    if (code === 0 && fs.existsSync(auth)) {
      setCodex({ stage: "saving", message: "Saving the ChatGPT login to GitHub…", loginUrl: undefined });
      void saveRepoSecret("CODEX_AUTH_JSON", fs.readFileSync(auth, "utf8"))
        .then(() => setCodex({ stage: "done", message: "Connected ✓ — cloud builds can use Codex with your ChatGPT subscription." }))
        .catch((e) => setCodex({ stage: "error", message: (e as Error).message }));
    } else setCodex({ stage: "error", message: `The ChatGPT sign-in didn't finish${lastLines(log) ? ` (Codex said: “${lastLines(log)}”)` : ` (exit ${code})`}. Tap Connect with ChatGPT to try again.`, loginUrl: undefined });
  });
}

export function cancelCodexConnect() {
  codexChild?.kill();
  codexChild = null;
  setCodex({ stage: "idle", message: undefined, loginUrl: undefined });
}

/** Before a Codex cloud build: send the newest copy of the cloud login (if there is one). */
export async function refreshCodexSecret() {
  const auth = path.join(codexCloudHome(), "auth.json");
  if (fs.existsSync(auth)) await saveRepoSecret("CODEX_AUTH_JSON", fs.readFileSync(auth, "utf8")).catch(() => {});
}
