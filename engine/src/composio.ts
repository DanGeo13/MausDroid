import { randomUUID } from "node:crypto";
import { McpClient } from "./mcp.ts";
import { getSecret, setSecret } from "./secrets.ts";
import { settings, updateSettings } from "./settings.ts";
import type { ToolSpec } from "./types.ts";

/**
 * Composio connected apps, the same way OpenMausBot does it: one Composio
 * project key and one Tool Router Session. The Session's MCP server gives
 * every bot search/connect/execute tools for every app Composio supports,
 * and lets you connect several accounts per app.
 */
const API = process.env.MAUSDROID_COMPOSIO_API ?? "https://backend.composio.dev/api/v3";
let client: McpClient | null = null;
let tools: ToolSpec[] | null = null;

const headers = (key: string, json = false): Record<string, string> => ({
  "x-api-key": key,
  ...(json ? { "content-type": "application/json" } : {}),
});

async function responseError(res: Response) {
  const t = await res.text();
  try {
    const j = JSON.parse(t);
    return j.error?.message ?? j.message ?? t.slice(0, 300);
  } catch {
    return t.slice(0, 300);
  }
}

async function createSession(key: string, userId: string) {
  const res = await fetch(`${API}/tool_router/session`, {
    method: "POST",
    headers: headers(key, true),
    body: JSON.stringify({
      user_id: userId,
      manage_connections: { enable: true, enable_wait_for_connections: true, enable_connection_removal: true },
      multi_account: { enable: true, max_accounts_per_toolkit: 10, require_explicit_selection: true },
      // Apps signed in with your own developer app (e.g. eBay) use your sign-in setup.
      ...(Object.keys(settings().composio.authConfigs ?? {}).length ? { auth_configs: settings().composio.authConfigs } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Composio refused this key: ${await responseError(res)}`);
  const j = (await res.json()) as { session_id: string; mcp: { url: string } };
  const u = new URL(j.mcp.url);
  if (!process.env.MAUSDROID_COMPOSIO_API && (u.protocol !== "https:" || !(u.hostname === "composio.dev" || u.hostname.endsWith(".composio.dev"))))
    throw new Error("Composio returned an untrusted MCP address");
  return j;
}

/** Saves and checks a Composio project key (starts with ak_). */
export async function connectComposio(key: string) {
  key = key.trim();
  if (!key.startsWith("ak_")) throw new Error("Composio project API keys start with ak_ (from the project's API Keys page).");
  const userId = settings().composio.userId ?? `mausdroid_${randomUUID()}`;
  const s = await createSession(key, userId);
  await setSecret("composio", key);
  updateSettings((st) => {
    st.composio = { userId, sessionId: s.session_id, mcpUrl: s.mcp.url };
  });
  client = null;
  tools = null;
}

export async function disconnectComposio() {
  await setSecret("composio", null);
  updateSettings((st) => {
    st.composio = { userId: st.composio.userId };
  });
  client = null;
  tools = null;
}

function mcp(): McpClient | null {
  const key = getSecret("composio");
  const url = settings().composio.mcpUrl;
  if (!key || !url) return null;
  client ??= new McpClient(url, headers(key));
  return client;
}

export async function composioTools(): Promise<ToolSpec[]> {
  const c = mcp();
  if (!c) return [];
  if (!tools) {
    try {
      tools = (await c.listTools()).map((t) => ({ ...t, name: `composio__${t.name}` }));
    } catch (e) {
      // The Session may have expired: make a new one for the same user once.
      const key = getSecret("composio")!;
      const s = await createSession(key, settings().composio.userId!);
      updateSettings((st) => {
        st.composio.sessionId = s.session_id;
        st.composio.mcpUrl = s.mcp.url;
      });
      client = new McpClient(s.mcp.url, headers(key));
      tools = (await client.listTools()).map((t) => ({ ...t, name: `composio__${t.name}` }));
    }
  }
  return tools;
}

export async function callComposio(name: string, args: unknown) {
  const c = mcp();
  if (!c) throw new Error("Composio is not connected. Add your project key in Settings → Connected apps.");
  const r = await c.callTool(name.replace(/^composio__/, ""), args);
  // An app that needs your own developer app: tell the bot (and so the person) how to fix it.
  const m = r.text.match(/toolkit ([a-z0-9_]+)[^\n]{0,40}does not manage auth/i);
  if (m) r.text += `\n\n[MausDroid: ${m[1]} needs the person's own ${m[1]} developer app. Tell them: Settings → Connected apps → ${m[1]} → "Set up sign-in", enter its keys there (never in chat), then connect again.]`;
  return r;
}

/** Toolkit catalogue for the Connected apps screen. */
export async function listToolkits(search = "", cursor?: string) {
  const key = getSecret("composio");
  if (!key) throw new Error("Add your Composio project key first.");
  const q = new URLSearchParams({ limit: "50" });
  if (search) q.set("search", search);
  if (cursor) q.set("cursor", cursor);
  const res = await fetch(`${API}/toolkits?${q}`, { headers: headers(key) });
  if (!res.ok) throw new Error(await responseError(res));
  const j = (await res.json()) as any;
  return {
    items: (j.items ?? []).map((t: any) => ({ slug: t.slug, name: t.name, logo: t.meta?.logo, description: t.meta?.description, categories: (t.meta?.categories ?? []).map((c: any) => c.name ?? c) })),
    nextCursor: j.next_cursor ?? null,
  };
}

export async function listConnections() {
  const key = getSecret("composio");
  const userId = settings().composio.userId;
  if (!key || !userId) return [];
  const res = await fetch(`${API}/connected_accounts?user_ids=${encodeURIComponent(userId)}&limit=100`, { headers: headers(key) });
  if (!res.ok) throw new Error(await responseError(res));
  const j = (await res.json()) as any;
  return (j.items ?? []).map((a: any) => ({ id: a.id, toolkit: a.toolkit?.slug, status: a.status, alias: a.alias ?? a.data?.alias ?? null, createdAt: a.created_at }));
}

/** Starts the sign-in for one app. Returns a link to open in the phone's browser. */
export async function linkToolkit(toolkit: string, alias?: string): Promise<{ url: string }> {
  const key = getSecret("composio");
  const st = settings().composio;
  if (!key || !st.sessionId) throw new Error("Add your Composio project key first.");
  const res = await fetch(`${API}/tool_router/session/${encodeURIComponent(st.sessionId)}/link`, {
    method: "POST",
    headers: headers(key, true),
    body: JSON.stringify({ toolkit, ...(alias ? { alias } : {}) }),
  });
  if (!res.ok) throw new Error(explainAuthError(toolkit, await responseError(res)));
  const j = (await res.json()) as any;
  const url = j.redirect_url ?? j.link ?? j.url;
  if (!url) throw new Error("Composio did not return a sign-in link.");
  return { url };
}

export async function removeConnection(id: string) {
  const key = getSecret("composio");
  if (!key) throw new Error("Composio is not connected.");
  const res = await fetch(`${API}/connected_accounts/${encodeURIComponent(id)}?revoke_on_delete=true`, { method: "DELETE", headers: headers(key) });
  if (!res.ok) throw new Error(await responseError(res));
  tools = null;
}


// ---------------- Apps that need your own developer app (e.g. eBay) ----------------

export interface AuthField {
  name: string;
  label: string;
  description: string;
  secret: boolean;
  required: boolean;
  default?: string | null;
}

/** How an app signs in: whether Composio manages it, and the details your own setup needs. */
export async function toolkitAuth(slug: string) {
  const key = getSecret("composio");
  if (!key) throw new Error("Add your Composio project key first.");
  const res = await fetch(`${API}/toolkits/${encodeURIComponent(slug)}`, { headers: headers(key) });
  if (!res.ok) throw new Error(await responseError(res));
  const j = (await res.json()) as any;
  const field = (f: any, required: boolean): AuthField => ({ name: f.name, label: f.displayName ?? f.name, description: f.description ?? "", secret: Boolean(f.is_secret), required, default: f.default ?? null });
  const schemes = (j.auth_config_details ?? []).map((d: any) => ({
    mode: d.mode as string,
    fields: [...(d.fields?.auth_config_creation?.required ?? []).map((f: any) => field(f, true)), ...(d.fields?.auth_config_creation?.optional ?? []).filter((f: any) => f.user_visible !== false).map((f: any) => field(f, false))],
  }));
  return {
    slug: j.slug ?? slug,
    name: j.name ?? slug,
    composioManaged: (j.composio_managed_auth_schemes ?? []).length > 0,
    schemes,
    yours: settings().composio.authConfigs?.[slug] ?? null,
  };
}

/** Saves your own sign-in setup for an app (its developer keys stay in Composio, not on the phone) and uses it from now on. */
export async function setupCustomAuth(slug: string, mode: string, credentials: Record<string, string>) {
  const key = getSecret("composio");
  const st = settings().composio;
  if (!key || !st.userId) throw new Error("Add your Composio project key first.");
  const clean = Object.fromEntries(Object.entries(credentials ?? {}).map(([k, v]) => [k, String(v ?? "").trim()]).filter(([, v]) => v));
  const res = await fetch(`${API}/auth_configs`, {
    method: "POST",
    headers: headers(key, true),
    body: JSON.stringify({ toolkit: { slug }, auth_config: { type: "use_custom_auth", authScheme: mode, credentials: clean, name: `MausDroid ${slug}`, is_enabled_for_tool_router: true } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Composio didn't accept these details: ${await responseError(res)}`);
  const j = (await res.json()) as any;
  const id = j.auth_config?.id ?? j.id;
  if (!id) throw new Error("Composio didn't return the new sign-in setup.");
  updateSettings((s) => {
    s.composio.authConfigs = { ...(s.composio.authConfigs ?? {}), [slug]: id };
  });
  await renewSession();
  return { id };
}

export async function removeCustomAuth(slug: string) {
  updateSettings((s) => {
    const m = { ...(s.composio.authConfigs ?? {}) };
    delete m[slug];
    s.composio.authConfigs = m;
  });
  await renewSession();
}

/** A new session so bots and sign-ins use the current sign-in setups. */
async function renewSession() {
  const key = getSecret("composio");
  const userId = settings().composio.userId;
  if (!key || !userId) return;
  const s = await createSession(key, userId);
  updateSettings((st) => {
    st.composio.sessionId = s.session_id;
    st.composio.mcpUrl = s.mcp.url;
  });
  client = null;
  tools = null;
}

/** Composio's "doesn't manage auth" error, in plain words with the fix. */
export function explainAuthError(slug: string, message: string) {
  return /does not manage auth|auth_config_override|create an auth config/i.test(message)
    ? `${slug} needs your own developer app: Settings → Connected apps → ${slug} → "Set up sign-in" and enter its keys.`
    : message;
}

// ---------------- Direct tool execution (one chosen account) ----------------

const toolInfo = new Map<string, { version?: string; params: string[] }>();

/** A Composio tool's current version and input names (cached). */
export async function describeTool(slug: string) {
  const hit = toolInfo.get(slug);
  if (hit) return hit;
  const key = getSecret("composio");
  if (!key) throw new Error("Composio is not connected.");
  const res = await fetch(`${API}/tools/${encodeURIComponent(slug)}`, { headers: headers(key) });
  if (!res.ok) throw new Error(`Composio tool ${slug}: ${await responseError(res)}`);
  const j = (await res.json()) as any;
  const info = { version: j.version ?? j.toolkit?.version, params: Object.keys(j.input_parameters?.properties ?? j.inputParameters?.properties ?? {}) };
  toolInfo.set(slug, info);
  return info;
}

/** Picks the input name Composio uses (e.g. calendar_id vs calendarId). */
export async function argsFor(slug: string, wanted: Record<string, { names: string[]; value: unknown }>) {
  const { params } = await describeTool(slug);
  const out: Record<string, unknown> = {};
  for (const { names, value } of Object.values(wanted)) {
    if (value === undefined || value === null || value === "") continue;
    const name = names.find((n) => params.includes(n)) ?? (params.length ? undefined : names[0]);
    if (name) out[name] = value;
  }
  return out;
}

/** Runs one Composio tool as one specific connected account. Returns its data or throws its error. */
export async function executeTool(slug: string, args: Record<string, unknown>, connectedAccountId: string): Promise<any> {
  const key = getSecret("composio");
  const userId = settings().composio.userId;
  if (!key || !userId) throw new Error("Composio is not connected.");
  const info = await describeTool(slug).catch(() => ({ version: undefined }));
  const res = await fetch(`${API}/tools/execute/${encodeURIComponent(slug)}`, {
    method: "POST",
    headers: headers(key, true),
    body: JSON.stringify({ user_id: userId, connected_account_id: connectedAccountId, arguments: args, ...(info.version ? { version: info.version } : {}) }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(await responseError(res));
  const j = (await res.json()) as any;
  if (j.successful === false || j.error) throw new Error(typeof j.error === "string" ? j.error : JSON.stringify(j.error ?? "Composio reported a failure"));
  return j.data ?? j;
}
