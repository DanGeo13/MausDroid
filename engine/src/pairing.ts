import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { collection } from "./store.ts";
import { getSecret, setSecret } from "./secrets.ts";
import { settings, updateSettings } from "./settings.ts";

/**
 * Devices you trust to control MausDroid from elsewhere (your PC's browser,
 * a tablet): through the always-on website or over Tailscale. A device is
 * added by scanning the QR code shown on the phone, then the website asks
 * for your password too.
 */
interface Device {
  id: string;
  name: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt?: string;
}
const devices = collection<Device[]>("devices", []);
const codes = new Map<string, number>();

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export function createPairingCode(): { code: string; expiresAt: string } {
  const code = randomBytes(16).toString("base64url");
  const exp = Date.now() + 10 * 60_000;
  codes.set(code, exp);
  return { code, expiresAt: new Date(exp).toISOString() };
}

/** QR contents: the address to open plus the one-time code. */
export function pairingLink(code: string, base: string) {
  return `${base.replace(/\/$/, "")}/#pair=${code}`;
}

export function redeemPairingCode(code: string, name: string): string {
  const exp = codes.get(code);
  if (!exp || exp < Date.now()) throw new Error("This QR code has expired. Show a new one on the phone.");
  codes.delete(code);
  const token = randomBytes(32).toString("base64url");
  devices.update((d) => void d.push({ id: hash(token).slice(0, 12), name: name.slice(0, 60) || "Device", tokenHash: hash(token), createdAt: new Date().toISOString() }));
  return token;
}

export function deviceForToken(token: string | undefined): Device | undefined {
  if (!token) return undefined;
  const h = hash(token);
  const d = devices.get().find((x) => x.tokenHash === h);
  if (d) d.lastSeenAt = new Date().toISOString();
  return d;
}

export const listDevices = () => devices.get().map(({ tokenHash, ...d }) => d);
export function revokeDevice(id: string) {
  devices.update((l) => {
    const i = l.findIndex((x) => x.id === id);
    if (i >= 0) l.splice(i, 1);
  });
}

export async function setWebsitePassword(pw: string) {
  if (pw.length < 8) throw new Error("Use at least 8 characters.");
  const salt = randomBytes(16).toString("hex");
  await setSecret("website:password", `${salt}:${scryptSync(pw, salt, 32).toString("hex")}`);
}

export function checkWebsitePassword(pw: string): boolean {
  const stored = getSecret("website:password");
  if (!stored) return false;
  const [salt, want] = stored.split(":");
  const got = scryptSync(pw, salt, 32);
  return timingSafeEqual(got, Buffer.from(want, "hex"));
}

export function websiteBase(): string | null {
  const w = settings().website;
  if (w.enabled && w.relayUrl && w.deviceId) return `${w.relayUrl.replace(/\/$/, "")}/d/${w.deviceId}`;
  if (settings().tailscale.enabled) return `http://${settings().tailscale.hostname}`;
  return null;
}

export function configureWebsite(relayUrl: string, enabled: boolean) {
  updateSettings((s) => {
    s.website.relayUrl = relayUrl.trim().replace(/\/$/, "");
    s.website.enabled = enabled;
    s.website.deviceId ??= randomBytes(9).toString("base64url");
  });
}
