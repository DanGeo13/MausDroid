const HELPER_URL = "http://127.0.0.1:8791";

const log = document.getElementById("log");
const input = document.getElementById("input");
const pairForm = document.getElementById("pairform");
const pairInput = document.getElementById("pairinput");

const modelSelect = document.getElementById("model");
const effortSelect = document.getElementById("effort");
let models = [];

let threadId = null;
let haveScreenshot = false;
let busy = false;

function addBubble(cls, text) {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function getPairingCode() {
  const { pairingCode } = await chrome.storage.local.get("pairingCode");
  return pairingCode;
}

function showPairForm() {
  pairForm.hidden = false;
  pairInput.focus();
}

const EFFORT_LABELS = { low: "Quick", medium: "Normal", high: "Careful", xhigh: "Very careful", max: "Maximum", ultra: "Ultra" };

function fillEfforts(saved) {
  const model = models.find((m) => m.id === modelSelect.value);
  effortSelect.innerHTML = '<option value="">Default</option>';
  for (const e of model?.efforts ?? []) {
    const label = EFFORT_LABELS[e] ?? e;
    effortSelect.add(new Option(e === model.defaultEffort ? `${label} (default)` : label, e));
  }
  effortSelect.value = model?.efforts.includes(saved) ? saved : "";
}

async function loadModels() {
  const code = await getPairingCode();
  if (!code) return;
  try {
    const res = await fetch(`${HELPER_URL}/models`, { headers: { authorization: `Bearer ${code}` } });
    if (!res.ok) return;
    models = await res.json();
  } catch {
    return;
  }
  const { model = "", effort = "" } = await chrome.storage.local.get(["model", "effort"]);
  modelSelect.innerHTML = '<option value="">Codex default</option>';
  for (const m of models) modelSelect.add(new Option(m.name, m.id));
  modelSelect.value = models.some((m) => m.id === model) ? model : "";
  fillEfforts(effort);
}

modelSelect.onchange = () => {
  chrome.storage.local.set({ model: modelSelect.value });
  fillEfforts(effortSelect.value);
  chrome.storage.local.set({ effort: effortSelect.value });
};
effortSelect.onchange = () => chrome.storage.local.set({ effort: effortSelect.value });

async function captureTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  return dataUrl.split(",")[1];
}

function* ndjsonLines(buffer) {
  let i;
  while ((i = buffer.text.indexOf("\n")) >= 0) {
    const line = buffer.text.slice(0, i).trim();
    buffer.text = buffer.text.slice(i + 1);
    if (line) yield line;
  }
}

async function ask(prompt, imageBase64) {
  const code = await getPairingCode();
  if (!code) {
    addBubble("a", "Pair with the helper first: click Pair and paste the code from the helper window.");
    showPairForm();
    return;
  }
  busy = true;
  const bubble = addBubble("a", "Thinking…");
  let answered = false;

  try {
    const res = await fetch(`${HELPER_URL}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${code}` },
      body: JSON.stringify({ prompt, imageBase64, threadId, model: modelSelect.value, effort: effortSelect.value }),
    });
    if (res.status === 401) throw new Error("The pairing code doesn't match. Click Pair and paste the code from the helper window.");
    if (!res.ok) throw new Error(await res.text());

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const buffer = { text: "" };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer.text += decoder.decode(value, { stream: true });
      for (const line of ndjsonLines(buffer)) {
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === "thread.started") threadId = ev.thread_id;
        if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
          bubble.textContent = answered ? `${bubble.textContent}\n\n${ev.item.text}` : ev.item.text;
          answered = true;
        }
        if (ev.type === "turn.failed" || ev.type === "error") {
          throw new Error(ev.error?.message ?? ev.message ?? "ChatGPT (Codex) error");
        }
        log.scrollTop = log.scrollHeight;
      }
    }
    if (!answered) bubble.textContent = "No answer came back. Try again.";
  } catch (err) {
    const offline = err instanceof TypeError;
    bubble.textContent = offline
      ? "Can't reach the helper. Open Terminal and run: node helper.mjs (in the screen-helper folder), then try again."
      : `Error: ${err.message}`;
  }
  busy = false;
}

async function lookAtTab() {
  if (busy) return;
  log.innerHTML = "";
  threadId = null;
  haveScreenshot = false;
  let screenshot;
  try {
    screenshot = await captureTab();
  } catch {
    addBubble("a", "Couldn't capture this tab. Chrome blocks screenshots of some pages (like chrome:// pages and the Web Store). Try a normal web page.");
    return;
  }
  haveScreenshot = true;
  await ask(PROMPT, screenshot);
}

document.getElementById("look").onclick = lookAtTab;
document.getElementById("pair").onclick = showPairForm;

pairForm.onsubmit = async (e) => {
  e.preventDefault();
  const code = pairInput.value.trim();
  if (!code) return;
  await chrome.storage.local.set({ pairingCode: code });
  pairInput.value = "";
  pairForm.hidden = true;
  addBubble("a", "Paired. Click 'Look at this tab'.");
  loadModels();
};

document.getElementById("form").onsubmit = (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || busy) return;
  input.value = "";
  if (!haveScreenshot) {
    addBubble("a", "Click 'Look at this tab' first.");
    return;
  }
  addBubble("q", q);
  ask(q);
};

loadModels().then(lookAtTab);
