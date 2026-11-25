/**
 * Routine schedules: one model for every way a routine can start.
 *
 * User-facing options:
 *   - "alert"   Upon Alert: when a matching alert/event happens.
 *   - "daily"   Once a Day at a local time.
 *   - "weekly"  Once a Week on one or more weekdays at a local time.
 *   - "custom"  Intervals (15 min or more), specific dates/times, or
 *               recurring every N days at several times; optional
 *               execution window and conditions.
 * Also: "geofence" (modelled for a later release, not activated) and the
 * older "once" / "interval" kinds, which keep working unchanged.
 *
 * Time zones: the phone's Node.js has no Intl, so local times are computed
 * by briefly switching the process TZ (the system time-zone database knows
 * daylight saving). A time that doesn't exist on a DST-start day moves
 * forward; a repeated time on a DST-end day runs once.
 */
export type ScheduleKind = "alert" | "daily" | "weekly" | "custom" | "geofence" | "once" | "interval";

export interface AlertTrigger {
  /** e.g. "bot-alert", "app-event", "phone-notification", "external". Empty = any. */
  type?: string;
  /** Where it came from (bot name, app, sender). Case-insensitive "contains". */
  source?: string;
  /** Lowest priority that triggers. */
  minPriority?: "low" | "normal" | "high";
  /** Text that must appear in the title or body. */
  contains?: string;
  /** Ignore the same event again within this many minutes (default 60). */
  dedupeMinutes?: number;
}

export interface GeofenceTrigger {
  lat: number;
  lng: number;
  radiusM: number;
  on: "enter" | "exit";
}

export interface CustomSchedule {
  mode: "interval" | "dates" | "recurring";
  /** interval: minutes between runs (15+). */
  minutes?: number;
  /** dates: local date-times "YYYY-MM-DDTHH:MM". */
  dates?: string[];
  /** recurring: every N days (from startDate), at these local times, optionally only on these weekdays. */
  everyDays?: number;
  times?: string[];
  days?: number[];
  startDate?: string;
}

export interface Schedule {
  kind: ScheduleKind;
  /** IANA zone, e.g. "Australia/Sydney". Missing or "local" = the phone's time zone. */
  timeZone?: string;
  /** daily/weekly: local "HH:MM". */
  time?: string;
  /** weekly: 0=Sunday … 6=Saturday. */
  days?: number[];
  custom?: CustomSchedule;
  /** Only run inside this local time window (and on these weekdays, if given). */
  window?: { start: string; end: string; days?: number[] };
  /** Plain-language condition the bot checks before acting (e.g. "only if it will rain"). */
  conditions?: string;
  alert?: AlertTrigger;
  geofence?: GeofenceTrigger;
  /** What to do when a run was missed (phone off, app closed): run once late, or skip. */
  missedPolicy?: "run-once" | "skip";
  /** Only catch up when no more than this many hours late (default 12). */
  catchUpHours?: number;
  /** once (older kind): ISO time. */
  at?: string;
  /** interval (older kind): minutes. */
  minutes?: number;
}

export interface Occurrence {
  at: Date;
  /** Stable id of this occurrence, used to never run it twice. */
  key: string;
}

const pad = (n: number) => String(n).padStart(2, "0");
const HM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** Runs `fn` with local time in `tz` (restores the previous zone afterwards). */
export function withTimeZone<T>(tz: string | undefined, fn: () => T): T {
  if (!tz || tz === "local") return fn();
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

const parseHM = (s: string) => {
  const m = s.match(HM);
  if (!m) throw new Error(`"${s}" isn't a time like 07:30`);
  return [Number(m[1]), Number(m[2])] as const;
};
const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const localKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}@${pad(d.getHours())}:${pad(d.getMinutes())}`;

function inWindow(d: Date, w?: Schedule["window"]): boolean {
  if (!w) return true;
  if (w.days?.length && !w.days.includes(d.getDay())) return false;
  const [sh, sm] = parseHM(w.start);
  const [eh, em] = parseHM(w.end);
  const m = minutesOf(d);
  const a = sh * 60 + sm;
  const b = eh * 60 + em;
  return a <= b ? m >= a && m <= b : m >= a || m <= b;
}

/** Problems with a schedule, in plain words (empty = fine). */
export function validateSchedule(s: Schedule): string[] {
  const errs: string[] = [];
  try {
    if (s.kind === "daily" || s.kind === "weekly") {
      if (!s.time) errs.push("Choose a time.");
      else parseHM(s.time);
    }
    if (s.kind === "weekly" && !(s.days ?? []).length) errs.push("Choose at least one weekday.");
    if ((s.days ?? []).some((d) => d < 0 || d > 6)) errs.push("Weekdays are 0 (Sunday) to 6 (Saturday).");
    if (s.kind === "interval" && (s.minutes ?? 60) < 15) errs.push("Intervals must be at least 15 minutes.");
    if (s.kind === "once" && (!s.at || isNaN(Date.parse(s.at)))) errs.push("Choose a date and time.");
    if (s.kind === "custom") {
      const c = s.custom;
      if (!c) errs.push("Describe the custom schedule.");
      else if (c.mode === "interval" && (c.minutes ?? 0) < 15) errs.push("Intervals must be at least 15 minutes.");
      else if (c.mode === "dates" && !(c.dates ?? []).length) errs.push("Add at least one date and time.");
      else if (c.mode === "dates" && (c.dates ?? []).some((x) => !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(x))) errs.push('Dates look like "2026-12-01T07:30".');
      else if (c.mode === "recurring") {
        if (!(c.times ?? []).length) errs.push("Add at least one time.");
        (c.times ?? []).forEach(parseHM);
        if ((c.everyDays ?? 1) < 1) errs.push("Repeat every 1 day or more.");
      }
    }
    if (s.window) {
      parseHM(s.window.start);
      parseHM(s.window.end);
    }
    if (s.kind === "alert" && !s.alert) errs.push("Say which alerts should start it.");
    if (s.kind === "geofence") {
      const g = s.geofence;
      if (!g || Math.abs(g.lat) > 90 || Math.abs(g.lng) > 180) errs.push("Give a valid place (latitude/longitude).");
      else if (g.radiusM < 100 || g.radiusM > 50_000) errs.push("Radius must be between 100 m and 50 km.");
    }
    if (s.timeZone && s.timeZone !== "local" && !/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)+$|^UTC$/.test(s.timeZone)) errs.push(`Unknown time zone "${s.timeZone}".`);
  } catch (e) {
    errs.push((e as Error).message);
  }
  return errs;
}

/** The next time this schedule fires strictly after `from` (null for event-based or finished schedules). */
export function nextOccurrence(s: Schedule, from: Date): Occurrence | null {
  return withTimeZone(s.timeZone, () => next(s, from));
}

function next(s: Schedule, from: Date): Occurrence | null {
  switch (s.kind) {
    case "alert":
    case "geofence":
      return null;
    case "once": {
      const t = s.at ? new Date(s.at) : null;
      return t && t > from ? { at: t, key: `once@${t.toISOString()}` } : null;
    }
    case "interval":
      return intervalNext(from, s.minutes ?? 60, s.window);
    case "daily":
    case "weekly": {
      const [h, m] = parseHM(s.time ?? "");
      for (let i = 0; i < 400; i++) {
        const c = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i, h, m, 0, 0);
        if (c <= from) continue;
        if (s.kind === "weekly" && !(s.days ?? []).includes(c.getDay())) continue;
        if (!inWindow(c, s.window)) continue;
        return { at: c, key: localKey(new Date(c.getFullYear(), c.getMonth(), c.getDate(), h, m)) };
      }
      return null;
    }
    case "custom": {
      const c = s.custom;
      if (!c) return null;
      if (c.mode === "interval") return intervalNext(from, c.minutes ?? 60, s.window);
      if (c.mode === "dates") {
        const all = (c.dates ?? [])
          .map((x) => {
            const [d, t] = x.split("T");
            const [Y, M, D] = d.split("-").map(Number);
            const [h, m] = t.split(":").map(Number);
            return { at: new Date(Y, M - 1, D, h, m), key: `date@${x}` };
          })
          .filter((o) => o.at > from && inWindow(o.at, s.window))
          .sort((a, b) => a.at.getTime() - b.at.getTime());
        return all[0] ?? null;
      }
      const times = (c.times ?? []).map(parseHM).sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
      const every = Math.max(1, c.everyDays ?? 1);
      const [sy, sm, sd] = (c.startDate ?? "").split("-").map(Number);
      const start = c.startDate ? new Date(sy, sm - 1, sd) : new Date(from.getFullYear(), from.getMonth(), from.getDate());
      for (let i = 0; i < 800; i++) {
        const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
        const diff = Math.round((day.getTime() - start.getTime()) / 86400_000);
        if (diff < 0 || diff % every !== 0) continue;
        if (c.days?.length && !c.days.includes(day.getDay())) continue;
        for (const [h, m] of times) {
          const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
          if (at > from && inWindow(at, s.window)) return { at, key: localKey(new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m)) };
        }
      }
      return null;
    }
  }
}

function intervalNext(from: Date, minutes: number, window?: Schedule["window"]): Occurrence | null {
  const step = Math.max(15, minutes) * 60_000;
  // Aligned to the step from midnight UTC so the same run isn't scheduled twice after a restart.
  let t = Math.floor(from.getTime() / step) * step + step;
  for (let i = 0; i < 10_000; i++, t += step) {
    const d = new Date(t);
    if (inWindow(d, window)) return { at: d, key: `every${minutes}@${d.toISOString()}` };
  }
  return null;
}

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const time12 = (hm: string) => {
  const [h, m] = parseHM(hm);
  return `${h % 12 || 12}:${pad(m)} ${h < 12 ? "am" : "pm"}`;
};
const dayList = (d: number[]) => (d.length === 7 ? "every day" : d.length === 5 && [1, 2, 3, 4, 5].every((x) => d.includes(x)) ? "weekdays" : d.map((x) => DAY[x]).join(", "));

/** Human-readable preview, e.g. "Every Sunday at 7:52 am (Australia/Sydney)". */
export function describeSchedule(s: Schedule): string {
  const tz = s.timeZone && s.timeZone !== "local" ? ` (${s.timeZone})` : "";
  const win = s.window ? `, only between ${time12(s.window.start)} and ${time12(s.window.end)}${s.window.days?.length ? ` on ${dayList(s.window.days)}` : ""}` : "";
  const cond = s.conditions ? `, if ${s.conditions}` : "";
  try {
    switch (s.kind) {
      case "alert": {
        const a = s.alert ?? {};
        const what = [a.type && `${a.type} alerts`, a.source && `from "${a.source}"`, a.contains && `mentioning "${a.contains}"`, a.minPriority && a.minPriority !== "low" && `${a.minPriority}+ priority`].filter(Boolean).join(" ");
        return `Upon alert: ${what || "any alert"}${cond}`;
      }
      case "daily":
        return `Once a day at ${time12(s.time!)}${tz}${win}${cond}`;
      case "weekly":
        return `Once a week: ${dayList(s.days ?? [])} at ${time12(s.time!)}${tz}${win}${cond}`;
      case "once":
        return `Once on ${new Date(s.at!).toLocaleString()}${cond}`;
      case "interval":
        return `Every ${s.minutes ?? 60} minutes${win}${cond}`;
      case "geofence":
        return `When you ${s.geofence?.on === "exit" ? "leave" : "arrive at"} a place (${s.geofence?.radiusM} m radius) — not active in this version`;
      case "custom": {
        const c = s.custom!;
        if (c.mode === "interval") return `Every ${c.minutes} minutes${tz}${win}${cond}`;
        if (c.mode === "dates") return `On ${(c.dates ?? []).map((d) => d.replace("T", " at ")).join("; ")}${tz}${win}${cond}`;
        return `Every ${(c.everyDays ?? 1) === 1 ? "day" : `${c.everyDays} days`}${c.days?.length ? ` (${dayList(c.days)})` : ""} at ${(c.times ?? []).map(time12).join(", ")}${tz}${win}${cond}`;
      }
    }
  } catch {
    return "Schedule needs fixing";
  }
}
