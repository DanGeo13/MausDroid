// MausDroid always-on website relay (Cloudflare Worker + Durable Object).
// It stores nothing but a hash of your phone's key: each browser request is
// handed to your phone over a long-poll and the phone's answer is sent back.
// Pairing, passwords and all data checks happen on the phone.

const JSON_H = { "content-type": "application/json" };
const MAX_BODY = 4 * 1024 * 1024;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/d\/([A-Za-z0-9_-]{8,40})(\/.*)?$/);
    if (!m) {
      return new Response("MausDroid relay is running. Open the link from your phone's QR code.", { headers: { "content-type": "text/plain" } });
    }
    if (!m[2]) return Response.redirect(`${url.origin}/d/${m[1]}/`, 301);
    const stub = env.DEVICE.get(env.DEVICE.idFromName(m[1]));
    return stub.fetch(req);
  },
};

async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class Device {
  constructor(state) {
    this.state = state;
    this.queue = [];
    this.waitingPolls = [];
    this.pending = new Map();
  }

  async phoneAllowed(req) {
    const key = req.headers.get("x-phone-key");
    if (!key || key.length < 32) return false;
    const h = await sha256(key);
    const stored = await this.state.storage.get("keyHash");
    if (!stored) {
      // First phone to connect claims this address.
      await this.state.storage.put("keyHash", h);
      return true;
    }
    return stored === h;
  }

  flush() {
    while (this.waitingPolls.length && this.queue.length) {
      const resolve = this.waitingPolls.shift();
      resolve(this.queue.splice(0, 20));
    }
  }

  async fetch(req) {
    const url = new URL(req.url);
    const [, id, rest] = url.pathname.match(/^\/d\/([^/]+)(\/.*)$/);

    if (rest === "/_phone/poll") {
      if (!(await this.phoneAllowed(req))) return new Response("not your device", { status: 403 });
      this.lastPhone = Date.now();
      if (this.queue.length) return new Response(JSON.stringify(this.queue.splice(0, 20)), { headers: JSON_H });
      const jobs = await new Promise((resolve) => {
        this.waitingPolls.push(resolve);
        setTimeout(() => {
          const i = this.waitingPolls.indexOf(resolve);
          if (i >= 0) {
            this.waitingPolls.splice(i, 1);
            resolve([]);
          }
        }, 25_000);
      });
      return new Response(JSON.stringify(jobs), { headers: JSON_H });
    }

    if (rest === "/_phone/reply") {
      if (!(await this.phoneAllowed(req))) return new Response("not your device", { status: 403 });
      const r = await req.json();
      const p = this.pending.get(r.rid);
      if (p) {
        this.pending.delete(r.rid);
        p(r);
      }
      return new Response("{}", { headers: JSON_H });
    }

    // A browser request for the phone.
    const body = ["GET", "HEAD"].includes(req.method) ? null : await req.text();
    if (body && body.length > MAX_BODY) return new Response("Too large", { status: 413 });
    if (this.queue.length > 200) return new Response("Phone is busy", { status: 503 });
    const rid = crypto.randomUUID();
    const headers = {};
    for (const h of ["cookie", "content-type", "accept", "user-agent", "accept-language"]) {
      const v = req.headers.get(h);
      if (v) headers[h] = v;
    }
    const reply = new Promise((resolve) => {
      this.pending.set(rid, resolve);
      setTimeout(() => {
        if (this.pending.delete(rid)) resolve(null);
      }, 40_000);
    });
    this.queue.push({ rid, method: req.method, path: rest, query: url.search.slice(1), headers, body });
    this.flush();
    const r = await reply;
    if (!r) {
      const offline = !this.lastPhone || Date.now() - this.lastPhone > 60_000;
      return new Response(offline ? "Your phone is offline or MausDroid isn't running. It will reconnect by itself." : "The phone took too long to answer.", {
        status: 504,
        headers: { "content-type": "text/plain" },
      });
    }
    const out = new Headers();
    for (const [k, v] of Object.entries(r.headers ?? {})) out.set(k, v);
    out.set("x-frame-options", "DENY");
    out.set("referrer-policy", "no-referrer");
    out.set("strict-transport-security", "max-age=31536000");
    const bytes = Uint8Array.from(atob(r.body ?? ""), (c) => c.charCodeAt(0));
    return new Response(req.method === "HEAD" ? null : bytes, { status: r.status, headers: out });
  }
}
