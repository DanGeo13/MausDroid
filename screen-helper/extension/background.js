importScripts("auth.js");

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "origin", operation: "remove" }] },
      condition: {
        requestDomains: ["auth.openai.com", "chatgpt.com"],
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ["xmlhttprequest"],
      },
    }],
  });
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type !== "sign-in") return;
  buildSignInUrl().then((url) => chrome.tabs.create({ url }));
  reply();
});

chrome.tabs.onUpdated.addListener(async (tabId, change) => {
  if (!change.url?.startsWith(AUTH.redirectUri)) return;
  const url = new URL(change.url);
  chrome.tabs.remove(tabId);
  const { pkce } = await chrome.storage.session.get("pkce");
  let result;
  if (url.searchParams.get("error")) result = { ok: false, error: url.searchParams.get("error_description") ?? url.searchParams.get("error") };
  else if (!pkce || url.searchParams.get("state") !== pkce.state) result = { ok: false, error: "Sign-in didn't match. Try again." };
  else {
    try {
      const session = await exchangeCode(url.searchParams.get("code"));
      result = { ok: true, email: session.email };
    } catch (err) {
      result = { ok: false, error: err.message };
    }
  }
  chrome.runtime.sendMessage({ type: "signed-in", ...result }).catch(() => {});
});
