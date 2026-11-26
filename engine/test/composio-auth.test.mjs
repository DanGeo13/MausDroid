// Apps Composio doesn't sign in for (eBay): a clear message, your own
// developer app's keys saved in Composio as a sign-in setup, and the
// session using it so connecting works; Gumtree comes as a skill.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startEngine } from "./_engine.mjs";
import { fakeComposio } from "./_composio.mjs";

test("eBay: needs your own developer app → set up sign-in → connect works", async () => {
  const c = await fakeComposio({
    unmanaged: ["ebay"],
    toolkitInfo: {
      ebay: {
        slug: "ebay",
        name: "eBay",
        composio_managed_auth_schemes: [],
        auth_config_details: [
          {
            mode: "OAUTH2",
            required_scopes: [],
            fields: {
              auth_config_creation: {
                required: [
                  { name: "client_id", displayName: "Client ID", description: "App ID from eBay", type: "string", required: true, is_secret: false, user_visible: true },
                  { name: "client_secret", displayName: "Client Secret", description: "Cert ID from eBay", type: "string", required: true, is_secret: true, user_visible: true },
                ],
                optional: [{ name: "scopes", displayName: "Scopes", description: "", type: "string", required: false, default: "https://api.ebay.com/oauth/api_scope", user_visible: true }],
              },
              connected_account_initiation: { required: [], optional: [] },
            },
          },
        ],
      },
    },
  });
  const e = await startEngine({ env: { MAUSDROID_COMPOSIO_API: c.url } });
  try {
    await e.call("/api/composio/key", "POST", { key: "ak_test" });
    // Gumtree comes as a built-in skill (the background browser, no app connection).
    assert.ok((await e.call("/api/skills")).data.some((s) => s.name === "gumtree"));

    // Connecting eBay first: a plain message pointing at the fix.
    const first = await e.call("/api/composio/link", "POST", { toolkit: "ebay" });
    assert.equal(first.status, 500);
    assert.match(first.data.error, /needs your own developer app.*Set up sign-in/);

    // What eBay's sign-in needs, straight from Composio.
    const auth = (await e.call("/api/composio/toolkits/ebay/auth")).data;
    assert.equal(auth.composioManaged, false);
    assert.deepEqual(auth.schemes[0].fields.map((f) => [f.name, f.required, f.secret]), [["client_id", true, false], ["client_secret", true, true], ["scopes", false, false]]);

    // Missing keys: Composio's reason is shown; nothing saved.
    const bad = await e.call("/api/composio/toolkits/ebay/auth", "POST", { mode: "OAUTH2", credentials: { client_secret: "x" } });
    assert.equal(bad.status, 400);
    assert.match(bad.data.error, /client_id is required/);

    // The keys go to Composio as your sign-in setup; the session then uses it.
    const ok = (await e.call("/api/composio/toolkits/ebay/auth", "POST", { mode: "OAUTH2", credentials: { client_id: " my-app-id ", client_secret: "my-cert-id", scopes: "" } })).data;
    assert.match(ok.id, /^ac_ebay/);
    const sent = c.state.authConfigs.at(-1);
    assert.deepEqual(sent.toolkit, { slug: "ebay" });
    assert.equal(sent.auth_config.type, "use_custom_auth");
    assert.equal(sent.auth_config.authScheme, "OAUTH2");
    assert.deepEqual(sent.auth_config.credentials, { client_id: "my-app-id", client_secret: "my-cert-id" }, "trimmed, empty fields left out");
    assert.deepEqual(c.state.sessionAuth, { ebay: ok.id });
    assert.equal((await e.call("/api/composio/toolkits/ebay/auth")).data.yours, ok.id);
    const link = await e.call("/api/composio/link", "POST", { toolkit: "ebay" });
    assert.equal(link.status, 200);
    assert.equal(link.data.url, "https://connect.example/ebay");
    // The keys are never kept on the phone.
    assert.ok(!JSON.stringify((await e.call("/api/settings")).data).includes("my-cert-id"));

    // Removing the setup: the session stops using it.
    await e.call("/api/composio/toolkits/ebay/auth", "DELETE");
    assert.equal(c.state.sessionAuth, null);
  } finally {
    await e.stop();
    c.close();
  }
});
