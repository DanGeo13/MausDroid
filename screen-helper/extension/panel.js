const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_MODEL = "gemini-flash-latest";
const NOT_FOR_CHAT = /tts|image|embedding|live|robotics|computer-use|deep-research|aqa|veo|imagen|genie|customtools/i;

const log = document.getElementById("log");
const input = document.getElementById("input");
const keyForm = document.getElementById("keyform");
const keyInput = document.getElementById("keyinput");
const modelSelect = document.getElementById("model");

let conversation = [];
let busy = false;

function addBubble(cls, text) {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

async function getApiKey() {
  const { geminiKey } = await chrome.storage.local.get("geminiKey");
  return geminiKey;
}

function showKeyForm() {
  keyForm.hidden = false;
  keyInput.focus();
}

document.getElementById("key").onclick = showKeyForm;

keyForm.onsubmit = async (e) => {
  e.preventDefault();
  const key = keyInput.value.trim();
  if (!key) return;
  if (!key.startsWith("AIza")) {
    addBubble("a", "That doesn't look like a Gemini key. Gemini keys start with AIza. Get one at aistudio.google.com/apikey.");
    return;
  }
  await chrome.storage.local.set({ geminiKey: key });
  keyInput.value = "";
  keyForm.hidden = true;
  addBubble("a", "Key saved. Click 'Look at this tab'.");
  loadModels();
};

class GeminiError extends Error {
  constructor(status, body) {
    let message = body;
    try { message = JSON.parse(body).error?.message ?? body; } catch {}
    super(message);
    this.status = status;
  }
  get friendly() {
    if (/api key not valid|API_KEY_INVALID/i.test(this.message) || this.status === 401) {
      return "Google didn't accept that API key. Click 'API key' and paste it again (it starts with AIza).";
    }
    if (this.status === 429) return `Gemini's limit was reached for now. Wait a minute and try again, or pick a "Lite" model. (${this.message.slice(0, 200)})`;
    if (this.status === 404) return `The model "${modelSelect.value}" isn't available. Pick another in the Model menu.`;
    return `Gemini said ${this.status || "error"}: ${this.message.slice(0, 300)}`;
  }
}

function modelLabel(id) {
  return id === DEFAULT_MODEL ? `${id} (recommended)` : id;
}

async function loadModels() {
  const key = await getApiKey();
  const { model: saved } = await chrome.storage.local.get("model");
  let ids = [DEFAULT_MODEL];
  if (key) {
    try {
      const res = await fetch(`${GEMINI_API}/models?pageSize=1000`, { headers: { "x-goog-api-key": key } });
      if (res.ok) {
        const live = ((await res.json()).models ?? [])
          .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
          .map((m) => m.name.replace(/^models\//, ""))
          .filter((id) => /^(gemini|gemma)/.test(id) && !NOT_FOR_CHAT.test(id));
        if (live.length) ids = [...new Set([DEFAULT_MODEL, ...live])];
      }
    } catch {}
  }
  const rank = (id) => (id === DEFAULT_MODEL ? 0 : id.endsWith("-latest") ? 1 : id.startsWith("gemini") ? 2 : 3);
  ids.sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true }));
  modelSelect.innerHTML = "";
  for (const id of ids) modelSelect.add(new Option(modelLabel(id), id));
  modelSelect.value = ids.includes(saved) ? saved : DEFAULT_MODEL;
}

modelSelect.onchange = () => chrome.storage.local.set({ model: modelSelect.value });

async function captureTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 80 });
  return dataUrl.split(",")[1];
}

async function* sseData(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      try { yield JSON.parse(line.slice(5).trim()); } catch {}
    }
  }
}

async function ask(parts) {
  const key = await getApiKey();
  if (!key) {
    addBubble("a", "Click 'API key' and paste your Gemini key first (from aistudio.google.com/apikey).");
    showKeyForm();
    return;
  }
  busy = true;
  const bubble = addBubble("a", "Thinking…");
  const userTurn = { role: "user", parts };
  let answer = "";

  try {
    const res = await fetch(`${GEMINI_API}/models/${encodeURIComponent(modelSelect.value)}:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: PROMPT }] },
        contents: [...conversation, userTurn],
      }),
    });
    if (!res.ok) throw new GeminiError(res.status, await res.text());

    for await (const ev of sseData(res)) {
      if (ev.error) throw new GeminiError(ev.error.code ?? 0, JSON.stringify(ev));
      if (ev.promptFeedback?.blockReason) throw new Error(`Gemini wouldn't answer this (${ev.promptFeedback.blockReason}).`);
      for (const part of ev.candidates?.[0]?.content?.parts ?? []) {
        if (part.thought || !part.text) continue;
        answer += part.text;
        bubble.textContent = answer;
        log.scrollTop = log.scrollHeight;
      }
    }
    if (!answer) throw new Error("No answer came back. Try again.");
    conversation.push(userTurn, { role: "model", parts: [{ text: answer }] });
  } catch (err) {
    if (err instanceof GeminiError) bubble.textContent = `Error: ${err.friendly}`;
    else if (err instanceof TypeError) bubble.textContent = "Couldn't reach Gemini. Check your internet connection.";
    else bubble.textContent = `Error: ${err.message}`;
  }
  busy = false;
}

async function lookAtTab() {
  if (busy) return;
  log.innerHTML = "";
  conversation = [];
  let imageBase64;
  try {
    imageBase64 = await captureTab();
  } catch {
    addBubble("a", "Couldn't capture this tab. Chrome blocks screenshots of some pages (like chrome:// pages and the Web Store). Try a normal web page.");
    return;
  }
  await ask([
    { text: "Answer the questions in this screenshot." },
    { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
  ]);
}

document.getElementById("look").onclick = lookAtTab;

document.getElementById("form").onsubmit = (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || busy) return;
  input.value = "";
  if (!conversation.length) {
    addBubble("a", "Click 'Look at this tab' first.");
    return;
  }
  addBubble("q", q);
  ask([{ text: q }]);
};

(async () => {
  await loadModels();
  if (await getApiKey()) lookAtTab();
  else {
    addBubble("a", "Click 'API key' and paste your Gemini key (from aistudio.google.com/apikey) to get started.");
    showKeyForm();
  }
})();
