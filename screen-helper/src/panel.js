import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const SYSTEM_PROMPT = `You are a screen assistant. You get a screenshot of the user's browser tab.
Find the questions or tasks visible on it and answer each one.
- Multiple choice: give the letter/option and a one-line reason.
- Short answer: answer in one to three sentences.
- Ordering/sequencing: give the correct order as a numbered list.
- Anything else: briefly explain what is on screen and what to do next.
If the user asks a follow-up, answer it using the screenshot. Be concise. Use plain text.`;

const log = document.getElementById("log");
const input = document.getElementById("input");
const keyForm = document.getElementById("keyform");
const keyInput = document.getElementById("keyinput");

let history = [];
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
  const { apiKey } = await chrome.storage.local.get("apiKey");
  return apiKey;
}

function showKeyForm() {
  keyForm.hidden = false;
  keyInput.focus();
}

async function captureTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
  return dataUrl.split(",")[1];
}

async function ask(question, screenshot) {
  const apiKey = await getApiKey();
  if (!apiKey) {
    addBubble("a", "Paste your API key above and click Save, then try again.");
    showKeyForm();
    return;
  }
  busy = true;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  const content = [];
  if (screenshot) content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: screenshot } });
  content.push({ type: "text", text: question || "Answer the questions on my screen." });
  history.push({ role: "user", content });

  if (question) addBubble("q", question);
  const bubble = addBubble("a", "Thinking…");
  let started = false;

  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: history,
    });
    stream.on("text", (t) => {
      if (!started) { bubble.textContent = ""; started = true; }
      bubble.textContent += t;
      log.scrollTop = log.scrollHeight;
    });
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") bubble.textContent += "\n(Claude declined to answer this one.)";
    history.push({ role: "assistant", content: final.content });
  } catch (err) {
    history.pop();
    let msg = err.message;
    if (err instanceof Anthropic.AuthenticationError) msg = "That API key didn't work. Click 'API key' to change it.";
    else if (err instanceof Anthropic.RateLimitError) msg = "Too many requests right now. Wait a moment and try again.";
    bubble.textContent = `Error: ${msg}`;
  }
  busy = false;
}

async function lookAtTab() {
  if (busy) return;
  log.innerHTML = "";
  history = [];
  try {
    const screenshot = await captureTab();
    await ask("", screenshot);
  } catch {
    addBubble("a", "Couldn't capture this tab. Chrome blocks screenshots of some pages (like chrome:// pages and the Web Store). Try a normal web page.");
  }
}

document.getElementById("look").onclick = lookAtTab;
document.getElementById("key").onclick = showKeyForm;

keyForm.onsubmit = async (e) => {
  e.preventDefault();
  const key = keyInput.value.trim();
  if (!key) return;
  await chrome.storage.local.set({ apiKey: key });
  keyInput.value = "";
  keyForm.hidden = true;
};

document.getElementById("form").onsubmit = (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || busy) return;
  input.value = "";
  if (history.length === 0) {
    addBubble("a", "Click 'Look at this tab' first.");
    return;
  }
  ask(q);
};

lookAtTab();
