import { collection } from "./store.ts";
import { emit } from "./events.ts";
import { clip, id as newId, now } from "./util.ts";
import { getBot, listBots } from "./bots.ts";
import { sendToBot } from "./agent.ts";
import { notifyUser, type Alert } from "./notify.ts";
import { getRoutine, listRoutines } from "./routines.ts";
import { execute, matchesAlert } from "./scheduler.ts";
import { describeSchedule } from "./schedule.ts";
import type { Attachment } from "./files.ts";

/**
 * Sharing from other apps (links, YouTube / TikTok / Instagram videos, text,
 * photos, files): everything goes to Maus, which works out what it is and
 * forwards it to the routine(s) it belongs to — or deals with it itself.
 * "Upon Alert" routines set to the "share" alert type also run automatically.
 */
export interface ShareRecord {
  id: string;
  at: string;
  kind: string;
  text: string;
  urls: string[];
  attachments: { id: string; name: string; mime?: string }[];
  botId: string;
  forwarded: { routineId: string; title: string; at: string; runId?: string; note?: string }[];
}

const shares = collection<ShareRecord[]>("shares", []);
export const listShares = () => shares.get().slice().reverse().slice(0, 50);
export const getShare = (sid: string) => shares.get().find((s) => s.id === sid);

const SITES: [RegExp, string][] = [
  [/(^|\.)(youtube\.com|youtu\.be)$/, "YouTube video"],
  [/(^|\.)tiktok\.com$/, "TikTok video"],
  [/(^|\.)instagram\.com$/, "Instagram post"],
  [/(^|\.)(facebook\.com|fb\.watch)$/, "Facebook post"],
  [/(^|\.)(x\.com|twitter\.com)$/, "X post"],
  [/(^|\.)reddit\.com$/, "Reddit post"],
  [/(^|\.)spotify\.com$/, "Spotify link"],
  [/(^|\.)google\.[a-z.]+$|(^|\.)goo\.gl$/, "Google link"],
];

/** What was shared, in plain words ("YouTube video", "web page", "photo"…). */
export function shareKind(text: string, attachments: { name?: string; mime?: string }[] = []): string {
  const url = text.match(/https?:\/\/[^\s<>"']+/)?.[0];
  if (url) {
    try {
      const host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, "");
      for (const [re, kind] of SITES) if (re.test(host)) return kind;
      return "web page";
    } catch {
      return "link";
    }
  }
  const a = attachments[0];
  if (a) {
    const m = a.mime ?? "";
    if (m.startsWith("image/")) return attachments.length > 1 ? "photos" : "photo";
    if (m.startsWith("video/")) return "video";
    if (m.startsWith("audio/")) return "audio";
    return attachments.length > 1 ? "files" : "file";
  }
  return "text";
}

/** The bot that receives shares: Maus (or the pinned bot). */
export function shareBot() {
  const bots = listBots().filter((b) => !b.hidden);
  return bots.find((b) => b.name.trim().toLowerCase() === "maus") ?? bots.find((b) => b.pinned) ?? bots[0];
}

function alertFor(s: ShareRecord): Alert {
  return { id: s.id, title: `Shared: ${s.kind}`, body: [s.text, ...s.attachments.map((a) => a.name)].filter(Boolean).join("\n"), priority: "normal", at: s.at, read: true, type: "share", source: s.kind, eventId: s.id };
}

const describeFiles = (s: ShareRecord) => (s.attachments.length ? `\nFiles: ${s.attachments.map((a) => `${a.name} (file id ${a.id} — open with file_read)`).join("; ")}` : "");

export function receiveShare(input: { text?: string; attachments?: Attachment[] }): ShareRecord {
  const bot = shareBot();
  if (!bot) throw new Error("Create a bot first.");
  const text = clip(String(input.text ?? "").trim(), 4000);
  const atts = input.attachments ?? [];
  if (!text && !atts.length) throw new Error("Nothing was shared.");
  const rec: ShareRecord = {
    id: newId("share"),
    at: now(),
    kind: shareKind(text, atts as any),
    text,
    urls: text.match(/https?:\/\/[^\s<>"']+/g) ?? [],
    attachments: atts.map((a: any) => ({ id: a.id, name: a.name, mime: a.mime })),
    botId: bot.id,
    forwarded: [],
  };
  shares.update((l) => {
    l.push(rec);
    if (l.length > 300) l.splice(0, l.length - 300);
  });
  // "Upon Alert" routines for shares run by themselves.
  const alert = alertFor(rec);
  const auto = listRoutines().filter((r) => matchesAlert(r, alert));
  void notifyUser({ title: alert.title, body: alert.body.slice(0, 300), type: "share", source: rec.kind, eventId: rec.id, silentRecord: true });
  const candidates = listRoutines().filter((r) => r.enabled && r.system !== "self-improve");
  const lines = candidates.map((r) => `- ${r.id}: "${r.title}" (${getBot(r.botId)?.name ?? "?"}; ${describeSchedule(r.schedule)})${auto.some((a) => a.id === r.id) ? " — already runs automatically for shares" : ""} — ${clip(r.prompt.replace(/\s+/g, " "), 160)}`);
  sendToBot(
    bot.id,
    `📥 Shared with you from another app — ${rec.kind} (share id ${rec.id}):\n${text || "(no text)"}${describeFiles(rec)}

[How to handle a share: work out what it is — open the link with web_fetch or the browser if you need to (for videos use the title, description or captions; don't download them). Then, if it fits one or more of the routines below, call routine_forward with share_id ${rec.id}, the routine id and a one-line reason. Only forward where it clearly fits; skip routines that already run automatically. If nothing fits, deal with it yourself briefly (summarise it, or save it to memory if it's worth keeping) and say what you did. Reply in a sentence or two.
Routines:
${lines.join("\n") || "(none yet — you could suggest one if this kind of share will come up often)"}]`,
    "share",
    atts,
  );
  emit("share", { share: rec });
  return rec;
}

/** Maus sends a share to a routine: that routine runs now with the shared item. */
export function forwardShare(sid: string, routineId: string, note = "") {
  const s = getShare(sid);
  if (!s) throw new Error("No share with that id.");
  if (Date.now() - new Date(s.at).getTime() > 24 * 3600_000) throw new Error("That share is more than a day old.");
  const r = getRoutine(routineId);
  if (!r) throw new Error("No routine with that id. Use the ids from the share message.");
  if (!r.enabled) throw new Error(`"${r.title}" is paused.`);
  if (matchesAlert(r, alertFor(s))) return { already: true, title: r.title };
  if (s.forwarded.some((f) => f.routineId === r.id)) return { already: true, title: r.title };
  const bot = getBot(s.botId);
  const run = execute(r, `share@${s.id}`, "share", {
    extra: `\nThe person shared this (forwarded to this routine by ${bot?.name ?? "Maus"}): ${s.kind}\n${s.text || "(no text)"}${describeFiles(s)}${note ? `\nWhy it came to this routine: ${note}` : ""}\nUse it for this routine now.`,
  });
  if (!run) throw new Error(`Couldn't start "${r.title}" (its bot is missing).`);
  shares.update((l) => {
    const x = l.find((y) => y.id === s.id);
    x?.forwarded.push({ routineId: r.id, title: r.title, at: now(), runId: run.id, note: clip(note, 200) });
  });
  emit("share", { shareId: s.id });
  return { already: false, title: r.title, runId: run.id, status: run.status };
}
