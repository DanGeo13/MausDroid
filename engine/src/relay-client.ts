import { createHmac } from "node:crypto";
import { handle } from "./server.ts";
import { settings } from "./settings.ts";
import { getSecret, setSecret } from "./secrets.ts";
import { randomBytes } from "node:crypto";
import { sleep } from "./util.ts";

/**
 * Connects the phone to the always-on website (a small Cloudflare Worker you
 * deploy once). The phone keeps a long-poll open; the website hands it each
 * browser request and the phone answers. Nothing is stored on the website,
 * and every request is still checked by the phone (QR pairing + password).
 */
let running = false;
export const relayStatus = { connected: false, lastError: "" as string, lastSeen: "" as string };

async function relaySecret() {
  let s = getSecret("website:relay");
  if (!s) {
    s = randomBytes(32).toString("base64url");
    await setSecret("website:relay", s);
  }
  return s;
}

export function startRelayClient() {
  if (running) return;
  running = true;
  void loop();
}

async function loop() {
  let backoff = 1000;
  while (true) {
    const w = settings().website;
    if (!w.enabled || !w.relayUrl || !w.deviceId) {
      relayStatus.connected = false;
      await sleep(5000);
      continue;
    }
    const base = `${w.relayUrl.replace(/\/$/, "")}/d/${w.deviceId}`;
    try {
      const secret = await relaySecret();
      const ts = String(Date.now());
      const sig = createHmac("sha256", secret).update(`${w.deviceId}:${ts}`).digest("hex");
      phoneKey = createHmac("sha256", secret).update("register").digest("hex");
      const res = await fetch(`${base}/_phone/poll`, {
        headers: { "x-phone-ts": ts, "x-phone-sig": sig, "x-phone-key": phoneKey },
        signal: AbortSignal.timeout(40_000),
      });
      if (!res.ok) throw new Error(`website relay: HTTP ${res.status} ${await res.text()}`);
      relayStatus.connected = true;
      relayStatus.lastSeen = new Date().toISOString();
      relayStatus.lastError = "";
      backoff = 1000;
      const jobs = (await res.json()) as { rid: string; method: string; path: string; query: string; headers: Record<string, string>; body: string | null }[];
      for (const job of jobs) void answer(base, sig, ts, job);
    } catch (e) {
      relayStatus.connected = false;
      relayStatus.lastError = e instanceof Error ? e.message : String(e);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

let phoneKey = "";

async function answer(base: string, sig: string, ts: string, job: { rid: string; method: string; path: string; query: string; headers: Record<string, string>; body: string | null }) {
  let body: any;
  try {
    body = job.body ? JSON.parse(job.body) : undefined;
  } catch {
    body = job.body;
  }
  const prefix = new URL(base).pathname + "/";
  const r = await handle({ method: job.method, path: job.path, query: new URLSearchParams(job.query), headers: job.headers, body, via: "relay", prefix });
  const payload = typeof r.body === "string" ? Buffer.from(r.body) : (r.body ?? Buffer.alloc(0));
  await fetch(`${base}/_phone/reply`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-phone-ts": ts, "x-phone-sig": sig, "x-phone-key": phoneKey },
    body: JSON.stringify({ rid: job.rid, status: r.status, headers: r.headers ?? {}, body: payload.toString("base64") }),
  }).catch(() => {});
}
