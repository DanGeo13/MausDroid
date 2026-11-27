const GROQ_API = "https://api.groq.com/openai/v1";
// Groq models that accept images, per LiteLLM's model list (Nov 2026); Groq's /models doesn't say.
const IMAGE_MODELS = ["qwen/qwen3.8-27b"];
const DEFAULT_MODEL = IMAGE_MODELS[0];
const seesImages = (id) => IMAGE_MODELS.includes(id) || /vision|-vl\b/i.test(id);

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
  const { groqKey } = await chrome.storage.local.get("groqKey");
  return groqKey;
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
  if (!key.startsWith("gsk_")) {
    addBubble("a", "That doesn't look like a Groq key. Groq keys start with gsk_. Get one at console.groq.com/keys.");
    return;
  }
  await chrome.storage.local.set({ groqKey: key });
  keyInput.value = "";
  keyForm.hidden = true;
  addBubble("a", "Key saved. Click 'Look at this tab'.");
  loadModels();
};

class GroqError extends Error {
  constructor(status, body) {
    let message = body;
    try { message = JSON.parse(body).error?.message ?? body; } catch {}
    super(message);
    this.status = status;
  }
  get cantSeeImages() {
    return this.status === 404 || /image|vision|multimodal|content must be a string|content.*type/i.test(this.message);
  }
  get friendly() {
    if (this.status === 401) return "Groq didn't accept that API key. Click 'API key' and paste it again (it starts with gsk_).";
    if (this.status === 429) return `Groq's limit was reached for now. Wait a minute and try again. (${this.message})`;
    if (/too large|size|exceed/i.test(this.message)) return `The screenshot was too big for Groq. Make the browser window smaller and try again. (${this.message})`;
    return `Groq said ${this.status || "error"}: ${this.message.slice(0, 300)}`;
  }
}

async function loadModels() {
  const key = await getApiKey();
  const { model: saved } = await chrome.storage.local.get("model");
  let ids = [DEFAULT_MODEL];
  if (key) {
    try {
      const res = await fetch(`${GROQ_API}/models`, { headers: { authorization: `Bearer ${key}` } });
      if (res.ok) {
        const live = (await res.json()).data
          .filter((m) => m.active !== false && !/whisper|tts|guard|playai|orpheus|embed/i.test(m.id))
          .map((m) => m.id);
        if (live.length) ids = live;
      }
    } catch {}
  }
  ids.sort((a, b) => Number(seesImages(b)) - Number(seesImages(a)) || a.localeCompare(b));
  modelSelect.innerHTML = "";
  for (const id of ids) modelSelect.add(new Option(seesImages(id) ? `👁 ${id}` : id, id));
  modelSelect.value = ids.includes(saved) ? saved : ids.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : ids[0];
}

modelSelect.onchange = () => chrome.storage.local.set({ model: modelSelect.value });

async function captureTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 80 });
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
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

function hasImage(messages) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url"));
}

function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?(<\/think>\s*|$)/g, "").trimStart();
}

async function streamAnswer(key, model, messages, bubble) {
  const res = await fetch(`${GROQ_API}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true }),
  });
  if (!res.ok) throw new GroqError(res.status, await res.text());
  let raw = "";
  for await (const ev of sseData(res)) {
    if (ev.error) throw new GroqError(0, JSON.stringify(ev));
    const delta = ev.choices?.[0]?.delta?.content;
    if (delta) {
      raw += delta;
      const shown = stripThinking(raw);
      bubble.textContent = shown || "Thinking…";
      log.scrollTop = log.scrollHeight;
    }
  }
  return stripThinking(raw);
}

async function ask(content) {
  const key = await getApiKey();
  if (!key) {
    addBubble("a", "Click 'API key' and paste your Groq key first (from console.groq.com/keys).");
    showKeyForm();
    return;
  }
  busy = true;
  const bubble = addBubble("a", "Thinking…");
  const userMessage = { role: "user", content };

  const messages = [{ role: "system", content: PROMPT }, ...conversation, userMessage];
  try {
    let answer;
    try {
      answer = await streamAnswer(key, modelSelect.value, messages, bubble);
    } catch (err) {
      const canSwitch = err instanceof GroqError && err.cantSeeImages && hasImage(messages) && modelSelect.value !== DEFAULT_MODEL;
      if (!canSwitch) throw err;
      const from = modelSelect.value;
      modelSelect.value = DEFAULT_MODEL;
      if (modelSelect.value !== DEFAULT_MODEL) modelSelect.add(new Option(`👁 ${DEFAULT_MODEL}`, DEFAULT_MODEL, true, true));
      chrome.storage.local.set({ model: DEFAULT_MODEL });
      addBubble("q", `"${from}" can't read images, so I switched to ${DEFAULT_MODEL}.`);
      log.append(bubble);
      answer = await streamAnswer(key, DEFAULT_MODEL, messages, bubble);
    }
    if (!answer) throw new Error("No answer came back. Try again.");
    conversation.push(userMessage, { role: "assistant", content: answer });
  } catch (err) {
    if (err instanceof GroqError) bubble.textContent = `Error: ${err.friendly}`;
    else if (err instanceof TypeError) bubble.textContent = "Couldn't reach Groq. Check your internet connection.";
    else bubble.textContent = `Error: ${err.message}`;
  }
  busy = false;
}

async function lookAtTab() {
  if (busy) return;
  log.innerHTML = "";
  conversation = [];
  let imageUrl;
  try {
    imageUrl = await captureTab();
  } catch {
    addBubble("a", "Couldn't capture this tab. Chrome blocks screenshots of some pages (like chrome:// pages and the Web Store). Try a normal web page.");
    return;
  }
  await ask([
    { type: "text", text: "Answer the questions in this screenshot." },
    { type: "image_url", image_url: { url: imageUrl } },
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
  ask(q);
};

(async () => {
  await loadModels();
  if (await getApiKey()) lookAtTab();
  else {
    addBubble("a", "Click 'API key' and paste your Groq key (from console.groq.com/keys) to get started.");
    showKeyForm();
  }
})();
