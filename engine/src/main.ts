import fs from "node:fs";
import { config } from "./config.ts";
import { initSecrets } from "./secrets.ts";
import { ensureDefaultBots } from "./bots.ts";
import { startServer } from "./server.ts";
import { startScheduler } from "./scheduler.ts";
import { startRelayClient } from "./relay-client.ts";
import { startEgressProxy } from "./proxy.ts";
import { initMcpServer } from "./mcp-server.ts";
import { flushAll } from "./store.ts";
import { bridge, bridgeAvailable } from "./bridge.ts";
import { settings } from "./settings.ts";
import { getSecret } from "./secrets.ts";

async function main() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  await initSecrets();
  await initMcpServer();
  ensureDefaultBots();
  startServer();
  startEgressProxy(config.port + 3);
  startScheduler();
  startRelayClient();
  const ts = settings().tailscale;
  if (bridgeAvailable() && ts.enabled) {
    await bridge("/tailscale/start", { hostname: ts.hostname, authKey: getSecret("tailscale:authkey") ?? "" }).catch(() => {});
  }
  if (bridgeAvailable()) await bridge("/engine/ready", { version: config.version, port: config.port }).catch(() => {});
  console.log(`MausDroid engine ${config.version} on http://127.0.0.1:${config.port}/?t=${config.platform === "desktop-dev" ? config.localToken : "…"}`);
}

for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    flushAll();
    process.exit(0);
  });
process.on("exit", flushAll);
process.on("uncaughtException", (e) => console.error("uncaught", e));
process.on("unhandledRejection", (e) => console.error("unhandled", e));

void main();
