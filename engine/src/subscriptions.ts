import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { config } from "./config.ts";
import { dataPath } from "./store.ts";
import { emit } from "./events.ts";
import { getSecret, setSecret } from "./secrets.ts";
import { download, extractTarGz } from "./archive.ts";
import { errorText } from "./util.ts";

/**
 * Subscription sign-in for Claude and ChatGPT — by login only, never
 * an API key. Each uses the company's own official program, downloaded to
 * the phone, and that program's own sign-in page:
 *   Claude  → Claude Code   (claude auth login)    · your Claude Pro/Max plan
 *   ChatGPT → Codex         (codex login)          · your ChatGPT plan
 * If a program can't run on this phone, the bot uses your computer instead
 * (the MausDroid companion), when one is set up.
 */
export type SubId = "claude" | "chatgpt";
export const SUBS: Record<SubId, { label: string; program: string; company: string }> = {
  claude: { label: "Claude", program: "Claude Code", company: "Anthropic" },
  chatgpt: { label: "ChatGPT", program: "Codex", company: "OpenAI" },
};

export interface SubStatus {
  id: SubId;
  stage: "not-installed" | "installing" | "installed" | "signing-in" | "signed-in" | "error";
  progress?: number;
  message?: string;
  loginUrl?: string;
  needsCode?: boolean;
  log?: string;
}

const status = new Map<SubId, SubStatus>();
const root = () => path.dirname(dataPath("subs", ".keep"));
const bin = (...p: string[]) => path.join(root(), "bin", ...p);
const lib = () => path.join(root(), "lib");
export const subHome = (id: SubId) => {
  const h = path.join(root(), "home", id);
  fs.mkdirSync(h, { recursive: true });
  return h;
};
/** Where the programs work; also holds the short ".mausld" link to the loader. */
export const workDir = () => {
  const w = path.join(root(), "work");
  fs.mkdirSync(w, { recursive: true });
  const link = path.join(w, ".mausld");
  const target = path.join(lib(), "ld-musl-aarch64.so.1");
  if (fs.existsSync(target) && !fs.existsSync(link)) fs.symlinkSync(target, link);
  return w;
};

const signedInListeners: ((id: SubId) => void)[] = [];
/** Called whenever a sign-in completes. */
export const onSignedIn = (fn: (id: SubId) => void) => signedInListeners.push(fn);

function set(id: SubId, patch: Partial<SubStatus>) {
  const before = status.get(id)?.stage;
  const s = { ...(status.get(id) ?? { id, stage: "not-installed" as const }), ...patch, id };
  status.set(id, s);
  emit("subs.changed", { id, status: s });
  if (s.stage === "signed-in" && before !== "signed-in") for (const l of signedInListeners) l(id);
}

const installed = (id: SubId) =>
  id === "chatgpt" ? fs.existsSync(bin("codex")) : fs.existsSync(bin("claude")) && hasMusl();
const hasMusl = () => fs.existsSync(path.join(lib(), "ld-musl-aarch64.so.1"));

/** Claude Code keeps its sign-in in ~/.claude/.credentials.json; MausDroid also leaves a marker. */
const claudeCreds = () => [path.join(subHome("claude"), ".claude", ".credentials.json"), path.join(subHome("claude"), ".mausdroid-signed-in")];

export function isSignedIn(id: SubId): boolean {
  if (id === "claude") return Boolean(getSecret("sub:claude:token")) || claudeCreds().some((f) => fs.existsSync(f));
  return fs.existsSync(path.join(subHome("chatgpt"), ".codex", "auth.json"));
}

export function subStatus(id: SubId): SubStatus {
  const s = status.get(id);
  if (s && (s.stage === "installing" || s.stage === "signing-in" || s.stage === "error")) return s;
  return { id, stage: isSignedIn(id) ? "signed-in" : installed(id) ? "installed" : "not-installed", message: s?.message };
}

export const allSubs = () => (Object.keys(SUBS) as SubId[]).map((id) => ({ ...subStatus(id), ...SUBS[id] }));

// ---------------- Installing the official programs ----------------

async function npmTarball(pkg: string, version?: string) {
  const meta: any = await (await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}`)).json();
  const v = version ?? meta["dist-tags"]?.latest;
  const d = meta.versions?.[v]?.dist;
  if (!d) throw new Error(`Couldn't find ${pkg}@${v} on npm`);
  return { version: v, url: d.tarball as string, integrity: d.integrity as string };
}

function checkIntegrity(file: string, integrity: string) {
  const [algo, want] = integrity.split("-");
  const got = crypto.createHash(algo).update(fs.readFileSync(file)).digest("base64");
  if (got !== want) throw new Error("Download check failed (file damaged). Try again.");
}

/** Official Alpine Linux packages for the musl loader and C++ libraries the programs need. */
async function ensureMusl(id: SubId) {
  if (hasMusl()) return;
  set(id, { message: "Getting system libraries (Alpine Linux)…" });
  const base = "https://dl-cdn.alpinelinux.org/alpine/latest-stable/main/aarch64";
  const idxFile = path.join(root(), "dl", "APKINDEX.tar.gz");
  await download(`${base}/APKINDEX.tar.gz`, idxFile);
  const idxOut = path.join(root(), "dl", "APKINDEX");
  await extractTarGz(idxFile, (n) => (n === "APKINDEX" ? idxOut : null));
  const index = fs.readFileSync(idxOut, "utf8");
  const versionOf = (pkg: string) => index.match(new RegExp(`\\nP:${pkg.replace(/[+]/g, "\\+")}\\nV:([^\\n]+)`))?.[1];
  for (const pkg of ["musl", "libstdc++", "libgcc"]) {
    const v = versionOf(pkg);
    if (!v) {
      if (pkg === "musl") throw new Error(`Alpine package ${pkg} not found`);
      continue;
    }
    const f = path.join(root(), "dl", `${pkg}-${v}.apk`);
    await download(`${base}/${pkg}-${v}.apk`, f);
    await extractTarGz(f, (n) => (/^(usr\/)?lib\/[^/]+\.so[.\d]*$/.test(n) ? path.join(lib(), path.basename(n)) : null));
    fs.rmSync(f, { force: true });
  }
  if (!fs.existsSync(path.join(lib(), "libc.musl-aarch64.so.1"))) fs.copyFileSync(path.join(lib(), "ld-musl-aarch64.so.1"), path.join(lib(), "libc.musl-aarch64.so.1"));
  if (!hasMusl()) throw new Error("The system library download didn't contain the loader.");
}

/**
 * Points a Linux program at the downloaded loader. The loader path inside the
 * program is changed to "./.mausld" (a link in the work folder), so the
 * program still starts as itself — Claude Code needs that to find its code.
 */
function patchInterpreter(file: string) {
  const b = fs.readFileSync(file);
  const old = Buffer.from("/lib/ld-musl-aarch64.so.1\0");
  const i = b.indexOf(old);
  if (i < 0) return;
  const neu = Buffer.alloc(old.length);
  Buffer.from("./.mausld\0").copy(neu);
  neu.copy(b, i);
  fs.writeFileSync(file, b, { mode: 0o755 });
}

const progress = (id: SubId, what: string) => (done: number, total: number) => {
  const pct = total ? Math.round((done / total) * 100) : undefined;
  const s = status.get(id);
  if (pct !== undefined && s?.progress === pct) return;
  set(id, { progress: pct, message: `Downloading ${what}… ${pct !== undefined ? `${pct}%` : `${Math.round(done / 1e6)} MB`}` });
};

export async function install(id: SubId) {
  if (installed(id)) return;
  if (process.arch !== "arm64" && config.platform === "android") throw new Error("Only 64-bit phones are supported.");
  set(id, { stage: "installing", progress: 0, message: "Starting download…" });
  fs.mkdirSync(bin(), { recursive: true });
  const dl = path.join(root(), "dl");
  if (id === "chatgpt") {
    const top = await npmTarball("@openai/codex");
    const t = await npmTarball("@openai/codex", `${top.version}-linux-arm64`);
    const f = path.join(dl, "codex.tgz");
    await download(t.url, f, progress(id, `Codex ${top.version} (about 170 MB)`));
    checkIntegrity(f, t.integrity);
    set(id, { message: "Unpacking…" });
    await extractTarGz(f, (n) => (/aarch64-unknown-linux-musl\/bin\/(codex|codex-code-mode-host)$/.test(n) ? bin(path.basename(n)) : null));
    fs.rmSync(f, { force: true });
  } else {
    await ensureMusl(id);
    const t = await npmTarball("@anthropic-ai/claude-code-linux-arm64-musl");
    const f = path.join(dl, "claude.tgz");
    await download(t.url, f, progress(id, `Claude Code ${t.version} (about 170 MB)`));
    checkIntegrity(f, t.integrity);
    set(id, { message: "Unpacking…" });
    await extractTarGz(f, (n) => (n === "package/claude" ? bin("claude") : null));
    fs.rmSync(f, { force: true });
    patchInterpreter(bin("claude"));
  }
  set(id, { stage: "installed", progress: undefined, message: `${SUBS[id].program} is installed.` });
}

// ---------------- Running the programs ----------------

let certFile: string | null = null;
/** CA certificates for the Linux programs (Android keeps them in a different format). */
function caBundle() {
  if (certFile && fs.existsSync(certFile)) return certFile;
  certFile = path.join(root(), "cacert.pem");
  fs.writeFileSync(certFile, tls.rootCertificates.join("\n"));
  return certFile;
}

export function programEnv(id: SubId): NodeJS.ProcessEnv {
  const proxy = `http://127.0.0.1:${config.port + 3}`;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: subHome(id),
    TMPDIR: path.dirname(dataPath("tmp", "x")),
    // These Linux programs can't read Android's network settings, so their
    // traffic goes through MausDroid's local proxy, which resolves names.
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    SSL_CERT_FILE: caBundle(),
    LD_LIBRARY_PATH: lib(),
    SHELL: "/system/bin/sh",
    // No browser for the programs to open: MausDroid opens sign-in pages itself.
    BROWSER: fs.existsSync("/system/bin/true") ? "/system/bin/true" : "true",
    TERM: "xterm-256color",
    NO_COLOR: "1",
  };
  if (id === "claude") {
    const tok = getSecret("sub:claude:token");
    if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
    env.DISABLE_AUTOUPDATER = "1";
  }
  return env;
}

/** The command line to run a program; [cmd, args]. */
export function programCommand(id: SubId, args: string[]): [string, string[]] {
  if (id === "chatgpt") return [bin("codex"), args];
  return [bin("claude"), args];
}


// ---------------- Signing in ----------------

const sessions = new Map<SubId, ChildProcess>();
const watchdogs = new Map<SubId, NodeJS.Timeout>();
const viaPty = new Set<SubId>();
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "\n");

/**
 * Finds a Claude key (sk-ant-oat…) in program output. A key wrapped onto the
 * next line(s) is joined, but only lines made purely of key characters, so
 * the following text is never glued on.
 */
export function findClaudeKey(log: string): string | null {
  const lines = log.split(/\r?\n/).map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/sk-ant-oat[0-9A-Za-z_-]{20,}/);
    if (!m) continue;
    let tok = m[0];
    // Only if the key ran to the end of its line.
    if (lines[i].endsWith(tok)) for (let j = i + 1; j < lines.length && /^[0-9A-Za-z_-]+$/.test(lines[j]) && tok.length < 400; j++) tok += lines[j];
    return tok;
  }
  return null;
}

export async function signIn(id: SubId, openUrl: (url: string) => Promise<void>) {
  try {
    await install(id);
  } catch (e) {
    set(id, { stage: "error", message: `Couldn't install ${SUBS[id].program} on this phone: ${errorText(e)}` });
    return;
  }
  sessions.get(id)?.kill();
  workDir();
  // Plain sign-in commands: they print the sign-in link, read the code, save the login, and exit.
  const loginArgs = id === "chatgpt" ? ["login"] : ["auth", "login", "--claudeai"];
  const [cmd, args] = programCommand(id, loginArgs);
  // The terminal helper stays available for programs that need one; these two don't.
  const native = process.env.MAUSDROID_NATIVE_DIR;
  const usePty = Boolean(process.env.MAUSDROID_LOGIN_PTY) && native;
  const child = usePty ? spawn(path.join(native!, "libtsbridge.so"), ["pty", cmd, ...args], { cwd: workDir(), env: programEnv(id) }) : spawn(cmd, args, { cwd: workDir(), env: programEnv(id) });
  sessions.set(id, child);
  if (usePty) viaPty.add(id);
  else viaPty.delete(id);
  set(id, { stage: "signing-in", message: `Opening the ${SUBS[id].label} sign-in page…`, loginUrl: undefined, needsCode: false, log: "" });
  let log = "";
  let opened = false;
  const onData = (d: Buffer) => {
    // Keep readable lines only (drop spinner frames and box drawing).
    const clean = stripAnsi(d.toString("utf8"))
      .split("\n")
      .filter((l) => /[A-Za-z0-9]{2,}/.test(l))
      .join("\n");
    if (!clean.trim()) return;
    log = (log + "\n" + clean).replace(/\n{2,}/g, "\n").slice(-6000);
    const compact = log.replace(/\n(?=\S)/g, (m, off) => (/[A-Za-z0-9%&=._~:/?#-]$/.test(log.slice(0, off)) ? "" : m));
    const url = compact.match(/https:\/\/[^\s"'<>]+(oauth|authorize|auth\.openai\.com)[^\s"'<>]*/)?.[0];
    const needsCode = /paste|authorization code|enter.*code/i.test(log) && id !== "chatgpt";
    if (id === "claude") {
      const tok = findClaudeKey(log);
      if (tok) void setSecret("sub:claude:token", tok).then(() => set(id, { stage: "signed-in", message: "Signed in to Claude ✓", loginUrl: undefined, needsCode: false }));
    }
    set(id, { log: log.slice(-1500), ...(url ? { loginUrl: url } : {}), needsCode });
    if (url && !opened) {
      opened = true;
      set(id, { message: `Sign in on the ${SUBS[id].label} page that opened.${needsCode ? " Then paste the code here." : ""}` });
      void openUrl(url).catch(() => {});
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (e) => set(id, { stage: "error", message: `${SUBS[id].program} couldn't start on this phone (${e.message}). Use "My computer" instead.` }));
  child.on("close", (code) => {
    if (sessions.get(id) === child) sessions.delete(id);
    clearTimeout(watchdogs.get(id));
    if (code === 0 && id === "claude" && !isSignedIn(id)) fs.writeFileSync(claudeCreds()[1], new Date().toISOString());
    if (isSignedIn(id)) set(id, { stage: "signed-in", message: `Signed in to ${SUBS[id].label} ✓`, loginUrl: undefined, needsCode: false });
    else if (status.get(id)?.stage === "signing-in") {
      // Show the program's own reason, e.g. "That code wasn't accepted…".
      const reason = log.split("\n").map((l) => l.trim()).filter(Boolean).reverse().find((l) => /error|couldn't|failed|invalid|expired|denied|not accepted|wasn't/i.test(l));
      set(id, { stage: "error", message: `${reason ? reason.replace(/^\[err\]/, "") : `Sign-in didn't finish (exit ${code}).`} Tap Sign in to try again.`, log: log.slice(-2500), loginUrl: undefined, needsCode: false });
    }
  });
}

export function sendCode(id: SubId, code: string) {
  const c = sessions.get(id);
  if (!c?.stdin) throw new Error("No sign-in is waiting for a code. Tap Sign in again.");
  // A terminal expects Enter as "\r"; a plain pipe expects a newline.
  c.stdin.write(`${code.trim()}${viaPty.has(id) ? "\r" : "\n"}`);
  set(id, { message: "Checking the code…", needsCode: false });
  // Never wait forever: if the program doesn't answer, say so and show what it printed.
  clearTimeout(watchdogs.get(id));
  watchdogs.set(
    id,
    setTimeout(() => {
      if (status.get(id)?.stage !== "signing-in") return;
      cancelSignIn(id);
      set(id, { stage: "error", message: `${SUBS[id].program} didn't finish signing in within 90 seconds (it may not be able to reach ${SUBS[id].company} from this phone). Tap Sign in to try again, or use your computer (Options).`, log: status.get(id)?.log });
    }, 90_000),
  );
}

export function cancelSignIn(id: SubId) {
  sessions.get(id)?.kill();
  sessions.delete(id);
  set(id, { stage: installed(id) ? "installed" : "not-installed", message: undefined, loginUrl: undefined, needsCode: false });
}

export async function signOut(id: SubId) {
  cancelSignIn(id);
  if (id === "claude") {
    await setSecret("sub:claude:token", null);
    for (const f of claudeCreds()) fs.rmSync(f, { force: true });
  }
  if (id === "chatgpt") fs.rmSync(path.join(subHome("chatgpt"), ".codex", "auth.json"), { force: true });
  set(id, { stage: installed(id) ? "installed" : "not-installed", message: "Signed out." });
}

export async function uninstall(id: SubId) {
  await signOut(id);
  for (const f of id === "chatgpt" ? ["codex", "codex-code-mode-host"] : ["claude"]) fs.rmSync(bin(f), { force: true });
  set(id, { stage: "not-installed", message: "Removed from this phone." });
}
