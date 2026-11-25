// The phone's Node.js (nodejs-mobile) is built without Unicode/ICU data:
// features that need it make the whole engine fail to load there, even
// though they work on a normal computer. Keep them out of the bundle.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("engine bundle uses nothing the phone's Node.js can't run", () => {
  const src = fs.readFileSync(new URL("../dist/engine.cjs", import.meta.url), "utf8");
  const banned = [
    [/\\[pP]\{/, "Unicode property escapes in regular expressions (\\p{…})"],
    [/\/[a-z]*v[a-z]*\.test\(|new RegExp\([^)]*,\s*["'][a-z]*v/, "the RegExp v flag"],
    [/(?<![\w.])Intl\.(?!.*\?\.)/, "Intl without a guard"],
    [/new TextDecoder\(/, "TextDecoder"],
  ];
  for (const [re, what] of banned) {
    const m = src.match(re);
    assert.ok(!m, `${what} found in the engine bundle near: ${m ? src.slice(Math.max(0, m.index - 80), m.index + 80) : ""}`);
  }
});
