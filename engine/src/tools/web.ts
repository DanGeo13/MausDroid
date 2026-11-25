import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { config } from "../config.ts";
import { clip, htmlToText } from "../util.ts";

export async function webFetch(url: string): Promise<string> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https links can be fetched.");
  const res = await fetch(u, {
    headers: { "user-agent": "Mozilla/5.0 (Linux; Android 15) MausDroid/0.1", accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const text = type.includes("html") ? htmlToText(body) : body;
  return clip(`HTTP ${res.status} ${res.url}\n\n${text}`);
}

/** Web search without an API key, via DuckDuckGo's HTML results page. */
export async function webSearch(query: string): Promise<string> {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { "user-agent": "Mozilla/5.0 (Linux; Android 15) MausDroid/0.1" },
    signal: AbortSignal.timeout(20_000),
  });
  const html = await res.text();
  const results: string[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && results.length < 10) {
    let link = m[1];
    const uddg = link.match(/uddg=([^&]+)/);
    if (uddg) link = decodeURIComponent(uddg[1]);
    results.push(`${results.length + 1}. ${htmlToText(m[2])}\n   ${link}\n   ${htmlToText(m[3] ?? "")}`);
  }
  return results.length ? results.join("\n\n") : "No results (the search page may have changed; try the browser tool).";
}

/** Fetches a URL on your tailnet (e.g. your PC) through the embedded Tailscale proxy. */
export function tailnetFetch(url: string, method = "GET", body?: string, headers: Record<string, string> = {}): Promise<string> {
  const [phost, pport] = config.tailnetProxy.split(":");
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const done = (res: http.IncomingMessage) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(clip(`HTTP ${res.statusCode}\n\n${data}`)));
    };
    if (u.protocol === "http:") {
      const req = http.request({ host: phost, port: Number(pport), method, path: url, headers: { host: u.host, ...headers } }, done);
      req.on("error", (e) => reject(new Error(`Tailnet: ${e.message} (is Tailscale on? Settings → Tailscale)`)));
      req.setTimeout(30_000, () => req.destroy(new Error("timed out")));
      if (body) req.write(body);
      req.end();
      return;
    }
    const connect = http.request({ host: phost, port: Number(pport), method: "CONNECT", path: `${u.hostname}:${u.port || 443}` });
    connect.on("connect", (_res, socket) => {
      const tlsSock = tls.connect({ socket, servername: u.hostname });
      const req = https.request({ createConnection: () => tlsSock, method, path: u.pathname + u.search, headers: { host: u.host, ...headers } } as any, done);
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
    connect.on("error", (e) => reject(new Error(`Tailnet: ${e.message}`)));
    connect.end();
  });
}
