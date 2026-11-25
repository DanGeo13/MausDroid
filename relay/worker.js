// MausDroid always-on website relay (Cloudflare Worker + Durable Object).
// It stores nothing but a hash of your phone's key: each browser request is
// handed to your phone over a long-poll and the phone's answer is sent back.
// Pairing, passwords and all data checks happen on the phone.
//
// Linking a PC or tablet: open the website's main address on it. It shows a
// QR code (and a short code). Scan it with MausDroid on the phone; the phone
// tells this relay which personal page that browser should open, with a
// one-time pairing code, and the browser then asks for your password.
import qrcode from "qrcode-generator";

const JSON_H = { "content-type": "application/json" };
const MAX_BODY = 4 * 1024 * 1024;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/" || url.pathname === "/link") return linkPage(url.origin);
    const p = url.pathname.match(/^\/p\/([A-Za-z0-9]{8})$/);
    if (p) {
      const code = p[1].toUpperCase();
      return env.PAIRING.get(env.PAIRING.idFromName(code)).fetch(new Request(`${url.origin}/p/${code}`, req));
    }
    const m = url.pathname.match(/^\/d\/([A-Za-z0-9_-]{8,40})(\/.*)?$/);
    if (!m) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    if (!m[2]) return Response.redirect(`${url.origin}/d/${m[1]}/`, 301);
    const stub = env.DEVICE.get(env.DEVICE.idFromName(m[1]));
    return stub.fetch(req);
  },
};

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LINK_MINUTES = 10;

function newCode() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return [...b].map((x) => CODE_CHARS[x % CODE_CHARS.length]).join("");
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The PC / tablet page: a QR code for the phone to scan, then it opens your MausDroid. */
function linkPage(origin) {
  const code = newCode();
  const q = qrcode(0, "M");
  q.addData(`${origin}/p/${code}`);
  q.make();
  const svg = q.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link to MausDroid</title><style>
:root{color-scheme:light dark;--bg:#f3f4f8;--card:#fff;--text:#11131a;--muted:#5f6577;--accent:#6c5cff}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d12;--card:#151922;--text:#eef0f6;--muted:#9aa1b2}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,sans-serif}
.card{background:var(--card);border-radius:20px;padding:28px 24px;max-width:380px;width:calc(100% - 32px);box-sizing:border-box;text-align:center;box-shadow:0 10px 40px #0002}
h1{font-size:1.35rem;margin:.2rem 0 .4rem}.qr{background:#fff;border-radius:14px;padding:10px;margin:16px auto;max-width:260px}.qr svg{width:100%;height:auto;display:block}
.code{font:600 1.5rem ui-monospace,monospace;letter-spacing:.12em}.muted{color:var(--muted);font-size:.92rem}ol{text-align:left;padding-left:1.2rem;color:var(--muted);font-size:.92rem}
.status{margin-top:12px;font-weight:600;color:var(--accent)}</style></head><body><main class="card">
<h1>🐭 Link this device to MausDroid</h1>
<ol><li>On your phone, open <b>MausDroid → Settings → Website &amp; devices</b>.</li><li>Tap <b>Scan the QR on your PC</b> and point the phone at this code.</li></ol>
<div class="qr" role="img" aria-label="QR code to scan with MausDroid">${svg}</div>
<div class="muted">No scanner? Type this code on the phone:</div><div class="code">${esc(code.slice(0, 4))}-${esc(code.slice(4))}</div>
<div class="status" id="s" role="status">Waiting for your phone…</div></main>
<script>
const code=${JSON.stringify(code)};const until=Date.now()+${LINK_MINUTES}*60000;const s=document.getElementById("s");
async function poll(){if(Date.now()>until){s.textContent="This code expired — getting a new one…";return setTimeout(()=>location.reload(),1200)}
try{const r=await fetch("/p/"+code,{headers:{accept:"application/json"},cache:"no-store"});const j=await r.json();
if(j.link){s.textContent="Linked! Opening MausDroid…";return location.replace(j.link)}}catch(e){}setTimeout(poll,2000)}poll();
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
}

/**
 * One linking code: the phone posts the page this browser should open
 * (its own /d/... address with a one-time pairing code); the browser
 * collects it once. Codes last 10 minutes and can be used once.
 */
export class Pairing {
  constructor(state) {
    this.state = state;
  }
  async fetch(req) {
    const url = new URL(req.url);
    const now = Date.now();
    let rec = (await this.state.storage.get("rec")) ?? null;
    if (rec && now - rec.at > LINK_MINUTES * 60_000) {
      await this.state.storage.deleteAll();
      rec = null;
    }
    if (req.method === "POST") {
      let body;
      try {
        body = await req.json();
      } catch {
        return new Response(JSON.stringify({ error: "Bad request" }), { status: 400, headers: JSON_H });
      }
      const link = String(body?.link ?? "");
      if (!link.startsWith(`${url.origin}/d/`) || !link.includes("#pair=") || link.length > 300)
        return new Response(JSON.stringify({ error: "That isn't a MausDroid link for this website." }), { status: 400, headers: JSON_H });
      if (rec?.link) return new Response(JSON.stringify({ error: "This code was already used." }), { status: 409, headers: JSON_H });
      await this.state.storage.put("rec", { link, at: now });
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_H });
    }
    if ((req.headers.get("accept") ?? "").includes("application/json")) {
      if (rec?.link) {
        await this.state.storage.deleteAll(); // handed over once
        return new Response(JSON.stringify({ link: rec.link }), { headers: { ...JSON_H, "cache-control": "no-store" } });
      }
      return new Response(JSON.stringify({ waiting: true }), { headers: { ...JSON_H, "cache-control": "no-store" } });
    }
    // Opened with an ordinary camera app instead of MausDroid.
    return new Response(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>MausDroid</title><body style="font:16px system-ui;padding:24px;max-width:480px;margin:auto"><h2>Scan this with MausDroid</h2><p>Open <b>MausDroid → Settings → Website &amp; devices</b> on your phone and tap <b>Scan the QR on your PC</b>, then point it at the code on your computer.</p></body>`,
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  }
}

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
