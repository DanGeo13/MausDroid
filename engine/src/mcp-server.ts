import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getBot } from "./bots.ts";
import { getSecret, setSecret } from "./secrets.ts";
import { gate, toolsFor } from "./tools/index.ts";
import { requestApproval } from "./approvals.ts";
import { addMessage } from "./bots.ts";
import { emit } from "./events.ts";
import { clip, errorText } from "./util.ts";

/**
 * MausDroid as an MCP server, so Claude Code and Codex (on the phone or on
 * a paired computer) can use the phone's tools and ask you for approval.
 */
let key: string | undefined;
export async function initMcpServer() {
  key = getSecret("mcp:key");
  if (!key) {
    key = randomBytes(32).toString("hex");
    await setSecret("mcp:key", key);
  }
}

export function mcpTokenFor(botId: string): string {
  return createHmac("sha256", key ?? "unset").update(`mcp:${botId}`).digest("hex");
}

function validToken(botId: string, header: string | undefined): boolean {
  const got = Buffer.from((header ?? "").replace(/^Bearer /i, ""));
  const want = Buffer.from(mcpTokenFor(botId));
  return got.length === want.length && timingSafeEqual(got, want);
}

const approvalTool = {
  name: "approval_prompt",
  description: "Asks the person on their phone to allow or deny a tool call.",
  inputSchema: { type: "object", properties: { tool_name: { type: "string" }, input: { type: "object" } }, required: ["tool_name"] },
};

export async function handleMcp(botId: string, req: IncomingMessage, res: ServerResponse, body: any) {
  const send = (status: number, obj: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (!validToken(botId, req.headers.authorization)) return send(401, { error: "bad token" });
  const bot = getBot(botId);
  if (!bot) return send(404, { error: "no bot" });
  if (req.method !== "POST") return send(405, { error: "POST only" });
  const reply = (result: unknown) => send(200, { jsonrpc: "2.0", id: body.id, result });
  const fail = (message: string) => send(200, { jsonrpc: "2.0", id: body.id, error: { code: -32000, message } });

  switch (body.method) {
    case "initialize":
      return reply({ protocolVersion: body.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mausdroid", version: "0.1" } });
    case "notifications/initialized":
    case "notifications/cancelled":
      res.writeHead(202).end();
      return;
    case "ping":
      return reply({});
    case "tools/list": {
      const tools = await toolsFor(bot);
      return reply({ tools: [approvalTool, ...tools.map((t) => t.spec)].map((t: any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    }
    case "tools/call": {
      const { name, arguments: args } = body.params ?? {};
      if (name === "approval_prompt") {
        const r = await requestApproval(bot.id, String(args?.tool_name), `Computer: ${args?.tool_name}`, clip(JSON.stringify(args?.input ?? {}, null, 1), 1200));
        const decision = r.allow ? { behavior: "allow", updatedInput: args?.input ?? {} } : { behavior: "deny", message: "The person declined." };
        return reply({ content: [{ type: "text", text: JSON.stringify(decision) }] });
      }
      const tool = (await toolsFor(bot)).find((t) => t.spec.name === name);
      if (!tool) return fail(`No tool ${name}`);
      {
        const r = await gate(bot, tool, args ?? {});
        if (!r.allow) return reply({ content: [{ type: "text", text: "The person declined this action." }], isError: true });
      }
      try {
        const out = await tool.run({ bot, signal: AbortSignal.timeout(600_000) }, args ?? {});
        const r = typeof out === "string" ? { text: out } : out;
        return reply({
          content: [{ type: "text", text: clip(r.text) }, ...(r.images ?? []).map((i) => ({ type: "image", mimeType: i.mediaType, data: i.data }))],
          isError: Boolean(r.isError),
        });
      } catch (e) {
        const m = addMessage(bot.id, { role: "tool", text: "", tool: { name, input: args, result: errorText(e), isError: true, status: "done" } });
        emit("message", { botId: bot.id, message: m });
        return reply({ content: [{ type: "text", text: errorText(e) }], isError: true });
      }
    }
    default:
      return fail(`Unsupported method ${body.method}`);
  }
}
