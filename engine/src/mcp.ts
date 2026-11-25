import type { ToolSpec } from "./types.ts";
import { readSSE } from "./sse.ts";

/**
 * Minimal MCP client over Streamable HTTP. Used for Composio's Tool Router
 * (all its apps) and for any custom MCP server you add.
 */
export class McpClient {
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;
  constructor(public url: string, private headers: Record<string, string> = {}) {}

  private async rpc(method: string, params?: unknown, notify = false): Promise<any> {
    const body: any = { jsonrpc: "2.0", method, params };
    if (!notify) body.id = this.nextId++;
    const h: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, { method: "POST", headers: h, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (notify) return null;
    if (!res.ok) throw new Error(`MCP ${method}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    let msg: any;
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      for await (const { data } of readSSE(res)) {
        const m = JSON.parse(data);
        if (m.id === body.id) {
          msg = m;
          break;
        }
      }
    } else msg = await res.json();
    if (msg?.error) throw new Error(`MCP ${method}: ${msg.error.message}`);
    return msg?.result;
  }

  async init() {
    if (this.initialized) return;
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "MausDroid", version: "0.1" },
    });
    await this.rpc("notifications/initialized", undefined, true);
    this.initialized = true;
  }

  async listTools(): Promise<ToolSpec[]> {
    await this.init();
    const out: ToolSpec[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.rpc("tools/list", cursor ? { cursor } : {});
      for (const t of r.tools ?? []) out.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object" } });
      cursor = r.nextCursor;
    } while (cursor);
    return out;
  }

  async callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean; images: { mediaType: string; data: string }[] }> {
    await this.init();
    const r = await this.rpc("tools/call", { name, arguments: args ?? {} });
    const parts: string[] = [];
    const images: { mediaType: string; data: string }[] = [];
    for (const c of r.content ?? []) {
      if (c.type === "text") parts.push(c.text);
      else if (c.type === "image") images.push({ mediaType: c.mimeType, data: c.data });
      else parts.push(JSON.stringify(c));
    }
    if (r.structuredContent && !parts.length) parts.push(JSON.stringify(r.structuredContent));
    return { text: parts.join("\n"), isError: Boolean(r.isError), images };
  }
}
