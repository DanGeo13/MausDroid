import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import zlib from "node:zlib";

/**
 * A fetch() built on Node's own http/https modules. The phone's Node.js
 * build may not include everything the built-in fetch needs, so on Android
 * MausDroid always uses this one. Supports what the engine uses: method,
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
        const outHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined || k === "content-encoding" || k === "content-length") continue;
          if (Array.isArray(v)) v.forEach((x) => outHeaders.append(k, x));
          else outHeaders.set(k, String(v));
        }
        const noBody = method === "HEAD" || status === 204 || status === 304 || status < 200;
        const webBody = noBody ? null : (Readable.toWeb(stream) as unknown as ReadableStream);
        if (noBody) res.resume();
        const r = new Response(webBody, { status: status < 200 ? 200 : status, statusText: res.statusMessage, headers: outHeaders });
        Object.defineProperty(r, "url", { value: urlStr });
        resolve(r);
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

export function installNodeFetch() {
  (globalThis as any).fetch = nodeFetch;
}
