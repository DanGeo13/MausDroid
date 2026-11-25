// web_fetch: spots pages that need JavaScript (they then go to the phone's browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "./_load.mjs";

const W = await load("src/tools/web.ts");
const { htmlToText } = await load("src/util.ts");

test("detects JavaScript-built pages, leaves normal pages alone", () => {
  const spa = '<html><body><div id="root"></div><script src="/app.js"></script></body></html>';
  assert.equal(W.needsJavaScript(spa, htmlToText(spa)), true);
  const noscript = "<html><body><noscript>You need to enable JavaScript to run this app.</noscript><script></script></body></html>";
  assert.equal(W.needsJavaScript(noscript, htmlToText(noscript)), true);
  const article = `<html><body><h1>News</h1>${"<p>Plenty of real words in this article about the school week. </p>".repeat(30)}<script>analytics()</script></body></html>`;
  assert.equal(W.needsJavaScript(article, htmlToText(article)), false);
});
