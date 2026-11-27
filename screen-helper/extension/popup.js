const status = document.getElementById("status");

async function run() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch {
    status.textContent = "Chrome won't let extensions screenshot this page (like chrome:// pages or the Web Store). Try a normal web page.";
    return;
  }

  const blob = await (await fetch(dataUrl)).blob();
  await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);

  await chrome.storage.local.set({ pendingPrompt: { text: PROMPT, at: Date.now() } });
  await chrome.tabs.create({ url: "https://chatgpt.com/", index: tab.index + 1 });
}

run().catch((err) => {
  status.textContent = `Something went wrong: ${err.message}`;
});
