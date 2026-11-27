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
  if (existing && [PROMPT_0_11_0, PROMPT_0_12_0].some((p) => existing.prompt.trim() === p.trim()) && existing.prompt !== AUDIO_PROMPT) updateRoutine(existing.id, { prompt: AUDIO_PROMPT });
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

/** The routine's wording in 0.12.0. */
const PROMPT_0_12_0 = "A new Staff Update has been published and shared with me (details below). Make this week's audio overview.\n1. Read the whole Staff Update (Google Docs/Drive through connected apps, or web_fetch its link).\n2. Cover what's taking place NEXT WEEK: day by day, key dates and times, deadlines, events, duties and anything I need to do or bring. Only facts from the update \u2014 never guess.\nWrite it as one real conversation between two hosts \u2014 host A (a woman) and host B (a man) \u2014 grounded only in the source:\n- They respond to each other: follow-up questions, quick clarifications, the odd \"wait, so\u2026\" or gentle challenge, short reactions. Vary who leads each topic; don't alternate mechanically.\n- Clean handoffs: one line per turn, starting with \"A:\" or \"B:\".\n- After a line based on a specific part of the source, add {source \"a short exact quote from it\"} (it's not spoken; it lets the listener jump to that spot).\nWrite for listening, not reading:\n- Say the point first, plainly. No run-ups (\"Here's the thing\", \"Let's dive in\"), no \"not X but Y\" framing, no one-line closers that repeat the point.\n- Use natural contractions (it's, you'll, didn't) and vary sentence length: mostly short, the odd longer one.\n- Don't force things into threes, don't inflate ordinary facts, and don't argue with objections nobody raised.\n- Keep every fact, name, number, date and time exactly; keep uncertainty (\"I think\", \"probably\") where it's real.\n- No lists, headings, links, emoji or formatting: it's heard, not seen.\nOptional delivery cues (they're never spoken or shown): {pause 300} for a short silence; {faster}, {slower}, {higher} or {lower} at the start of a phrase changes only that phrase, subtly; {react mm-hmm} (or uh-huh, hmm, oh, right, yeah, ah) for a brief listening sound. Use them rarely and only where a person naturally would \u2014 most phrases need none.\n3. Keep it under 1,300 words (it must stay under 10 minutes). No headings, lists or links.\n4. Call audio_overview_record with: title like \"Week 8 audio overview\", week (e.g. \"Term 4 Week 8\"), staff_update_name, staff_update_link, source_text (the update's text, so I can ask about it while listening) and the script.\nIt records in the background and notifies me with a link when it's ready. If you can't read the update, say so plainly instead.";
