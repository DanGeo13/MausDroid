import { createRoutine, listRoutines } from "./routines.ts";
import { listBots } from "./bots.ts";
import { addRunValidator } from "./scheduler.ts";
import { AUDIT_PROMPT, AUDIT_SYSTEM, auditFor } from "./audit.ts";

/**
 * The weekly audit routine: Sundays 07:52 Australia/Sydney, research cutoff
 * 5 minutes after it starts, hard deadline 08:00. A missed Sunday is skipped
 * (it can't finish by 08:00 late) and reported. Created once; you can pause
 * or edit it like any routine.
 */
export function ensureAuditRoutine() {
  addRunValidator(AUDIT_SYSTEM, (run) => (auditFor(run.id)?.report ? null : "The audit finished without producing its report, so it's incomplete."));
  if (listRoutines().some((r) => r.system === AUDIT_SYSTEM)) return;
  const bots = listBots().filter((b) => !b.hidden);
  const owner = bots.find((b) => b.pinned) ?? bots[0];
  if (!owner) return;
  createRoutine({
    botId: owner.id,
    title: "Weekly MausDroid Routine & Skill Audit",
    prompt: AUDIT_PROMPT,
    schedule: { kind: "weekly", days: [0], time: "07:52", timeZone: "Australia/Sydney", missedPolicy: "skip" },
    deadline: "08:00",
    researchCutoffMinutes: 5,
    timeoutMinutes: 8,
    retry: { max: 0, delayMinutes: 1 },
    system: AUDIT_SYSTEM,
  });
}
