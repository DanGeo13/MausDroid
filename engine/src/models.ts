import { provider, settings, updateSettings, type ProviderConfig } from "./settings.ts";
import { getSecret } from "./secrets.ts";
import { anthropicTurn } from "./providers/anthropic.ts";
import { openaiTurn } from "./providers/openai.ts";
import { runCli } from "./providers/cli.ts";
import { errorText } from "./util.ts";

/**
 * Which models each AI offers, for choosing a model per bot.
 *  - Claude (your subscription, through Claude Code): the short names
 *    (opus/sonnet/haiku/fable = newest of each) and full numbered ids.
 *  - ChatGPT (Codex): its default, plus any model you type.
 *  - API / local / custom endpoints: the list the service reports
 *    (Refresh), plus any model you type.
 * Whether a model works depends on your plan or server: use Check.
 */
export interface ModelGroup {
  label: string;
  models: { id: string; label: string }[];
}

export const CLAUDE_MODELS: ModelGroup[] = [
  {
    label: "Newest of each (short names)",
    models: [
      { id: "opus", label: "Opus — most capable" },
      { id: "sonnet", label: "Sonnet — balanced" },
      { id: "haiku", label: "Haiku — fastest" },
      { id: "fable", label: "Fable" },
    ],
  },
  {
    label: "Claude 5 (numbered)",
    models: [
      { id: "claude-fable-5-2", label: "Fable 5.2" },
      { id: "claude-opus-5-5", label: "Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    ],
  },
  {
    label: "Earlier (numbered)",
    models: [
      { id: "claude-opus-4-1-20250805", label: "Opus 4.1" },
      { id: "claude-opus-4-20250514", label: "Opus 4" },
      { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5" },
      { id: "claude-sonnet-4-20250514", label: "Sonnet 4" },
      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
      { id: "claude-3-7-sonnet-20250219", label: "Sonnet 3.7" },
      { id: "claude-3-5-haiku-20241022", label: "Haiku 3.5" },
    ],
  },
];

export function modelGroups(p: ProviderConfig): ModelGroup[] {
  const yours = (p.customModels ?? []).map((id) => ({ id, label: id }));
  const groups: ModelGroup[] = [];
  if (p.subId === "claude") groups.push(...CLAUDE_MODELS);
  else if (p.subId === "chatgpt") groups.push({ label: "ChatGPT", models: [{ id: "default", label: "Codex default (best for your plan)" }] });
  else if (p.models.length) groups.push({ label: p.kind === "openai" ? "Offered by this service" : "Models", models: p.models.map((id) => ({ id, label: id })) });
  if (yours.length) groups.push({ label: "Your models", models: yours });
  return groups;
}

/** Remembers a model you typed so it appears in the list next time. */
export function rememberModel(providerId: string, model: string) {
  const m = model.trim();
  if (!m || m === "default") return;
  updateSettings((s) => {
    const p = s.providers.find((x) => x.id === providerId);
    if (!p) return;
    const known = modelGroups(p).some((g) => g.models.some((x) => x.id === m));
    if (!known) p.customModels = [...(p.customModels ?? []), m].slice(-20);
  });
}

/** Sends a tiny test message with this model; says whether it answered. */
export async function checkModel(providerId: string, model: string): Promise<{ ok: boolean; detail: string; ms: number }> {
  const p = provider(providerId);
  if (!p) return { ok: false, detail: "Unknown AI.", ms: 0 };
  const start = Date.now();
  const signal = AbortSignal.timeout(90_000);
  try {
    let text = "";
    if (p.kind === "subscription") {
      for await (const ev of runCli(p, { prompt: "Reply with just the word OK.", model, mcpUrl: "http://127.0.0.1:1/none", mcpToken: "-", systemPrompt: "This is a connection check." }, signal)) {
        if (ev.kind === "text") text += ev.text;
        if (ev.kind === "error") throw new Error(ev.text);
      }
    } else {
      const key = getSecret(`provider:${p.id}`);
      if (p.needsKey && !key) throw new Error("Add the API key first.");
      const req = { model, system: "This is a connection check.", messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Reply with just the word OK." }] }], tools: [], signal, onText: () => {} };
      const turn = p.kind === "anthropic" ? await anthropicTurn(req, key!) : await openaiTurn(req, p.baseUrl!, key);
      text = turn.blocks.filter((b) => b.type === "text").map((b: any) => b.text).join("");
    }
    rememberModel(providerId, model);
    return { ok: true, detail: `Answered: “${text.trim().slice(0, 60) || "(empty)"}”`, ms: Date.now() - start };
  } catch (e) {
    const msg = errorText(e);
    const hint = /not.?found|404|unknown model|invalid model|does not exist|not available|model_not_found/i.test(msg) ? " This model isn't available for your plan/server." : "";
    return { ok: false, detail: `${msg.slice(0, 300)}${hint}`, ms: Date.now() - start };
  }
}

/** Your own extra endpoints (local on the phone, your PC, another device, any OpenAI-compatible API). */
export function addEndpoint(label: string, baseUrl: string, needsKey: boolean) {
  const clean = label.trim() || "My endpoint";
  let base = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("The address must start with http:// or https://");
  if (!/\/v\d+$/.test(base)) base += "/v1";
  const id = `custom-${clean.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "endpoint"}-${Date.now().toString(36).slice(-4)}`;
  updateSettings((s) => void s.providers.push({ id, label: clean, kind: "openai", baseUrl: base, defaultModel: "", models: [], enabled: false, needsKey, custom: true, free: !needsKey }));
  return id;
}

export function removeEndpoint(id: string) {
  const p = provider(id);
  if (!p?.custom) throw new Error("Only endpoints you added can be removed.");
  updateSettings((s) => {
    s.providers = s.providers.filter((x) => x.id !== id);
    if (s.defaultProvider === id) s.defaultProvider = null;
  });
}

export const usedBy = (providerId: string) => settings().providers.find((p) => p.id === providerId);
