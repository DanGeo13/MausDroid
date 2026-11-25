import { collection } from "./store.ts";
import { emit } from "./events.ts";
import { bridge, bridgeAvailable } from "./bridge.ts";
import { notifyUser } from "./notify.ts";
import { getBot, listBots } from "./bots.ts";
import { busyBetween } from "./calendar.ts";
import { settings } from "./settings.ts";
import { id as newId, now } from "./util.ts";
import { onTurnEnd, sendToBot } from "./agent.ts";
import { withTimeZone } from "./schedule.ts";

/**
 * Voice calls with Maus (one bot only):
 *  - you call Maus from its chat (hands-free conversation);
 *  - Maus can call you — but never during a calendar event, never during
 *    your lock-out times, and at most a few times an hour. If it can't
 *    check your calendar, it doesn't ring (it sends a quiet note instead).
 */
export interface CallSettings {
  enabled: boolean;
  /** The one bot allowed to call (null = the bot named "Maus", else the pinned bot). */
  botId: string | null;
  /** No calls during these local times (e.g. teaching, sleep). */
  lockouts: { days: number[]; start: string; end: string; label?: string }[];
  maxPerHour: number;
  /** Minutes around "now" that must be free in your calendars. */
  calendarMarginMinutes: number;
  /** What Maus calls you ("Morning, Dan"). */
  userName?: string;
}

export interface CallRecord {
  id: string;
  direction: "incoming" | "outgoing";
  botId: string;
  reason: string;
  openingLine?: string;
  state: "ringing" | "active" | "declined" | "missed" | "blocked" | "ended";
  at: string;
  endedAt?: string;
  detail?: string;
}

const store = collection<{ settings: CallSettings; log: CallRecord[] }>("calls", {
  settings: { enabled: true, botId: null, lockouts: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "21:30", end: "07:00", label: "Night" }], maxPerHour: 3, calendarMarginMinutes: 10 },
  log: [],
});

export const callSettings = () => store.get().settings;
export function saveCallSettings(p: Partial<CallSettings>) {
  store.update((s) => (s.settings = { ...s.settings, ...p }));
  emit("settings.changed");
  return callSettings();
}
export const callLog = () => store.get().log.slice().reverse().slice(0, 50);

/** The one bot that may call / be called. */
export function callBot() {
  const s = callSettings();
  const bots = listBots().filter((b) => !b.hidden);
  return (s.botId && getBot(s.botId)) || bots.find((b) => b.name.trim().toLowerCase() === "maus") || bots.find((b) => b.pinned) || bots[0];
}
export const isCallBot = (botId: string) => callSettings().enabled && callBot()?.id === botId;

function record(r: Omit<CallRecord, "id" | "at">): CallRecord {
  const c: CallRecord = { ...r, id: newId("call"), at: now() };
  store.update((s) => {
    s.log.push(c);
    if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
  });
  emit("call", { call: c });
  return c;
}
function patch(id: string, p: Partial<CallRecord>) {
  let out: CallRecord | undefined;
  store.update((s) => {
    const c = s.log.find((x) => x.id === id);
    if (c) Object.assign(c, p), (out = { ...c });
  });
  if (out) emit("call", { call: out });
  return out;
}
export const getCall = (id: string) => store.get().log.find((c) => c.id === id);

const minutes = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
};

/** Is "now" inside a lock-out window? (Windows can cross midnight.) */
export function inLockout(at: Date, lockouts: CallSettings["lockouts"], tz?: string): CallSettings["lockouts"][number] | null {
  return withTimeZone(tz, () => {
    const m = at.getHours() * 60 + at.getMinutes();
    const day = at.getDay();
    const yesterday = (day + 6) % 7;
    for (const w of lockouts) {
      const a = minutes(w.start);
      const b = minutes(w.end);
      if (a <= b) {
        if (w.days.includes(day) && m >= a && m < b) return w;
      } else if ((w.days.includes(day) && m >= a) || (w.days.includes(yesterday) && m < b)) return w;
    }
    return null;
  });
}

/** May Maus ring you right now? */
export async function mayCall(at = new Date()): Promise<{ ok: boolean; reason: string }> {
  const s = callSettings();
  if (!s.enabled) return { ok: false, reason: "Calls are switched off." };
  const tz = settings().timeZone?.includes("/") ? settings().timeZone : undefined;
  const lock = inLockout(at, s.lockouts, tz);
  if (lock) return { ok: false, reason: `It's a lock-out time (${lock.label ?? `${lock.start}–${lock.end}`}).` };
  const hourAgo = at.getTime() - 3600_000;
  const recent = store.get().log.filter((c) => c.direction === "incoming" && c.state !== "blocked" && new Date(c.at).getTime() > hourAgo).length;
  if (recent >= s.maxPerHour) return { ok: false, reason: `Maus already called ${recent} time(s) in the last hour (limit ${s.maxPerHour}).` };
  const margin = s.calendarMarginMinutes * 60_000;
  const busy = await busyBetween(new Date(at.getTime() - margin), new Date(at.getTime() + margin)).catch((e) => ({ busy: true, event: undefined, error: (e as Error).message }));
  if (busy.error) return { ok: false, reason: `Couldn't check your calendar (${busy.error}), so no call — better safe than interrupting.` };
  if (busy.busy) return { ok: false, reason: `You have "${busy.event ?? "an event"}" in your calendar right now.` };
  return { ok: true, reason: "Free." };
}

const waiting = new Map<string, (state: "active" | "declined" | "missed") => void>();

/** Maus rings you. Resolves when you answer, decline, or don't pick up (45 s). */
export async function ringUser(reason: string, openingLine?: string): Promise<CallRecord> {
  const bot = callBot();
  if (!bot) throw new Error("No bot to call from.");
  const allowed = await mayCall();
  if (!allowed.ok) {
    const c = record({ direction: "incoming", botId: bot.id, reason, state: "blocked", detail: allowed.reason });
    await notifyUser({ title: `${bot.emoji} ${bot.name} wanted to call`, body: `${reason} (Didn't ring: ${allowed.reason})`, botId: bot.id, priority: "low", type: "call" });
    return c;
  }
  if (!bridgeAvailable()) throw new Error("Calls need the Android app.");
  const c = record({ direction: "incoming", botId: bot.id, reason, openingLine, state: "ringing" });
  const result = new Promise<"active" | "declined" | "missed">((resolve) => {
    waiting.set(c.id, resolve);
    setTimeout(() => waiting.get(c.id) && (waiting.delete(c.id), resolve("missed")), Number(process.env.MAUSDROID_CALL_RING_MS ?? 45_000));
  });
  await bridge("/call/ring", { callId: c.id, name: bot.name, emoji: bot.emoji, reason });
  const state = await result;
  await bridge("/call/stop-ring", { callId: c.id }).catch(() => {});
  const out = patch(c.id, { state, ...(state === "missed" ? { endedAt: now(), detail: "No answer" } : {}) })!;
  if (state === "missed") await notifyUser({ title: `Missed call from ${bot.emoji} ${bot.name}`, body: reason, botId: bot.id, type: "call" });
  return out;
}

export function answerCall(id: string, answer: boolean) {
  const fn = waiting.get(id);
  if (!fn) return getCall(id);
  waiting.delete(id);
  fn(answer ? "active" : "declined");
  return getCall(id);
}

/** You start a call with Maus from its chat. */
export function startOutgoing() {
  const bot = callBot();
  if (!bot) throw new Error("No bot to call.");
  if (!callSettings().enabled) throw new Error("Calls are switched off (Settings → Voice & assistant).");
  return record({ direction: "outgoing", botId: bot.id, reason: "You called", state: "active" });
}

export function endCall(id: string) {
  return patch(id, { state: "ended", endedAt: now() });
}

/** One spoken turn: your words → Maus's reply (waits for the bot, up to 2 min). */
export function callTurn(callId: string, text: string): Promise<{ reply: string }> {
  const c = getCall(callId);
  if (!c || c.state !== "active") throw new Error("This call has ended.");
  return new Promise((resolve) => {
    const off = onTurnEnd((botId, reply) => {
      if (botId !== c.botId) return;
      off();
      clearTimeout(t);
      resolve({ reply });
    });
    const t = setTimeout(() => (off(), resolve({ reply: "Sorry, that's taking me a while. I'll message you when it's done." })), 120_000);
    sendToBot(c.botId, `${text}\n\n(Said aloud during a phone call with you: answer in one to three short spoken sentences, no lists or links.)`, "call");
  });
}
