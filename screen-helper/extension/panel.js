const log = document.getElementById("log");
const input = document.getElementById("input");
const accountButton = document.getElementById("account");
const modelSelect = document.getElementById("model");
const effortSelect = document.getElementById("effort");

const EFFORT_LABELS = { low: "Quick", medium: "Normal", high: "Careful", xhigh: "Very careful", max: "Maximum", ultra: "Ultra" };

let models = FALLBACK_MODELS;
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

async function showAccount() {
  const { session } = await chrome.storage.local.get("session");
  accountButton.textContent = session ? "Sign out" : "Sign in with ChatGPT";
  accountButton.title = session?.email ? `Signed in as ${session.email}` : "";
  return session;
}

accountButton.onclick = async () => {
  if (await showAccount()) {
    await chrome.storage.local.remove("session");
    await showAccount();
    addBubble("a", "Signed out.");
    return;
  }
  chrome.runtime.sendMessage({ type: "sign-in" });
  addBubble("a", "A ChatGPT sign-in tab opened. Sign in there, then come back here.");
};

chrome.runtime.onMessage.addListener(async (msg) => {
  if (msg.type !== "signed-in") return;
  await showAccount();
  if (!msg.ok) return addBubble("a", `Sign-in didn't work: ${msg.error}`);
  addBubble("a", `Signed in${msg.email ? ` as ${msg.email}` : ""}. Click 'Look at this tab'.`);
  loadModels();
});

function fillModels(savedModel) {
  modelSelect.innerHTML = "";
  for (const m of models) modelSelect.add(new Option(m.name, m.id));
  if (models.some((m) => m.id === savedModel)) modelSelect.value = savedModel;
}

function fillEfforts(savedEffort) {
  const model = models.find((m) => m.id === modelSelect.value);
  effortSelect.innerHTML = "";
  for (const e of model?.efforts ?? []) {
    const label = EFFORT_LABELS[e] ?? e;
    effortSelect.add(new Option(e === model.defaultEffort ? `${label} (default)` : label, e));
  }
  effortSelect.value = model?.efforts.includes(savedEffort) ? savedEffort : model?.defaultEffort ?? "";
}

async function loadModels() {
  const { model, effort } = await chrome.storage.local.get(["model", "effort"]);
  try {
    const session = await getSession();
    if (session) {
      const res = await fetch(`${CODEX_API}/models?client_version=${AUTH.clientVersion}`, {
        credentials: "omit",
        headers: await codexHeaders(session),
      });
      if (res.ok) {
        const live = (await res.json()).models
          ?.filter((m) => m.visibility === "list" && (m.input_modalities ?? ["image"]).includes("image"))
          .map((m) => ({
            id: m.slug,
            name: m.display_name ?? m.slug,
            efforts: (m.supported_reasoning_levels ?? []).map((r) => r.effort),
            defaultEffort: m.default_reasoning_level,
            instructions: m.base_instructions,
          }));
        if (live?.length) models = live;
      }
    }
  } catch {}
  fillModels(model);
  fillEfforts(effort);
}

modelSelect.onchange = () => {
  fillEfforts(effortSelect.value);
  chrome.storage.local.set({ model: modelSelect.value, effort: effortSelect.value });
};
effortSelect.onchange = () => chrome.storage.local.set({ effort: effortSelect.value });

async function captureTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
}

async function* sseEvents(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) >= 0) {
      const chunk = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      const data = chunk.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
      if (!data || data === "[DONE]") continue;
      try { yield JSON.parse(data); } catch {}
    }
  }
}

async function ask(content) {
  const session = await getSession().catch((err) => {
    addBubble("a", err.message);
    return undefined;
  });
  if (session === undefined) return;
  if (!session) {
    addBubble("a", "Click 'Sign in with ChatGPT' first.");
    return;
  }
  busy = true;
  const bubble = addBubble("a", "Thinking…");
  const model = models.find((m) => m.id === modelSelect.value);
  const userMessage = { type: "message", role: "user", content };
  let answer = "";

  try {
    const res = await fetch(`${CODEX_API}/responses`, {
      method: "POST",
      credentials: "omit",
      headers: { ...(await codexHeaders(session)), "content-type": "application/json", accept: "text/event-stream", session_id: crypto.randomUUID() },
      body: JSON.stringify({
        model: modelSelect.value,
        instructions: model?.instructions ?? PROMPT,
        input: [...conversation, userMessage],
        tools: [],
        tool_choice: "auto",
        parallel_tool_calls: false,
        reasoning: effortSelect.value ? { effort: effortSelect.value } : undefined,
        store: false,
        stream: true,
      }),
    });
    if (res.status === 401) {
      await chrome.storage.local.remove("session");
      await showAccount();
      throw new Error("Your ChatGPT sign-in expired. Click 'Sign in with ChatGPT' again.");
    }
    if (!res.ok) throw new Error(`ChatGPT said ${res.status}: ${(await res.text()).slice(0, 300)}`);

    for await (const ev of sseEvents(res)) {
      if (ev.type === "response.output_text.delta") {
        answer += ev.delta;
        bubble.textContent = answer;
        log.scrollTop = log.scrollHeight;
      }
      if (ev.type === "response.failed" || ev.type === "error") {
        throw new Error(ev.response?.error?.message ?? ev.error?.message ?? ev.message ?? "ChatGPT error");
      }
    }
    if (!answer) throw new Error("No answer came back. Try again.");
    conversation.push(userMessage, { type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] });
  } catch (err) {
    bubble.textContent = `Error: ${err.message}`;
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
    { type: "input_text", text: PROMPT },
    { type: "input_image", image_url: imageUrl },
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
  ask([{ type: "input_text", text: q }]);
};

(async () => {
  const session = await showAccount();
  await loadModels();
  if (session) lookAtTab();
  else addBubble("a", "Click 'Sign in with ChatGPT' to get started.");
})();
