import { config } from "./config.ts";

/**
 * Calls into the Android shell (notifications, the background browser,
 * Keystore encryption, Tailscale, updates). When the engine runs on a
 * computer for development there is no shell, and calls fail clearly.
 */
export const bridgeAvailable = () => Boolean(config.bridgeUrl);

export async function bridge<T = any>(path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  if (!config.bridgeUrl) throw new Error("This feature needs the Android app (no native bridge in this run).");
  const res = await fetch(`${config.bridgeUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-bridge-token": config.bridgeToken },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data?.error ?? `Native bridge ${path}: HTTP ${res.status}`);
  return data as T;
}
