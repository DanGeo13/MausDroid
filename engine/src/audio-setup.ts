import { createRoutine, listRoutines } from "./routines.ts";
import { getMainBotId } from "./playbook.ts";
import { AUDIO_PROMPT, AUDIO_SYSTEM, startStaffUpdateWatch } from "./audio-overview.ts";
import { latestStaffUpdate } from "./brief.ts";

/**
 * The weekly audio overview routine: runs when a new Staff Update appears
 * in Drive (checked every 30 minutes, 6 am–9 pm). Created once for the main
 * assistant; you can pause or edit it like any routine.
 */
export function ensureAudioRoutine() {
  startStaffUpdateWatch(() => latestStaffUpdate());
  if (listRoutines().some((r) => r.system === AUDIO_SYSTEM)) return;
  const owner = getMainBotId();
  if (!owner) return;
  createRoutine({
    botId: owner,
    title: "Weekly Audio Overview",
    prompt: AUDIO_PROMPT,
    schedule: { kind: "alert", alert: { type: "staff-update", dedupeMinutes: 7 * 24 * 60 } },
    timeoutMinutes: 20,
    retry: { max: 1, delayMinutes: 10 },
    system: AUDIO_SYSTEM,
  });
}
