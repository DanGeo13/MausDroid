// Bundles the engine (one file for nodejs-mobile, Node 18) and the web UI.
import { build } from "esbuild";
import fs from "node:fs";

const version = process.env.MAUSDROID_ENGINE_VERSION ?? JSON.parse(fs.readFileSync("../version.json", "utf8")).engine;
fs.rmSync("dist", { recursive: true, force: true });

await build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/engine.cjs",
  define: { "process.env.MAUSDROID_ENGINE_VERSION": JSON.stringify(version) },
  logLevel: "warning",
});

await build({
  entryPoints: ["../ui/src/main.tsx"],
  bundle: true,
  minify: true,
  target: "chrome100",
  format: "esm",
  jsx: "automatic",
  jsxImportSource: "preact",
  outfile: "dist/ui/app.js",
  nodePaths: [new URL("./node_modules", import.meta.url).pathname],
  logLevel: "warning",
});
for (const f of fs.readdirSync("../ui/public")) fs.copyFileSync(`../ui/public/${f}`, `dist/ui/${f}`);
console.log(`built engine ${version}`);
