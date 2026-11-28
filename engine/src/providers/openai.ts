import type { Block, ModelRequest, ModelTurn } from "../types.ts";
import { readSSE } from "../sse.ts";

/**
 * OpenAI-compatible Chat Completions. Covers OpenAI, Gemini's OpenAI
 * endpoint, OpenRouter, Groq, Ollama, LM Studio and most self-hosted servers.
 */
function toOpenAI(system: string, messages: ModelRequest["messages"]) {
  const out: any[] = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b: any) => b.text).join("");
      const calls = m.content.filter((b) => b.type === "tool_use") as Extract<Block, { type: "tool_use" }>[];
      out.push({
        role: "assistant",
        content: text || null,
        tool_calls: calls.length
          ? calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } }))
          : undefined,
      });
      continue;
    }
    const parts: any[] = [];
    for (const b of m.content) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.toolUseId, content: (b.isError ? "ERROR: " : "") + (b.content || "(no output)") });
        for (const img of b.images ?? []) parts.push({ type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } });
      } else if (b.type === "text") parts.push({ type: "text", text: b.text });
      else if (b.type === "image") parts.push({ type: "image_url", image_url: { url: `data:${b.mediaType};base64,${b.data}` } });
    }
    if (parts.length) out.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
  }
  return out;
}

export async function openaiTurn(req: ModelRequest, baseUrl: string, apiKey: string | undefined): Promise<ModelTurn> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  if (baseUrl.includes("openrouter.ai")) {
    headers["HTTP-Referer"] = "https://github.com/DanGeo13/DanDroid";
    headers["X-Title"] = "DanDroid";
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal: req.signal,
    headers,
    body: JSON.stringify({
      model: req.model,
      stream: true,
      messages: toOpenAI(req.system, req.messages),
      tools: req.tools.length
        ? req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
        : undefined,
    }),
  });
  if (!res.ok) throw new Error(`Model endpoint: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);

  let text = "";
  const calls: { id: string; name: string; args: string }[] = [];
  let finish = "";
  const usage: ModelTurn["usage"] = {};
  for await (const { data } of readSSE(res)) {
    if (data === "[DONE]") break;
    const ev = JSON.parse(data);
    if (ev.error) throw new Error(`Model endpoint: ${ev.error.message ?? JSON.stringify(ev.error)}`);
    if (ev.usage) {
      usage.input = ev.usage.prompt_tokens;
      usage.output = ev.usage.completion_tokens;
    }
    const choice = ev.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? {};
    if (d.content) {
      text += d.content;
      req.onText(d.content);
    }
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? calls.length;
      calls[i] ??= { id: tc.id ?? `call_${i}`, name: "", args: "" };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) calls[i].name += tc.function.name;
      if (tc.function?.arguments) calls[i].args += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const blocks: Block[] = [];
  if (text) blocks.push({ type: "text", text });
  for (const c of calls.filter(Boolean)) {
    let input: Record<string, unknown> = {};
    try {
      input = c.args ? JSON.parse(c.args) : {};
    } catch {
      input = { _unparsed: c.args };
    }
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
  }
  const stopReason = calls.length ? "tool_use" : finish === "length" ? "max_tokens" : "end";
  return { blocks, stopReason, usage };
}

export async function openaiModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
  if (!res.ok) throw new Error(`Model list: HTTP ${res.status}`);
  const j = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] };
  return (j.data?.map((m) => m.id) ?? j.models?.map((m) => m.name) ?? []).map((m) => m.replace(/^models\//, "")).sort();
}
