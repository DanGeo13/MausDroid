import { collection } from "./store.ts";
import { hasSecret } from "./secrets.ts";
import { deviceTimeZone } from "./time.ts";

export type ProviderKind = "anthropic" | "openai" | "subscription";

export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  /** OpenAI-compatible base URL (OpenRouter, Groq, Ollama, LM Studio, your PC…). */
  baseUrl?: string;
  defaultModel: string;
  models: string[];
  /** Subscription providers: which sign-in (Claude or ChatGPT). */
  subId?: "claude" | "chatgpt";
  /** Where the official program runs: this phone (computer as backup), or always the computer. */
  runOn?: "phone" | "computer";
  computerUrl?: string;
  enabled: boolean;
  needsKey: boolean;
  note?: string;
  free?: boolean;
  /** Models you typed that worked (shown under "Your models"). */
  customModels?: string[];
  /** An endpoint you added yourself (can be removed). */
  custom?: boolean;
}

/** Ready-made presets. Free options are marked so new people can start without paying. */
export const PROVIDER_PRESETS: ProviderConfig[] = [
  // Your subscriptions: sign in with your account (no API keys). Each runs the company's official program.
  { id: "claude", label: "Claude", kind: "subscription", subId: "claude", defaultModel: "default", models: ["default", "opus", "sonnet", "haiku", "fable"], runOn: "phone", enabled: false, needsKey: false, note: "Sign in with your Claude account (Pro or Max). Uses Anthropic's official Claude Code." },
  { id: "chatgpt", label: "ChatGPT", kind: "subscription", subId: "chatgpt", defaultModel: "default", models: ["default"], runOn: "phone", enabled: false, needsKey: false, note: "Sign in with your ChatGPT account (Plus, Pro, Business or Edu). Uses OpenAI's official Codex." },
  // Other models: API keys, free services, and local models.
  { id: "openrouter", label: "OpenRouter (many models, some free)", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", defaultModel: "openrouter/auto", models: ["openrouter/auto"], enabled: false, needsKey: true, free: true, note: "Models ending in :free cost nothing." },
  { id: "groq", label: "Groq (free tier)", kind: "openai", baseUrl: "https://api.groq.com/openai/v1", defaultModel: "llama-3.3-70b-versatile", models: ["llama-3.3-70b-versatile"], enabled: false, needsKey: true, free: true },
  { id: "local", label: "Local / custom model (phone, PC or any device)", kind: "openai", baseUrl: "http://127.0.0.1:11434/v1", defaultModel: "llama3.2", models: [], enabled: false, needsKey: false, free: true, note: "Any OpenAI-compatible server: on this phone, your PC over Tailscale, or another device." },
];

/** Old provider ids from earlier versions and what replaced them. */
const RENAMED: Record<string, string> = { anthropic: "claude", openai: "chatgpt", "claude-code": "claude", codex: "chatgpt" };

export interface Settings {
  providers: ProviderConfig[];
  defaultProvider: string | null;
  composio: { userId?: string; sessionId?: string; mcpUrl?: string; /** Your own sign-in setups (auth configs) for apps Composio doesn't manage, e.g. eBay. */ authConfigs?: Record<string, string> };
  website: { relayUrl?: string; deviceId?: string; enabled: boolean };
  tailscale: { enabled: boolean; hostname: string };
  onboardingDone: boolean;
  timeZone: string;
  quietHours: { start: string; end: string } | null;
  /** Voice: "phone" = the phone's own speech recognition and voice (API and local voices later). */
  voice: { engine: "phone"; readReplies: "voice" | "always" | "never"; rate: number; ttsEngine?: string; voiceName?: string; pitch?: number; speech?: Partial<SpeechPrefs>; recognizer?: string };
  /** Digital assistant (long-press home/power): which bot answers. null = the pinned/first bot. */
  assistant: { botId: string | null; speak: boolean };
}

/** Natural speech (calls, read-aloud replies, the assistant). Everything on by default. */
export interface SpeechPrefs {
  /** Phrase-by-phrase speech with delivery (speed, pitch, pauses). Off = the plain voice as before. */
  natural: boolean;
  /** Short listening sounds ("mm-hmm"), used occasionally. */
  reactions: boolean;
  /** Calls: wait when you pause mid-thought. */
  smartWaiting: boolean;
  /** Calls: the pause before answering. */
  beat: "quick" | "normal" | "relaxed";
  /** Calls: interrupt just by talking. */
  interruptByVoice: boolean;
  /** Calls: "hold on a sec", resume by the bot's name. */
  holdByVoice: boolean;
  /** Calls: on slow jobs say "let me check", keep working while you talk, give progress updates. */
  delegate: boolean;
}
export const SPEECH_DEFAULTS: SpeechPrefs = { natural: true, reactions: true, smartWaiting: true, beat: "normal", interruptByVoice: true, holdByVoice: true, delegate: true };
export const speechPrefs = (): SpeechPrefs => ({ ...SPEECH_DEFAULTS, ...(settings().voice.speech ?? {}) });

const settingsFile = collection<Settings>("settings", {
  providers: PROVIDER_PRESETS,
  defaultProvider: null,
  composio: {},
  website: { enabled: false },
  tailscale: { enabled: false, hostname: "mausdroid" },
  onboardingDone: false,
  timeZone: deviceTimeZone(),
  quietHours: null,
  voice: { engine: "phone", readReplies: "voice", rate: 1 },
  assistant: { botId: null, speak: true },
});

settingsFile.update((s) => {
  s.voice ??= { engine: "phone", readReplies: "voice", rate: 1 };
  s.assistant ??= { botId: null, speak: true };
});

// Keep providers in step with this version: subscriptions are sign-in only,
// old API-key entries for Claude/ChatGPT and Gemini are removed, new presets appear.
settingsFile.update((s) => {
  // Gemini (API key or sign-in) was removed: Claude and ChatGPT are the subscriptions.
  s.providers = s.providers.filter((p) => !RENAMED[p.id] && p.id !== "gemini");
  for (const p of PROVIDER_PRESETS) {
    const have = s.providers.find((x) => x.id === p.id);
    if (!have) s.providers.push(p);
    else if (p.kind === "subscription") Object.assign(have, { label: p.label, note: p.note, kind: p.kind, subId: p.subId, needsKey: false, baseUrl: undefined, models: p.models });
  }
  // Presets first in their usual order, then endpoints you added.
  const order = (id: string) => {
    const i = PROVIDER_PRESETS.findIndex((p) => p.id === id);
    return i < 0 ? 1000 : i;
  };
  s.providers.sort((a, b) => order(a.id) - order(b.id));
  if (s.defaultProvider && RENAMED[s.defaultProvider]) s.defaultProvider = RENAMED[s.defaultProvider];
  if (s.defaultProvider === "gemini") s.defaultProvider = null;
  if (s.defaultProvider && !s.providers.find((p) => p.id === s.defaultProvider)) s.defaultProvider = null;
});

export const renamedProvider = (id: string | null) => (id && RENAMED[id]) || id;

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
