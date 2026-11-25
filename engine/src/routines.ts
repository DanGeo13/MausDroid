import { collection } from "./store.ts";
import { id, now } from "./util.ts";
import { emit } from "./events.ts";
import { describeSchedule, nextOccurrence, validateSchedule, type Schedule } from "./schedule.ts";

export type { Schedule } from "./schedule.ts";

/**
 * Routines: a bot repeats a task on a schedule or when an alert arrives
 * ("every weekday at 7:00 brief me", "when Compass posts a notice, summarise
 * it"). Every run is recorded with an honest status: a queued run is never
 * reported as done.
 */
export interface Routine {
  id: string;
  botId: string;
  title: string;
  prompt: string;
  schedule: Schedule;
  enabled: boolean;
  createdAt: string;
  updatedAt?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  /** Occurrence id of nextRunAt (used to never run the same occurrence twice). */
  nextKey?: string;
  lastResult?: { status: RunStatus; at: string; summary: string };
  /** Retries after a failure (default 1) and the wait between them. */
  retry?: { max: number; delayMinutes: number };
  /** A run that takes longer is stopped and marked timed out (default 15). */
  timeoutMinutes?: number;
  /** Local "HH:MM" by which a run must finish (e.g. the weekly audit's 08:00). */
  deadline?: string;
  /** Minutes after a run starts when research tools stop (weekly audit: 5). */
  researchCutoffMinutes?: number;
  /** Built-in routine (e.g. the weekly audit); only its owner bot or the person can change it. */
  system?: string;
}

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "timed_out" | "missed" | "skipped";

export interface Run {
  id: string;
  routineId: string;
  botId: string;
  key: string;
  trigger: "schedule" | "manual" | "alert" | "catch-up" | "retry" | "share";
  scheduledFor?: string;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: RunStatus;
  attempt: number;
  result?: string;
  error?: string;
  retryAt?: string;
  retried?: boolean;
}

const file = collection<Routine[]>("routines", []);
const runsFile = collection<Run[]>("routine-runs", []);

/** Older routines get today's defaults; nothing about them changes. */
file.update((l) => {
  for (const r of l) {
    r.retry ??= { max: 1, delayMinutes: 5 };
    r.timeoutMinutes ??= 15;
    if (r.enabled && !r.nextKey && r.nextRunAt) r.nextKey = `legacy@${r.nextRunAt}`;
  }
});

export function computeNext(r: Pick<Routine, "schedule">, from = new Date()) {
  const o = nextOccurrence(r.schedule, from);
  return { nextRunAt: o?.at.toISOString(), nextKey: o?.key };
}

export const listRoutines = (botId?: string) => file.get().filter((r) => !botId || r.botId === botId);
export const getRoutine = (rid: string) => file.get().find((r) => r.id === rid);

export interface RoutineInput {
  botId: string;
  title: string;
  prompt: string;
  schedule: Schedule;
  enabled?: boolean;
  retry?: Routine["retry"];
  timeoutMinutes?: number;
  deadline?: string;
  researchCutoffMinutes?: number;
  system?: string;
}

function check(schedule: Schedule) {
  const errs = validateSchedule(schedule);
  if (errs.length) throw new Error(errs.join(" "));
  if (schedule.kind === "geofence") throw new Error("Place-based (geofence) routines are prepared but not switched on in this version.");
}

export function createRoutine(input: RoutineInput): Routine {
  check(input.schedule);
  if (!input.title?.trim()) throw new Error("Give the routine a short title.");
  if (!input.prompt?.trim()) throw new Error("Say what the routine should do.");
  const routine: Routine = {
    retry: { max: 1, delayMinutes: 5 },
    timeoutMinutes: 15,
    ...input,
    title: input.title.trim(),
    id: id("rt"),
    createdAt: now(),
    enabled: input.enabled ?? true,
  };
  Object.assign(routine, routine.enabled ? computeNext(routine) : { nextRunAt: undefined, nextKey: undefined });
  file.update((l) => void l.push(routine));
  emit("routines.changed", {});
  return routine;
}

/** Changes a routine in place (same id). */
export function updateRoutine(rid: string, patch: Partial<Routine>): Routine {
  let out: Routine | undefined;
  if (patch.schedule) check(patch.schedule);
  file.update((l) => {
    const r = l.find((x) => x.id === rid);
    if (!r) throw new Error("No such routine");
    const { id: _id, createdAt: _c, botId: _b, system: _s, ...safe } = patch;
    Object.assign(r, safe, { updatedAt: now() });
    Object.assign(r, r.enabled ? computeNext(r) : { nextRunAt: undefined, nextKey: undefined });
    out = { ...r };
  });
  emit("routines.changed", {});
  return out!;
}

export function deleteRoutine(rid: string) {
  file.update((l) => {
    const i = l.findIndex((x) => x.id === rid);
    if (i >= 0) l.splice(i, 1);
  });
  emit("routines.changed", {});
}

export const pauseRoutine = (rid: string) => updateRoutine(rid, { enabled: false });
export const resumeRoutine = (rid: string) => updateRoutine(rid, { enabled: true });

/** Moves a routine on to its next occurrence after `from`. */
export function advance(rid: string, from: Date) {
  file.update((l) => {
    const r = l.find((x) => x.id === rid);
    if (!r) return;
    Object.assign(r, computeNext(r, from));
    if (!r.nextRunAt && (r.schedule.kind === "once" || (r.schedule.kind === "custom" && r.schedule.custom?.mode === "dates"))) r.enabled = false;
  });
  emit("routines.changed", {});
}

// ---------------- Runs ----------------

export const listRuns = (routineId?: string, limit = 50) =>
  runsFile
    .get()
    .filter((r) => !routineId || r.routineId === routineId)
    .slice(-limit)
    .reverse();

export const getRun = (runId: string) => runsFile.get().find((r) => r.id === runId);

export function addRun(r: Omit<Run, "id" | "queuedAt">): Run {
  const run: Run = { ...r, id: id("run"), queuedAt: now() };
  runsFile.update((l) => {
    l.push(run);
    if (l.length > 3000) l.splice(0, l.length - 3000);
  });
  emit("routines.changed", {});
  return run;
}

export function patchRun(runId: string, patch: Partial<Run>): Run | undefined {
  let out: Run | undefined;
  runsFile.update((l) => {
    const r = l.find((x) => x.id === runId);
    if (r) {
      Object.assign(r, patch);
      out = { ...r };
    }
  });
  if (out && patch.status && ["succeeded", "failed", "timed_out", "missed", "skipped"].includes(patch.status)) {
    file.update((l) => {
      const rt = l.find((x) => x.id === out!.routineId);
      if (rt) rt.lastResult = { status: out!.status, at: now(), summary: (out!.result ?? out!.error ?? "").slice(0, 300) };
    });
  }
  emit("routines.changed", {});
  return out;
}

export function markRoutineRan(rid: string) {
  file.update((l) => {
    const r = l.find((x) => x.id === rid);
    if (r) r.lastRunAt = now();
  });
}

export function historySummary(routineId: string) {
  const recent = listRuns(routineId, 20);
  const count = (s: RunStatus) => recent.filter((r) => r.status === s).length;
  return { last20: { succeeded: count("succeeded"), failed: count("failed") + count("timed_out"), missed: count("missed"), skipped: count("skipped") }, lastStatus: recent[0]?.status ?? null };
}

/** Everything about a routine, for the screen and the routine_list tool. */
export function routineDetails(r: Routine) {
  return {
    id: r.id,
    title: r.title,
    prompt: r.prompt,
    botId: r.botId,
    schedule: r.schedule,
    scheduleText: describeSchedule(r.schedule),
    enabled: r.enabled,
    nextRunAt: r.nextRunAt ?? null,
    lastRunAt: r.lastRunAt ?? null,
    lastResult: r.lastResult ?? null,
    history: historySummary(r.id),
    retry: r.retry,
    timeoutMinutes: r.timeoutMinutes,
    deadline: r.deadline ?? null,
    system: r.system ?? null,
  };
}
