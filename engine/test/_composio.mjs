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
      if (p === "/tool_router/session") {
        state.sessionAuth = body.auth_configs ?? null;
        state.sessions = (state.sessions ?? 0) + 1;
        return send(200, { session_id: `sess${state.sessions}`, mcp: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp` } });
      }
      const link = p.match(/^\/tool_router\/session\/([^/]+)\/link$/);
      if (link) {
        // Apps Composio doesn't sign in for need a sign-in setup in the session.
        if ((state.unmanaged ?? []).includes(body.toolkit) && !state.sessionAuth?.[body.toolkit])
          return send(400, { error: { message: `Composio does not manage auth for toolkit ${body.toolkit} and no auth config without required fields is available. Please create an auth config manually or specify one in auth_config_override.` } });
        return send(200, { redirect_url: `https://connect.example/${body.toolkit}` });
      }
      const kit = p.match(/^\/toolkits\/([a-z0-9_]+)$/);
      if (kit && state.toolkitInfo?.[kit[1]]) return send(200, state.toolkitInfo[kit[1]]);
      if (p === "/auth_configs" && req.method === "POST") {
        state.authConfigs = [...(state.authConfigs ?? []), body];
        if (!body.auth_config?.credentials?.client_id) return send(400, { error: { message: "client_id is required" } });
        return send(201, { toolkit: { slug: body.toolkit.slug }, auth_config: { id: `ac_${body.toolkit.slug}${state.authConfigs.length}`, auth_scheme: body.auth_config.authScheme, is_composio_managed: false } });
      }
      if (p === "/mcp") {
        if (!state.mcp) return send(500, { error: "no mcp in stand-in" });
        const result = state.mcp(body);
        return result === undefined ? res.writeHead(202).end() : send(200, { jsonrpc: "2.0", id: body.id, result });
      }
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
