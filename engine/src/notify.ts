import { bridge, bridgeAvailable } from "./bridge.ts";
import { emit } from "./events.ts";
import { collection } from "./store.ts";
import { id, now } from "./util.ts";
import { settings } from "./settings.ts";
import { fmtParts } from "./time.ts";

export interface Alert {
  id: string;
  title: string;
  body: string;
  botId?: string;
  cardId?: string;
  priority: "low" | "normal" | "high";
  at: string;
  read: boolean;
}

const alerts = collection<Alert[]>("alerts", []);

function inQuietHours(): boolean {
  const q = settings().quietHours;
  if (!q) return false;
  const p = Object.fromEntries(fmtParts(new Date(), settings().timeZone, { hour: "2-digit", minute: "2-digit", hour12: false }).map((x) => [x.type, x.value]));
  const t = `${p.hour === "24" ? "00" : p.hour}:${p.minute}`;
  return q.start <= q.end ? t >= q.start && t < q.end : t >= q.start || t < q.end;
}

/** Shows an Android notification (and keeps it in the in-app Alerts list). */
export async function notifyUser(a: { title: string; body: string; botId?: string; cardId?: string; actions?: string[]; priority?: Alert["priority"] }) {
  const alert: Alert = { id: id("alert"), title: a.title, body: a.body, botId: a.botId, cardId: a.cardId, priority: a.priority ?? "normal", at: now(), read: false };
  alerts.update((l) => {
    l.push(alert);
    if (l.length > 500) l.splice(0, l.length - 500);
  });
  emit("alert", { alert });
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
