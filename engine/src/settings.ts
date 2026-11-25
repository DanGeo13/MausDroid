import { collection } from "./store.ts";
import { hasSecret } from "./secrets.ts";

export type ProviderKind = "anthropic" | "openai" | "cli-claude" | "cli-codex";

export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  /** OpenAI-compatible base URL (OpenAI, Gemini, OpenRouter, Groq, Ollama, LM Studio, your PC…). */
  baseUrl?: string;
  defaultModel: string;
  models: string[];
  /** Where a CLI engine runs: on this phone, or on a paired computer through its companion. */
  runOn?: "phone" | "computer";
  computerUrl?: string;
  enabled: boolean;
  needsKey: boolean;
  note?: string;
  free?: boolean;
}

/** Ready-made presets. Free options are marked so new people can start without paying. */
export const PROVIDER_PRESETS: ProviderConfig[] = [
  { id: "anthropic", label: "Claude (API key)", kind: "anthropic", defaultModel: "claude-sonnet-5-5", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"], enabled: false, needsKey: true },
  { id: "openai", label: "ChatGPT / OpenAI (API key)", kind: "openai", baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.1", models: ["gpt-5.1", "gpt-5.1-mini"], enabled: false, needsKey: true },
  { id: "gemini", label: "Gemini (free tier key from Google AI Studio)", kind: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-flash", models: ["gemini-2.5-flash", "gemini-2.5-pro"], enabled: false, needsKey: true, free: true, note: "Get a free key at aistudio.google.com with your Google account." },
  { id: "openrouter", label: "OpenRouter (has free models)", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/auto", models: ["openrouter/auto"], enabled: false, needsKey: true, free: true, note: "Models ending in :free cost nothing." },
  { id: "groq", label: "Groq (free tier)", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", models: ["llama-3.3-70b-versatile"], enabled: false, needsKey: true, free: true },
  { id: "local", label: "Local / custom endpoint (Ollama, LM Studio, your PC)", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "llama3.2", models: [], enabled: false, needsKey: false, free: true, note: "Any OpenAI-compatible server: on this phone, your PC over Tailscale, or another device." },
  { id: "claude-code", label: "Claude Code (your Claude subscription)", kind: "cli-claude", defaultModel: "default", models: ["default", "opus", "sonnet", "haiku"], runOn: "computer", enabled: false, needsKey: false, note: "Uses your Claude Pro/Max login. Runs on a paired computer; on-phone mode is experimental." },
  { id: "codex", label: "Codex (your ChatGPT subscription)", kind: "cli-codex", defaultModel: "default", models: ["default"], runOn: "computer", enabled: false, needsKey: false, note: "Uses your ChatGPT Plus/Pro login. Runs on a paired computer; on-phone mode is experimental." },
];

export interface Settings {
  providers: ProviderConfig[];
  defaultProvider: string | null;
  composio: { userId?: string; sessionId?: string; mcpUrl?: string };
  website: { relayUrl?: string; deviceId?: string; enabled: boolean };
  tailscale: { enabled: boolean; hostname: string };
  onboardingDone: boolean;
  timeZone: string;
  quietHours: { start: string; end: string } | null;
}

const settingsFile = collection<Settings>("settings", {
  providers: PROVIDER_PRESETS,
  defaultProvider: null,
  composio: {},
  website: { enabled: false },
  tailscale: { enabled: false, hostname: "mausdroid" },
  onboardingDone: false,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Australia/Sydney",
  quietHours: null,
});

// New presets added in later engine updates appear automatically.
settingsFile.update((s) => {
  for (const p of PROVIDER_PRESETS) if (!s.providers.find((x) => x.id === p.id)) s.providers.push(p);
});

export const settings = () => settingsFile.get();
export const updateSettings = (fn: (s: Settings) => void) => settingsFile.update(fn);

export function provider(id: string): ProviderConfig | undefined {
  return settings().providers.find((p) => p.id === id);
}

/** What the UI may see: everything except secret values. */
export function publicSettings() {
  const s = settings();
  return {
    ...s,
    providers: s.providers.map((p) => ({ ...p, hasKey: hasSecret(`provider:${p.id}`) })),
    composio: { connected: hasSecret("composio"), userId: s.composio.userId },
    website: { ...s.website, passwordSet: hasSecret("website:password") },
    tailscale: { ...s.tailscale, hasAuthKey: hasSecret("tailscale:authkey") },
    github: { hasToken: hasSecret("github") },
  };
}
