const MAX_AGE_MS = 60_000;

function findComposer() {
  return document.querySelector("#prompt-textarea");
}

function waitForComposer(timeoutMs = 15_000) {
  return new Promise((resolve) => {
    const found = findComposer();
    if (found) return resolve(found);
    const observer = new MutationObserver(() => {
      const el = findComposer();
      if (el) { observer.disconnect(); resolve(el); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
  });
}

function showHint(message) {
  const hint = document.createElement("div");
  hint.textContent = message;
  Object.assign(hint.style, {
    position: "fixed", top: "16px", left: "50%", transform: "translateX(-50%)", zIndex: 2147483647,
    background: "#d97757", color: "#fff", padding: "10px 16px", borderRadius: "10px",
    font: "600 15px system-ui, sans-serif", boxShadow: "0 4px 16px rgba(0,0,0,.25)",
  });
  document.body.append(hint);
  setTimeout(() => hint.remove(), 8000);
}

async function fillPrompt() {
  const { pendingPrompt } = await chrome.storage.local.get("pendingPrompt");
  if (!pendingPrompt) return;
  await chrome.storage.local.remove("pendingPrompt");
  if (Date.now() - pendingPrompt.at > MAX_AGE_MS) return;

  const composer = await waitForComposer();
  if (!composer) {
    showHint("Press ⌘V to paste your screenshot, ask your question, then press Enter.");
    return;
  }
  composer.focus();
  if (composer.isContentEditable) {
    document.execCommand("insertText", false, pendingPrompt.text);
  } else {
    composer.value = pendingPrompt.text;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  }
  showHint("Press ⌘V to paste your screenshot, then press Enter.");
}

fillPrompt();
