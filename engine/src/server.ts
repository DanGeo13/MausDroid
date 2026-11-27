import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import * as bots from "./bots.ts";
import { busyBots, sendToBot, stopBot } from "./agent.ts";
import { currentSeq, subscribe, waitForEvents, emit } from "./events.ts";
import { pendingCards, settle } from "./approvals.ts";
import { listAlerts, markAlertsRead, notifyUser } from "./notify.ts";
import { provider, publicSettings, updateSettings, settings } from "./settings.ts";
import { setSecret } from "./secrets.ts";
import { anthropicModels } from "./providers/anthropic.ts";
import { openaiModels } from "./providers/openai.ts";
import { getSecret } from "./secrets.ts";
import * as composio from "./composio.ts";
import * as skills from "./skills.ts";
import * as routines from "./routines.ts";
import * as improve from "./improve.ts";
import * as callSession from "./call-session.ts";
import * as share from "./share.ts";
import * as botAdmin from "./bot-admin.ts";
import * as selfupdate from "./selfupdate.ts";
import * as cloudKeys from "./cloud-keys.ts";
import * as phoneNotes from "./phone-notifications.ts";
import * as playbook from "./playbook.ts";
import * as pairing from "./pairing.ts";
import { readMemory, writeMemory } from "./memory.ts";
import { bridge, bridgeAvailable } from "./bridge.ts";
import { handleMcp } from "./mcp-server.ts";
import { toolCatalog } from "./tools/index.ts";
import { collection } from "./store.ts";
import { errorText } from "./util.ts";
import { runRoutineNow } from "./scheduler.ts";
import { describeSchedule, nextOccurrence, validateSchedule } from "./schedule.ts";
import * as subs from "./subscriptions.ts";
import * as voice from "./voice.ts";
import * as files from "./files.ts";
import * as calendar from "./calendar.ts";
import * as brief from "./brief.ts";
import * as audio from "./audio-overview.ts";
import * as podcast from "./podcast-session.ts";
import { saveToDownloads } from "./downloads.ts";
import * as audit from "./audit.ts";
import * as location from "./location.ts";
import * as models from "./models.ts";
import * as calls from "./calls.ts";

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

/**
 * The app's screens. Each engine version's files have their own address
 * (app.js?v=…) and are re-checked on every load, so after an update the
 * phone never keeps showing an older version's screens.
 */
function serveStatic(p: string, ifNoneMatch?: string): Res {
  const rel = p === "/" ? "index.html" : p.replace(/^\/+/, "");
  const file = path.resolve(config.uiDir, rel);
  if (!file.startsWith(path.resolve(config.uiDir)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return rel === "index.html" ? { status: 404, body: "UI missing" } : serveStatic("/");
  }
  const st = fs.statSync(file);
  const etag = `"${config.version}-${st.size}-${Math.floor(st.mtimeMs)}"`;
  const common = {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
    "content-security-policy": "default-src 'self'; img-src 'self' data: https: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  };
  if (rel === "index.html") {
    const v = encodeURIComponent(config.version);
    const html = fs
      .readFileSync(file, "utf8")
      .replace('href="app.css"', `href="app.css?v=${v}"`)
      .replace('src="app.js"', `src="app.js?v=${v}"`)
      .replace("<head>", `<head>\n<meta name="md-version" content="${v}" />`);
    return { status: 200, headers: { ...common, "cache-control": "no-store" }, body: html };
  }
  if (ifNoneMatch === etag) return { status: 304, headers: { etag, "cache-control": "no-cache" } };
  return { status: 200, headers: { ...common, etag, "cache-control": "no-cache" }, body: fs.readFileSync(file) };
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
  const b = bots.updateBot(id, patch);
  if (b.providerId && b.model) models.rememberModel(b.providerId, b.model);
  return json(b);
});
route("DELETE", "/api/bots/:id", (_r, [id]) => {
  stopBot(id);
  bots.deleteBot(id);
  return json({ ok: true });
});
route("GET", "/api/bots/:id/messages", (req, [id]) => json(bots.messages(id, req.query.get("before") ?? undefined)));
const attachmentsFrom = (ids: unknown): files.Attachment[] => (Array.isArray(ids) ? ids.map((x) => files.getFile(String(x && typeof x === "object" ? (x as any).id : x))).filter((x): x is files.Attachment => Boolean(x)) : []);
route("POST", "/api/bots/:id/messages", (req, [id]) => json(sendToBot(id, String(req.body?.text ?? ""), "you", attachmentsFrom(req.body?.attachments))));
// Small files as JSON (the website and the assistant use this): { name, mime, b64 }.
route("POST", "/api/files/json", (req) => {
  const b = req.body ?? {};
  const data = Buffer.from(String(b.b64 ?? ""), "base64");
  if (!data.length) throw new HttpError(400, "Empty file");
  return json(files.saveFile(String(b.name ?? "file"), b.mime, data, b.note));
});
route("GET", "/api/files/:id/info", (_r, [id]) => {
  const a = files.getFile(id);
  if (!a) throw new HttpError(404, "No such file");
  return json(a);
});
route("GET", "/api/files/:id", (req, [id]) => {
  const a = files.getFile(id);
  if (!a) throw new HttpError(404, "No such file");
  const headers: Record<string, string> = { "content-type": a.mime, "content-disposition": `inline; filename="${a.name.replace(/"/g, "")}"`, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff", "content-security-policy": "sandbox", "accept-ranges": "bytes" };
  const body = fs.readFileSync(files.filePath(a));
  // Audio and video players ask for parts of the file (so you can skip ahead).
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    if (start >= body.length || start > end) return { status: 416, headers: { "content-range": `bytes */${body.length}` }, body: "" };
    return { status: 206, headers: { ...headers, "content-range": `bytes ${start}-${end}/${body.length}` }, body: body.subarray(start, end + 1) };
  }
  return { status: 200, headers, body };
});
// Save one of MausDroid's files to the phone's Downloads (checked on the phone).
route("POST", "/api/files/:id/save-to-downloads", async (_r, [id]) => {
  const a = files.getFile(id);
  if (!a) throw new HttpError(404, "No such file");
  return json(await saveToDownloads(a));
});
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
// Models per AI (for choosing a model per bot), checks, and your own endpoints
route("GET", "/api/models/:provider", (_r, [pid]) => {
  const p = provider(pid);
  if (!p) throw new HttpError(404, "No such AI");
  return json({ provider: p.id, defaultModel: p.defaultModel, groups: models.modelGroups(p) });
});
route("POST", "/api/models/check", async (req) => json(await models.checkModel(String(req.body?.provider ?? ""), String(req.body?.model ?? "").trim() || provider(String(req.body?.provider ?? ""))?.defaultModel || "default")));
route("POST", "/api/endpoints", (req) => {
  const b = req.body ?? {};
  try {
    return json({ id: models.addEndpoint(String(b.label ?? ""), String(b.baseUrl ?? ""), Boolean(b.needsKey)) });
  } catch (e) {
    throw new HttpError(400, errorText(e));
  }
});
route("DELETE", "/api/endpoints/:id", (_r, [id]) => {
  try {
    models.removeEndpoint(id);
  } catch (e) {
    throw new HttpError(400, errorText(e));
  }
  return json(publicSettings());
});
route("PUT", "/api/settings/github", async (req) => {
  await setSecret("github", String(req.body?.token ?? "").trim() || null);
  return json(publicSettings());
});

// Subscriptions: sign in with your Claude / ChatGPT / Gemini account (no API keys)
const subId = (id: string): subs.SubId => {
  if (!(id in subs.SUBS)) throw new HttpError(404, "Unknown subscription");
  return id as subs.SubId;
};
route("GET", "/api/subs", () => json(subs.allSubs()));
// Signing in switches the subscription on, and makes it the default if none is set.
subs.onSignedIn((sid) => {
  updateSettings((st) => {
    const p = st.providers.find((x) => x.id === sid);
    if (p) p.enabled = true;
    st.defaultProvider ??= sid;
  });
  emit("settings.changed");
});
route("POST", "/api/subs/:id/signin", (req, [id]) => {
  const sid = subId(id);
  const opener = async (url: string) => {
    if (req.via === "local" && bridgeAvailable()) await bridge("/open-url", { url });
  };
  void subs.signIn(sid, opener);
  return json(subs.subStatus(sid));
});
route("POST", "/api/subs/:id/code", (req, [id]) => (subs.sendCode(subId(id), String(req.body?.code ?? "")), json(subs.subStatus(subId(id)))));
route("POST", "/api/subs/:id/cancel", (_r, [id]) => (subs.cancelSignIn(subId(id)), json(subs.subStatus(subId(id)))));
route("POST", "/api/subs/:id/signout", async (_r, [id]) => {
  await subs.signOut(subId(id));
  return json(subs.subStatus(subId(id)));
});
route("POST", "/api/subs/:id/uninstall", async (_r, [id]) => {
  await subs.uninstall(subId(id));
  return json(subs.subStatus(subId(id)));
});

// Voice & digital assistant
route("PUT", "/api/settings/voice", (req) => {
  const b = req.body ?? {};
  updateSettings((st) => {
    if (b.readReplies) st.voice.readReplies = b.readReplies;
    if (typeof b.rate === "number") st.voice.rate = Math.min(2, Math.max(0.5, b.rate));
    if (typeof b.pitch === "number") st.voice.pitch = Math.min(2, Math.max(0.5, b.pitch));
    if (typeof b.ttsEngine === "string") st.voice.ttsEngine = b.ttsEngine;
    if (typeof b.voiceName === "string") st.voice.voiceName = b.voiceName;
    // Speech recognition service ("" = automatic: Google first, then the phone's default).
    if (typeof b.recognizer === "string") st.voice.recognizer = b.recognizer;
    if ("assistantBotId" in b) st.assistant.botId = b.assistantBotId || null;
    if ("assistantSpeak" in b) st.assistant.speak = Boolean(b.assistantSpeak);
    if (b.speech && typeof b.speech === "object") {
      const cur = { ...(st.voice.speech ?? {}) } as Record<string, unknown>;
      for (const k of ["natural", "reactions", "smartWaiting", "interruptByVoice", "holdByVoice"]) if (k in b.speech) cur[k] = Boolean(b.speech[k]);
      if (["quick", "normal", "relaxed"].includes(b.speech.beat)) cur.beat = b.speech.beat;
      st.voice.speech = cur;
    }
  });
  emit("settings.changed");
  return json(publicSettings());
});
route("POST", "/api/voice/listen", async (req) => json(await bridge("/voice/listen", { soft: Boolean(req.body?.soft), service: settings().voice.recognizer ?? "" }, 60_000)));
route("GET", "/api/voice/recognizers", async () => json(await bridge("/voice/recognizers", {})));
route("GET", "/api/voice/engines", async () => json(await bridge("/voice/engines", {})));
route("POST", "/api/voice/voices", async (req) => json(await bridge("/voice/voices", { engine: String(req.body?.engine ?? "") }, 20_000)));
route("POST", "/api/voice/speak", async (req) => (await voice.speak(String(req.body?.text ?? ""), Boolean(req.body?.wait)), json({ ok: true })));
route("POST", "/api/voice/stop", async () => json(await bridge("/voice/stop", {}).catch(() => ({}))));
route("POST", "/api/bots/:id/voice", (req, [id]) => json(voice.sendByVoice(id, String(req.body?.text ?? ""))));
route("GET", "/api/assistant", () => {
  const b = voice.assistantBot();
  return json({ botId: b?.id ?? null, botName: b?.name ?? null, emoji: b?.emoji ?? null, color: b?.color ?? null, speak: settings().assistant.speak });
});
route("POST", "/api/assistant/ask", async (req) => json(await voice.askAssistant(String(req.body?.text ?? ""), attachmentsFrom(req.body?.attachments), req.body?.screen)));

// Calendars (Google Calendar through Composio, all connected accounts)
route("GET", "/api/calendars", async (req) => json({ destination: calendar.getDestination(), ...(req.query.get("refresh") === "0" && calendar.lastDiscovery() ? calendar.lastDiscovery()! : await calendar.discoverCalendars()) }));
route("PUT", "/api/calendars/destination", (req) => {
  const b = req.body ?? {};
  if (!b.accountId || !b.calendarId) {
    calendar.setDestination(null);
    return json({ destination: null });
  }
  const c = calendar.lastDiscovery()?.calendars.find((x) => x.accountId === b.accountId && x.calendarId === b.calendarId);
  if (!c) throw new HttpError(400, "Refresh the calendar list first.");
  if (!c.writable) throw new HttpError(400, `"${c.name}" is read-only for ${c.accountAlias}.`);
  calendar.setDestination({ accountId: c.accountId, calendarId: c.calendarId, name: c.name, accountAlias: c.accountAlias });
  return json({ destination: calendar.getDestination() });
});
route("POST", "/api/calendars/test-write", async (req) => json(await calendar.testWrite(req.body?.accountId ? req.body : undefined)));
// The person approves an event on screen (e.g. a Morning Brief proposal).
route("POST", "/api/calendars/events", async (req) => {
  const b = req.body ?? {};
  return json(await calendar.createEvent({ summary: b.summary, start: b.start, durationMinutes: b.durationMinutes, description: b.description, location: b.location, timeZone: b.timeZone }, b.calendar ? { name: b.calendar } : undefined));
});

// Location: permission state, active requests, recent uses (no coordinates kept)
route("GET", "/api/location", async () =>
  json({
    permission: bridgeAvailable() ? (await bridge("/location/permission").catch(() => ({ permission: "unavailable" }))).permission : "unavailable",
    active: location.activeLocationRequests(),
    recent: location.recentLocationUses(),
  }),
);

// Calls with Maus
route("GET", "/api/calls", () => {
  const b = calls.callBot();
  return json({ settings: calls.callSettings(), knownName: callSession.userName(), bot: b ? { id: b.id, name: b.name, emoji: b.emoji } : null, log: calls.callLog() });
});
route("PUT", "/api/calls/settings", (req) => json(calls.saveCallSettings(req.body ?? {})));
route("GET", "/api/calls/may", async () => json(await calls.mayCall()));
route("POST", "/api/calls/start", () => json(calls.startOutgoing()));
route("GET", "/api/calls/:id", (_r, [id]) => {
  const c = calls.getCall(id);
  if (!c) throw new HttpError(404, "No such call");
  return json(c);
});
route("POST", "/api/calls/:id/answer", (req, [id]) => json(calls.answerCall(id, req.body?.answer !== false)));
route("POST", "/api/calls/:id/turn", async (req, [id]) => {
  try {
    return json(await calls.callTurn(id, String(req.body?.text ?? "")));
  } catch (e) {
    throw new HttpError(400, errorText(e));
  }
});
route("POST", "/api/calls/:id/end", async (_r, [id]) => (await callSession.hangUp(id), json(calls.getCall(id) ?? {})));
route("POST", "/api/calls/:id/resume", (_r, [id]) => json(callSession.resumeHold(id) ?? {}));
route("POST", "/api/calls/:id/run", (_r, [id]) => json(badRequest(() => callSession.runCall(id))));
route("GET", "/api/calls/:id/live", (_r, [id]) => json(callSession.liveCall(id) ?? { callId: id, phase: "ended", lines: [], note: "", active: false }));
route("POST", "/api/calls/test", async (req) => json(await calls.ringUser(String(req.body?.reason ?? "Test call"), "Hi, this is a test call from MausDroid.")));

// Weekly audit reports and wiki status
route("GET", "/api/audits", () => json(audit.listAudits().map(({ scored, ...a }) => ({ ...a, candidates: scored.length }))));
route("GET", "/api/audits/wiki", async () => json(await audit.checkWiki()));

// Morning Brief: settings, briefings, approvals of proposed events
route("GET", "/api/brief/settings", () => json(brief.briefSettings()));
route("PUT", "/api/brief/settings", (req) => json(brief.saveBriefSettings(req.body ?? {})));
route("GET", "/api/briefings", () => json(brief.listBriefings()));
// Weekly audio overviews (Morning Brief screen)
route("GET", "/api/audio-overviews", () => json({ overviews: audio.listOverviews(), settings: audio.audioSettings(), routine: routines.listRoutines().find((r) => r.system === audio.AUDIO_SYSTEM) ?? null }));
route("PUT", "/api/audio-overviews/settings", (req) => json(audio.saveAudioSettings(req.body ?? {})));
// Hands-free listening: "pause, explain that last bit", "continue"; tap a line to jump there.
route("POST", "/api/audio-overviews/:id/listen", (req, [id]) => json(badRequest(() => podcast.startPodcast(id, Number(req.body?.fromMs ?? 0)))));
route("GET", "/api/audio-overviews/:id/listen", (_r, [id]) => json(podcast.podcastSession(id) ?? { overviewId: id, state: "ended", active: false }));
route("POST", "/api/audio-overviews/:id/listen/stop", async (_r, [id]) => json((await podcast.stopPodcast(id)) ?? {}));
// A transcript line's source: open the PDF at its page with the quote highlighted (phone only).
route("POST", "/api/audio-overviews/:id/source", async (req, [id]) => {
  const o = audio.getOverview(id);
  const sg = o?.segments?.[Number(req.body?.index)];
  const f = sg?.source?.pdf ? files.getFile(sg.source.pdf) : null;
  if (!o || !sg || !f) throw new HttpError(404, "That line has no saved source PDF.");
  if (!bridgeAvailable()) return json({ open: `api/files/${f.id}#page=${(sg.source!.page ?? 0) + 1}` });
  await bridge("/pdf/open", { path: files.filePath(f), page: sg.source!.page ?? 0, quote: sg.source!.quote, title: f.name });
  return json({ ok: true });
});
route("DELETE", "/api/audio-overviews/:id", (_r, [id]) => (audio.deleteOverview(id), json({ ok: true })));
// Make one now from this week's Staff Update (runs the routine, even if this update already had one).
route("POST", "/api/audio-overviews/make", async () => {
  const r = routines.listRoutines().find((x) => x.system === audio.AUDIO_SYSTEM);
  if (!r) throw new HttpError(400, "The Weekly Audio Overview routine is missing.");
  const { file, warnings } = await brief.latestStaffUpdate();
  if (!file) throw new HttpError(400, warnings[0] ?? "No current Staff Update found in Google Drive.");
  const run = runRoutineNow(r.id, `\nThe Staff Update:\nName: ${file.name}\nDrive file id: ${file.id}\nLink: ${file.webViewLink ?? ""}`);
  return json({ ok: true, run, staffUpdate: file.name });
});
route("GET", "/api/briefings/:id", (_r, [id]) => {
  const b = brief.getBriefing(id);
  if (!b) throw new HttpError(404, "No such briefing");
  return json(b);
});
route("POST", "/api/briefings/:id/events/:eid", async (req, [id, eid]) => json(await brief.decideEvent(id, eid, Boolean(req.body?.approve))));
route("POST", "/api/brief/prepare", async (req) => json(await brief.prepareBrief(req.body?.date)));
/** The Morning Brief routine (made on first use: weekdays 6:30 am, owned by the pinned bot), run now. */
function morningBriefRoutine(create: boolean) {
  const existing = routines.listRoutines().find((r) => r.system === "morning-brief");
  if (existing || !create) return existing;
  const bots = listBotsForBrief();
  const owner = bots.find((b) => b.pinned) ?? bots[0];
  if (!owner) throw new HttpError(400, "Create a bot first.");
  return routines.createRoutine({ botId: owner.id, title: "Morning Brief", prompt: brief.MORNING_BRIEF_PROMPT, schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "06:30", timeZone: settings().timeZone?.includes("/") ? settings().timeZone : undefined }, system: "morning-brief", timeoutMinutes: 20 });
}
const listBotsForBrief = () => bots.listBots().filter((b) => !b.hidden);
route("GET", "/api/brief/routine", () => json(morningBriefRoutine(false) ? routines.routineDetails(morningBriefRoutine(false)!) : null));
route("POST", "/api/brief/routine", () => json(routines.routineDetails(morningBriefRoutine(true)!)));
route("POST", "/api/brief/refresh", () => json(runRoutineNow(morningBriefRoutine(true)!.id)));

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
route("GET", "/api/composio/toolkits/:slug/auth", async (_r, [slug]) => json(await composio.toolkitAuth(decodeURIComponent(slug))));
route("POST", "/api/composio/toolkits/:slug/auth", async (req, [slug]) => {
  try {
    return json(await composio.setupCustomAuth(decodeURIComponent(slug), String(req.body?.mode ?? "OAUTH2"), req.body?.credentials ?? {}));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
route("DELETE", "/api/composio/toolkits/:slug/auth", async (_r, [slug]) => (await composio.removeCustomAuth(decodeURIComponent(slug)), json({ ok: true })));
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
// The person manages every routine from the screen (bots only their own, via tools).
const badRequest = (fn: () => unknown) => {
  try {
    return fn();
  } catch (e) {
    throw new HttpError(400, errorText(e));
  }
};
// Tools: every tool, which bots have it (bot editor + Settings → Tools), and bot changes made by bots.
route("GET", "/api/tools", () =>
  json({
    tools: toolCatalog(),
    bots: bots.listBots().filter((b) => !b.hidden).map((b) => ({ id: b.id, name: b.name, emoji: b.emoji, tools: b.tools, disabledTools: b.disabledTools ?? [] })),
  }),
);
route("POST", "/api/tools/:name/bots", (req, [name]) => {
  botAdmin.setToolForBots(decodeURIComponent(name), (req.body?.botIds ?? []).map(String), req.body?.enabled !== false);
  return json({ ok: true });
});
route("GET", "/api/bot-changes", () => json(botAdmin.listBotChanges()));
route("POST", "/api/bot-changes/:id/undo", (_r, [id]) => json(badRequest(() => botAdmin.undoBotChange(id))));
// Notifications read from apps you choose (e.g. Meta's Muse), read-only.
let firstReviewTimer: NodeJS.Timeout | null = null;
function reviewMuse(): { botId: string; reviewed: number } {
  const items = phoneNotes.recent({ app: "muse", limit: 150 });
  if (!items.length) throw new HttpError(400, "No Muse notifications have been read yet. Allow notification access, then tap Read pending notifications.");
  const bot = improve.improverBot();
  if (!bot) throw new HttpError(400, "No Improver bot.");
  phoneNotes.markFirstReview();
  sendToBot(bot.id, phoneNotes.REVIEW_PROMPT(items), "notifications");
  return { botId: bot.id, reviewed: items.length };
}
route("POST", "/api/notifications/incoming", (req) => {
  const r = phoneNotes.addIncoming(req.body?.items ?? []);
  // The first Muse notifications read (those still pending): Improver reviews them once, a minute later.
  if (r.added && !phoneNotes.firstReviewDone() && !firstReviewTimer && phoneNotes.recent({ app: "muse", limit: 1 }).length)
    firstReviewTimer = setTimeout(() => {
      firstReviewTimer = null;
      if (!phoneNotes.firstReviewDone()) {
        try {
          reviewMuse();
        } catch {
          /* tried again next time */
        }
      }
    }, Number(process.env.MAUSDROID_FIRST_REVIEW_MS ?? 60_000));
  return json(r);
});
route("GET", "/api/notifications/phone", async (req) => {
  const native = bridgeAvailable() ? await bridge("/notifications/status", {}).catch(() => null) : null;
  return json({ native, counts: phoneNotes.counts(), recent: phoneNotes.recent({ app: req.query.get("app") ?? undefined, limit: 50 }) });
});
route("POST", "/api/notifications/allow", async () => json(await bridge("/notifications/open-settings", {})));
route("PUT", "/api/notifications/watch", async (req) => json(await bridge("/notifications/watch", { packages: (req.body?.packages ?? []).map(String) })));
route("POST", "/api/notifications/rescan", async () => json(await bridge("/notifications/rescan", {})));
route("POST", "/api/notifications/review", () => json(reviewMuse()));
// Your playbook (kept only on this phone).
route("GET", "/api/playbook", () => json({ ...playbook.playbookState(), mainBotId: playbook.getMainBotId() }));
route("GET", "/api/playbook/:id/text", (_r, [id]) => json({ text: playbook.readDoc(id) }));
route("POST", "/api/playbook/import", (req) => {
  try {
    return json(playbook.importDoc(String(req.body?.name ?? "playbook.md"), Buffer.from(String(req.body?.b64 ?? ""), "base64")));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
route("PATCH", "/api/playbook/:id", (req, [id]) => (playbook.updateDoc(id, { mode: req.body?.mode }), json(playbook.playbookState())));
route("DELETE", "/api/playbook/:id", (_r, [id]) => (playbook.removeDoc(id), json(playbook.playbookState())));
route("PUT", "/api/playbook/settings", (req) => (playbook.setAppliesTo(req.body?.appliesTo), json(playbook.playbookState())));
route("POST", "/api/playbook/review", () => {
  const bot = improve.improverBot();
  if (!bot) throw new HttpError(400, "No Improver bot.");
  if (!playbook.playbookState().docs.length) throw new HttpError(400, "Import your playbook first.");
  sendToBot(bot.id, playbook.REVIEW_PROMPT, "playbook");
  return json({ botId: bot.id });
});
route("POST", "/api/share", (req) => {
  const rec = badRequest(() => share.receiveShare({ text: req.body?.text, attachments: attachmentsFrom(req.body?.attachments) })) as share.ShareRecord;
  const bot = bots.getBot(rec.botId);
  return json({ ...rec, botName: bot?.name ?? "Maus" });
});
route("GET", "/api/shares", () => json(share.listShares()));
route("GET", "/api/improve", () => json(improve.overview()));
route("PUT", "/api/improve/settings", (req) => json(badRequest(() => improve.saveImproveSettings(req.body ?? {}))));
route("POST", "/api/improve/run", () => {
  const r = improve.improveRoutine();
  if (!r) throw new Error("The nightly check routine is missing.");
  return json(runRoutineNow(r.id));
});
route("POST", "/api/improve/reveal", async () => json(await improve.revealDue(new Date(), true)));
// Setting up cloud builds from the phone.
route("GET", "/api/improve/cloud", async () => json({ checklist: await cloudKeys.checklist(), connect: cloudKeys.connectState(), codex: cloudKeys.codexConnectState() }));
route("POST", "/api/improve/cloud/codex/connect", async (req) => {
  const opener = async (url: string) => {
    if (req.via === "local" && bridgeAvailable()) await bridge("/open-url", { url });
  };
  if (!getSecret("github")) throw new HttpError(400, "Save a GitHub token first (Settings → Memory → GitHub token).");
  void cloudKeys.startCodexConnect(opener).catch(() => {});
  return json(cloudKeys.codexConnectState());
});
route("POST", "/api/improve/cloud/codex/cancel", () => (cloudKeys.cancelCodexConnect(), json(cloudKeys.codexConnectState())));
route("POST", "/api/improve/cloud/connect", async (req) => {
  const opener = async (url: string) => {
    if (req.via === "local" && bridgeAvailable()) await bridge("/open-url", { url });
  };
  if (!getSecret("github")) throw new HttpError(400, "Save a GitHub token first (Settings → Memory → GitHub token).");
  void cloudKeys.startConnect(opener).catch(() => {});
  return json(cloudKeys.connectState());
});
route("POST", "/api/improve/cloud/code", (req) => {
  try {
    cloudKeys.connectCode(String(req.body?.code ?? ""));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return json(cloudKeys.connectState());
});
route("POST", "/api/improve/cloud/secret", async (req) => {
  try {
    await cloudKeys.addSecret(String(req.body?.name ?? ""), String(req.body?.value ?? ""));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return json({ checklist: await cloudKeys.checklist() });
});
route("POST", "/api/improve/cloud/cancel", () => (cloudKeys.cancelConnect(), json(cloudKeys.connectState())));
route("POST", "/api/improve/rollback", (req) => json(badRequest(() => {
  const r = selfupdate.rollBack(req.body?.version ? String(req.body.version) : undefined);
  improve.recordApplied(`Rolled back ${r.from} → ${r.to}`, `Went back from ${r.from} to ${r.to}.`, "code");
  return r;
})));
route("POST", "/api/improve/build", async (req) => json(await improve.requestBuild(String(req.body?.title ?? "Change"), String(req.body?.spec ?? ""))));
route("POST", "/api/improve/check-builds", async () => (await improve.checkBuilds(), json(improve.overview())));
route("POST", "/api/improve/:id/answer", async (req, [id]) => {
  try {
    return json(await improve.answerBuild(id, String(req.body?.answers ?? "")));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
route("POST", "/api/improve/:id/approve", async (_r, [id]) => json(await improve.approve(id)));
route("POST", "/api/improve/:id/snooze", (_r, [id]) => json(badRequest(() => improve.snooze(id))));
route("POST", "/api/improve/:id/dismiss", (_r, [id]) => json(badRequest(() => improve.dismiss(id))));
route("GET", "/api/routines", (req) => json(routines.listRoutines(req.query.get("bot") ?? undefined).map(routines.routineDetails)));
route("POST", "/api/routines", (req) => json(routines.routineDetails(badRequest(() => routines.createRoutine(req.body)) as routines.Routine)));
route("PATCH", "/api/routines/:id", (req, [id]) => json(routines.routineDetails(badRequest(() => routines.updateRoutine(id, req.body ?? {})) as routines.Routine)));
route("DELETE", "/api/routines/:id", (_r, [id]) => (routines.deleteRoutine(id), json({ ok: true })));
route("POST", "/api/routines/:id/run", (_r, [id]) => json(runRoutineNow(id)));
route("POST", "/api/routines/:id/pause", (_r, [id]) => json(routines.routineDetails(routines.pauseRoutine(id))));
route("POST", "/api/routines/:id/resume", (_r, [id]) => json(routines.routineDetails(routines.resumeRoutine(id))));
route("GET", "/api/routines/:id/runs", (req, [id]) => json(routines.listRuns(id, Number(req.query.get("limit") ?? 30))));
// Live preview while editing: readable text, problems, and the next few times.
route("POST", "/api/routines/preview", (req) => {
  const sc = req.body?.schedule ?? {};
  const problems = validateSchedule(sc);
  const upcoming: string[] = [];
  if (!problems.length) {
    let from = new Date();
    for (let i = 0; i < 3; i++) {
      const o = nextOccurrence(sc, from);
      if (!o) break;
      upcoming.push(o.at.toISOString());
      from = o.at;
    }
  }
  return json({ text: problems.length ? null : describeSchedule(sc), problems, upcoming });
});
// Alerts from outside (other apps, Composio events, automations) can start "Upon Alert" routines.
route("POST", "/api/alerts/incoming", async (req) => {
  const b = req.body ?? {};
  if (!b.title && !b.body) throw new HttpError(400, "Send at least a title or body.");
  const a = await notifyUser({ title: String(b.title ?? ""), body: String(b.body ?? ""), type: String(b.type ?? "external"), source: b.source ? String(b.source) : undefined, priority: ["low", "normal", "high"].includes(b.priority) ? b.priority : "normal", eventId: b.id ? String(b.id) : undefined, silentRecord: b.notify === false });
  return json(a);
});

// Memory
route("GET", "/api/memory/:scope", (_r, [scope]) => json({ text: readMemory(scope) }));
route("PUT", "/api/memory/:scope", (req, [scope]) => (writeMemory(scope, String(req.body?.text ?? "")), json({ ok: true })));

// Devices, website, pairing
route("GET", "/api/devices", () => json(pairing.listDevices()));
route("DELETE", "/api/devices/:id", (_r, [id]) => (pairing.revokeDevice(id), json({ ok: true })));
route("POST", "/api/pair/link", async (req) => {
  try {
    return json(await pairing.linkDevice(String(req.body?.text ?? "")));
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
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
route("POST", "/api/update/check", async () => json(await bridge("/update/check", {}, 300_000)));
route("POST", "/api/update/apply", async () => json(await bridge("/update/apply", {}, 300_000)));
route("GET", "/api/system", async () => json({ ...(bridgeAvailable() ? await bridge("/device/info").catch(() => ({})) : {}), engine: config.version }));
route("POST", "/api/system/:action", async (req, [action]) => json(await bridge(`/device/${action}`, req.body ?? {})));
route("POST", "/api/browser/login", async (req) => json(await bridge("/login/show", { url: req.body?.url })));

export async function handle(req: Req): Promise<Res> {
  try {
    if (!req.path.startsWith("/api/")) return serveStatic(req.path, req.headers["if-none-match"]);
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
    // Large files (videos, documents) stream straight to disk: POST /api/files with the raw bytes.
    if (url.pathname === "/api/files" && inc.method === "POST") {
      const headers0 = Object.fromEntries(Object.entries(inc.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]));
      if (auth({ method: "POST", path: url.pathname, query: url.searchParams, headers: headers0, body: undefined, via, prefix: "/" }) !== "owner") return out.writeHead(401).end();
      const name = decodeURIComponent(String(inc.headers["x-file-name"] ?? "file"));
      const up = files.startUpload(name, String(inc.headers["content-type"] ?? ""));
      let size = 0;
      inc.on("data", (c: Buffer) => {
        size += c.length;
        if (size > 500 * 1024 * 1024) inc.destroy();
      });
      inc.pipe(up.stream);
      up.stream.on("finish", () => {
        up.finish(size);
        out.writeHead(200, { "content-type": "application/json" });
        out.end(JSON.stringify({ ...up.attachment, size }));
      });
      up.stream.on("error", () => out.writeHead(500).end());
      return;
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
