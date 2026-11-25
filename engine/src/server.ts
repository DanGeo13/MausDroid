import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import * as bots from "./bots.ts";
import { busyBots, sendToBot, stopBot } from "./agent.ts";
import { currentSeq, subscribe, waitForEvents, emit } from "./events.ts";
import { pendingCards, settle } from "./approvals.ts";
import { listAlerts, markAlertsRead } from "./notify.ts";
import { provider, publicSettings, updateSettings, settings } from "./settings.ts";
import { setSecret } from "./secrets.ts";
import { anthropicModels } from "./providers/anthropic.ts";
import { openaiModels } from "./providers/openai.ts";
import { getSecret } from "./secrets.ts";
import * as composio from "./composio.ts";
import * as skills from "./skills.ts";
import * as routines from "./routines.ts";
import * as pairing from "./pairing.ts";
import { readMemory, writeMemory } from "./memory.ts";
import { bridge, bridgeAvailable } from "./bridge.ts";
import { handleMcp } from "./mcp-server.ts";
import { collection } from "./store.ts";
import { errorText } from "./util.ts";
import { runRoutineNow } from "./scheduler.ts";

export type Via = "local" | "tailnet" | "relay";
export interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: any;
  via: Via;
  prefix: string;
}
export interface Res {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

class HttpError extends Error {
  constructor(public status: number, msg: string) {
    super(msg);
  }
}

const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Res => ({
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  body: JSON.stringify(data),
});

// ---- Authentication -------------------------------------------------------
const sessions = collection<Record<string, { device: string; expires: number }>>("web-sessions", {});
const attempts: number[] = [];

function cookies(h: Req["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (h.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name: string, value: string, req: Req, maxAge: number) {
  const secure = req.via === "relay" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=${req.prefix || "/"}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}

/** Who is calling: the phone itself, a paired + logged-in device, or nobody. */
function auth(req: Req): "owner" | "paired" | null {
  const c = cookies(req.headers);
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
  if (req.via === "local" && (bearer === config.localToken || c.md_t === config.localToken)) return "owner";
  const dev = pairing.deviceForToken(c.md_dev);
  if (!dev) return null;
  const s = sessions.get()[c.md_sess ?? ""];
  if (s && s.device === dev.id && s.expires > Date.now()) return "owner";
  return "paired";
}

// ---- Static UI --------------------------------------------------------------
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json", ".ico": "image/x-icon" };

function serveStatic(p: string): Res {
  const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
  const file = path.resolve(config.uiDir, rel);
  if (!file.startsWith(path.resolve(config.uiDir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return serveStatic("/");
  }
  return {
    status: 200,
    headers: {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": rel === "index.html" ? "no-cache" : "public, max-age=300",
      "content-security-policy": "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    },
    body: fs.readFileSync(file),
  };
}

// ---- Routing -----------------------------------------------------------------
type Handler = (req: Req, params: string[]) => Promise<Res> | Res;
const routes: { method: string; re: RegExp; open?: boolean; h: Handler }[] = [];
const route = (method: string, pattern: string, h: Handler, open = false) =>
  routes.push({ method, re: new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, "([^/]+)")}$`), h, open });

function state() {
  return {
    version: { engine: config.version, apk: config.apkVersion, platform: config.platform },
    bots: bots.listBots().map((b) => ({ ...b, last: bots.lastMessage(b.id) ?? null, busy: busyBots().includes(b.id) })),
    cards: pendingCards(),
    seq: currentSeq(),
    unreadAlerts: listAlerts().filter((a) => !a.read).length,
    onboardingDone: settings().onboardingDone,
    nativeBridge: bridgeAvailable(),
  };
}

// Pairing and login are the only open endpoints.
route("POST", "/api/pair/redeem", (req) => {
  const token = pairing.redeemPairingCode(String(req.body?.code ?? ""), String(req.body?.name ?? "Device"));
  return json({ ok: true, needsPassword: true }, 200, { "set-cookie": cookie("md_dev", token, req, 400 * 86400) });
}, true);

route("POST", "/api/login", (req) => {
  const c = cookies(req.headers);
  const dev = pairing.deviceForToken(c.md_dev);
  if (!dev) throw new HttpError(401, "This device isn't paired. Scan the QR code on the phone first.");
  const recent = attempts.filter((t) => t > Date.now() - 15 * 60_000);
  attempts.splice(0, attempts.length, ...recent);
  if (recent.length >= 8) throw new HttpError(429, "Too many tries. Wait 15 minutes.");
  attempts.push(Date.now());
  if (!pairing.checkWebsitePassword(String(req.body?.password ?? ""))) throw new HttpError(401, "Wrong password.");
  const sid = randomBytes(24).toString("base64url");
  sessions.update((s) => {
    for (const [k, v] of Object.entries(s)) if (v.expires < Date.now()) delete s[k];
    s[sid] = { device: dev.id, expires: Date.now() + 30 * 86400_000 };
  });
  return json({ ok: true }, 200, { "set-cookie": cookie("md_sess", sid, req, 30 * 86400) });
}, true);

route("GET", "/api/whoami", (req) => json({ auth: auth(req), via: req.via, passwordSet: publicSettings().website.passwordSet }), true);

route("POST", "/api/logout", (req) => {
  const c = cookies(req.headers);
  sessions.update((s) => void delete s[c.md_sess ?? ""]);
  return json({ ok: true }, 200, { "set-cookie": cookie("md_sess", "", req, 0) });
});

route("GET", "/api/state", () => json(state()));

// Bots
route("POST", "/api/bots", (req) => json(bots.createBot(req.body ?? {})));
route("PATCH", "/api/bots/:id", (req, [id]) => {
  const { id: _i, createdAt: _c, ...patch } = req.body ?? {};
  return json(bots.updateBot(id, patch));
});
route("DELETE", "/api/bots/:id", (_r, [id]) => {
  stopBot(id);
  bots.deleteBot(id);
  return json({ ok: true });
});
route("GET", "/api/bots/:id/messages", (req, [id]) => json(bots.messages(id, req.query.get("before") ?? undefined)));
route("POST", "/api/bots/:id/messages", (req, [id]) => json(sendToBot(id, String(req.body?.text ?? ""), "you", req.body?.images)));
route("POST", "/api/bots/:id/stop", (_r, [id]) => (stopBot(id), json({ ok: true })));
route("POST", "/api/bots/:id/clear", (_r, [id]) => (bots.clearChat(id), json({ ok: true })));
route("POST", "/api/bots/:id/read", (_r, [id]) => json(bots.updateBot(id, { unread: 0 })));

// Events (long poll; SSE is handled directly by the HTTP server)
route("GET", "/api/events/poll", async (req) => json({ events: await waitForEvents(Number(req.query.get("since") ?? 0), 25_000), seq: currentSeq() }));

// Cards & alerts
route("GET", "/api/cards", () => json(pendingCards()));
route("POST", "/api/cards/:id", (req, [id]) => json({ ok: settle(id, { allow: Boolean(req.body?.allow), answer: req.body?.answer, always: Boolean(req.body?.always) }) }));
route("GET", "/api/alerts", () => json(listAlerts()));
route("POST", "/api/alerts/read", () => (markAlertsRead(), json({ ok: true })));

// Settings
route("GET", "/api/settings", () => json(publicSettings()));
route("PUT", "/api/settings/general", (req) => {
  const b = req.body ?? {};
  updateSettings((s) => {
    if ("defaultProvider" in b) s.defaultProvider = b.defaultProvider;
    if (b.timeZone) s.timeZone = b.timeZone;
    if ("quietHours" in b) s.quietHours = b.quietHours;
    if ("onboardingDone" in b) s.onboardingDone = Boolean(b.onboardingDone);
  });
  emit("settings.changed");
  return json(publicSettings());
});
route("PUT", "/api/settings/providers/:id", async (req, [id]) => {
  const b = req.body ?? {};
  if (!provider(id) && b.kind) {
    updateSettings((s) => void s.providers.push({ id, label: b.label ?? id, kind: b.kind, baseUrl: b.baseUrl, defaultModel: b.defaultModel ?? "", models: [], enabled: false, needsKey: Boolean(b.needsKey) }));
  }
  if (!provider(id)) throw new HttpError(404, "No such AI provider");
  if (typeof b.key === "string") await setSecret(`provider:${id}`, b.key.trim() || null);
  if (typeof b.computerToken === "string") await setSecret(`computer:${id}`, b.computerToken.trim() || null);
  updateSettings((s) => {
    const p = s.providers.find((x) => x.id === id)!;
    for (const k of ["enabled", "baseUrl", "defaultModel", "models", "runOn", "computerUrl", "label", "needsKey"] as const) if (k in b) (p as any)[k] = b[k];
    if (p.enabled && !s.defaultProvider) s.defaultProvider = p.id;
  });
  emit("settings.changed");
  return json(publicSettings());
});
route("POST", "/api/settings/providers/:id/models", async (_r, [id]) => {
  const p = provider(id);
  if (!p) throw new HttpError(404, "No such AI provider");
  const key = getSecret(`provider:${id}`);
  const models = p.kind === "anthropic" ? await anthropicModels(key ?? "") : p.kind === "openai" ? await openaiModels(p.baseUrl!, key) : p.models;
  updateSettings((s) => void (s.providers.find((x) => x.id === id)!.models = models));
  return json({ models });
});
route("PUT", "/api/settings/github", async (req) => {
  await setSecret("github", String(req.body?.token ?? "").trim() || null);
  return json(publicSettings());
});

// Connected apps (Composio)
route("POST", "/api/composio/key", async (req) => (await composio.connectComposio(String(req.body?.key ?? "")), json(publicSettings())));
route("DELETE", "/api/composio/key", async () => (await composio.disconnectComposio(), json(publicSettings())));
route("GET", "/api/composio/toolkits", async (req) => json(await composio.listToolkits(req.query.get("search") ?? "", req.query.get("cursor") ?? undefined)));
route("GET", "/api/composio/connections", async () => json(await composio.listConnections()));
route("POST", "/api/composio/link", async (req) => {
  const { url } = await composio.linkToolkit(String(req.body?.toolkit), req.body?.alias);
  if (req.via === "local" && bridgeAvailable()) await bridge("/open-url", { url }).catch(() => {});
  return json({ url });
});
route("DELETE", "/api/composio/connections/:id", async (_r, [id]) => (await composio.removeConnection(id), json({ ok: true })));

// Skills marketplace
route("GET", "/api/skills", () => json(skills.listSkills().map(({ dir, ...s }) => s)));
route("POST", "/api/skills", (req) => json({ name: skills.saveSkill(String(req.body?.name), String(req.body?.md)) }));
route("DELETE", "/api/skills/:name", (_r, [name]) => (skills.removeSkill(decodeURIComponent(name)), json({ ok: true })));
route("GET", "/api/skills/market", async (req) => json(await skills.searchMarketplace(req.query.get("q") ?? "")));
route("GET", "/api/skills/repo", async (req) => {
  const r = await skills.listRepoSkills(req.query.get("ref") ?? "");
  return json({ repo: `${r.owner}/${r.repo}`, branch: r.branch, skills: r.dirs });
});
route("POST", "/api/skills/install", async (req) => json({ installed: await skills.installFromGitHub(String(req.body?.ref), req.body?.only) }));

// Routines
route("GET", "/api/routines", (req) => json(routines.listRoutines(req.query.get("bot") ?? undefined)));
route("POST", "/api/routines", (req) => json(routines.createRoutine(req.body)));
route("PATCH", "/api/routines/:id", (req, [id]) => (routines.updateRoutine(id, req.body ?? {}), json({ ok: true })));
route("DELETE", "/api/routines/:id", (_r, [id]) => (routines.deleteRoutine(id), json({ ok: true })));
route("POST", "/api/routines/:id/run", (_r, [id]) => (runRoutineNow(id), json({ ok: true })));

// Memory
route("GET", "/api/memory/:scope", (_r, [scope]) => json({ text: readMemory(scope) }));
route("PUT", "/api/memory/:scope", (req, [scope]) => (writeMemory(scope, String(req.body?.text ?? "")), json({ ok: true })));

// Devices, website, pairing
route("GET", "/api/devices", () => json(pairing.listDevices()));
route("DELETE", "/api/devices/:id", (_r, [id]) => (pairing.revokeDevice(id), json({ ok: true })));
route("POST", "/api/pair/create", () => {
  const base = pairing.websiteBase();
  if (!base) throw new HttpError(400, "Turn on the website (or Tailscale) first so other devices have an address to open.");
  const c = pairing.createPairingCode();
  return json({ ...c, link: pairing.pairingLink(c.code, base) });
});
route("PUT", "/api/website", async (req) => {
  const b = req.body ?? {};
  if (b.password) await pairing.setWebsitePassword(String(b.password));
  if ("relayUrl" in b || "enabled" in b) pairing.configureWebsite(String(b.relayUrl ?? settings().website.relayUrl ?? ""), Boolean(b.enabled));
  emit("settings.changed");
  return json(publicSettings());
});

// Native features passed through to the Android shell
route("GET", "/api/tailscale", async () => json(bridgeAvailable() ? await bridge("/tailscale/status") : { state: "Unavailable" }));
route("PUT", "/api/tailscale", async (req) => {
  const b = req.body ?? {};
  if (typeof b.authKey === "string") await setSecret("tailscale:authkey", b.authKey.trim() || null);
  updateSettings((s) => {
    if ("enabled" in b) s.tailscale.enabled = Boolean(b.enabled);
    if (b.hostname) s.tailscale.hostname = String(b.hostname).toLowerCase().replace(/[^a-z0-9-]/g, "-");
  });
  const s = settings().tailscale;
  if (bridgeAvailable()) await bridge(s.enabled ? "/tailscale/start" : "/tailscale/stop", { hostname: s.hostname, authKey: getSecret("tailscale:authkey") ?? "" });
  return json(publicSettings());
});
route("GET", "/api/update", async () => json(bridgeAvailable() ? await bridge("/update/status") : { state: "dev" }));
route("POST", "/api/update/check", async () => json(await bridge("/update/check", {}, 120_000)));
route("POST", "/api/update/apply", async () => json(await bridge("/update/apply", {}, 300_000)));
route("GET", "/api/system", async () => json({ ...(bridgeAvailable() ? await bridge("/device/info").catch(() => ({})) : {}), engine: config.version }));
route("POST", "/api/system/:action", async (req, [action]) => json(await bridge(`/device/${action}`, req.body ?? {})));
route("POST", "/api/browser/login", async (req) => json(await bridge("/login/show", { url: req.body?.url })));

export async function handle(req: Req): Promise<Res> {
  try {
    if (!req.path.startsWith("/api/")) return serveStatic(req.path);
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = req.path.match(r.re);
      if (!m) continue;
      if (!r.open) {
        const who = auth(req);
        if (who !== "owner") throw new HttpError(401, who === "paired" ? "Enter your password." : "Not signed in.");
      }
      return await r.h(req, m.slice(1));
    }
    return json({ error: "Not found" }, 404);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: errorText(e) }, status);
  }
}

// ---- HTTP server ----------------------------------------------------------------
export function startServer() {
  const server = http.createServer(async (inc, out) => {
    const url = new URL(inc.url ?? "/", "http://x");
    const via: Via = inc.headers["x-mausdroid-via"] === "tailnet" ? "tailnet" : "local";
    // First load inside the app: ?t=<token> becomes a cookie, then the token leaves the URL.
    if (via === "local" && url.searchParams.get("t") === config.localToken) {
      out.writeHead(302, { location: "/", "set-cookie": `md_t=${config.localToken}; Path=/; HttpOnly; SameSite=Strict` });
      return out.end();
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of inc) {
      size += c.length;
      if (size > 25 * 1024 * 1024) return out.writeHead(413).end();
      chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any = undefined;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    const headers = Object.fromEntries(Object.entries(inc.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
    const req: Req = { method: inc.method ?? "GET", path: url.pathname, query: url.searchParams, headers, body, via, prefix: "/" };

    const mcp = url.pathname.match(/^\/mcp\/([^/]+)$/);
    if (mcp) return void handleMcp(mcp[1], inc, out, body).catch((e) => out.writeHead(500).end(errorText(e)));

    if (req.path === "/api/events" && req.method === "GET") {
      if (auth(req) !== "owner") return out.writeHead(401).end();
      out.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      out.write(`event: hello\ndata: ${JSON.stringify({ seq: currentSeq() })}\n\n`);
      const off = subscribe((e) => out.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => out.write(": ping\n\n"), 20_000);
      inc.on("close", () => {
        off();
        clearInterval(ping);
      });
      return;
    }
    const res = await handle(req);
    out.writeHead(res.status, res.headers ?? {});
    out.end(res.body);
  });
  server.listen(config.port, "127.0.0.1");
  return server;
}
