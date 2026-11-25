import path from "node:path";
import { randomBytes } from "node:crypto";

/** Runtime settings handed to the engine by the Android shell (or by a developer running it on a computer). */
export const config = {
  version: process.env.MAUSDROID_ENGINE_VERSION ?? "dev",
  apkVersion: process.env.MAUSDROID_APK_VERSION ?? "dev",
  dataDir: process.env.MAUSDROID_DATA_DIR ?? path.resolve(".mausdroid-data"),
  uiDir: process.env.MAUSDROID_UI_DIR ?? path.resolve("../ui/dist"),
  port: Number(process.env.MAUSDROID_PORT ?? 8737),
  /** Secret the on-phone UI uses; the shell passes it in the WebView URL. */
  localToken: process.env.MAUSDROID_TOKEN ?? randomBytes(24).toString("hex"),
  bridgeUrl: process.env.MAUSDROID_BRIDGE_URL ?? "",
  bridgeToken: process.env.MAUSDROID_BRIDGE_TOKEN ?? "",
  /** Local HTTP proxy (from tsbridge) that reaches devices on your tailnet. */
  tailnetProxy: process.env.MAUSDROID_TAILNET_PROXY ?? "127.0.0.1:8739",
  platform: process.env.MAUSDROID_PLATFORM ?? "desktop-dev",
};
