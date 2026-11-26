// Loads an engine source module for unit tests (bundled for Node 18, like the phone).
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

export async function load(rel) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mdunit-")), "m.mjs");
  await build({ entryPoints: [new URL(`../${rel}`, import.meta.url).pathname], bundle: true, platform: "node", target: "node18", format: "esm", outfile: out, logLevel: "error",
    // Some libraries (e.g. tweetnacl) call require() for Node modules; give the ES module bundle one.
    banner: { js: 'import { createRequire as __mdCreateRequire } from "node:module"; const require = __mdCreateRequire(import.meta.url);' } });
  return import(pathToFileURL(out).href);
}
