import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";

/** Choose a bot's model: grouped list from the AI, "Other…" to type any model, and a quick Check. */
export function ModelPicker({ providerId, value, onChange }: { providerId: string; value: string | null; onChange: (m: string | null) => void }) {
  const [data, setData] = useState<{ defaultModel: string; groups: { label: string; models: { id: string; label: string }[] }[] } | null>(null);
  const [typing, setTyping] = useState(false);
  const [check, setCheck] = useState<{ ok: boolean; detail: string; ms: number } | "busy" | null>(null);
  useEffect(() => {
    setData(null);
    setCheck(null);
    void api(`models/${providerId}`).then((d) => {
      setData(d);
      const known = d.groups.some((g: any) => g.models.some((m: any) => m.id === value));
      setTyping(Boolean(value) && !known);
    });
  }, [providerId]);
  if (!data) return <p class="muted">Loading models…</p>;
  const run = async () => {
    setCheck("busy");
    try {
      setCheck(await api("models/check", { body: { provider: providerId, model: value ?? data.defaultModel } }));
    } catch (e) {
      setCheck({ ok: false, detail: (e as Error).message, ms: 0 });
    }
  };
  return (
    <div class="field">
      <label>Model</label>
      {!typing ? (
        <select
          value={value ?? ""}
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value;
            if (v === "__other") {
              setTyping(true);
              onChange(null);
            } else onChange(v || null);
            setCheck(null);
          }}
        >
          <option value="">AI's default{data.defaultModel ? ` (${data.defaultModel})` : ""}</option>
          {data.groups.map((g) => (
            <optgroup label={g.label}>
              {g.models.map((m) => (
                <option value={m.id}>
                  {m.label}
                  {m.label !== m.id ? ` · ${m.id}` : ""}
                </option>
              ))}
            </optgroup>
          ))}
          <option value="__other">Other (type a model name)…</option>
        </select>
      ) : (
        <div class="inline">
          <input value={value ?? ""} onInput={(e) => (onChange((e.target as HTMLInputElement).value.trim() || null), setCheck(null))} placeholder="e.g. claude-sonnet-5-5, gpt-5.1-codex, llama3.2:3b" />
          <button class="btn secondary small" onClick={() => setTyping(false)}>
            List
          </button>
        </div>
      )}
      <div class="inline" style={{ marginTop: ".4rem" }}>
        <button class="btn secondary small" disabled={check === "busy"} onClick={run}>
          {check === "busy" ? "Checking…" : "Check this model"}
        </button>
        {check && check !== "busy" ? (
          <span class={`pill ${check.ok ? "ok" : "bad"}`} style={{ whiteSpace: "normal" }}>
            {check.ok ? `Works (${(check.ms / 1000).toFixed(1)} s)` : "Didn't work"}
          </span>
        ) : null}
      </div>
      {check && check !== "busy" && !check.ok ? <p class="help" style={{ color: "var(--danger)" }}>{check.detail}</p> : null}
      <p class="help">Which models you can use depends on your plan or server. Models that pass the check are remembered under “Your models”.</p>
    </div>
  );
}

/** Add your own endpoint: a model server on this phone, your PC (over Tailscale), or any OpenAI-compatible API. */
export function AddEndpoint({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [needsKey, setNeedsKey] = useState(false);
  const [err, setErr] = useState("");
  if (!open)
    return (
      <button class="btn secondary" onClick={() => setOpen(true)}>
        + Add an endpoint (local, PC or API)
      </button>
    );
  return (
    <div class="section">
      <h2>Add an endpoint</h2>
      <p class="help">Any OpenAI-compatible server: Ollama or LM Studio on your PC (e.g. http://my-pc:11434 over Tailscale), a model app on this phone (http://127.0.0.1:port), or a hosted API.</p>
      <div class="field">
        <label>Name</label>
        <input value={label} onInput={(e) => setLabel((e.target as HTMLInputElement).value)} placeholder="e.g. PC Ollama" />
      </div>
      <div class="field">
        <label>Address</label>
        <input value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} placeholder="http://my-pc:11434" />
      </div>
      <label class="toggle">
        <span>Needs an API key</span>
        <input type="checkbox" checked={needsKey} onChange={() => setNeedsKey(!needsKey)} />
      </label>
      {err ? <p class="help" style={{ color: "var(--danger)" }}>{err}</p> : null}
      <div class="inline">
        <button
          class="btn"
          onClick={async () => {
            try {
              await api("endpoints", { body: { label, baseUrl: url, needsKey } });
              setOpen(false);
              setLabel("");
              setUrl("");
              onAdded();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
        >
          Add
        </button>
        <button class="btn secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
