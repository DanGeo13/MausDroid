import type { Block, ModelRequest, ModelTurn } from "../types.ts";
import { readSSE } from "../sse.ts";

const API = "https://api.anthropic.com/v1";

function toAnthropic(messages: ModelRequest["messages"]) {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((b) => {
      switch (b.type) {
        case "text":
          return { type: "text", text: b.text };
        case "image":
          return { type: "image", source: { type: "base64", media_type: b.mediaType, data: b.data } };
        case "tool_use":
          return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: b.toolUseId,
            is_error: b.isError || undefined,
            content: [
              { type: "text", text: b.content || "(no output)" },
              ...(b.images ?? []).map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
            ],
          };
      }
    }),
  }));
}

export async function anthropicTurn(req: ModelRequest, apiKey: string): Promise<ModelTurn> {
  const res = await fetch(`${API}/messages`, {
    method: "POST",
    signal: req.signal,
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: req.model,
      max_tokens: 16000,
      stream: true,
      system: req.system,
      messages: toAnthropic(req.messages),
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
    }),
  });
  if (!res.ok) throw new Error(`Claude API: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);

  const blocks: (Block & { _json?: string })[] = [];
  let stop: ModelTurn["stopReason"] = "end";
  const usage: ModelTurn["usage"] = {};
  for await (const { data } of readSSE(res)) {
    const ev = JSON.parse(data);
    switch (ev.type) {
      case "message_start":
        usage.input = ev.message?.usage?.input_tokens;
        break;
      case "content_block_start":
        if (ev.content_block.type === "text") blocks[ev.index] = { type: "text", text: "" };
        else if (ev.content_block.type === "tool_use")
          blocks[ev.index] = { type: "tool_use", id: ev.content_block.id, name: ev.content_block.name, input: {}, _json: "" };
        break;
      case "content_block_delta": {
        const b = blocks[ev.index];
        if (ev.delta.type === "text_delta" && b?.type === "text") {
          b.text += ev.delta.text;
          req.onText(ev.delta.text);
        } else if (ev.delta.type === "input_json_delta" && b?.type === "tool_use") b._json += ev.delta.partial_json;
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b?.type === "tool_use") {
          b.input = b._json ? JSON.parse(b._json) : {};
          delete b._json;
        }
        break;
      }
      case "message_delta":
        if (ev.delta?.stop_reason === "tool_use") stop = "tool_use";
        else if (ev.delta?.stop_reason === "max_tokens") stop = "max_tokens";
        usage.output = ev.usage?.output_tokens;
        break;
      case "error":
        throw new Error(`Claude API: ${ev.error?.message ?? "stream error"}`);
    }
  }
  return { blocks: blocks.filter(Boolean), stopReason: stop, usage };
}

export async function anthropicModels(apiKey: string): Promise<string[]> {
  const res = await fetch(`${API}/models?limit=100`, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
  if (!res.ok) throw new Error(`Claude API: HTTP ${res.status}`);
  const j = (await res.json()) as { data: { id: string }[] };
  return j.data.map((m) => m.id);
}
