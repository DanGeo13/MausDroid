// Writes dist/updates/update.json: a signed description of the newest
// engine (and optionally APK). The app refuses anything not signed with the
// MausDroid update key. Usage:
//   MAUSDROID_UPDATE_KEY=path/to/update-signing-key.pem node scripts/publish-update.mjs [apk-path]
import crypto from "node:crypto";
import fs from "node:fs";

const v = JSON.parse(fs.readFileSync("version.json", "utf8"));
const keyPem = process.env.MAUSDROID_UPDATE_KEY_PEM ?? fs.readFileSync(process.env.MAUSDROID_UPDATE_KEY, "utf8");
const raw = "https://raw.githubusercontent.com/DanGeo13/MausDroid/updates";
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const zip = `dist/updates/engine-${v.engine}.zip`;
const payload = {
  createdAt: new Date().toISOString(),
  engine: { version: v.engine, url: `${raw}/engine-${v.engine}.zip`, sha256: sha(zip), size: fs.statSync(zip).size, minApk: v.minApkForEngine ?? 0 },
};
const apk = process.argv[2];
if (apk) {
  const [a, b, c] = v.apk.split(".").map(Number);
  fs.copyFileSync(apk, `dist/updates/MausDroid-${v.apk}.apk`);
  payload.apk = { versionName: v.apk, versionCode: a * 10000 + b * 100 + c, url: `${raw}/MausDroid-${v.apk}.apk`, sha256: sha(apk) };
}
// Engine-only release: keep offering the APK from the previous manifest.
if (!apk && process.env.KEEP_APK_FROM && fs.existsSync(process.env.KEEP_APK_FROM)) {
  try {
    const prev = JSON.parse(JSON.parse(fs.readFileSync(process.env.KEEP_APK_FROM, "utf8")).payload);
    if (prev.apk) payload.apk = prev.apk;
  } catch {
    /* no previous manifest */
  }
}
const text = JSON.stringify(payload);
const signature = crypto.sign("sha256", Buffer.from(text), crypto.createPrivateKey(keyPem)).toString("base64");
fs.writeFileSync("dist/updates/update.json", JSON.stringify({ payload: text, signature }, null, 1));
console.log("update.json written for engine", v.engine, apk ? `and apk ${v.apk}` : "");
