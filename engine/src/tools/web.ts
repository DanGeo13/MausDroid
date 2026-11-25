import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { config } from "../config.ts";
import { clip, htmlToText } from "../util.ts";

/**
 * Signs that a page builds its content with JavaScript (so the plain
 * download is nearly empty): little readable text, a "please enable
 * JavaScript" message, or an empty app container.
 */
export function needsJavaScript(html: string, text: string): boolean {
  if (/enable javascript|requires javascript|javascript is (disabled|required)|turn on javascript/i.test(text)) return true;
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  if (text.replace(/\s+/g, " ").trim().length < 600 && scripts >= 1) return true;
  if (/<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>/i.test(html) && text.length < 2000) return true;
  return false;
}

/** Opens a page in the phone's background browser (runs JavaScript), waits for it to fill in, reads it. */
async function renderInBrowser(url: string, waitMs: number): Promise<string> {
  const { bridge } = await import("../bridge.ts");
  const opened = await bridge("/browser/open", { url }, 90_000);
  try {
    // Many pages load their lists a moment after the page itself; give them time, then read again.
    await new Promise((r) => setTimeout(r, Math.min(15_000, Math.max(0, waitMs))));
    const read = await bridge("/browser/read", { tab: opened.tab, mode: "text" }, 30_000);
    const text = String(read.text ?? opened.text ?? "");
    return clip(`Rendered with JavaScript: ${opened.url}\nTitle: ${opened.title}\n\n${text}`);
  } finally {
    await bridge("/browser/close", { tab: opened.tab }).catch(() => {});
  }
}

/**
 * Downloads a page. render: "auto" (default) uses the phone's browser when
 * the page needs JavaScript; "always" always does; "never" never does.
 */
export async function webFetch(url: string, render: "auto" | "always" | "never" = "auto", waitMs = 2500): Promise<string> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("Only http and https links can be fetched.");
  const { bridgeAvailable } = await import("../bridge.ts");
  if (render === "always") {
    if (!bridgeAvailable()) throw new Error("Showing JavaScript pages needs the Android app's background browser.");
    return renderInBrowser(u.toString(), waitMs);
  }
  const res = await fetch(u, {
    headers: { "user-agent": "Mozilla/5.0 (Linux; Android 15) MausDroid/0.1", accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  const type = res.headers.get("content-type") ?? "";
  const body = await res.text();
  const isHtml = type.includes("html");
  const text = isHtml ? htmlToText(body) : body;
  if (isHtml && render === "auto" && needsJavaScript(body, text)) {
    if (bridgeAvailable()) {
      try {
        return await renderInBrowser(res.url || u.toString(), waitMs);
      } catch (e) {
        return clip(`HTTP ${res.status} ${res.url}\n(This page needs JavaScript and the background browser couldn't open it: ${(e as Error).message})\n\n${text}`);
      }
    }
    return clip(`HTTP ${res.status} ${res.url}\n(This page builds its content with JavaScript, so this plain copy may be incomplete. On the phone MausDroid opens such pages in its background browser.)\n\n${text}`);
  }
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
