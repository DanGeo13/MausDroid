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
}

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
  if (a.silentRecord) return alert;
  // Quiet hours hold back everything except approvals and high-priority alerts.
  if (inQuietHours() && alert.priority !== "high") return alert;
  if (bridgeAvailable()) {
    await bridge("/notify", { ...a, id: alert.id, silent: alert.priority === "low" }).catch(() => {});
  }
  return alert;
}

export const listAlerts = () => alerts.get().slice().reverse();
export function markAlertsRead() {
  alerts.update((l) => l.forEach((x) => (x.read = true)));
}
