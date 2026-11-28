import { argsFor, executeTool, listConnections } from "./composio.ts";
import { collection } from "./store.ts";
import { emit } from "./events.ts";

/**
 * Google Calendar through Composio, across every connected Google account.
 *  - Finds every calendar each account can see, with its access level
 *    (owner / writer = can add events; reader / freeBusyReader = read-only).
 *    A shared calendar (e.g. the CMW calendar shared to your personal Gmail
 *    with "Make changes to events") appears under that account as "writer".
 *  - Never assumes the default calendar: events go to the calendar you chose.
 *  - Checks for an identical event first, and confirms the event really
 *    exists after creating it.
 */
export const SLUGS = {
  list: "GOOGLECALENDAR_LIST_CALENDARS",
  events: "GOOGLECALENDAR_EVENTS_LIST",
  create: "GOOGLECALENDAR_CREATE_EVENT",
  remove: "GOOGLECALENDAR_DELETE_EVENT",
};

export interface CalendarInfo {
  accountId: string;
  accountAlias: string;
  calendarId: string;
  name: string;
  accessRole: string;
  writable: boolean;
  primary: boolean;
}

export interface CalendarDiscovery {
  calendars: CalendarInfo[];
  /** Accounts that couldn't be read, and why. */
  problems: { accountId: string; accountAlias: string; error: string }[];
  checkedAt: string;
}

export interface Destination {
  accountId: string;
  calendarId: string;
  name: string;
  accountAlias: string;
  /** Last write test. */
  writeTest?: { ok: boolean; at: string; detail: string };
}

const store = collection<{ destination: Destination | null; last: CalendarDiscovery | null }>("calendar", { destination: null, last: null });

/** Finds arrays of objects anywhere in a Composio response (their shapes vary). */
function findArray(data: any, keys: string[]): any[] {
  if (!data || typeof data !== "object") return [];
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  for (const v of Object.values(data)) {
    if (v && typeof v === "object") {
      const hit = findArray(v, keys);
      if (hit.length) return hit;
    }
  }
  return [];
}

export async function discoverCalendars(): Promise<CalendarDiscovery> {
  const accounts = (await listConnections()).filter((a: any) => a.toolkit === "googlecalendar" && a.status === "ACTIVE");
  const out: CalendarDiscovery = { calendars: [], problems: [], checkedAt: new Date().toISOString() };
  if (!accounts.length) out.problems.push({ accountId: "", accountAlias: "", error: "No Google Calendar account is connected. Connect one in Settings → Connected apps → Google Calendar." });
  for (const a of accounts) {
    const alias = a.alias ?? a.id;
    try {
      const data = await executeTool(SLUGS.list, {}, a.id);
      for (const c of findArray(data, ["items", "calendars"])) {
        const role = String(c.accessRole ?? c.access_role ?? "reader");
        out.calendars.push({ accountId: a.id, accountAlias: alias, calendarId: String(c.id), name: String(c.summaryOverride ?? c.summary ?? c.id), accessRole: role, writable: role === "owner" || role === "writer", primary: Boolean(c.primary) });
      }
    } catch (e) {
      out.problems.push({ accountId: a.id, accountAlias: alias, error: explain((e as Error).message) });
    }
  }
  store.update((s) => (s.last = out));
  return out;
}

/** Turns API errors into something a person can act on. */
function explain(msg: string): string {
  if (/401|unauthor|invalid_grant|expired/i.test(msg)) return `The sign-in for this account has expired. Reconnect it in Connected apps. (${msg.slice(0, 120)})`;
  if (/403|forbidden|insufficient|permission/i.test(msg)) return `This account doesn't allow it (no permission). If it's a shared calendar, ask its owner for "Make changes to events". (${msg.slice(0, 120)})`;
  if (/404|not found/i.test(msg)) return `Calendar not found from this account. (${msg.slice(0, 120)})`;
  return msg.slice(0, 300);
}

export const getDestination = () => store.get().destination;
export const lastDiscovery = () => store.get().last;

export function setDestination(d: Omit<Destination, "writeTest"> | null) {
  store.update((s) => (s.destination = d ? { ...d } : null));
  emit("settings.changed");
}

export interface NewEvent {
  summary: string;
  /** Local date-time "YYYY-MM-DDTHH:MM" (or ISO). */
  start: string;
  durationMinutes?: number;
  description?: string;
  location?: string;
  timeZone?: string;
}

async function resolveTarget(target?: { accountId?: string; calendarId?: string; name?: string }) {
  const dest = getDestination();
  if (target?.calendarId && target.accountId) return { accountId: target.accountId, calendarId: target.calendarId };
  const known = lastDiscovery()?.calendars ?? (await discoverCalendars()).calendars;
  if (target?.name || target?.calendarId) {
    const want = (target.name ?? target.calendarId ?? "").toLowerCase();
    const hit = known.find((c) => c.calendarId.toLowerCase() === want || c.name.toLowerCase() === want) ?? known.find((c) => c.name.toLowerCase().includes(want));
    if (!hit) throw new Error(`No calendar called "${target.name ?? target.calendarId}". Use calendar_list to see them.`);
    return { accountId: hit.accountId, calendarId: hit.calendarId };
  }
  if (!dest) throw new Error("No destination calendar chosen. Pick one in Settings → Connected apps → Calendars (DanDroid never guesses the default calendar).");
  return { accountId: dest.accountId, calendarId: dest.calendarId };
}

function writableCheck(accountId: string, calendarId: string) {
  const c = lastDiscovery()?.calendars.find((x) => x.accountId === accountId && x.calendarId === calendarId);
  if (c && !c.writable) throw new Error(`"${c.name}" is read-only for ${c.accountAlias} (access: ${c.accessRole}). Ask the owner for "Make changes to events", or choose another calendar.`);
  return c;
}

const toUtcRange = (start: string, minutes: number) => {
  const s = new Date(start);
  return { min: new Date(s.getTime() - 60_000).toISOString(), max: new Date(s.getTime() + Math.max(1, minutes) * 60_000 + 60_000).toISOString(), startMs: s.getTime() };
};

async function eventsAround(accountId: string, calendarId: string, ev: NewEvent) {
  const r = toUtcRange(ev.start, ev.durationMinutes ?? 60);
  const args = await argsFor(SLUGS.events, {
    cal: { names: ["calendarId", "calendar_id"], value: calendarId },
    min: { names: ["timeMin", "time_min"], value: r.min },
    max: { names: ["timeMax", "time_max"], value: r.max },
    q: { names: ["q", "query"], value: ev.summary },
    single: { names: ["singleEvents", "single_events"], value: true },
  });
  const data = await executeTool(SLUGS.events, args, accountId);
  return { items: findArray(data, ["items", "events"]), startMs: r.startMs };
}

const sameEvent = (item: any, ev: NewEvent, startMs: number) => {
  const st = item.start?.dateTime ?? item.start?.date ?? item.start_datetime;
  return String(item.summary ?? "").trim().toLowerCase() === ev.summary.trim().toLowerCase() && st && Math.abs(new Date(st).getTime() - startMs) < 60_000;
};

export interface CreateResult {
  status: "created" | "duplicate" | "failed";
  verified: boolean;
  calendar: string;
  eventId?: string;
  link?: string;
  detail: string;
}

/** Creates an event in the chosen calendar: duplicate check → create → verify. */
export async function createEvent(ev: NewEvent, target?: { accountId?: string; calendarId?: string; name?: string }): Promise<CreateResult> {
  if (!ev.summary?.trim() || !ev.start) throw new Error("An event needs a title and a start time.");
  const { accountId, calendarId } = await resolveTarget(target);
  const info = writableCheck(accountId, calendarId);
  const label = info ? `${info.name} (${info.accountAlias})` : calendarId;
  const before = await eventsAround(accountId, calendarId, ev).catch(() => null);
  const dup = before?.items.find((it) => sameEvent(it, ev, before.startMs));
  if (dup) return { status: "duplicate", verified: true, calendar: label, eventId: dup.id, link: dup.htmlLink, detail: `"${ev.summary}" already exists at that time in ${label}; nothing added.` };
  const minutes = ev.durationMinutes ?? 60;
  const args = await argsFor(SLUGS.create, {
    cal: { names: ["calendar_id", "calendarId"], value: calendarId },
    summary: { names: ["summary", "title"], value: ev.summary },
    start: { names: ["start_datetime", "start_time", "startDateTime"], value: ev.start },
    hours: { names: ["event_duration_hour"], value: Math.floor(minutes / 60) },
    mins: { names: ["event_duration_minutes"], value: minutes % 60 },
    tz: { names: ["timezone", "time_zone", "timeZone"], value: ev.timeZone },
    desc: { names: ["description"], value: ev.description },
    loc: { names: ["location"], value: ev.location },
  });
  let created: any;
  try {
    created = await executeTool(SLUGS.create, args, accountId);
  } catch (e) {
    return { status: "failed", verified: false, calendar: label, detail: `Couldn't add it to ${label}: ${explain((e as Error).message)}` };
  }
  const eventId = created?.id ?? created?.response_data?.id ?? findArray({ x: [created] }, ["x"])[0]?.id;
  // Verify: the event must now be in the calendar.
  const after = await eventsAround(accountId, calendarId, ev).catch(() => null);
  const found = after?.items.find((it) => (eventId && it.id === eventId) || sameEvent(it, ev, after.startMs));
  return found
    ? { status: "created", verified: true, calendar: label, eventId: found.id, link: found.htmlLink, detail: `Added "${ev.summary}" to ${label} and confirmed it's there.` }
    : { status: "created", verified: false, calendar: label, eventId, detail: `Google accepted "${ev.summary}" for ${label}, but it didn't show up when checked. Please look in the calendar.` };
}

/** Write test: adds a short private event far in the future, confirms it, deletes it. */
export async function testWrite(target?: { accountId?: string; calendarId?: string }) {
  const { accountId, calendarId } = await resolveTarget(target);
  const start = new Date(Date.now() + 400 * 86400_000);
  start.setUTCHours(3, 0, 0, 0);
  const ev: NewEvent = { summary: `DanDroid write test ${start.getTime().toString(36)}`, start: start.toISOString(), durationMinutes: 15, description: "Automatic permission check; deleted straight away." };
  let ok = false;
  let detail: string;
  try {
    writableCheck(accountId, calendarId);
    const r = await createEvent(ev, { accountId, calendarId });
    ok = r.status === "created" && r.verified;
    detail = ok ? "Can add events here (test event created, found and removed)." : r.detail;
    if (r.eventId) {
      const del = await argsFor(SLUGS.remove, { cal: { names: ["calendar_id", "calendarId"], value: calendarId }, id: { names: ["event_id", "eventId"], value: r.eventId } });
      await executeTool(SLUGS.remove, del, accountId).catch((e) => (detail += ` (Couldn't remove the test event: ${(e as Error).message})`));
    }
  } catch (e) {
    detail = explain((e as Error).message);
  }
  const result = { ok, at: new Date().toISOString(), detail };
  store.update((s) => {
    if (s.destination && s.destination.accountId === accountId && s.destination.calendarId === calendarId) s.destination.writeTest = result;
  });
  return result;
}


/**
 * Whether any of your calendars has a timed event overlapping [from, to]
 * (all-day events like holidays don't count). Throws if none can be read.
 */
export async function busyBetween(from: Date, to: Date): Promise<{ busy: boolean; event?: string; error?: string }> {
  const found = lastDiscovery() ?? (await discoverCalendars());
  if (!found.calendars.length) throw new Error(found.problems[0]?.error ?? "No Google Calendar is connected");
  let readable = 0;
  for (const c of found.calendars.filter((x) => x.accessRole !== "freeBusyReader").slice(0, 10)) {
    try {
      const args = await argsFor(SLUGS.events, {
        cal: { names: ["calendarId", "calendar_id"], value: c.calendarId },
        min: { names: ["timeMin", "time_min"], value: from.toISOString() },
        max: { names: ["timeMax", "time_max"], value: to.toISOString() },
        single: { names: ["singleEvents", "single_events"], value: true },
      });
      const items = findArray(await executeTool(SLUGS.events, args, c.accountId), ["items", "events"]);
      readable++;
      for (const ev of items) {
        const st = ev.start?.dateTime;
        const en = ev.end?.dateTime;
        if (!st) continue; // all-day
        if (ev.transparency === "transparent" || ev.status === "cancelled") continue;
        if (new Date(st) < to && (!en || new Date(en) > from)) return { busy: true, event: String(ev.summary ?? "an event") };
      }
    } catch {
      /* one unreadable calendar: keep checking the others */
    }
  }
  if (!readable) throw new Error("none of your calendars could be read");
  return { busy: false };
}
