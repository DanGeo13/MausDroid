import { createRoutine, listRoutines, updateRoutine } from "./routines.ts";
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
  const existing = listRoutines().find((r) => r.system === AUDIO_SYSTEM);
  // The built-in wording improved (two-host conversation, source links): update it only if you never edited it.
  if (existing && existing.prompt.trim() === PROMPT_0_11_0.trim()) updateRoutine(existing.id, { prompt: AUDIO_PROMPT });
  if (existing) return;
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

/** The routine's wording in 0.11.0 (to recognise an unedited copy). */
const PROMPT_0_11_0 = "A new Staff Update has been published and shared with me (details below). Make this week's audio overview.\n1. Read the whole Staff Update (Google Docs/Drive through connected apps, or web_fetch its link).\n2. Write a friendly two-host conversation about what's taking place NEXT WEEK: day by day, key dates and times, deadlines, events, duties and anything I need to do or bring. Only facts from the update \u2014 never guess.\n3. Keep it under 1,300 words (it must stay under 10 minutes). One line per turn, starting each line with \"A:\" or \"B:\". No headings, lists or links.\n4. Call audio_overview_record with: title like \"Week 8 audio overview\", week (e.g. \"Term 4 Week 8\"), staff_update_name, staff_update_link and the script.\nIt records in the background and notifies me with a link when it's ready. If you can't read the update, say so plainly instead.";
