import { advance, getRoutine, getRun, listRoutines, listRuns, addRun, patchRun, markRoutineRan, type Routine, type Run } from "./routines.ts";
import { currentRunTags, onTurnEnd, onTurnStart, sendToBot, stopBot } from "./agent.ts";
import { getBot } from "./bots.ts";
import { notifyUser, onAlert, type Alert } from "./notify.ts";
import { describeSchedule, withTimeZone } from "./schedule.ts";
import { clip } from "./util.ts";

/**
 * Runs routines reliably:
 *  - one run at a time per routine (locking), never the same occurrence twice;
 *  - a run is "queued" until the bot starts it, "running" while it works, and
 *    only "succeeded" when the bot actually finished without an error;
 *  - timeouts and hard deadlines, retries after failures;
 *  - missed runs (phone off, app closed) are caught up once or skipped;
 *  - after a restart, interrupted runs are marked failed and retried.
 */
const GRACE_MS = 3 * 60_000;
const timers = new Map<string, NodeJS.Timeout>();
const active = new Map<string, string>(); // routineId -> runId
const recentAlertKeys = new Map<string, number>();

function lockedBy(routineId: string) {
  const runId = active.get(routineId);
  if (!runId) return null;
  const run = getRun(runId);
  if (!run || !["queued", "running"].includes(run.status)) {
    active.delete(routineId);
    return null;
  }
  return run;
}

/** Local time today at "HH:MM" in the routine's zone. */
function deadlineFor(r: Routine, from: Date): Date | null {
  if (!r.deadline) return null;
  const [h, m] = r.deadline.split(":").map(Number);
  return withTimeZone(r.schedule.timeZone, () => new Date(from.getFullYear(), from.getMonth(), from.getDate(), h, m));
}

function promptFor(r: Routine, run: Run, extra = "") {
  const bits = [
    r.prompt,
    r.schedule.conditions ? `\nOnly act if this condition holds: ${r.schedule.conditions}. If it doesn't, reply "Condition not met" and stop.` : "",
    extra,
    `\n(This is your routine "${r.title}" — ${describeSchedule(r.schedule)}. Run ${run.id}, attempt ${run.attempt}. The person is probably not watching: if there's something they should know, use notify_user; otherwise reply briefly with what you did.)`,
  ];
  return bits.join("\n");
}

export function execute(r: Routine, key: string, trigger: Run["trigger"], opts: { attempt?: number; scheduledFor?: string; extra?: string } = {}): Run | null {
  if (!getBot(r.botId)) return null;
  // Never the same occurrence twice (retries reuse the key on purpose).
  if (trigger !== "retry" && listRuns(r.id, 200).some((x) => x.key === key && ["queued", "running", "succeeded"].includes(x.status))) return null;
  const busy = lockedBy(r.id);
  if (busy) {
    return addRun({ routineId: r.id, botId: r.botId, key, trigger, status: "skipped", attempt: opts.attempt ?? 1, scheduledFor: opts.scheduledFor, error: `Previous run ${busy.id} was still ${busy.status}.` });
  }
  const run = addRun({ routineId: r.id, botId: r.botId, key, trigger, status: "queued", attempt: opts.attempt ?? 1, scheduledFor: opts.scheduledFor });
  active.set(r.id, run.id);
  markRoutineRan(r.id);
  // Timeout: the routine's limit or its hard deadline, whichever comes first.
  const started = new Date();
  let limit = started.getTime() + (r.timeoutMinutes ?? 15) * 60_000;
  const dl = deadlineFor(r, started);
  if (dl && dl.getTime() > started.getTime()) limit = Math.min(limit, dl.getTime());
  timers.set(
    run.id,
    setTimeout(() => timedOut(run.id), Math.max(1000, limit - started.getTime())),
  );
  sendToBot(r.botId, promptFor(r, run, opts.extra), `routine: ${r.title}`, [], run.id);
  return run;
}

function finish(runId: string, status: Run["status"], text: string) {
  clearTimeout(timers.get(runId));
  timers.delete(runId);
  const run = patchRun(runId, { status, finishedAt: new Date().toISOString(), ...(status === "succeeded" ? { result: clip(text, 2000) } : { error: clip(text || status, 2000) }) });
  if (!run) return;
  if (active.get(run.routineId) === runId) active.delete(run.routineId);
  const r = getRoutine(run.routineId);
  if (!r) return;
  if (status === "failed" || status === "timed_out") {
    const retry = r.retry ?? { max: 1, delayMinutes: 5 };
    const late = r.deadline ? (deadlineFor(r, new Date())?.getTime() ?? Infinity) <= Date.now() + retry.delayMinutes * 60_000 : false;
    if (run.attempt <= retry.max && !late) {
      patchRun(runId, { retryAt: new Date(Date.now() + retry.delayMinutes * 60_000).toISOString() });
    } else {
      const bot = getBot(r.botId);
      void notifyUser({
        title: `${bot?.emoji ?? "⚠️"} Routine "${r.title}" ${status === "timed_out" ? "ran out of time" : "failed"}`,
        body: clip(text || "No details.", 280),
        botId: r.botId,
        priority: "normal",
        type: "routine-result",
        source: r.title,
        routineId: r.id,
      });
    }
  }
}

function timedOut(runId: string) {
  const run = getRun(runId);
  if (!run || !["queued", "running"].includes(run.status)) return;
  if (currentRunTags(run.botId).includes(runId)) stopBot(run.botId);
  finish(runId, "timed_out", "The run took too long and was stopped.");
}

/** Upon Alert routines: run when a matching alert arrives (once per event). */
const RANK = { low: 0, normal: 1, high: 2 } as const;
export function matchesAlert(r: Routine, a: Alert): boolean {
  const t = r.schedule.alert;
  if (r.schedule.kind !== "alert" || !t || !r.enabled) return false;
  if (a.routineId === r.id) return false; // never trigger itself
  if (t.type && t.type !== a.type) return false;
  if (t.source && !(a.source ?? "").toLowerCase().includes(t.source.toLowerCase())) return false;
  if (t.minPriority && RANK[a.priority] < RANK[t.minPriority]) return false;
  if (t.contains && !`${a.title}\n${a.body}`.toLowerCase().includes(t.contains.toLowerCase())) return false;
  return true;
}

export function handleAlert(a: Alert) {
  for (const r of listRoutines()) {
    if (!matchesAlert(r, a)) continue;
    const eventKey = a.eventId ?? `${a.type}|${a.source}|${a.title}|${a.body}`.slice(0, 500);
    const k = `${r.id}|${eventKey}`;
    const ttl = (r.schedule.alert?.dedupeMinutes ?? 60) * 60_000;
    const seen = recentAlertKeys.get(k);
    if (seen && Date.now() - seen < ttl) continue;
    recentAlertKeys.set(k, Date.now());
    execute(r, `alert@${eventKey}`, "alert", { extra: `\nThe alert that started this:\nType: ${a.type}\nFrom: ${a.source ?? "?"}\nPriority: ${a.priority}\nTitle: ${a.title}\n${a.body}` });
  }
  for (const [k, t] of recentAlertKeys) if (Date.now() - t > 24 * 3600_000) recentAlertKeys.delete(k);
}

export function runRoutineNow(rid: string): Run {
  const r = getRoutine(rid);
  if (!r) throw new Error("No such routine");
  const run = execute(r, `manual@${new Date().toISOString()}`, "manual");
  if (!run) throw new Error("Couldn't start it (its bot is missing).");
  return run;
}

/** Called every 30 s and when the phone wakes the engine. */
export function tick(at = new Date()) {
  for (const r of listRoutines()) {
    if (!r.enabled || !r.nextRunAt || !r.nextKey) continue;
    const due = new Date(r.nextRunAt);
    if (due > at) continue;
    const late = at.getTime() - due.getTime();
    if (late <= GRACE_MS) {
      execute(r, r.nextKey, "schedule", { scheduledFor: r.nextRunAt });
    } else {
      // Missed (phone asleep, app closed, restart). Catch up once if allowed and not too late.
      const policy = r.schedule.missedPolicy ?? "run-once";
      const tooLate = late > (r.schedule.catchUpHours ?? 12) * 3600_000 || (r.deadline && (deadlineFor(r, at)?.getTime() ?? Infinity) <= at.getTime());
      if (policy === "run-once" && !tooLate) execute(r, r.nextKey, "catch-up", { scheduledFor: r.nextRunAt, extra: `\n(This run was due at ${due.toLocaleString()} but the phone missed it; it's running late.)` });
      else {
        addRun({ routineId: r.id, botId: r.botId, key: r.nextKey, trigger: "schedule", status: "missed", attempt: 1, scheduledFor: r.nextRunAt, error: tooLate ? "Missed and too late to catch up." : "Missed (set to skip missed runs)." });
        if (r.deadline) void notifyUser({ title: `Routine "${r.title}" was missed`, body: `It was due ${due.toLocaleString()} and couldn't run before its deadline.`, botId: r.botId, type: "routine-result", source: r.title, routineId: r.id });
      }
    }
    advance(r.id, at);
  }
  // Retries that are due.
  for (const run of listRuns(undefined, 300)) {
    if (!run.retryAt || run.retried || new Date(run.retryAt) > at) continue;
    patchRun(run.id, { retried: true });
    const r = getRoutine(run.routineId);
    if (r?.enabled) execute(r, run.key, "retry", { attempt: run.attempt + 1, scheduledFor: run.scheduledFor });
  }
}

/** After a restart: runs that were in progress are marked failed (and retried if allowed). */
export function recoverAfterRestart() {
  for (const run of listRuns(undefined, 300)) {
    if (run.status === "queued" || run.status === "running") finish(run.id, "failed", "MausDroid restarted during this run.");
  }
}

/** Follows each run: "running" when the bot starts it, a final status when it ends. */
function listen() {
  onTurnStart((_botId, tags) => {
    for (const t of tags) {
      const run = getRun(t);
      if (run?.status === "queued") patchRun(t, { status: "running", startedAt: new Date().toISOString() });
    }
  });
  onTurnEnd((_botId, reply, info) => {
    for (const t of info?.tags ?? []) {
      const run = getRun(t);
      if (!run || !["queued", "running"].includes(run.status)) continue;
      finish(t, info.aborted || info.failed ? "failed" : "succeeded", info.aborted ? "Stopped before it finished." : reply);
    }
  });
}

let started = false;
export function startScheduler() {
  if (started) return;
  started = true;
  listen();
  recoverAfterRestart();
  onAlert(handleAlert);
  setInterval(() => tick(), 30_000);
  tick();
}
