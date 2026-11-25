// A stand-in for Composio's API: connected accounts, tool descriptions and
// tool execution for Google Calendar / Drive / Sheets. Tests set the data.
import http from "node:http";

export async function fakeComposio(state = {}) {
  const calls = [];
  state.accounts ??= [];
  state.events ??= {};
  state.tools ??= {};
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const send = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const body = b ? JSON.parse(b) : {};
      calls.push({ method: req.method, path: url.pathname, body });
      const p = url.pathname.replace(/^\/api\/v3/, "");
      if (p === "/tool_router/session") return send(200, { session_id: "sess1", mcp: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp` } });
      if (p === "/mcp") return send(500, { error: "no mcp in stand-in" });
      if (p === "/connected_accounts") return send(200, { items: state.accounts.map((a) => ({ id: a.id, alias: a.alias, status: a.status ?? "ACTIVE", toolkit: { slug: a.toolkit } })) });
      const tool = p.match(/^\/tools\/([A-Z_]+)$/);
      if (tool) return send(200, { slug: tool[1], version: "20251101_00", input_parameters: { properties: Object.fromEntries((state.tools[tool[1]] ?? []).map((n) => [n, {}])) } });
      const exec = p.match(/^\/tools\/execute\/([A-Z_]+)$/);
      if (exec) {
        const handler = state.handlers?.[exec[1]];
        if (!handler) return send(200, { successful: false, error: `stand-in has no ${exec[1]}` });
        try {
          return send(200, { successful: true, data: handler(body.arguments ?? {}, body.connected_account_id, body) });
        } catch (e) {
          return send(200, { successful: false, error: e.message });
        }
      }
      send(404, { error: `stand-in: ${p}` });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/api/v3`, calls, state, close: () => server.close() };
}
