import { argsFor, executeTool, listConnections } from "./composio.ts";
import { collection } from "./store.ts";
import { emit } from "./events.ts";
import { id as newId, now } from "./util.ts";
import { dayStatus, extractThursday, pickSportSheet, rankStaffUpdates, type DayStatus, type DriveFile, type TermDates } from "./brief-logic.ts";
import * as calendar from "./calendar.ts";
import { listAlerts, notifyUser } from "./notify.ts";

/**
 * Morning Brief: gathers today's facts (school day, calendar, Staff Update,
 * Thursday sport, notices), with warnings for anything missing, then keeps
 * each published briefing for the Briefing screen.
 */
export interface BriefPrefs {
  /** Words to find the Staff Update (default "Staff Update"). */
  staffUpdateTerms: string[];
  /** Sport matrix spreadsheet (link or id). */
  sportSheet: string;
  /** Your name / staff code as written on the sport matrix. */
  identifiers: string[];
  /** Calendars to show in the brief (empty = all your calendars). */
  briefCalendars: { accountId: string; calendarId: string }[];
  missingInfo: "warn" | "ask";
  eventCreation: "propose" | "never";
  content: string;
  holidays: "short" | "skip";
  /** Which of these the person has confirmed (the rest are assumptions). */
  confirmed: string[];
}

export interface ProposedEvent {
  id: string;
  summary: string;
  start: string;
  durationMinutes?: number;
  reason?: string;
  status: "proposed" | "added" | "duplicate" | "failed" | "dismissed";
  detail?: string;
}

export interface Briefing {
  id: string;
  date: string;
  createdAt: string;
  day: DayStatus;
  summary: string;
  schedule: { time: string; title: string; calendar: string; link?: string }[];
  staffUpdate: { name: string; link?: string; modified: string; summary?: string } | null;
  sport: { sheet: string | null; header: string[]; rows: string[][]; source?: string } | null;
  notices: string[];
  warnings: string[];
  sources: { label: string; url?: string }[];
  calendarStatus: string;
  proposedEvents: ProposedEvent[];
}

const DEFAULT_PREFS: BriefPrefs = {
  staffUpdateTerms: ["Staff Update"],
  sportSheet: "",
  identifiers: [],
  briefCalendars: [],
  missingInfo: "warn",
  eventCreation: "propose",
  content: "Short: today's schedule, key Staff Update items, my Thursday sport, anything needing action.",
  holidays: "short",
  confirmed: [],
};

const store = collection<{ prefs: BriefPrefs; terms: TermDates; briefings: Briefing[] }>("brief", { prefs: DEFAULT_PREFS, terms: { terms: [], days: [] }, briefings: [] });
store.update((s) => (s.prefs = { ...DEFAULT_PREFS, ...s.prefs }));

export const briefSettings = () => ({ prefs: store.get().prefs, terms: store.get().terms });
export function saveBriefSettings(b: { prefs?: Partial<BriefPrefs>; terms?: TermDates }) {
  store.update((s) => {
    if (b.prefs) s.prefs = { ...s.prefs, ...b.prefs };
    if (b.terms) s.terms = b.terms;
  });
  emit("settings.changed");
  return briefSettings();
}

export const listBriefings = () => store.get().briefings.slice().reverse().map(({ id, date, createdAt, summary, warnings }) => ({ id, date, createdAt, summary: summary.slice(0, 160), warnings: warnings.length }));
export const getBriefing = (bid: string) => store.get().briefings.find((b) => b.id === bid);

const sheetId = (s: string) => s.match(/\/d\/([A-Za-z0-9_-]{20,})/)?.[1] ?? (s.trim().match(/^[A-Za-z0-9_-]{20,}$/) ? s.trim() : "");
const findArray = (data: any, keys: string[]): any[] => {
  if (!data || typeof data !== "object") return [];
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  for (const v of Object.values(data)) if (v && typeof v === "object") {
    const hit = findArray(v, keys);
    if (hit.length) return hit;
  }
  return [];
};

async function accountsFor(toolkit: string) {
  return (await listConnections()).filter((a: any) => a.toolkit === toolkit && a.status === "ACTIVE");
}

/** Drive search by title AND content, recent files only. */
async function searchStaffUpdates(terms: string[], since: Date): Promise<{ files: DriveFile[]; warnings: string[] }> {
  const warnings: string[] = [];
  const files: DriveFile[] = [];
  const accounts = await accountsFor("googledrive");
  if (!accounts.length) return { files, warnings: ["Google Drive isn't connected, so the Staff Update couldn't be found."] };
  const esc = (t: string) => t.replace(/'/g, "\\'");
  const byName = terms.map((t) => `name contains '${esc(t)}'`).join(" or ");
  const byText = terms.map((t) => `fullText contains '${esc(t)}'`).join(" or ");
  for (const a of accounts) {
    for (const [q, content] of [[`(${byName}) and modifiedTime > '${since.toISOString()}' and trashed = false`, false], [`(${byText}) and modifiedTime > '${since.toISOString()}' and trashed = false`, true]] as const) {
      try {
        const args = await argsFor("GOOGLEDRIVE_FIND_FILE", { q: { names: ["q", "query"], value: q }, size: { names: ["pageSize", "page_size"], value: 25 }, order: { names: ["orderBy", "order_by"], value: "modifiedTime desc" } });
        const data = await executeTool("GOOGLEDRIVE_FIND_FILE", args, a.id);
        for (const f of findArray(data, ["files", "items"])) {
          if (files.some((x) => x.id === f.id)) continue;
          files.push({ id: f.id, name: f.name ?? f.title, mimeType: f.mimeType ?? "", modifiedTime: f.modifiedTime ?? f.modified_time ?? new Date(0).toISOString(), webViewLink: f.webViewLink ?? `https://drive.google.com/file/d/${f.id}/view`, contentMatch: content, account: a.alias });
        }
      } catch (e) {
        warnings.push(`Drive search (${a.alias ?? a.id}) failed: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }
  return { files, warnings };
}

async function readSport(prefs: BriefPrefs, week: number | undefined, term: number | undefined) {
  const id = sheetId(prefs.sportSheet);
  if (!id) return { sport: null, warnings: ["No sport matrix spreadsheet set (Morning Brief settings)."], source: undefined };
  if (!week) return { sport: null, warnings: ["The school week isn't known (add term dates), so the sport sheet can't be chosen."], source: undefined };
  const accounts = await accountsFor("googlesheets");
  if (!accounts.length) return { sport: null, warnings: ["Google Sheets isn't connected."], source: undefined };
  const warnings: string[] = [];
  for (const a of accounts) {
    try {
      const info = await executeTool("GOOGLESHEETS_GET_SPREADSHEET_INFO", await argsFor("GOOGLESHEETS_GET_SPREADSHEET_INFO", { id: { names: ["spreadsheet_id", "spreadsheetId"], value: id } }), a.id);
      const names = findArray(info, ["sheets"]).map((s: any) => String(s.properties?.title ?? s.title ?? ""));
      const pick = pickSportSheet(names, week, term);
      warnings.push(...pick.warnings);
      const source = `https://docs.google.com/spreadsheets/d/${id}`;
      if (!pick.sheet) return { sport: { sheet: null, header: [], rows: [], source }, warnings, source };
      const range = `'${pick.sheet.replace(/'/g, "''")}'!A1:Z300`;
      const vals = await executeTool("GOOGLESHEETS_BATCH_GET", await argsFor("GOOGLESHEETS_BATCH_GET", { id: { names: ["spreadsheet_id", "spreadsheetId"], value: id }, ranges: { names: ["ranges"], value: [range] } }), a.id);
      const values: string[][] = findArray(vals, ["values"]).length && Array.isArray(findArray(vals, ["values"])[0]) ? findArray(vals, ["values"]) : findArray(findArray(vals, ["valueRanges", "value_ranges"])[0] ?? {}, ["values"]);
      const t = extractThursday(values, prefs.identifiers);
      warnings.push(...t.warnings);
      return { sport: { sheet: pick.sheet.trim(), header: t.header, rows: t.rows, source: `${source} · tab "${pick.sheet.trim()}"` }, warnings, source };
    } catch (e) {
      warnings.push(`Sport sheet (${a.alias ?? a.id}): ${(e as Error).message.slice(0, 160)}`);
    }
  }
  return { sport: null, warnings, source: undefined };
}

async function todaysEvents(prefs: BriefPrefs, date: Date) {
  const warnings: string[] = [];
  const out: Briefing["schedule"] = [];
  let found;
  try {
    found = calendar.lastDiscovery() ?? (await calendar.discoverCalendars());
  } catch (e) {
    return { events: out, warnings: [`Calendar couldn't be read: ${(e as Error).message}`] };
  }
  for (const p of found.problems) warnings.push(`Calendar: ${p.accountAlias ? `${p.accountAlias}: ` : ""}${p.error}`);
  const wanted = prefs.briefCalendars.length ? found.calendars.filter((c) => prefs.briefCalendars.some((w) => w.accountId === c.accountId && w.calendarId === c.calendarId)) : found.calendars.filter((c) => c.accessRole !== "freeBusyReader").slice(0, 8);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start.getTime() + 86400_000);
  for (const c of wanted) {
    try {
      const args = await argsFor(calendar.SLUGS.events, { cal: { names: ["calendarId", "calendar_id"], value: c.calendarId }, min: { names: ["timeMin", "time_min"], value: start.toISOString() }, max: { names: ["timeMax", "time_max"], value: end.toISOString() }, single: { names: ["singleEvents", "single_events"], value: true }, order: { names: ["orderBy", "order_by"], value: "startTime" } });
      for (const ev of findArray(await executeTool(calendar.SLUGS.events, args, c.accountId), ["items", "events"])) {
        const st = ev.start?.dateTime ?? ev.start?.date ?? "";
        out.push({ time: st.length > 10 ? new Date(st).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "All day", title: ev.summary ?? "(no title)", calendar: `${c.name} (${c.accountAlias})`, link: ev.htmlLink });
      }
    } catch (e) {
      warnings.push(`Calendar "${c.name}" couldn't be read: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  out.sort((a, b) => (a.time === "All day" ? -1 : b.time === "All day" ? 1 : 0));
  return { events: out, warnings };
}

const drafts = new Map<string, Awaited<ReturnType<typeof prepareBrief>>>();

/** Everything the brief needs for a date, with warnings and source links. Nothing is guessed. */
export async function prepareBrief(dateStr?: string) {
  const date = dateStr ? new Date(`${dateStr}T08:00:00`) : new Date();
  const { prefs, terms } = briefSettings();
  const day = dayStatus(date, terms);
  const warnings: string[] = [];
  if (day.unconfirmed) warnings.push("Term dates aren't confirmed, so school-day/week details may be wrong (Morning Brief settings).");
  const termNo = Number(day.term?.match(/\d+/)?.[0]) || undefined;
  const [cal, staff, sport] = await Promise.all([
    todaysEvents(prefs, date),
    searchStaffUpdates(prefs.staffUpdateTerms.length ? prefs.staffUpdateTerms : ["Staff Update"], new Date(date.getTime() - 21 * 86400_000)),
    readSport(prefs, day.week, termNo),
  ]);
  const pick = rankStaffUpdates(staff.files, date, { term: termNo, week: day.week });
  warnings.push(...cal.warnings, ...staff.warnings, ...pick.warnings, ...sport.warnings);
  const dest = calendar.getDestination();
  const calendarStatus = dest ? `Events go to ${dest.name} (${dest.accountAlias})${dest.writeTest ? (dest.writeTest.ok ? " — write tested ✓" : " — write test failed") : " — not write-tested yet"}` : "No destination calendar chosen; events can only be proposed.";
  const cutoff = Date.now() - 24 * 3600_000;
  const notices = listAlerts()
    .filter((a) => new Date(a.at).getTime() > cutoff && a.type !== "approval" && a.type !== "routine-result")
    .slice(0, 10)
    .map((a) => `${a.title}: ${a.body}`.slice(0, 200));
  const sources: Briefing["sources"] = [];
  if (pick.best) sources.push({ label: `Staff Update: ${pick.best.name}`, url: pick.best.webViewLink });
  if (sport.source) sources.push({ label: "Sport matrix", url: sport.source.split(" · ")[0] });
  const out = {
    date: day.date,
    day,
    prefs: { ...prefs, assumed: Object.keys(DEFAULT_PREFS).filter((k) => k !== "confirmed" && !prefs.confirmed.includes(k)) },
    schedule: cal.events,
    staffUpdate: pick.best ? { name: pick.best.name, link: pick.best.webViewLink, modified: pick.best.modifiedTime, id: pick.best.id, account: pick.best.account } : null,
    staffUpdateAlternatives: pick.alternatives.map((f) => ({ name: f.name, link: f.webViewLink, modified: f.modifiedTime })),
    sport: sport.sport,
    notices,
    warnings,
    sources,
    calendarStatus,
  };
  drafts.set(out.date, out);
  return out;
}

/** Saves the finished brief (bot's summary + gathered facts) and notifies with a link to it. */
export async function publishBrief(input: { date?: string; summary: string; staff_update_summary?: string; notices?: string[]; proposed_events?: { summary: string; start: string; duration_minutes?: number; reason?: string }[]; extra_warnings?: string[] }, botId?: string) {
  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const d = drafts.get(date) ?? (await prepareBrief(date));
  const prefs = briefSettings().prefs;
  const b: Briefing = {
    id: newId("brief"),
    date: d.date,
    createdAt: now(),
    day: d.day,
    summary: input.summary,
    schedule: d.schedule,
    staffUpdate: d.staffUpdate ? { name: d.staffUpdate.name, link: d.staffUpdate.link, modified: d.staffUpdate.modified, summary: input.staff_update_summary } : null,
    sport: d.sport,
    notices: [...(input.notices ?? []), ...d.notices].slice(0, 15),
    warnings: [...d.warnings, ...(input.extra_warnings ?? [])],
    sources: d.sources,
    calendarStatus: d.calendarStatus,
    proposedEvents: prefs.eventCreation === "never" ? [] : (input.proposed_events ?? []).map((e) => ({ id: newId("pe"), summary: e.summary, start: e.start, durationMinutes: e.duration_minutes, reason: e.reason, status: "proposed" as const })),
  };
  store.update((s) => {
    s.briefings.push(b);
    if (s.briefings.length > 120) s.briefings.splice(0, s.briefings.length - 120);
  });
  emit("briefing", { id: b.id });
  await notifyUser({
    title: "Morning Brief ready",
    body: `${b.day.reason}${b.warnings.length ? ` ${b.warnings.length} thing(s) to check.` : ""} Tap to open.`,
    botId,
    type: "briefing",
    source: "Morning Brief",
    link: `briefing:${b.id}`,
  });
  return b;
}

/** You approve (or dismiss) a proposed event from the Briefing screen. */
export async function decideEvent(bid: string, eid: string, approve: boolean) {
  const b = getBriefing(bid);
  const e = b?.proposedEvents.find((x) => x.id === eid);
  if (!b || !e) throw new Error("No such proposal");
  if (e.status !== "proposed" && e.status !== "failed") return e;
  let patch: Partial<ProposedEvent>;
  if (!approve) patch = { status: "dismissed" };
  else {
    const r = await calendar.createEvent({ summary: e.summary, start: e.start, durationMinutes: e.durationMinutes });
    patch = { status: r.status === "created" ? "added" : r.status, detail: r.detail };
  }
  store.update((s) => Object.assign(s.briefings.find((x) => x.id === bid)!.proposedEvents.find((x) => x.id === eid)!, patch));
  emit("briefing", { id: bid });
  return { ...e, ...patch };
}

export const MORNING_BRIEF_PROMPT = `Prepare today's Morning Brief.
1. Call morning_brief_prepare.
2. If it's not a school day, follow the holiday preference (short brief or skip).
3. If a Staff Update was found, read it (Google Docs/Drive through connected apps, or web_fetch its link) and pick out what matters for me today and this week. Don't use an older Staff Update if this week's is missing — say it's missing.
4. Use only the sport rows returned (never last week's). If the sport sheet is missing, say so.
5. Write the brief following my content preference, in plain words.
6. For dated items that should be in my calendar, propose events (don't create them).
7. Call morning_brief_publish with the summary, a short Staff Update summary, notices and proposed events. Mention every warning honestly.`;

/** This week's Staff Update in Drive (newest, published to or shared with the person), or null. */
export async function latestStaffUpdate(at = new Date()) {
  const { prefs, terms } = briefSettings();
  const day = dayStatus(at, terms);
  const termNo = Number(day.term?.match(/\d+/)?.[0]) || undefined;
  const found = await searchStaffUpdates(prefs.staffUpdateTerms.length ? prefs.staffUpdateTerms : ["Staff Update"], new Date(at.getTime() - 10 * 86400_000));
  const pick = rankStaffUpdates(found.files, at, { term: termNo, week: day.week });
  return { file: pick.best ?? null, warnings: [...found.warnings, ...pick.warnings], week: day.week, term: termNo };
}
