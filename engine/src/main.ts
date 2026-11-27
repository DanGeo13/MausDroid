import fs from "node:fs";
import path from "node:path";
import { installNodeFetch } from "./net-fetch.ts";
import { config } from "./config.ts";

// On the phone, use MausDroid's own fetch (see net-fetch.ts) before anything else runs.
if (config.platform === "android" || process.env.MAUSDROID_NODE_FETCH === "1" || typeof (globalThis as any).WebAssembly === "undefined") installNodeFetch();

const statusFile = () => path.join(config.dataDir, "engine-status.json");
const steps: { step: string; ok: boolean; error?: string; at: string }[] = [];
function record(step: string, error?: unknown) {
  steps.push({ step, ok: !error, error: error ? (error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)) : undefined, at: new Date().toISOString() });
  try {
    fs.writeFileSync(statusFile(), JSON.stringify({ version: config.version, steps }, null, 1));
  } catch {
    /* data folder not ready */
  }
  if (error) console.error(`[startup] ${step} failed:`, error);
  else console.log(`[startup] ${step} ok`);
}

/** Each start-up step is independent: one failing (e.g. no network) never stops the app from opening. */
async function step(name: string, fn: () => unknown | Promise<unknown>) {
  try {
    await fn();
    record(name);
  } catch (e) {
    record(name, e);
  }
}

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  record("begin");
  // Loaded lazily so a problem in one module shows up in the status file.
  const { initSecrets } = await import("./secrets.ts");
  const { ensureDefaultBots } = await import("./bots.ts");
  const { startServer } = await import("./server.ts");
  const { startScheduler } = await import("./scheduler.ts");
  const { startRelayClient } = await import("./relay-client.ts");
  const { startEgressProxy } = await import("./proxy.ts");
  const { initMcpServer } = await import("./mcp-server.ts");
  const { flushAll } = await import("./store.ts");
  const { bridge, bridgeAvailable } = await import("./bridge.ts");
  const { settings } = await import("./settings.ts");
  const { getSecret } = await import("./secrets.ts");

  for (const sig of ["SIGTERM", "SIGINT"] as const)
    process.on(sig, () => {
      flushAll();
      process.exit(0);
    });
  process.on("exit", flushAll);

  await step("server", () => startServer());
  await step("secrets", () => initSecrets());
  await step("bots", () => ensureDefaultBots());
  const { ensureBuiltinSkills } = await import("./skills.ts");
  await step("skills", () => ensureBuiltinSkills());
  await step("mcp", () => initMcpServer());
  await step("proxy", () => startEgressProxy(config.port + 3));
  const { ensureAuditRoutine } = await import("./audit-setup.ts");
  await step("audit-routine", () => ensureAuditRoutine());
  const { ensureAudioRoutine } = await import("./audio-setup.ts");
  await step("audio-overview", () => ensureAudioRoutine());
  const { ensureImprover, startImprover } = await import("./improve.ts");
  await step("improver", () => ensureImprover());
  await step("scheduler", () => startScheduler());
  await step("improver-reveal", () => startImprover());
  await step("website", () => startRelayClient());
  const ts = settings().tailscale;
  if (bridgeAvailable() && ts.enabled) await step("tailscale", () => bridge("/tailscale/start", { hostname: ts.hostname, authKey: getSecret("tailscale:authkey") ?? "" }));
  if (bridgeAvailable()) await step("ready", () => bridge("/engine/ready", { version: config.version, port: config.port }));
  console.log(`MausDroid engine ${config.version} on http://127.0.0.1:${config.port}/?t=${config.platform === "desktop-dev" ? config.localToken : "…"}`);
}

process.on("uncaughtException", (e) => record("uncaught", e));
process.on("unhandledRejection", (e) => record("unhandled", e));

main().catch((e) => record("main", e));
