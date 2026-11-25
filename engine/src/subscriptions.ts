import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { config } from "./config.ts";
import { dataPath } from "./store.ts";
import { emit } from "./events.ts";
import { getSecret, setSecret } from "./secrets.ts";
import { download, extractTarGz, extractZip } from "./archive.ts";
import { errorText } from "./util.ts";

/**
 * Subscription sign-in for Claude, ChatGPT and Gemini — by login only, never
 * an API key. Each uses the company's own official program, downloaded to
 * the phone, and that program's own sign-in page:
 *   Claude  → Claude Code   (claude setup-token)  · your Claude Pro/Max plan
 *   ChatGPT → Codex         (codex login)          · your ChatGPT plan
 *   Gemini  → Gemini CLI    (Login with Google)    · your Google account / Google AI plan
 * If a program can't run on this phone, the bot uses your computer instead
 * (the MausDroid companion), when one is set up.
 */
export type SubId = "claude" | "chatgpt" | "gemini";
export const SUBS: Record<SubId, { label: string; program: string; company: string }> = {
  claude: { label: "Claude", program: "Claude Code", company: "Anthropic" },
  chatgpt: { label: "ChatGPT", program: "Codex", company: "OpenAI" },
  gemini: { label: "Gemini", program: "Gemini CLI", company: "Google" },
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
  id === "chatgpt" ? fs.existsSync(bin("codex")) : id === "claude" ? fs.existsSync(bin("claude")) && hasMusl() : fs.existsSync(bin("bun")) && fs.existsSync(path.join(root(), "gemini", "bundle", "gemini.js")) && hasMusl();
const hasMusl = () => fs.existsSync(path.join(lib(), "ld-musl-aarch64.so.1"));

export function isSignedIn(id: SubId): boolean {
  if (id === "claude") return Boolean(getSecret("sub:claude:token"));
  if (id === "chatgpt") return fs.existsSync(path.join(subHome("chatgpt"), ".codex", "auth.json"));
  return fs.existsSync(path.join(subHome("gemini"), ".gemini", "oauth_creds.json"));
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
  if (hasMusl() && fs.existsSync(path.join(lib(), "libstdc++.so.6"))) return;
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
    if (!v) throw new Error(`Alpine package ${pkg} not found`);
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
  } else if (id === "claude") {
    await ensureMusl(id);
    const t = await npmTarball("@anthropic-ai/claude-code-linux-arm64-musl");
    const f = path.join(dl, "claude.tgz");
    await download(t.url, f, progress(id, `Claude Code ${t.version} (about 170 MB)`));
    checkIntegrity(f, t.integrity);
    set(id, { message: "Unpacking…" });
    await extractTarGz(f, (n) => (n === "package/claude" ? bin("claude") : null));
    fs.rmSync(f, { force: true });
    patchInterpreter(bin("claude"));
  } else {
    await ensureMusl(id);
    const BUN = "1.4.5";
    const z = path.join(dl, "bun.zip");
    await download(`https://github.com/oven-sh/bun/releases/download/bun-v${BUN}/bun-linux-aarch64-musl.zip`, z, progress(id, `Bun ${BUN} runtime`));
    const sums = await (await fetch(`https://github.com/oven-sh/bun/releases/download/bun-v${BUN}/SHASUMS256.txt`)).text().catch(() => "");
    const want = sums.split("\n").find((l) => l.includes("bun-linux-aarch64-musl.zip"))?.split(/\s+/)[0];
    if (want && crypto.createHash("sha256").update(fs.readFileSync(z)).digest("hex") !== want) throw new Error("Bun download check failed. Try again.");
    extractZip(z, (n) => (n.endsWith("/bun") ? bin("bun") : null));
    fs.rmSync(z, { force: true });
    patchInterpreter(bin("bun"));
    const t = await npmTarball("@google/gemini-cli");
    const f = path.join(dl, "gemini.tgz");
    await download(t.url, f, progress(id, `Gemini CLI ${t.version}`));
    checkIntegrity(f, t.integrity);
    const dest = path.join(root(), "gemini");
    fs.rmSync(dest, { recursive: true, force: true });
    await extractTarGz(f, (n) => (n.startsWith("package/") ? path.join(dest, n.slice(8)) : null));
    fs.rmSync(f, { force: true });
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
    TERM: "xterm-256color",
    NO_COLOR: "1",
  };
  if (id === "claude") {
    const tok = getSecret("sub:claude:token");
    if (tok) env.CLAUDE_CODE_OAUTH_TOKEN = tok;
    env.DISABLE_AUTOUPDATER = "1";
  }
  if (id === "gemini") {
    env.NO_BROWSER = "true";
    env.GEMINI_CLI_NO_RELAUNCH = "true";
  }
  return env;
}

/** The command line to run a program; [cmd, args]. */
export function programCommand(id: SubId, args: string[]): [string, string[]] {
  if (id === "chatgpt") return [bin("codex"), args];
  if (id === "claude") return [bin("claude"), args];
  return [bin("bun"), [path.join(root(), "gemini", "bundle", "gemini.js"), ...args]];
}

function writeGeminiSettings(mcp?: { url: string; token: string }) {
  const dir = path.join(subHome("gemini"), ".gemini");
  fs.mkdirSync(dir, { recursive: true });
  const s: any = {
    security: { auth: { selectedType: "oauth-personal" } },
    // Gemini's own shell and file-writing tools stay off on the phone; MausDroid's tools ask before risky actions.
    tools: { exclude: ["run_shell_command", "write_file", "replace"] },
    general: { disableAutoUpdate: true, disableUpdateNag: true },
    privacy: { usageStatisticsEnabled: false },
  };
  if (mcp) s.mcpServers = { mausdroid: { httpUrl: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` }, trust: true } };
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(s, null, 1));
}
export { writeGeminiSettings };

// ---------------- Signing in ----------------

const sessions = new Map<SubId, ChildProcess>();
const viaPty = new Set<SubId>();
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "\n");

export async function signIn(id: SubId, openUrl: (url: string) => Promise<void>) {
  try {
    await install(id);
  } catch (e) {
    set(id, { stage: "error", message: `Couldn't install ${SUBS[id].program} on this phone: ${errorText(e)}` });
    return;
  }
  sessions.get(id)?.kill();
  workDir();
  if (id === "gemini") writeGeminiSettings();
  const loginArgs = id === "chatgpt" ? ["login"] : id === "claude" ? ["setup-token"] : ["-p", "Reply with the single word OK."];
  const [cmd, args] = programCommand(id, loginArgs);
  // Claude Code and Gemini CLI want a real terminal: run them through the pty helper.
  const native = process.env.MAUSDROID_NATIVE_DIR;
  const usePty = id !== "chatgpt" && native;
  const child = usePty ? spawn(path.join(native!, "libtsbridge.so"), ["pty", cmd, ...args], { cwd: workDir(), env: programEnv(id) }) : spawn(cmd, args, { cwd: workDir(), env: programEnv(id) });
  sessions.set(id, child);
  if (usePty) viaPty.add(id);
  else viaPty.delete(id);
  set(id, { stage: "signing-in", message: `Opening the ${SUBS[id].label} sign-in page…`, loginUrl: undefined, needsCode: false, log: "" });
  let log = "";
  let opened = false;
  const onData = (d: Buffer) => {
    log = (log + stripAnsi(d.toString("utf8"))).slice(-6000);
    const compact = log.replace(/\n(?=\S)/g, (m, off) => (/[A-Za-z0-9%&=._~:/?#-]$/.test(log.slice(0, off)) ? "" : m));
    const url = compact.match(/https:\/\/[^\s"'<>]+(oauth|authorize|accounts\.google\.com|auth\.openai\.com)[^\s"'<>]*/)?.[0];
    const needsCode = /paste|authorization code|enter.*code/i.test(log) && id !== "chatgpt";
    if (id === "claude") {
      const tok = compact.match(/sk-ant-oat[0-9A-Za-z_-]{20,}/)?.[0];
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
    sessions.delete(id);
    if (isSignedIn(id)) set(id, { stage: "signed-in", message: `Signed in to ${SUBS[id].label} ✓`, loginUrl: undefined, needsCode: false });
    else if (status.get(id)?.stage === "signing-in") set(id, { stage: "error", message: `Sign-in didn't finish (exit ${code}). Try again.`, log: log.slice(-1500) });
  });
}

export function sendCode(id: SubId, code: string) {
  const c = sessions.get(id);
  if (!c?.stdin) throw new Error("No sign-in is waiting for a code. Tap Sign in again.");
  // A terminal expects Enter as "\r"; a plain pipe expects a newline.
  c.stdin.write(`${code.trim()}${viaPty.has(id) ? "\r" : "\n"}`);
  set(id, { message: "Checking the code…", needsCode: false });
}

export function cancelSignIn(id: SubId) {
  sessions.get(id)?.kill();
  sessions.delete(id);
  set(id, { stage: installed(id) ? "installed" : "not-installed", message: undefined, loginUrl: undefined, needsCode: false });
}

export async function signOut(id: SubId) {
  cancelSignIn(id);
  if (id === "claude") await setSecret("sub:claude:token", null);
  if (id === "chatgpt") fs.rmSync(path.join(subHome("chatgpt"), ".codex", "auth.json"), { force: true });
  if (id === "gemini") fs.rmSync(path.join(subHome("gemini"), ".gemini", "oauth_creds.json"), { force: true });
  set(id, { stage: installed(id) ? "installed" : "not-installed", message: "Signed out." });
}

export async function uninstall(id: SubId) {
  await signOut(id);
  for (const f of id === "chatgpt" ? ["codex", "codex-code-mode-host"] : id === "claude" ? ["claude"] : ["bun"]) fs.rmSync(bin(f), { force: true });
  if (id === "gemini") fs.rmSync(path.join(root(), "gemini"), { recursive: true, force: true });
  set(id, { stage: "not-installed", message: "Removed from this phone." });
}
