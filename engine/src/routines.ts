import { collection } from "./store.ts";
import { id, now } from "./util.ts";
import { settings } from "./settings.ts";
import { emit } from "./events.ts";
import { fmtParts } from "./time.ts";

/**
 * Routines: a bot repeats a task on a schedule ("every weekday at 7:00
 * brief me", "check this page every hour and only alert me if the price
 * drops"). The base for smart alerts; Phase 2 adds event triggers.
 */
export interface Schedule {
  kind: "once" | "interval" | "daily" | "weekly";
  /** once: ISO time. */
  at?: string;
  /** interval: minutes between runs (15 or more). */
  minutes?: number;
  /** daily/weekly: local "HH:MM". */
  time?: string;
  /** weekly: 0=Sunday … 6=Saturday. */
  days?: number[];
}

export interface Routine {
  id: string;
  botId: string;
  title: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

const file = collection<Routine[]>("routines", []);

function localParts(d: Date) {
  const tz = settings().timeZone;
  const parts = fmtParts(d, tz, { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  return { hm: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`, wd, ymd: `${p.year}-${p.month}-${p.day}` };
}

/** Next run strictly after `from`, scanning minute by minute for daily/weekly (cheap: at most 8 days). */
export function nextRun(s: Schedule, from: Date): Date | null {
  if (s.kind === "once") {
    const t = s.at ? new Date(s.at) : null;
    return t && t > from ? t : null;
  }
  if (s.kind === "interval") return new Date(from.getTime() + Math.max(15, s.minutes ?? 60) * 60_000);
  const start = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const d = new Date(start.getTime() + i * 60_000);
    const p = localParts(d);
    if (p.hm !== s.time) continue;
    if (s.kind === "weekly" && !(s.days ?? []).includes(p.wd)) continue;
    return d;
  }
  return null;
}

export function listRoutines(botId?: string) {
  return file.get().filter((r) => !botId || r.botId === botId);
}

export function createRoutine(r: Omit<Routine, "id" | "createdAt" | "enabled" | "nextRunAt"> & { enabled?: boolean }): Routine {
  const routine: Routine = { ...r, id: id("rt"), createdAt: now(), enabled: r.enabled ?? true };
  routine.nextRunAt = nextRun(routine.schedule, new Date())?.toISOString();
  file.update((l) => void l.push(routine));
  emit("routines.changed", {});
  return routine;
}

export function updateRoutine(rid: string, patch: Partial<Routine>) {
  file.update((l) => {
    const r = l.find((x) => x.id === rid);
    if (!r) throw new Error("No such routine");
    Object.assign(r, patch);
    r.nextRunAt = nextRun(r.schedule, new Date())?.toISOString();
  });
  emit("routines.changed", {});
}

export function deleteRoutine(rid: string) {
  file.update((l) => {
    const i = l.findIndex((x) => x.id === rid);
    if (i >= 0) l.splice(i, 1);
  });
  emit("routines.changed", {});
}

/** Called every 30 s. The Android shell also wakes the engine with an alarm so this runs with the screen off. */
export function dueRoutines(at = new Date()): Routine[] {
  const due: Routine[] = [];
  file.update((l) => {
    for (const r of l) {
      if (!r.enabled || !r.nextRunAt) continue;
      if (new Date(r.nextRunAt) <= at) {
        due.push({ ...r });
        r.lastRunAt = at.toISOString();
        r.nextRunAt = nextRun(r.schedule, at)?.toISOString();
        if (!r.nextRunAt && r.schedule.kind === "once") r.enabled = false;
      }
    }
  });
  return due;
}
