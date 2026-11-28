import { collection } from "./store.ts";
import { emit } from "./events.ts";
import { clip, id as newId, now } from "./util.ts";
import { notifyUser } from "./notify.ts";
import { looksSecret } from "./audit.ts";

/**
 * Notifications read from the apps you choose (by default Meta's Muse) —
 * read-only. They're kept so bots can look at them, start "Upon Alert"
 * routines (type "phone-notification"), and so Improver can learn what a
 * good assistant anticipates. Android only shows apps notifications still
 * in the shade and new ones — dismissed ones can't be read by any app.
 */
export interface PhoneNotification {
  id: string;
  key: string;
  pkg: string;
  app: string;
  title: string;
  text: string;
  subText?: string;
  category?: string;
  postedAt: string;
  receivedAt: string;
  /** Was already in the shade when read (rather than arriving new). */
  pending: boolean;
  /** Messaging apps: the conversation's name, group chat or not, recent messages (when the app shares them). */
  conversation?: string;
  group?: boolean;
  messages?: { who: string; text: string; at?: number }[];
  /** A group summary ("3 new messages"), not a message. */
  summary?: boolean;
}

const store = collection<PhoneNotification[]>("phone-notifications", []);
const flags = collection<{ firstReviewAt?: string }>("phone-notifications-state", {});
export const firstReviewDone = () => Boolean(flags.get().firstReviewAt);
export const markFirstReview = () => flags.update((f) => void (f.firstReviewAt = now()));

const listeners: ((n: PhoneNotification) => void)[] = [];
/** Reply Desk listens for messages from messaging apps. */
export const onPhoneNotification = (fn: (n: PhoneNotification) => void) => listeners.push(fn);

export function addIncoming(items: any[]): { added: number } {
  let added = 0;
  const fresh: PhoneNotification[] = [];
  store.update((l) => {
    for (const it of Array.isArray(items) ? items.slice(0, 200) : []) {
      const postedAt = new Date(Number(it.postedAt) || Date.now()).toISOString();
      const key = String(it.key ?? "");
      const title = clip(String(it.title ?? ""), 300);
      const text = clip(String(it.text ?? ""), 4000);
      // The same notification again (re-read or updated with the same words): keep one.
      if (l.some((x) => x.key === key && x.postedAt === postedAt) || l.some((x) => x.key === key && x.title === title && x.text === text)) continue;
      if (looksSecret(`${title}\n${text}`)) continue; // codes, card numbers: never kept
      const n: PhoneNotification = { id: newId("pn"), key, pkg: String(it.pkg ?? ""), app: clip(String(it.app ?? it.pkg ?? "app"), 80), title, text, subText: it.subText ? clip(String(it.subText), 200) : undefined, category: it.category || undefined, postedAt, receivedAt: now(), pending: Boolean(it.pending), conversation: it.conversation ? clip(String(it.conversation), 200) : undefined, group: Boolean(it.group) || undefined, summary: Boolean(it.summary) || undefined, messages: Array.isArray(it.messages) ? it.messages.slice(-8).map((m: any) => ({ who: clip(String(m?.who ?? ""), 100), text: clip(String(m?.text ?? ""), 1000), at: Number(m?.at) || undefined })).filter((m: any) => m.text && !looksSecret(m.text)) : undefined };
      l.push(n);
      fresh.push(n);
      added++;
    }
    if (l.length > 3000) l.splice(0, l.length - 3000);
  });
  for (const n of fresh)
    void notifyUser({ title: `${n.app}: ${n.title}`.slice(0, 200), body: n.text.slice(0, 500), type: "phone-notification", source: n.app, eventId: n.id, priority: "low", silentRecord: true });
  if (added) emit("phone-notifications", { added });
  for (const fn of listeners) for (const n of fresh) {
    try {
      fn(n);
    } catch {
      /* a listener problem never blocks notifications */
    }
  }
  return { added };
}

export function recent(opts: { app?: string; sinceHours?: number; limit?: number } = {}) {
  const since = opts.sinceHours ? Date.now() - opts.sinceHours * 3600_000 : 0;
  return store
    .get()
    .filter((n) => (!opts.app || `${n.app} ${n.pkg}`.toLowerCase().includes(opts.app.toLowerCase())) && new Date(n.postedAt).getTime() >= since)
    .slice(-(opts.limit ?? 200))
    .reverse();
}

export const counts = () => {
  const by: Record<string, number> = {};
  for (const n of store.get()) by[n.app] = (by[n.app] ?? 0) + 1;
  return by;
};

/** For Improver: notifications from assistant apps (Muse) as examples of anticipating needs. */
export function assistantExamples(days = 7) {
  return recent({ sinceHours: days * 24, limit: 60 })
    .filter((n) => /muse/i.test(`${n.app} ${n.pkg}`))
    .map((n) => ({ at: n.postedAt, title: n.title, text: clip(n.text, 400) }));
}

export const REVIEW_PROMPT = (items: PhoneNotification[]) => `Review these notifications from Meta's Muse assistant (${items.length}; ${items.filter((n) => n.pending).length} were still pending). They show what a quality digital assistant anticipates for the person.

1. Work out the kinds of needs Muse anticipates (reminders, follow-ups, plans, nudges…), when it sends them, and how it words them.
2. Compare with DanDroid's routines (routine_admin_list) and bots (bot_list): what does DanDroid not anticipate yet?
3. Suggest the few most useful changes with improve_propose (at most 5; new routines for Maus, better wording or timing) — don't change things now, the person approves the cards.
4. Save 3–6 short "assistant quality notes" with memory_save (scope "bot") so future checks keep them in mind.
5. Reply with a short summary: what Muse anticipates, what DanDroid now suggests doing.
DanDroid only reads these notifications; it never acts in Meta's apps.

Notifications (newest first):
${items.map((n) => `- ${n.postedAt}${n.pending ? " (pending)" : ""}: ${n.title} — ${clip(n.text.replace(/\s+/g, " "), 300)}`).join("\n")}`;
