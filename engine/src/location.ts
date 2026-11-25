import { bridge, bridgeAvailable } from "./bridge.ts";
import { emit } from "./events.ts";
import { collection } from "./store.ts";
import { id as newId, now } from "./util.ts";

/**
 * Device location for bots and routines: one short fix per request through
 * the Android app (fused provider), never continuous, never stored. Every
 * request shows an in-app indicator naming who asked; a short log keeps who
 * asked and when (never the coordinates).
 */
export interface LocationResult {
  latitude?: number;
  longitude?: number;
  accuracy_m?: number | null;
  timestamp?: string;
  age_s?: number;
  provider?: string;
  stale?: boolean;
  permission: "granted" | "denied" | "permanently_denied" | "not_requested" | "unavailable";
  error?: string;
  note?: string;
}

const log = collection<{ id: string; at: string; requester: string; outcome: string }[]>("location-uses", []);
const active = new Map<string, { requester: string; startedAt: string }>();

export const recentLocationUses = () => log.get().slice().reverse().slice(0, 30);
export const activeLocationRequests = () => [...active.entries()].map(([id, a]) => ({ id, ...a }));

const MESSAGES: Record<string, string> = {
  permission_not_requested: "Location permission hasn't been given. The person can allow it in Settings → Phone → Location (MausDroid never turns it on by itself).",
  permission_denied: "The person said no to location access.",
  permission_permanently_denied: "Location is blocked for MausDroid in Android settings. The person can allow it under App info → Permissions → Location.",
  location_off: "Location is turned off on the phone.",
  no_provider: "No location provider is available on the phone.",
  unavailable: "The phone couldn't get a location fix right now.",
};

export function describeLocationError(r: LocationResult): string | null {
  return r.error ? (MESSAGES[r.error] ?? `Location unavailable (${r.error}).`) : null;
}

/** One fix; maxAgeMs = how old a known position may be (default 2 min). */
export async function getLocation(requester: string, maxAgeMs = 120_000): Promise<LocationResult> {
  const reqId = newId("loc");
  active.set(reqId, { requester, startedAt: now() });
  emit("location", { state: "active", id: reqId, requester });
  let r: LocationResult;
  try {
    if (!bridgeAvailable()) r = { permission: "unavailable", error: "unavailable", note: "Location needs the Android app." };
    else r = await bridge<LocationResult>("/location/get", { maxAgeMs: Math.min(Math.max(maxAgeMs, 10_000), 30 * 60_000), timeoutMs: 20_000 }, 30_000);
  } catch (e) {
    r = { permission: "unavailable", error: "unavailable", note: (e as Error).message };
  } finally {
    active.delete(reqId);
  }
  // Never invented: coordinates only when the phone gave real ones.
  if (r.error || typeof r.latitude !== "number" || typeof r.longitude !== "number") {
    delete r.latitude;
    delete r.longitude;
  }
  const outcome = r.error ? r.error : r.stale ? "stale fix" : "ok";
  log.update((l) => {
    l.push({ id: reqId, at: now(), requester, outcome });
    if (l.length > 200) l.splice(0, l.length - 200);
  });
  emit("location", { state: "done", id: reqId, requester, outcome });
  return r;
}
