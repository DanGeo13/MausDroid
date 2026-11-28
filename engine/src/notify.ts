import { bridge, bridgeAvailable } from "./bridge.ts";
import { emit } from "./events.ts";
import { collection } from "./store.ts";
import { id, now } from "./util.ts";
import { settings } from "./settings.ts";
import { localParts } from "./time.ts";

export interface Alert {
  id: string;
  title: string;
  body: string;
  botId?: string;
  cardId?: string;
  priority: "low" | "normal" | "high";
  at: string;
  read: boolean;
  /** What kind of alert: "bot-alert", "approval", "routine-result", "app-event", "phone-notification", "external"… */
  type: string;
  /** Where it came from (bot name, app, sender). */
  source?: string;
  /** The routine whose run raised it (so it can't trigger itself). */
  routineId?: string;
  /** The original event's id, for duplicate protection. */
  eventId?: string;
  /** Opens this screen when tapped (e.g. "briefing:<id>"). */
  link?: string;
  /** How much it matters: "act" needs you, "info" is an update, "log" is a quiet record. */
  tier?: Tier;
}

/**
 * Only what needs you interrupts you. "act": approvals, questions, missed
 * calls, messages that need a reply, anything a bot marks urgent — these go
 * to the phone and count on the bell. "info": something you asked for is
 * ready, or a routine result — listed, on the phone only if you turn updates
 * on. "log": copies of other apps' notifications, shares, automatic triggers
 * — kept quietly for bots and routines, never counted.
 */
export type Tier = "act" | "info" | "log";
const LOG_TYPES = new Set(["phone-notification", "share", "staff-update", "app-event"]);
export function tierOf(a: Pick<Alert, "type" | "priority" | "cardId">): Tier {
  if (LOG_TYPES.has(a.type)) return "log";
  if (a.cardId || a.type === "approval" || a.type === "reply-desk" || a.priority === "high") return "act";
  if (a.priority === "low") return "log";
  if (a.type === "call") return "act"; // a missed call from a bot
  return "info";
}
const withTier = (a: Alert): Alert => ({ ...a, tier: a.tier ?? tierOf(a) });

type AlertListener = (a: Alert) => void;
const alertListeners = new Set<AlertListener>();
/** "Upon Alert" routines listen here. */
export const onAlert = (fn: AlertListener) => {
  alertListeners.add(fn);
  return () => alertListeners.delete(fn);
};

const alerts = collection<Alert[]>("alerts", []);

function inQuietHours(): boolean {
  const q = settings().quietHours;
  if (!q) return false;
  const t = localParts(new Date()).hm;
  return q.start <= q.end ? t >= q.start && t < q.end : t >= q.start || t < q.end;
}

/** Shows an Android notification (and keeps it in the in-app Alerts list). */
export interface AlertInput {
  title: string;
  body: string;
  botId?: string;
  cardId?: string;
  actions?: string[];
  priority?: Alert["priority"];
  type?: string;
  source?: string;
  routineId?: string;
  eventId?: string;
  link?: string;
  /** Record and trigger routines, but don't show a phone notification. */
  silentRecord?: boolean;
}

export async function notifyUser(a: AlertInput) {
  const alert: Alert = {
    id: id("alert"),
    title: a.title,
    body: a.body,
    botId: a.botId,
    cardId: a.cardId,
    priority: a.priority ?? "normal",
    at: now(),
    read: false,
    type: a.type ?? (a.cardId ? "approval" : "bot-alert"),
    source: a.source,
    routineId: a.routineId,
    eventId: a.eventId,
    link: a.link,
  };
  alert.tier = tierOf(alert);
  // The same thing again while the first is still unread: no second alert or buzz.
  const dupe = alerts.get().find((x) => !x.read && x.title === alert.title && x.body === alert.body && Date.now() - new Date(x.at).getTime() < 6 * 3600_000);
  if (dupe && !alert.cardId) return withTier(dupe);
  alerts.update((l) => {
    l.push(alert);
    if (l.length > 500) l.splice(0, l.length - 500);
  });
  emit("alert", { alert });
  for (const l of alertListeners) {
    try {
      l(alert);
    } catch {
      /* a routine problem never blocks an alert */
    }
  }
  if (a.silentRecord || alert.tier === "log") return alert;
  // Updates reach the phone only if you've asked for them (and then silently).
  if (alert.tier === "info" && !settings().notifyUpdates) return alert;
  // Quiet hours hold back everything except approvals and high-priority alerts.
  if (inQuietHours() && alert.priority !== "high") return alert;
  if (bridgeAvailable()) {
    await bridge("/notify", { ...a, id: alert.id, silent: alert.tier !== "act" }).catch(() => {});
  }
  return alert;
}

export const listAlerts = () => alerts.get().slice().reverse().map(withTier);
/** What the bell counts: unread things that need you. */
export const unreadImportant = () => alerts.get().filter((a) => !a.read && (a.tier ?? tierOf(a)) === "act").length;
export function markAlertsRead(ids?: string[]) {
  alerts.update((l) => l.forEach((x) => (!ids?.length || ids.includes(x.id)) && (x.read = true)));
  emit("alerts.read", { unread: unreadImportant() });
}
/** Clears the list (all, or one tier). */
export function clearAlerts(tier?: Tier): number {
  let n = 0;
  alerts.update((l) => {
    const keep = l.filter((x) => tier && (x.tier ?? tierOf(x)) !== tier);
    n = l.length - keep.length;
    l.splice(0, l.length, ...keep);
  });
  emit("alerts.read", { unread: unreadImportant() });
  return n;
}
