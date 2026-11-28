import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";

/**
 * A fetch() built on Node's own http/https modules. The phone's Node.js
 * build may not include everything the built-in fetch needs, so on Android
 * DanDroid always uses this one. Supports what the engine uses: method,
 * headers, string/Buffer body, AbortSignal, redirects, streaming bodies.
 */
export function nodeFetch(input: string | URL | { url: string }, init: any = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (urlStr: string, method: string, body: any) => {
      const u = new URL(urlStr);
      const lib = u.protocol === "https:" ? https : u.protocol === "http:" ? http : null;
      if (!lib) return reject(new TypeError(`Unsupported URL ${urlStr}`));
      const headers: Record<string, string> = {};
      const h = init.headers;
      if (h) {
        if (typeof h.forEach === "function" && !Array.isArray(h)) h.forEach((v: string, k: string) => (headers[k.toLowerCase()] = v));
        else for (const [k, v] of Array.isArray(h) ? h : Object.entries(h)) if (v !== undefined) headers[String(k).toLowerCase()] = String(v);
      }
      headers["accept-encoding"] ??= "gzip, deflate, br";
      let payload: Buffer | undefined;
      if (body !== undefined && body !== null) {
        payload = Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(String(body));
        headers["content-length"] = String(payload.length);
      }
      const req = lib.request(u, { method, headers }, (res) => {
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && loc && init.redirect !== "manual" && redirects++ < 10) {
          res.resume();
          const next = new URL(loc, u).toString();
          const keep = status === 307 || status === 308;
          return go(next, keep ? method : method === "HEAD" ? "HEAD" : "GET", keep ? body : undefined);
        }
        let stream: Readable = res;
        const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
        if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
        const noBody = method === "HEAD" || status === 204 || status === 304 || status < 200;
        if (noBody) res.resume();
        resolve(makeResponse(urlStr, status, res.statusMessage ?? "", res.headers, noBody ? null : stream) as unknown as Response);
      });
      req.on("error", reject);
      const signal: AbortSignal | undefined = init.signal;
      if (signal) {
        if (signal.aborted) return req.destroy(signal.reason ?? new Error("aborted"));
        signal.addEventListener("abort", () => req.destroy(signal.reason ?? new Error("The operation was aborted")), { once: true });
      }
      if (payload) req.write(payload);
      req.end();
    };
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    go(url, (init.method ?? "GET").toUpperCase(), init.body);
  });
}

/** Header lookup like the standard Headers object (case-insensitive get/has/forEach). */
class SimpleHeaders {
  private m = new Map<string, string>();
  constructor(raw: http.IncomingHttpHeaders) {
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || k === "content-encoding" || k === "content-length") continue;
      this.m.set(k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v));
    }
  }
  get(k: string) {
    return this.m.get(k.toLowerCase()) ?? null;
  }
  has(k: string) {
    return this.m.has(k.toLowerCase());
  }
  forEach(fn: (v: string, k: string) => void) {
    this.m.forEach(fn);
  }
  entries() {
    return this.m.entries();
  }
  [Symbol.iterator]() {
    return this.m.entries();
  }
}

/**
 * A minimal Response: ok/status/headers/url, text()/json()/arrayBuffer(),
 * and body.getReader() for streaming. Uses Buffers only (no TextDecoder,
 * which the phone's Node build may not have).
 */
function makeResponse(url: string, status: number, statusText: string, raw: http.IncomingHttpHeaders, stream: Readable | null) {
  let used = false;
  const all = async (): Promise<Buffer> => {
    if (used) throw new TypeError("Body already read");
    used = true;
    if (!stream) return Buffer.alloc(0);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    return Buffer.concat(chunks);
  };
  const body = stream
    ? {
        getReader() {
          used = true;
          const it = stream[Symbol.asyncIterator]();
          return {
            async read(): Promise<{ done: boolean; value?: Uint8Array }> {
              const r = await it.next();
              return r.done ? { done: true } : { done: false, value: new Uint8Array(Buffer.isBuffer(r.value) ? r.value : Buffer.from(r.value)) };
            },
            async cancel() {
              stream.destroy();
            },
            releaseLock() {},
          };
        },
        async cancel() {
          stream.destroy();
        },
      }
    : null;
  return {
    url,
    status,
    statusText,
    ok: status >= 200 && status < 300,
    redirected: false,
    headers: new SimpleHeaders(raw),
    body,
    get bodyUsed() {
      return used;
    },
    text: async () => (await all()).toString("utf8"),
    json: async () => JSON.parse((await all()).toString("utf8")),
    arrayBuffer: async () => {
      const b = await all();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

export function installNodeFetch() {
  (globalThis as any).fetch = nodeFetch;
}
