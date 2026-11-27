import { useEffect, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { api } from "./api.ts";
import type { Bot, Provider } from "./types.ts";
import { IconBack } from "./icons.tsx";
import { Routines } from "./routines.tsx";
import { Calendars } from "./calendars.tsx";
import { AddEndpoint, ModelPicker } from "./models.tsx";
import { CallSettings } from "./call.tsx";
import { loadAppearance, saveAppearance, TEXT_SIZES, type Appearance } from "./appearance.ts";

export const toast = (msg: string) => {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

const run = (fn: () => Promise<unknown>, ok?: string) => async () => {
  try {
    await fn();
    if (ok) toast(ok);
  } catch (e) {
    toast(`⚠️ ${(e as Error).message}`);
  }
};

const val = (e: Event) => (e.target as HTMLInputElement).value;

function useLoad<T>(path: string, deps: unknown[] = []): [T | null, () => void, string | null] {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => api<T>(path).then((d) => (setData(d), setErr(null))).catch((e) => setErr(e.message));
  useEffect(() => void load(), deps);
  return [data, load, err];
}

// ---------------- AI ----------------
function ProviderRow({ p, isDefault, reload }: { p: Provider; isDefault: boolean; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? "");
  const [model, setModel] = useState(p.defaultModel);
  const [runOn, setRunOn] = useState(p.runOn ?? "computer");
  const [computerUrl, setComputerUrl] = useState(p.computerUrl ?? "");
  const [computerToken, setComputerToken] = useState("");
  const isCli = false;
  const save = run(async () => {
    const body: any = { enabled: true, defaultModel: model };
    if (key) body.key = key;
    if (p.kind === "openai") body.baseUrl = baseUrl;
    if (isCli) Object.assign(body, { runOn, computerUrl, ...(computerToken ? { computerToken } : {}) });
    await api(`settings/providers/${p.id}`, { method: "PUT", body });
    setKey("");
    reload();
  }, "Saved");
  return (
    <div class="section">
      <div class="inline" style={{ justifyContent: "space-between" }}>
        <div>
          <strong>{p.label}</strong> {p.free ? <span class="pill ok">free option</span> : null} {p.enabled ? <span class="pill ok">on</span> : <span class="pill">off</span>}{" "}
          {isDefault ? <span class="pill">default</span> : null}
        </div>
        <button class="btn secondary small" onClick={() => setOpen(!open)}>
          {open ? "Close" : p.enabled ? "Edit" : "Set up"}
        </button>
      </div>
      {open ? (
        <div style={{ marginTop: 10 }}>
          {p.note ? <p class="help">{p.note}</p> : null}
          {p.needsKey || p.id === "local" ? (
            <div class="field">
              <label>API key {p.hasKey ? "(saved — type to replace)" : p.needsKey ? "" : "(optional)"}</label>
              <input type="password" value={key} onInput={(e) => setKey(val(e))} placeholder={p.hasKey ? "••••••••" : "Paste key"} autocomplete="off" />
            </div>
          ) : null}
          {p.kind === "openai" ? (
            <div class="field">
              <label>Address (OpenAI-compatible)</label>
              <input value={baseUrl} onInput={(e) => setBaseUrl(val(e))} />
            </div>
          ) : null}
          {isCli ? (
            <>
              <div class="field">
                <label>Run on</label>
                <select value={runOn} onChange={(e) => setRunOn(val(e))}>
                  <option value="computer">My computer (companion app, reliable)</option>
                  <option value="phone">This phone (experimental)</option>
                </select>
              </div>
              {runOn === "computer" ? (
                <>
                  <div class="field">
                    <label>Computer companion address (e.g. http://my-pc:8790 over Tailscale)</label>
                    <input value={computerUrl} onInput={(e) => setComputerUrl(val(e))} />
                  </div>
                  <div class="field">
                    <label>Companion pairing token</label>
                    <input type="password" value={computerToken} onInput={(e) => setComputerToken(val(e))} placeholder="Shown by the companion when it starts" />
                  </div>
                </>
              ) : (
                <p class="help">On-phone mode downloads the official program to the phone. Sign in once when asked. If it doesn't work on your phone, use "My computer".</p>
              )}
            </>
          ) : null}
          <div class="field">
            <label>Default model</label>
            <div class="inline">
              <input value={model} onInput={(e) => setModel(val(e))} list={`models-${p.id}`} />
              <datalist id={`models-${p.id}`}>
                {p.models.map((m) => (
                  <option value={m} />
                ))}
              </datalist>
              {!isCli ? (
                <button class="btn secondary small" onClick={run(async () => (await api(`settings/providers/${p.id}/models`, { body: {} }), reload()), "Model list updated")}>
                  Refresh list
                </button>
              ) : null}
            </div>
          </div>
          <div class="inline">
            <button class="btn" onClick={save}>
              Save &amp; turn on
            </button>
            {p.enabled ? (
              <>
                <button class="btn secondary" onClick={run(async () => (await api("settings/general", { method: "PUT", body: { defaultProvider: p.id } }), reload()), "Now the default")}>
                  Make default
                </button>
                <button class="btn secondary" onClick={run(async () => (await api(`settings/providers/${p.id}`, { method: "PUT", body: { enabled: false } }), reload()))}>
                  Turn off
                </button>
              </>
            ) : null}
            {(p as any).custom ? (
              <>
                <button class="btn secondary" onClick={run(async () => (confirm(`Remove “${p.label}”?`) && (await api(`endpoints/${p.id}`, { method: "DELETE" })), reload()))}>
                  Remove
                </button>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const SUB_LOOK: Record<string, { color: string; mark: string }> = {
  claude: { color: "#D97757", mark: "✳︎" },
  chatgpt: { color: "#10A37F", mark: "◎" },
  gemini: { color: "#4C8DF6", mark: "✦" },
};

function SubscriptionCard({ sub, p, isDefault, reload }: { sub: any; p: Provider; isDefault: boolean; reload: () => void }) {
  const [code, setCode] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [computerUrl, setComputerUrl] = useState(p.computerUrl ?? "");
  const [computerToken, setComputerToken] = useState("");
  const [runOn, setRunOn] = useState(p.runOn ?? "phone");
  const [model, setModel] = useState(p.defaultModel);
  const look = SUB_LOOK[sub.id] ?? { color: "#666", mark: "•" };
  const busy = sub.stage === "installing" || sub.stage === "signing-in";
  const signedIn = sub.stage === "signed-in";
  const stageText: Record<string, string> = {
    "not-installed": "Not signed in",
    installed: "Not signed in",
    installing: "Getting ready…",
    "signing-in": "Signing in…",
    "signed-in": "Signed in",
    error: "Needs attention",
  };
  return (
    <div class="section">
      <div class="inline" style={{ flexWrap: "nowrap" }}>
        <div class="avatar" style={{ background: look.color, width: "2.8rem", height: "2.8rem", fontSize: "1.3rem" }}>
          {look.mark}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <strong>{sub.label}</strong> {isDefault ? <span class="pill">default</span> : null}
          <div class="muted" style={{ fontSize: ".8rem" }}>
            <span class={`pill ${signedIn ? "ok" : sub.stage === "error" ? "bad" : busy ? "warn" : ""}`}>{stageText[sub.stage]}</span> · {sub.program} by {sub.company}
          </div>
        </div>
      </div>
      <p class="help" style={{ marginTop: ".6rem" }}>
        {p.note}
      </p>
      {sub.message ? <p style={{ fontSize: ".88rem", margin: ".2rem 0 .6rem" }}>{sub.message}</p> : null}
      {sub.stage === "installing" && sub.progress != null ? (
        <div style={{ height: ".45rem", background: "var(--panel2)", borderRadius: "999px", overflow: "hidden", marginBottom: ".6rem" }}>
          <div style={{ width: `${sub.progress}%`, height: "100%", background: "linear-gradient(90deg, var(--accent), var(--accent2))" }} />
        </div>
      ) : null}
      {sub.stage === "signing-in" ? (
        <div class="section" style={{ background: "var(--panel2)", boxShadow: "none" }}>
          {sub.loginUrl ? (
            <p style={{ margin: "0 0 .5rem" }}>
              <a href={sub.loginUrl} target="_blank" rel="noopener">
                Open the {sub.label} sign-in page
              </a>{" "}
              if it didn't open by itself.
            </p>
          ) : (
            <p class="muted">Waiting for the sign-in page…</p>
          )}
          {sub.needsCode || sub.id !== "chatgpt" ? (
            <div class="field">
              <label>After signing in, {sub.label} shows a code: copy it, paste it here, tap Submit</label>
              <div class="inline">
                <input value={code} onInput={(e) => setCode(val(e))} placeholder="Paste code here" autocomplete="off" />
                <button class="btn small" disabled={!code.trim()} onClick={run(async () => (await api(`subs/${sub.id}/code`, { body: { code } }), setCode("")))}>
                  Submit
                </button>
              </div>
            </div>
          ) : (
            <p class="help">Finish signing in on the page that opened; this updates by itself.</p>
          )}
          {sub.log ? (
            <details>
              <summary class="muted" style={{ fontSize: ".8rem" }}>
                Details
              </summary>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: ".72rem", maxHeight: "10rem", overflow: "auto" }}>{sub.log}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
      {sub.stage === "error" && sub.log ? (
        <details style={{ marginBottom: ".6rem" }}>
          <summary class="muted" style={{ fontSize: ".8rem" }}>
            Details
          </summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: ".72rem", maxHeight: "12rem", overflow: "auto" }}>{sub.log}</pre>
          <button class="btn secondary small" onClick={run(async () => navigator.clipboard.writeText(`${sub.message}\n\n${sub.log}`), "Copied")}>
            Copy details
          </button>
        </details>
      ) : null}
      <div class="inline">
        {!signedIn && !busy ? (
          <button class="btn" onClick={run(async () => api(`subs/${sub.id}/signin`, { body: {} }))}>
            Sign in with {sub.label}
          </button>
        ) : null}
        {busy ? (
          <button class="btn secondary" onClick={run(async () => api(`subs/${sub.id}/cancel`, { body: {} }))}>
            Cancel
          </button>
        ) : null}
        {signedIn && !isDefault ? (
          <button class="btn" onClick={run(async () => (await api("settings/general", { method: "PUT", body: { defaultProvider: p.id } }), reload()), `${sub.label} is now the default`)}>
            Make default
          </button>
        ) : null}
        {signedIn ? (
          <button class="btn secondary" onClick={run(async () => api(`subs/${sub.id}/signout`, { body: {} }), "Signed out")}>
            Sign out
          </button>
        ) : null}
        <button class="btn secondary small" onClick={() => setAdvanced(!advanced)}>
          {advanced ? "Hide options" : "Options"}
        </button>
      </div>
      {advanced ? (
        <div style={{ marginTop: ".8rem" }}>
          <div class="field">
            <label>Default model</label>
            <select value={model} onChange={(e) => setModel(val(e))}>
              {p.models.map((m) => (
                <option value={m}>{m === "default" ? `${sub.label}'s default` : m}</option>
              ))}
            </select>
          </div>
          <div class="field">
            <label>Where it runs</label>
            <select value={runOn} onChange={(e) => setRunOn(val(e))}>
              <option value="phone">This phone (your computer as backup)</option>
              <option value="computer">Always my computer</option>
            </select>
          </div>
          <div class="field">
            <label>Computer backup: companion address (e.g. http://my-pc:8790 over Tailscale)</label>
            <input value={computerUrl} onInput={(e) => setComputerUrl(val(e))} placeholder="Optional" />
          </div>
          <div class="field">
            <label>Companion pairing token</label>
            <input type="password" value={computerToken} onInput={(e) => setComputerToken(val(e))} placeholder="Shown by the companion when it starts" />
          </div>
          <p class="help">On the computer, sign in once by running the official program there (see companion/README.md).</p>
          <div class="inline">
            <button
              class="btn secondary"
              onClick={run(async () => {
                await api(`settings/providers/${p.id}`, { method: "PUT", body: { defaultModel: model, runOn, computerUrl, ...(computerToken ? { computerToken } : {}), ...(runOn === "computer" && computerUrl ? { enabled: true } : {}) } });
                setComputerToken("");
                reload();
              }, "Saved")}
            >
              Save options
            </button>
            {sub.stage !== "not-installed" && !busy ? (
              <button class="btn secondary" onClick={run(async () => api(`subs/${sub.id}/uninstall`, { body: {} }), "Removed")}>
                Remove from phone
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AiTab() {
  const [s, reload] = useLoad<any>("settings");
  const [subs, reloadSubs] = useLoad<any[]>("subs");
  useEffect(() => {
    const t = setInterval(() => {
      reloadSubs();
    }, 1500);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (subs?.some((x) => x.stage === "signed-in")) reload();
  }, [subs?.map((x) => x.stage).join()]);
  if (!s || !subs) return <p class="muted">Loading…</p>;
  const subProviders = s.providers.filter((p: Provider) => p.kind === "subscription");
  const others = s.providers.filter((p: Provider) => p.kind !== "subscription");
  return (
    <>
      <h2 style={{ fontSize: "1rem", margin: ".2rem 0 .3rem" }}>Your subscriptions</h2>
      <p class="help">Sign in with your own account. No API keys: each uses the company's official app and login page. The first sign-in downloads it to your phone (about 170 MB; Wi-Fi recommended).</p>
      {subs.map((sub) => {
        const p = subProviders.find((x: Provider) => x.id === sub.id);
        return p ? <SubscriptionCard key={sub.id} sub={sub} p={p} isDefault={s.defaultProvider === p.id} reload={reload} /> : null;
      })}
      <h2 style={{ fontSize: "1rem", margin: "1.2rem 0 .3rem" }}>Other models</h2>
      <p class="help">Optional extras with an API key, free services, or local models on your phone, PC or another device. Add as many endpoints as you like; each bot can use a different one.</p>
      {others.map((p: Provider) => (
        <ProviderRow p={p} key={p.id} isDefault={s.defaultProvider === p.id} reload={reload} />
      ))}
      <AddEndpoint onAdded={reload} />
    </>
  );
}

// ---------------- Connected apps ----------------
function AppsTab() {
  const [setup, setSetup] = useState<{ slug: string; name: string } | null>(null);
  const [s, reloadS] = useLoad<any>("settings");
  const [key, setKey] = useState("");
  const [search, setSearch] = useState("");
  const [kits, setKits] = useState<any[]>([]);
  const [conns, reloadConns] = useLoad<any[]>("composio/connections", [s?.composio?.connected]);
  const connected = s?.composio?.connected;
  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(() => api(`composio/toolkits?search=${encodeURIComponent(search)}`).then((r) => setKits(r.items)).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [search, connected]);
  if (!s) return <p class="muted">Loading…</p>;
  if (!connected)
    return (
      <div class="section">
        <h2>Connect Composio</h2>
        <p class="help">
          Composio links your bots to 500+ services (Gmail, Google Drive, Calendar, Outlook, Slack, Notion…). Create a free project at <a href="https://dashboard.composio.dev" target="_blank">dashboard.composio.dev</a>, open the project's API Keys page and copy the key that starts with <code>ak_</code>.
        </p>
        <div class="inline">
          <input type="password" value={key} onInput={(e) => setKey(val(e))} placeholder="ak_…" />
          <button class="btn" onClick={run(async () => (await api("composio/key", { body: { key } }), setKey(""), reloadS()), "Composio connected")}>
            Connect
          </button>
        </div>
      </div>
    );
  return (
    <>
      <div class="section">
        <h2>Your connected accounts</h2>
        {conns?.length ? (
          conns.map((c) => (
            <div class="toggle">
              <span>
                <strong>{c.toolkit}</strong> {c.alias ? `· ${c.alias}` : ""} <span class={`pill ${c.status === "ACTIVE" ? "ok" : "warn"}`}>{c.status.toLowerCase()}</span>
              </span>
              <button class="btn secondary small" onClick={run(async () => (await api(`composio/connections/${c.id}`, { method: "DELETE" }), reloadConns()), "Disconnected")}>
                Disconnect
              </button>
            </div>
          ))
        ) : (
          <p class="help">Nothing connected yet. Pick an app below, or just ask a bot ("connect my Gmail").</p>
        )}
        <div class="inline" style={{ marginTop: 8 }}>
          <button class="btn secondary small" onClick={reloadConns}>
            Refresh
          </button>
          <button class="btn secondary small" onClick={run(async () => (await api("composio/key", { method: "DELETE" }), reloadS()))}>
            Remove Composio key
          </button>
        </div>
      </div>
      {(conns ?? []).some((c) => c.toolkit === "googlecalendar") ? <Calendars /> : null}
      {setup ? <AppSignInSetup slug={setup.slug} name={setup.name} onClose={() => (setSetup(null), reloadConns())} /> : null}
      <div class="section">
        <h2>Add an app</h2>
        <input value={search} onInput={(e) => setSearch(val(e))} placeholder="Search: gmail, drive, outlook, ebay, canva…" />
        {/gum ?tree/i.test(search) && !kits.some((k) => /gumtree/i.test(k.slug)) ? (
          <p class="help">
            Gumtree has no app connection (no Composio toolkit, no public API). Your bots use Gumtree through the <b>background browser</b> with your own login instead — just ask, e.g. “search Gumtree for a road bike under $300 near me”. Posting or messaging always asks you first.
          </p>
        ) : null}
        <div class="grid" style={{ marginTop: 10 }}>
          {kits.map((k) => (
            <button
              class="app-tile"
              onClick={async () => {
                const alias = (conns ?? []).some((c) => c.toolkit === k.slug) ? prompt(`Name this extra ${k.name} account (e.g. work, personal):`) ?? undefined : undefined;
                try {
                  const r = await api("composio/link", { body: { toolkit: k.slug, alias } });
                  if (!(window as any).MausDroidNative) window.open(r.url, "_blank");
                  toast("Finish signing in, then come back and tap Refresh");
                } catch (e) {
                  // Apps Composio doesn't sign in for (e.g. eBay) need your own developer app first.
                  if (/Set up sign-in|own developer app|does not manage auth/i.test((e as Error).message)) setSetup({ slug: k.slug, name: k.name });
                  else toast(`⚠️ ${(e as Error).message}`);
                }
              }}
            >
              {k.logo ? <img src={k.logo} alt="" /> : null}
              <strong>{k.name}</strong>
              <span class="muted" style={{ fontSize: 12 }}>
                {(k.description ?? "").slice(0, 70)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

/** Your own sign-in setup for an app Composio doesn't sign in for (e.g. eBay): its developer keys go to Composio. */
function AppSignInSetup({ slug, name, onClose }: { slug: string; name: string; onClose: () => void }) {
  const [d, setD] = useState<any | null>(null);
  const [mode, setMode] = useState("");
  const [vals, setVals] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    api(`composio/toolkits/${encodeURIComponent(slug)}/auth`)
      .then((r) => {
        setD(r);
        const first = r.schemes.find((x: any) => x.mode === "OAUTH2") ?? r.schemes[0];
        setMode(first?.mode ?? "");
        setVals(Object.fromEntries((first?.fields ?? []).filter((f: any) => f.default).map((f: any) => [f.name, f.default])));
      })
      .catch((e) => setD({ error: (e as Error).message }));
  }, [slug]);
  const scheme = d?.schemes?.find((x: any) => x.mode === mode);
  const save = async () => {
    setBusy(true);
    try {
      await api(`composio/toolkits/${encodeURIComponent(slug)}/auth`, { body: { mode, credentials: vals } });
      setDone(true);
      toast("Saved in Composio ✓");
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
    setBusy(false);
  };
  const connect = async () => {
    try {
      const r = await api("composio/link", { body: { toolkit: slug } });
      if (!(window as any).MausDroidNative) window.open(r.url, "_blank");
      toast("Finish signing in, then come back and tap Refresh");
      onClose();
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
  };
  return (
    <div class="section">
      <h2>Set up sign-in: {name}</h2>
      {!d ? <p class="muted">Loading…</p> : d.error ? <p class="help">⚠️ {d.error}</p> : null}
      {d && !d.error ? (
        <>
          <p class="help">
            Composio doesn't sign in to {name} for you: it needs your own (free) {name} developer app. Enter its keys here once — they're stored in your Composio project, not on this phone — then connect your {name} account as usual.
          </p>
          {slug === "ebay" ? (
            <ol class="help" style={{ paddingLeft: "1.1rem" }}>
              <li>
                Sign in at <a href="https://developer.ebay.com" target="_blank" rel="noopener">developer.ebay.com</a> with your eBay account (join the developer program if asked — it's free).
              </li>
              <li>Open <b>Application Keys</b> and create a <b>Production</b> keyset: the <b>App ID</b> is the client ID and the <b>Cert ID</b> is the client secret.</li>
              <li>
                In <b>User Tokens</b>, add an <b>eBay Redirect URL</b> (RuName). Set its “auth accepted URL” to Composio's sign-in return address (Composio shows it in the field below if it needs it), and copy the RuName if a field asks for it.
              </li>
            </ol>
          ) : null}
          {d.schemes.length > 1 ? (
            <div class="field">
              <label>Sign-in type</label>
              <select value={mode} onChange={(e) => setMode(val(e))}>
                {d.schemes.map((x: any) => (
                  <option value={x.mode}>{x.mode}</option>
                ))}
              </select>
            </div>
          ) : null}
          {(scheme?.fields ?? []).map((f: any) => (
            <div class="field">
              <label>
                {f.label}
                {f.required ? "" : " (optional)"}
              </label>
              <input type={f.secret ? "password" : "text"} value={vals[f.name] ?? ""} onInput={(e) => setVals({ ...vals, [f.name]: val(e) })} autocomplete="off" />
              {f.description ? <p class="help">{f.description}</p> : null}
            </div>
          ))}
          <div class="inline">
            {!done ? (
              <button class="btn" disabled={busy || (scheme?.fields ?? []).some((f: any) => f.required && !vals[f.name]?.trim())} onClick={save}>
                Save sign-in setup
              </button>
            ) : (
              <button class="btn" onClick={connect}>
                Connect {name} now
              </button>
            )}
            <button class="btn secondary" onClick={onClose}>
              Close
            </button>
          </div>
          {d.yours && !done ? <p class="help">You already have a setup ({d.yours}); saving replaces it.</p> : null}
        </>
      ) : null}
    </div>
  );
}

// ---------------- Skills ----------------
function SkillsTab() {
  const [skills, reload] = useLoad<any[]>("skills");
  const [q, setQ] = useState("");
  const [market, setMarket] = useState<any[] | null>(null);
  const [repo, setRepo] = useState("");
  const [repoSkills, setRepoSkills] = useState<{ repo: string; skills: string[] } | null>(null);
  return (
    <>
      <div class="section">
        <h2>Installed skills</h2>
        <p class="help">Skills teach your bots how to do specific jobs. Bots read them when a task matches.</p>
        {skills?.length ? (
          skills.map((s) => (
            <div class="toggle">
              <span>
                <strong>{s.name}</strong>
                <br />
                <span class="muted" style={{ fontSize: 13 }}>
                  {s.description}
                </span>
              </span>
              <button class="btn secondary small" onClick={run(async () => (await api(`skills/${encodeURIComponent(s.name)}`, { method: "DELETE" }), reload()))}>
                Remove
              </button>
            </div>
          ))
        ) : (
          <p class="muted">None yet.</p>
        )}
      </div>
      <div class="section">
        <h2>GitHub marketplace</h2>
        <div class="inline">
          <input value={q} onInput={(e) => setQ(val(e))} placeholder="Search skills on GitHub" />
          <button class="btn secondary" onClick={run(async () => setMarket(await api(`skills/market?q=${encodeURIComponent(q)}`)))}>
            Search
          </button>
        </div>
        {market?.map((m) => (
          <div class="toggle">
            <span>
              <strong>{m.repo}</strong> {m.stars != null ? <span class="pill">★ {m.stars}</span> : null}
              <br />
              <span class="muted" style={{ fontSize: 13 }}>
                {m.description}
              </span>
            </span>
            <button class="btn secondary small" onClick={run(async () => setRepoSkills(await api(`skills/repo?ref=${encodeURIComponent(m.repo)}`)))}>
              Browse
            </button>
          </div>
        ))}
        <div class="field" style={{ marginTop: 10 }}>
          <label>Or paste a GitHub link (owner/repo or a folder link)</label>
          <div class="inline">
            <input value={repo} onInput={(e) => setRepo(val(e))} placeholder="anthropics/skills" />
            <button class="btn secondary" onClick={run(async () => setRepoSkills(await api(`skills/repo?ref=${encodeURIComponent(repo)}`)))}>
              Look
            </button>
          </div>
        </div>
        {repoSkills ? (
          <div class="section">
            <h2>{repoSkills.repo}</h2>
            {repoSkills.skills.map((d) => (
              <div class="toggle">
                <span>{d}</span>
                <button class="btn small" onClick={run(async () => (await api("skills/install", { body: { ref: repoSkills.repo, only: [d] } }), reload()), "Installed")}>
                  Install
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}

// ---------------- Routines & alerts ----------------
function RoutinesTab({ bots }: { bots: Bot[] }) {
  const [alerts, reloadAlerts] = useLoad<any[]>("alerts");
  const [s, reloadS] = useLoad<any>("settings");
  return (
    <>
      <Routines bots={bots} />
      <div class="section">
        <h2>Quiet hours</h2>
        <p class="help">Only approvals and urgent alerts make a sound during quiet hours. Everything else waits in the list below.</p>
        {s ? (
          <div class="inline">
            <input type="time" value={s.quietHours?.start ?? "21:30"} id="qs" />
            <input type="time" value={s.quietHours?.end ?? "06:30"} id="qe" />
            <button
              class="btn secondary small"
              onClick={run(async () => {
                const start = (document.getElementById("qs") as HTMLInputElement).value;
                const end = (document.getElementById("qe") as HTMLInputElement).value;
                await api("settings/general", { method: "PUT", body: { quietHours: { start, end } } });
                reloadS();
              }, "Quiet hours saved")}
            >
              Save
            </button>
            {s.quietHours ? (
              <button class="btn secondary small" onClick={run(async () => (await api("settings/general", { method: "PUT", body: { quietHours: null } }), reloadS()), "Quiet hours off")}>
                Turn off
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div class="section">
        <div class="inline" style={{ justifyContent: "space-between" }}>
          <h2>Recent alerts</h2>
          <button class="btn secondary small" onClick={run(async () => (await api("alerts/read", { body: {} }), reloadAlerts()))}>
            Mark all read
          </button>
        </div>
        {(alerts ?? []).slice(0, 50).map((a) => (
          <div style={{ padding: "6px 0", borderBottom: "1px solid var(--line)", opacity: a.read ? 0.65 : 1 }}>
            <strong>{a.title}</strong> <span class="muted" style={{ fontSize: 12 }}>{new Date(a.at).toLocaleString()}</span>
            <div style={{ fontSize: 14 }}>{a.body}</div>
          </div>
        ))}
      </div>
    </>
  );
}

// ---------------- Phone: Tailscale, updates, background ----------------
/** Notification reading: apps you choose (e.g. Meta's Muse), read-only. */
function NotificationReading() {
  const [d, reload] = useLoad<any>("notifications/phone");
  if (!d) return null;
  const n = d.native;
  const chosen: string[] = n?.packages ?? [];
  const seen: Record<string, string> = n?.seen ?? {};
  const museGuess = Object.entries(seen).filter(([pkg, label]) => /muse/i.test(`${label} ${pkg}`)).map(([pkg]) => pkg);
  const isOn = (pkg: string) => (chosen.length ? chosen.includes(pkg) : museGuess.includes(pkg));
  const toggle = (pkg: string) => run(async () => (await api("notifications/watch", { method: "PUT", body: { packages: isOn(pkg) ? (chosen.length ? chosen : museGuess).filter((p) => p !== pkg) : [...(chosen.length ? chosen : museGuess), pkg] } }), reload()))();
  const total = Object.values(d.counts ?? {}).reduce((a: number, b: any) => a + Number(b), 0);
  return (
    <div class="section">
      <h2>Notification reading</h2>
      <p class="help">
        MausDroid reads notifications from the apps you choose — by default Meta's <b>Muse</b> — so it can learn what a good assistant anticipates, start routines, and let bots look at them. Read-only: it never acts in those apps. Android only lets apps read notifications still in your notification shade and new ones; dismissed ones can't be read by any app.
      </p>
      {!n ? (
        <p class="help">Notification reading needs the Android app.</p>
      ) : (
        <>
          <div class="toggle">
            <span>Access {n.access ? <span class="pill ok">allowed</span> : <span class="pill warn">not allowed yet</span>}</span>
            {!n.access ? (
              <button class="btn small" onClick={run(async () => api("notifications/allow", { body: {} }))}>
                Allow
              </button>
            ) : (
              <button class="btn secondary small" onClick={run(async () => (await api("notifications/rescan", { body: {} }), setTimeout(reload, 2500)), "Reading what's in your notifications…")}>
                Read pending notifications
              </button>
            )}
          </div>
          {!n.access ? <p class="help">Tap Allow, find <b>MausDroid (notifications you choose)</b> in the list and switch it on, then come back.</p> : null}
          <p class="help" style={{ marginTop: ".5rem" }}>Apps to read {chosen.length ? "" : "(none chosen: any app called Muse)"}:</p>
          <div class="seg" style={{ flexWrap: "wrap" }}>
            {Object.entries(seen)
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([pkg, label]) => (
                <button class={isOn(pkg) ? "on" : ""} onClick={() => toggle(pkg)} title={pkg}>
                  {label}
                </button>
              ))}
          </div>
          {!Object.keys(seen).length && n.access ? <p class="help">Apps appear here as they send notifications.</p> : null}
          <p class="help">
            Read so far: {total || "none"}
            {Object.entries(d.counts ?? {}).length ? ` (${Object.entries(d.counts).map(([a, c]) => `${a}: ${c}`).join(", ")})` : ""}.
          </p>
          <button class="btn secondary small" disabled={!Object.keys(d.counts ?? {}).some((a) => /muse/i.test(a))} onClick={run(async () => api("notifications/review", { body: {} }), "Improver is reviewing them — see its chat")}>
            Review Muse notifications with Improver
          </button>
          {d.recent?.length ? (
            <details style={{ marginTop: ".5rem" }}>
              <summary class="muted">Latest notifications read</summary>
              {d.recent.slice(0, 15).map((x: any) => (
                <p style={{ fontSize: ".85rem" }}>
                  <b>{x.app}</b> · {new Date(x.postedAt).toLocaleString()} {x.pending ? "(pending)" : ""}
                  <br />
                  {x.title} — {x.text.slice(0, 200)}
                </p>
              ))}
            </details>
          ) : null}
        </>
      )}
    </div>
  );
}

function PhoneTab() {
  const [s, reloadS] = useLoad<any>("settings");
  const [ts, reloadTs] = useLoad<any>("tailscale");
  const [upd, reloadUpd] = useLoad<any>("update");
  const [sys, reloadSys] = useLoad<any>("system");
  const [authKey, setAuthKey] = useState("");
  const [host, setHost] = useState("");
  useEffect(() => {
    const t = setInterval(() => (reloadTs(), reloadUpd()), 5000);
    return () => clearInterval(t);
  }, []);
  if (!s) return <p class="muted">Loading…</p>;
  return (
    <>
      <NotificationReading />
      <div class="section">
        <h2>Keep working in the background</h2>
        <p class="help">So bots keep running while you use other apps or the screen is off. On Xiaomi/POCO (HyperOS) all three matter.</p>
        <div class="toggle">
          <span>Battery: no restrictions {sys?.ignoringBatteryOptimizations ? <span class="pill ok">done</span> : <span class="pill warn">needed</span>}</span>
          <button class="btn secondary small" onClick={run(async () => (await api("system/battery", { body: {} }), setTimeout(reloadSys, 4000)))}>
            Open
          </button>
        </div>
        <div class="toggle">
          <span>Autostart (HyperOS)</span>
          <button class="btn secondary small" onClick={run(async () => api("system/autostart", { body: {} }))}>
            Open
          </button>
        </div>
        <div class="toggle">
          <span>Notifications {sys?.notificationsAllowed ? <span class="pill ok">on</span> : <span class="pill warn">off</span>}</span>
          <button class="btn secondary small" onClick={run(async () => (await api("system/notifications", { body: {} }), setTimeout(reloadSys, 4000)))}>
            Open
          </button>
        </div>
        <p class="help">Tip: also lock MausDroid in Recent apps (pull the card down → lock icon).</p>
      </div>
      <LocationSection />
      <div class="section">
        <h2>Tailscale (built in)</h2>
        <p class="help">
          MausDroid joins your tailnet by itself — you never need to open the Tailscale app. Create an auth key at <a href="https://login.tailscale.com/admin/settings/keys" target="_blank">Tailscale → Settings → Keys</a> (tick "Reusable"), paste it once.
        </p>
        <div class="toggle">
          <span>
            Status: <strong>{ts?.state ?? "…"}</strong> {ts?.ips?.length ? `· ${ts.ips[0]}` : ""} {ts?.dns_name ? `· ${ts.dns_name}` : ""}
          </span>
        </div>
        {ts?.auth_url ? (
          <p>
            Needs sign-in: <a href={ts.auth_url} target="_blank">open Tailscale login</a>
          </p>
        ) : null}
        <div class="field">
          <label>Auth key {s.tailscale.hasAuthKey ? "(saved)" : ""}</label>
          <input type="password" value={authKey} onInput={(e) => setAuthKey(val(e))} placeholder={s.tailscale.hasAuthKey ? "••••••" : "tskey-auth-…"} />
        </div>
        <div class="field">
          <label>Name on your tailnet</label>
          <input value={host || s.tailscale.hostname} onInput={(e) => setHost(val(e))} />
        </div>
        <div class="inline">
          <button class="btn" onClick={run(async () => (await api("tailscale", { method: "PUT", body: { enabled: true, hostname: host || s.tailscale.hostname, ...(authKey ? { authKey } : {}) } }), setAuthKey(""), reloadS(), reloadTs()), "Tailscale starting")}>
            {s.tailscale.enabled ? "Save" : "Turn on"}
          </button>
          {s.tailscale.enabled ? (
            <button class="btn secondary" onClick={run(async () => (await api("tailscale", { method: "PUT", body: { enabled: false } }), reloadS(), reloadTs()))}>
              Turn off
            </button>
          ) : null}
        </div>
        {ts?.peers?.length ? (
          <>
            <p class="help" style={{ marginTop: 10 }}>
              Your devices:
            </p>
            {ts.peers.map((p: any) => (
              <div class="muted" style={{ fontSize: 13 }}>
                {p.online ? "🟢" : "⚪"} {p.name} · {p.os} · {p.ips?.[0]}
              </div>
            ))}
          </>
        ) : null}
      </div>
      <div class="section">
        <h2>Updates</h2>
        <p class="help">MausDroid updates itself in the background: new screens and features arrive without reinstalling. A new app file is only needed for rare core changes, and you'd get a one-tap prompt.</p>
        <div class="muted" style={{ fontSize: 13 }}>
          App {upd?.apkVersion ?? "?"} · Engine {upd?.engineVersion ?? "?"} · {upd?.state ?? ""} {upd?.lastChecked ? `· checked ${new Date(upd.lastChecked).toLocaleString()}` : ""}
          {upd?.message ? <div>{upd.message}</div> : null}
          {upd?.appUpdate ? (
            <div>
              📦 App update: {upd.appUpdate.replace(/ Get it from \S+$/, "")}{" "}
              {/https:\/\/\S+\.apk/.test(upd.appUpdate) ? <a href={upd.appUpdate.match(/https:\/\/\S+\.apk/)![0]} target="_blank" rel="noopener">Download the app</a> : null}
            </div>
          ) : null}
        </div>
        <div class="inline" style={{ marginTop: 8 }}>
          <button class="btn secondary" onClick={run(async () => (await api("update/check", { body: {} }), reloadUpd()), "Checked")}>
            Check now
          </button>
          {upd?.available ? (
            <button class="btn" onClick={run(async () => api("update/apply", { body: {} }), "Updating — the app will refresh")}>
              Install {upd.available}
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}

// ---------------- Location ----------------
function LocationSection() {
  const [l, reload] = useLoad<any>("location");
  const state: Record<string, string> = { granted: "allowed", denied: "not allowed", permanently_denied: "blocked in Android settings", not_requested: "not asked yet", unavailable: "unavailable" };
  return (
    <div class="section">
      <h2>Location</h2>
      <p class="help">
        Bots can ask for your location for one task at a time (e.g. "leave-now" reminders). You approve each request (or "always allow" for a bot), a 📍 banner shows who asked, and only a single position is taken — no tracking, nothing kept except who asked and when.
      </p>
      <div class="toggle">
        <span>
          Android permission: <span class={`pill ${l?.permission === "granted" ? "ok" : "warn"}`}>{state[l?.permission] ?? "…"}</span>
        </span>
        {l?.permission !== "granted" ? (
          <button class="btn secondary small" onClick={run(async () => (await api(`system/${l?.permission === "permanently_denied" ? "app" : "location"}`, { body: {} }), setTimeout(reload, 5000)))}>
            {l?.permission === "permanently_denied" ? "Open app settings" : "Allow"}
          </button>
        ) : (
          <button class="btn secondary small" onClick={run(async () => api("system/app", { body: {} }))}>
            Change
          </button>
        )}
      </div>
      {l?.recent?.length ? (
        <>
          <p class="help" style={{ marginTop: ".5rem" }}>
            Recent use:
          </p>
          {l.recent.slice(0, 8).map((u: any) => (
            <div class="muted" style={{ fontSize: ".8rem" }}>
              {new Date(u.at).toLocaleString()} · {u.requester} · {u.outcome}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}

// ---------------- Website & devices ----------------
export function Qr({ text }: { text: string }) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return <div class="qr" dangerouslySetInnerHTML={{ __html: q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }) }} />;
}

function WebsiteTab() {
  const [s, reloadS] = useLoad<any>("settings");
  const [devices, reloadD] = useLoad<any[]>("devices");
  const [relay, setRelay] = useState("");
  const [pw, setPw] = useState("");
  const [code, setCode] = useState("");
  const [linking, setLinking] = useState(false);
  const [linkMsg, setLinkMsg] = useState("");
  const link = async (text: string) => {
    setLinking(true);
    setLinkMsg("Linking…");
    try {
      await api("pair/link", { body: { text } });
      setLinkMsg("✅ Linked — the PC is opening MausDroid. Enter your website password there.");
      setCode("");
      setTimeout(reloadD, 4000);
    } catch (e) {
      setLinkMsg(`⚠️ ${(e as Error).message}`);
    }
    setLinking(false);
  };
  const scan = () => {
    (window as any).mausdroidScan = (text: string | null, error: string | null) => {
      delete (window as any).mausdroidScan;
      if (error) setLinkMsg(`⚠️ ${error}`);
      else if (text) void link(text);
    };
    if (!(window as any).MausDroidShell.scanQr()) setLinkMsg("⚠️ The scanner isn't available on this phone — type the code instead.");
  };
  if (!s) return <p class="muted">Loading…</p>;
  return (
    <>
      <div class="section">
        <h2>Always-on website</h2>
        <p class="help">
          Control your bots from any browser. Uses a free Cloudflare Worker you deploy once (instructions in the MausDroid repo: <code>relay/README.md</code>). The website only passes messages to your phone; your data stays on the phone, and every device must be linked from this phone and know your password.
        </p>
        <div class="field">
          <label>Website address (your Worker URL)</label>
          <input value={relay || s.website.relayUrl || ""} onInput={(e) => setRelay(val(e))} placeholder="https://mausdroid-relay.yourname.workers.dev" />
        </div>
        <div class="field">
          <label>Website password {s.website.passwordSet ? "(set — type to change)" : ""}</label>
          <input type="password" value={pw} onInput={(e) => setPw(val(e))} placeholder="At least 8 characters" autocomplete="new-password" />
        </div>
        <div class="inline">
          <button class="btn" onClick={run(async () => (await api("website", { method: "PUT", body: { relayUrl: relay || s.website.relayUrl, enabled: true, ...(pw ? { password: pw } : {}) } }), setPw(""), reloadS()), "Website on")}>
            {s.website.enabled ? "Save" : "Turn on"}
          </button>
          {s.website.enabled ? (
            <button class="btn secondary" onClick={run(async () => (await api("website", { method: "PUT", body: { enabled: false } }), reloadS()))}>
              Turn off
            </button>
          ) : null}
        </div>
      </div>
      <div class="section">
        <h2>Link a PC or tablet</h2>
        {s.website.enabled && s.website.relayUrl ? (
          <>
            <ol class="help" style={{ paddingLeft: "1.1rem" }}>
              <li>
                On the PC or tablet, open <b style={{ wordBreak: "break-all" }}>{s.website.relayUrl}</b> — it shows a QR code.
              </li>
              <li>Scan it here. That device opens your MausDroid and asks for your password.</li>
            </ol>
            {(window as any).MausDroidShell?.scanQr ? (
              <button class="btn" disabled={!s.website.passwordSet || linking} onClick={scan}>
                📷 Scan the QR on your PC
              </button>
            ) : null}
            <div class="inline" style={{ marginTop: ".6rem" }}>
              <input value={code} onInput={(e) => setCode(val(e))} placeholder="Or type its code, e.g. ABCD-2345" style={{ maxWidth: "15rem" }} autocapitalize="characters" />
              <button class="btn secondary" disabled={!s.website.passwordSet || linking || code.replace(/[\s-]/g, "").length < 8} onClick={() => link(code)}>
                Link
              </button>
            </div>
            {!s.website.passwordSet ? <p class="help">Set a website password first.</p> : null}
            {linkMsg ? <p class="help">{linkMsg}</p> : null}
          </>
        ) : (
          <p class="help">Turn on the website above first.</p>
        )}
      </div>
      <div class="section">
        <h2>Linked devices</h2>
        {devices?.length ? (
          devices.map((d) => (
            <div class="toggle">
              <span>
                {d.name}
                <br />
                <span class="muted" style={{ fontSize: 12 }}>
                  added {new Date(d.createdAt).toLocaleDateString()} {d.lastSeenAt ? `· last used ${new Date(d.lastSeenAt).toLocaleString()}` : ""}
                </span>
              </span>
              <button class="btn secondary small" onClick={run(async () => (await api(`devices/${d.id}`, { method: "DELETE" }), reloadD()), "Removed")}>
                Remove
              </button>
            </div>
          ))
        ) : (
          <p class="muted">None.</p>
        )}
      </div>
    </>
  );
}

// ---------------- Voice & assistant ----------------
// Kokoro voice names: first letter = accent, second = gender (e.g. "bf_emma" = British female).
const KOKORO_ACCENT: Record<string, string> = { a: "American", b: "British", e: "Spanish", f: "French", h: "Hindi", i: "Italian", j: "Japanese", p: "Portuguese", z: "Mandarin" };
export function voiceLabel(v: { name: string; locale?: string; network?: boolean }) {
  const k = v.name.match(/^([abefhijpz])([fm])_([a-z]+)$/i);
  if (k) return `${k[3][0].toUpperCase()}${k[3].slice(1)} — ${KOKORO_ACCENT[k[1].toLowerCase()] ?? ""} ${k[2].toLowerCase() === "f" ? "female" : "male"}`;
  return `${v.name}${v.locale ? ` (${v.locale})` : ""}${v.network ? " · needs internet" : ""}`;
}

/** Voice engine (Google, Samsung, Kokoro…), voice and pitch. */
function VoicePicker({ s, save }: { s: any; save: (b: object) => void }) {
  const [engines, setEngines] = useState<{ name: string; label: string }[] | null>(null);
  const [voices, setVoices] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  const engine = s.voice?.ttsEngine ?? "";
  useEffect(() => {
    api("voice/engines").then((r) => setEngines(r.engines ?? [])).catch((e) => setErr((e as Error).message));
  }, []);
  useEffect(() => {
    setVoices(null);
    api("voice/voices", { body: { engine } }).then((r) => setVoices(r.voices ?? [])).catch(() => setVoices([]));
  }, [engine]);
  if (err) return <p class="help">Voice choices need the Android app.</p>;
  const usable = (voices ?? []).filter((v) => !v.notInstalled);
  const lang = (navigator.language || "en").slice(0, 2);
  const sorted = [...usable].sort((a, b) => Number(!String(a.locale).startsWith(lang)) - Number(!String(b.locale).startsWith(lang)) || voiceLabel(a).localeCompare(voiceLabel(b)));
  return (
    <>
      <div class="field">
        <label>Voice engine</label>
        <select value={engine} onChange={(e) => save({ ttsEngine: val(e), voiceName: "" })}>
          <option value="">Phone default</option>
          {(engines ?? []).map((x) => (
            <option value={x.name}>{x.label}</option>
          ))}
        </select>
        <p class="help">Kokoro appears here if its app is installed as a voice engine (Settings → Accessibility → Text-to-speech on the phone).</p>
      </div>
      <div class="field">
        <label>Voice (style, accent, gender)</label>
        <select value={s.voice?.voiceName ?? ""} onChange={(e) => save({ voiceName: val(e) })} disabled={!voices}>
          <option value="">{voices ? "Engine default" : "Loading voices…"}</option>
          {sorted.map((v) => (
            <option value={v.name}>{voiceLabel(v)}</option>
          ))}
        </select>
      </div>
      <div class="field">
        <label>Pitch: {Math.round((s.voice?.pitch ?? 1) * 100)}%</label>
        <input type="range" min="0.6" max="1.6" step="0.1" value={s.voice?.pitch ?? 1} onChange={(e) => save({ pitch: Number(val(e)) })} />
      </div>
    </>
  );
}

/** The newer speech features: Phonon, phrase-by-phrase delivery, reactions, smart waiting, interrupting, hold. */
function NaturalSpeech({ s, save }: { s: any; save: (b: object) => void }) {
  const [engines, setEngines] = useState<{ name: string; label: string }[] | null>(null);
  useEffect(() => {
    api("voice/engines").then((r) => setEngines(r.engines ?? [])).catch(() => setEngines([]));
  }, []);
  const sp = { natural: true, reactions: true, smartWaiting: true, beat: "normal", interruptByVoice: true, holdByVoice: true, ...(s.voice?.speech ?? {}) };
  const set = (patch: object) => save({ speech: { ...sp, ...patch } });
  const phonon = (engines ?? []).find((e) => /phonon/i.test(`${e.name} ${e.label}`));
  const usingPhonon = Boolean(phonon && s.voice?.ttsEngine === phonon.name);
  const row = (key: keyof typeof sp, label: string, help: string) => (
    <label class="toggle" style={{ alignItems: "flex-start" }}>
      <span>
        {label}
        <br />
        <span class="help">{help}</span>
      </span>
      <input type="checkbox" checked={Boolean(sp[key])} onChange={() => set({ [key]: !sp[key] })} />
    </label>
  );
  return (
    <div class="section">
      <h2>Natural speech</h2>
      {engines === null ? null : phonon ? (
        <div class="toggle">
          <span>
            Phonon voice engine {usingPhonon ? <span class="pill ok">in use</span> : <span class="pill warn">installed, not in use</span>}
          </span>
          {!usingPhonon ? (
            <button class="btn small" onClick={() => save({ ttsEngine: phonon.name, voiceName: "" })}>
              Use Phonon
            </button>
          ) : null}
        </div>
      ) : (
        <p class="help">Phonon isn't installed as a voice engine on this phone. Install the Phonon TTS app, import the Phonon 31M model, then choose it here.</p>
      )}
      {row("natural", "Natural delivery", "Speaks phrase by phrase as replies arrive, with small changes in speed and pitch, and pauses where a person would pause. Calls, read-aloud replies and the assistant.")}
      {row("reactions", "Listening sounds", "An occasional “mm-hmm” or “uh-huh” in the same voice.")}
      {row("smartWaiting", "Wait when I pause mid-thought", "On calls, “the other thing is…” keeps listening instead of answering.")}
      <div class="field">
        <label>Pause before answering</label>
        <div class="seg">
          {(
            [
              ["quick", "Quick"],
              ["normal", "Natural"],
              ["relaxed", "Relaxed"],
            ] as const
          ).map(([k, label]) => (
            <button class={sp.beat === k ? "on" : ""} onClick={() => set({ beat: k })} disabled={!sp.smartWaiting}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {row("interruptByVoice", "Interrupt by talking", "On calls, just start talking: it stops at once and hears you from your first word.")}
      {row("holdByVoice", "“Hold on a sec”", "Puts the call on hold. It then listens on the phone only for the bot's name: “Maus, continue” or “Maus, what about…”. Side conversations stay private.")}
    </div>
  );
}

/** Which speech service listens (the phone's default can be an assistant app that won't take dictation). */
function SpeechService({ s, save }: { s: any; save: (b: object) => void }) {
  const [r, setR] = useState<{ services: { component: string; package: string; label: string }[]; phoneDefault: string; inUse: string } | null>(null);
  useEffect(() => {
    api("voice/recognizers").then(setR).catch(() => setR(null));
  }, []);
  if (!r) return null;
  const nameOf = (c: string) => r.services.find((x) => x.component === c || c.startsWith(`${x.package}/`))?.label ?? (c ? c.split("/")[0] : "");
  return (
    <div class="field" style={{ marginTop: ".6rem" }}>
      <label>Speech recognition</label>
      <select value={s.voice?.recognizer ?? ""} onChange={(e) => save({ recognizer: val(e) })}>
        <option value="">Automatic (Google first)</option>
        {r.services.map((x) => (
          <option value={x.component}>{x.label}</option>
        ))}
      </select>
      <p class="help">
        Your phone's default speech service is {nameOf(r.phoneDefault) || "not set"}
        {r.inUse ? `; MausDroid last used ${nameOf(r.inUse)}` : ""}. Assistant apps (e.g. Grok) often refuse to listen for other apps, so Automatic tries Google's first. Calls also use on-device recognition after you interrupt and while on hold.
      </p>
    </div>
  );
}

function VoiceTab({ bots }: { bots: Bot[] }) {
  const [s, reload] = useLoad<any>("settings");
  const [sys, reloadSys] = useLoad<any>("system");
  useEffect(() => {
    const t = setInterval(reloadSys, 4000);
    return () => clearInterval(t);
  }, []);
  if (!s) return <p class="muted">Loading…</p>;
  const save = (body: object) => run(async () => (await api("settings/voice", { method: "PUT", body }), reload()));
  const visible = bots.filter((b) => !b.hidden);
  const fallback = visible.find((b) => b.pinned) ?? visible[0];
  return (
    <>
      <div class="section">
        <h2>Digital assistant</h2>
        <p class="help">Use MausDroid instead of Google Assistant or ChatGPT: long-press the home button (or hold power), and your chosen bot listens straight away and answers out loud.</p>
        <div class="toggle">
          <span>MausDroid is your assistant {sys?.isDefaultAssistant ? <span class="pill ok">yes</span> : <span class="pill warn">not yet</span>}</span>
          <button class="btn secondary small" onClick={run(async () => api("system/assistant", { body: {} }))}>
            {sys?.isDefaultAssistant ? "Change" : "Set up"}
          </button>
        </div>
        {!sys?.isDefaultAssistant ? <p class="help">In the screen that opens, choose “Digital assistant app” (or “Default assistant”) → MausDroid.</p> : null}
        <div class="toggle">
          <span>Microphone {sys?.microphoneAllowed ? <span class="pill ok">allowed</span> : <span class="pill warn">needed</span>}</span>
          {!sys?.microphoneAllowed ? (
            <button class="btn secondary small" onClick={run(async () => api("system/microphone", { body: {} }))}>
              Allow
            </button>
          ) : null}
        </div>
        <SpeechService s={s} save={(b) => save(b)()} />
        <div class="field" style={{ marginTop: ".6rem" }}>
          <label>Which bot answers</label>
          <select value={s.assistant?.botId ?? ""} onChange={(e) => save({ assistantBotId: val(e) || null })()}>
            <option value="">{fallback ? `${fallback.emoji} ${fallback.name} (pinned bot)` : "Your first bot"}</option>
            {visible.map((b) => (
              <option value={b.id}>
                {b.emoji} {b.name}
              </option>
            ))}
          </select>
        </div>
        <label class="toggle">
          <span>Answer out loud</span>
          <input type="checkbox" checked={s.assistant?.speak ?? true} onChange={() => save({ assistantSpeak: !(s.assistant?.speak ?? true) })()} />
        </label>
        <p class="help">The assistant bot uses its own AI (e.g. your Claude or ChatGPT sign-in), skills and connected apps. Say “use the … skill” to pick a skill.</p>
      </div>
      <CallSettings />
      <div class="section">
        <h2>Voice</h2>
        <div class="field">
          <label>Voice engine</label>
          <select value={s.voice?.engine ?? "phone"} onChange={() => {}}>
            <option value="phone">This phone's voice (free, works with every AI)</option>
            <option value="api" disabled>
              AI voices with an API key — coming later
            </option>
            <option value="local" disabled>
              Local voice on phone or PC — coming later
            </option>
          </select>
        </div>
        <div class="field">
          <label>Read replies aloud</label>
          <div class="seg">
            {(
              [
                ["voice", "When I talk"],
                ["always", "Always"],
                ["never", "Never"],
              ] as const
            ).map(([k, label]) => (
              <button class={(s.voice?.readReplies ?? "voice") === k ? "on" : ""} onClick={save({ readReplies: k })}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div class="field">
          <label>Speaking speed: {Math.round((s.voice?.rate ?? 1) * 100)}%</label>
          <input type="range" min="0.6" max="1.6" step="0.1" value={s.voice?.rate ?? 1} onChange={(e) => save({ rate: Number(val(e)) })()} />
        </div>
        <VoicePicker s={s} save={(b) => save(b)()} />
        <button class="btn secondary" onClick={run(async () => api("voice/speak", { body: { text: "Hi! {pause 250}This is how your bots sound now. {faster}Quick bits go a little faster, {pause 200}{slower}and careful bits slow down." } }))}>
          Test voice
        </button>
      </div>
      <NaturalSpeech s={s} save={(b) => save(b)()} />
    </>
  );
}

// ---------------- Appearance ----------------
function AppearanceTab() {
  const [a, setA] = useState<Appearance>(loadAppearance());
  const set = (patch: Partial<Appearance>) => {
    const next = { ...a, ...patch };
    setA(next);
    saveAppearance(next);
  };
  const nearest = TEXT_SIZES.reduce((best, t) => (Math.abs(t.scale - a.scale) < Math.abs(best.scale - a.scale) ? t : best), TEXT_SIZES[1]);
  return (
    <>
      <div class="section">
        <h2>Text size</h2>
        <p class="help">Makes everything bigger or smaller on this device: text, buttons and spacing.</p>
        <div class="inline" style={{ gap: ".8rem" }}>
          <span style={{ fontSize: ".8rem" }}>A</span>
          <input type="range" min="0.8" max="1.6" step="0.05" value={a.scale} onInput={(e) => set({ scale: Number((e.target as HTMLInputElement).value) })} style={{ flex: 1 }} aria-label="Text size" />
          <span style={{ fontSize: "1.4rem" }}>A</span>
        </div>
        <div class="seg" style={{ marginTop: ".7rem", flexWrap: "wrap" }}>
          {TEXT_SIZES.map((t) => (
            <button class={nearest.scale === t.scale && Math.abs(a.scale - t.scale) < 0.03 ? "on" : ""} onClick={() => set({ scale: t.scale })}>
              {t.label}
            </button>
          ))}
        </div>
        <p class="help" style={{ marginTop: ".6rem" }}>
          Now: {Math.round(a.scale * 100)}%
        </p>
        <div class="preview-bubble">
          <div class="msg">
            <div class="bubble">Here's your morning briefing: 3 new emails, rain at 3pm, and Compass has 1 new notice.</div>
          </div>
          <div class="msg mine">
            <div class="bubble">Thanks! Draft a reply to the first email.</div>
          </div>
        </div>
      </div>
      <div class="section">
        <h2>Theme</h2>
        <div class="seg">
          {(
            [
              ["system", "Match phone"],
              ["light", "Light"],
              ["dark", "Dark"],
            ] as const
          ).map(([k, label]) => (
            <button class={a.theme === k ? "on" : ""} onClick={() => set({ theme: k })}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

// ---------------- Memory ----------------
/** Your playbook: documents with your rules for how the assistant works with you (kept only on this phone). */
function Playbook() {
  const [d, reload] = useLoad<any>("playbook");
  const [view, setView] = useState<{ id: string; text: string } | null>(null);
  if (!d) return null;
  const pick = async (e: Event) => {
    const files = [...((e.target as HTMLInputElement).files ?? [])];
    (e.target as HTMLInputElement).value = "";
    for (const f of files) {
      try {
        const b64 = btoa(Array.from(new Uint8Array(await f.arrayBuffer()), (c) => String.fromCharCode(c)).join(""));
        const doc = await api("playbook/import", { body: { name: f.name, b64 } });
        toast(`Imported ${doc.name} (${doc.mode === "always" ? "always followed" : "for reference"})`);
      } catch (err) {
        toast(`⚠️ ${f.name}: ${(err as Error).message}`);
      }
    }
    reload();
  };
  return (
    <div class="section">
      <h2>Playbook</h2>
      <p class="help">
        Your rules for how your assistant works with you — e.g. guides written with a previous assistant. Kept only on this phone. <b>Always follow</b> documents are part of the assistant's instructions; <b>Reference</b> ones (long guides) are looked up when needed. When you correct the assistant, it adds the rule here with a change-log line. Nothing else (bots, memory, routines) is changed.
      </p>
      {d.docs.length ? (
        d.docs.map((doc: any) => (
          <div style={{ padding: ".45rem 0", borderBottom: "1px solid var(--panel2)" }}>
            <b>{doc.name}</b>{" "}
            <span class="muted" style={{ fontSize: ".8rem" }}>
              {Math.round(doc.chars / 100) / 10}k characters · imported {new Date(doc.importedAt).toLocaleDateString()}
            </span>
            <div class="seg" style={{ marginTop: ".3rem" }}>
              <button class={doc.mode === "always" ? "on" : ""} onClick={run(async () => (await api(`playbook/${doc.id}`, { method: "PATCH", body: { mode: "always" } }), reload()))}>
                Always follow
              </button>
              <button class={doc.mode === "reference" ? "on" : ""} onClick={run(async () => (await api(`playbook/${doc.id}`, { method: "PATCH", body: { mode: "reference" } }), reload()))}>
                Reference
              </button>
              <button onClick={async () => setView(view?.id === doc.id ? null : { id: doc.id, text: (await api(`playbook/${doc.id}/text`)).text })}>{view?.id === doc.id ? "Hide" : "View"}</button>
              <button
                onClick={run(async () => {
                  if (!confirm(`Remove ${doc.name} from the playbook? (The original file on your phone isn't touched.)`)) return;
                  await api(`playbook/${doc.id}`, { method: "DELETE" });
                  reload();
                })}
              >
                Remove
              </button>
            </div>
            {view && view.id === doc.id ? <pre style={{ whiteSpace: "pre-wrap", maxHeight: "22rem", overflow: "auto" }}>{view.text}</pre> : null}
          </div>
        ))
      ) : (
        <p class="muted">No playbook yet.</p>
      )}
      <div class="inline" style={{ marginTop: ".6rem", flexWrap: "wrap", gap: ".5rem" }}>
        <label class="btn small" style={{ display: "inline-block" }}>
          Import documents
          <input type="file" multiple hidden onChange={pick} />
        </label>
        <button class="btn secondary small" disabled={!d.docs.length} onClick={run(async () => api("playbook/review", { body: {} }), "Improver is reviewing it — see its chat")}>
          Review with Improver
        </button>
      </div>
      <div class="field" style={{ marginTop: ".6rem" }}>
        <label>Who follows it</label>
        <select value={d.appliesTo} onChange={(e) => run(async () => (await api("playbook/settings", { method: "PUT", body: { appliesTo: val(e) } }), reload()))()}>
          <option value="main">The main assistant (Maus) and Improver</option>
          <option value="all">Every bot</option>
        </select>
      </div>
    </div>
  );
}

function MemoryTab() {
  const [m, reload] = useLoad<any>("memory/about-me");
  const [text, setText] = useState<string | null>(null);
  const [gh, setGh] = useState("");
  return (
    <>
      <Playbook />
      <div class="section">
        <h2>What your bots know about you</h2>
        <p class="help">Shared by all bots. Bots add to it when you tell them something worth remembering. Edit freely.</p>
        <textarea rows={10} value={text ?? m?.text ?? ""} onInput={(e) => setText(val(e))} />
        <button class="btn" style={{ marginTop: 8 }} onClick={run(async () => (await api("memory/about-me", { method: "PUT", body: { text: text ?? m?.text ?? "" } }), reload()), "Saved")}>
          Save
        </button>
      </div>
      <div class="section">
        <h2>GitHub token (optional)</h2>
        <p class="help">Raises GitHub's limit for skills searches from 60 to 5,000 an hour. For the weekly audit's wiki, use a fine-grained token with "Contents: read and write" on the private repo DanGeo13/mausdroid-routine-wiki only. MausDroid never writes to a public repo.</p>
        <div class="inline">
          <input type="password" value={gh} onInput={(e) => setGh(val(e))} placeholder="github_pat_…" />
          <button class="btn secondary" onClick={run(async () => (await api("settings/github", { method: "PUT", body: { token: gh } }), setGh("")), "Saved")}>
            Save
          </button>
        </div>
      </div>
    </>
  );
}

export const SETTINGS_TABS = ["AI", "Voice & assistant", "Appearance", "Connected apps", "Tools", "Skills", "Routines & alerts", "Phone", "Website & devices", "Memory"] as const;

export function Settings({ tab, setTab, bots, onBack }: { tab: string; setTab: (t: string) => void; bots: Bot[]; onBack: () => void }) {
  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={onBack} aria-label="Back">
          <IconBack />
        </button>
        <h1>Settings</h1>
      </div>
      <div class="tabs">
        {SETTINGS_TABS.map((t) => (
          <button class={`tab ${t === tab ? "on" : ""}`} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </div>
      <div class="page">
        {tab === "AI" ? <AiTab /> : tab === "Voice & assistant" ? <VoiceTab bots={bots} /> : tab === "Appearance" ? <AppearanceTab /> : tab === "Connected apps" ? <AppsTab /> : tab === "Tools" ? <ToolsTab /> : tab === "Skills" ? <SkillsTab /> : tab === "Routines & alerts" ? <RoutinesTab bots={bots} /> : tab === "Phone" ? <PhoneTab /> : tab === "Website & devices" ? <WebsiteTab /> : <MemoryTab />}
      </div>
    </>
  );
}

// ---------------- Bot editor ----------------
/** Plain words for a permission type key. */
// ---------------- Tools ----------------
const GROUP_LABEL: Record<string, string> = { core: "Always available", web: "Web", browser: "Background browser", apps: "Connected apps", phone: "Phone" };
const toolTitle = (n: string) => n.replace(/^composio__/, "apps: ").replace(/_/g, " ");

function ToolBadges({ t }: { t: any }) {
  return (
    <span style={{ display: "inline-flex", gap: ".3rem", flexWrap: "wrap" }}>
      <span class="pill">{GROUP_LABEL[t.group] ?? t.group}</span>
      {t.risky ? <span class="pill warn">can change things — asks first</span> : null}
      {t.onlyFor ? <span class="pill">only {t.onlyFor}</span> : null}
    </span>
  );
}

/** Settings → Tools: every tool, and which bots have it. */
function ToolsTab() {
  const [d, reload] = useLoad<any>("tools");
  const [changes, reloadC] = useLoad<any[]>("bot-changes");
  const [q, setQ] = useState("");
  if (!d) return <p class="muted">Loading…</p>;
  const has = (b: any, t: any) => (t.group === "core" || b.tools?.[t.group]) && !b.disabledTools.includes(t.name);
  const setFor = (t: any, botIds: string[], enabled: boolean) => run(async () => (await api(`tools/${encodeURIComponent(t.name)}/bots`, { body: { botIds, enabled } }), reload()))();
  const shown = d.tools.filter((t: any) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q.toLowerCase()));
  const groups = [...new Set(shown.map((t: any) => t.group))] as string[];
  return (
    <>
      <div class="section">
        <h2>Tools</h2>
        <p class="help">Every tool your bots can use. Tap a bot's name to switch that tool on or off for it. The switches for whole groups (web, browser, apps) are in each bot's editor. Tools that send, buy, post or delete things ask you first.</p>
        <input value={q} onInput={(e) => setQ(val(e))} placeholder="Search tools" />
      </div>
      {groups.map((g) => (
        <div class="section">
          <h2>{GROUP_LABEL[g] ?? g}</h2>
          {shown
            .filter((t: any) => t.group === g)
            .map((t: any) => (
              <div class="tool-row">
                <div>
                  <b>{toolTitle(t.name)}</b> <ToolBadges t={t} />
                </div>
                <div class="muted" style={{ fontSize: ".82rem" }}>{t.description}</div>
                <div class="seg" style={{ flexWrap: "wrap", marginTop: ".35rem" }}>
                  {d.bots.map((b: any) => {
                    const groupOff = t.group !== "core" && !b.tools?.[t.group];
                    return (
                      <button class={has(b, t) ? "on" : ""} disabled={groupOff} title={groupOff ? `${GROUP_LABEL[t.group]} is off for ${b.name} (bot editor)` : ""} onClick={() => setFor(t, [b.id], !has(b, t))}>
                        {b.emoji} {b.name}
                      </button>
                    );
                  })}
                  <button onClick={() => setFor(t, d.bots.map((b: any) => b.id), true)}>All on</button>
                  <button onClick={() => setFor(t, d.bots.map((b: any) => b.id), false)}>All off</button>
                </div>
              </div>
            ))}
        </div>
      ))}
      <div class="section">
        <h2>Changes bots made to other bots</h2>
        <p class="help">Maus asks you before changing another bot; Improver has admin rights and doesn't. Undo puts the bot back as it was.</p>
        {changes?.length ? (
          changes.map((c: any) => (
            <div class="toggle">
              <span>
                <b>{c.by}</b> changed <b>{c.botName}</b>: {Object.keys(c.after).join(", ")}
                <br />
                <span class="muted" style={{ fontSize: 12 }}>
                  {new Date(c.at).toLocaleString()} {c.undoneAt ? "· undone" : ""}
                </span>
              </span>
              {c.undoneAt ? null : (
                <button class="btn secondary small" onClick={run(async () => (await api(`bot-changes/${c.id}/undo`, { body: {} }), reloadC(), reload()), "Undone")}>
                  Undo
                </button>
              )}
            </div>
          ))
        ) : (
          <p class="muted">None yet.</p>
        )}
      </div>
    </>
  );
}

/** Bot editor: every tool this bot can have, with a tick box each. */
function BotTools({ b, set }: { b: Partial<Bot>; set: (p: Partial<Bot>) => void }) {
  const [d] = useLoad<any>("tools");
  const [open, setOpen] = useState(false);
  if (!d) return null;
  const off = new Set(b.disabledTools ?? []);
  const avail = d.tools.filter((t: any) => t.group === "core" || (b.tools as any)?.[t.group]);
  const toggle = (name: string) => {
    const n = new Set(off);
    if (n.has(name)) n.delete(name);
    else n.add(name);
    set({ disabledTools: [...n].sort() });
  };
  return (
    <div class="section">
      <h2>Tools</h2>
      <p class="help">
        {avail.length - avail.filter((t: any) => off.has(t.name)).length} of {avail.length} tools on. Untick any this bot shouldn't use. All bots' tools: Settings → Tools.
      </p>
      <button class="btn secondary small" onClick={() => setOpen(!open)}>
        {open ? "Hide tools" : "Show tools"}
      </button>
      {open
        ? avail.map((t: any) => (
            <label class="toggle">
              <span>
                <b>{toolTitle(t.name)}</b> <ToolBadges t={t} />
                <br />
                <span class="muted" style={{ fontSize: ".8rem" }}>{t.description}</span>
              </span>
              <input type="checkbox" checked={!off.has(t.name)} onChange={() => toggle(t.name)} />
            </label>
          ))
        : null}
    </div>
  );
}

export function permissionLabel(k: string): string {
  if (k === "routines:change") return "changing or deleting its routines";
  if (k === "bots:edit") return "changing other bots";
  const m = k.match(/^apps:(.+):write$/);
  if (m) return `changing things in ${m[1].split("+").join(", ")}`;
  if (k === "apps:workbench") return "running code in Composio's workbench";
  return k.replace(/^composio__/, "apps · ").replace(/_/g, " ");
}
export function BotEditor({ bot, onClose }: { bot: Bot | null; onClose: (deleted?: boolean) => void }) {
  const [s] = useLoad<any>("settings");
  const [skills] = useLoad<any[]>("skills");
  const [edits, setEdits] = useState<Partial<Bot>>({});
  const b: Partial<Bot> = { ...(bot ?? { name: "", emoji: "🤖", color: "#6c5ce7", persona: "", approvalMode: "ask-risky", tools: { web: true, browser: true, apps: true, phone: false }, skills: [] }), ...edits };
  const set = (patch: Partial<Bot>) => setEdits((prev) => ({ ...prev, ...patch }));
  const save = run(async () => {
    if (bot) await api(`bots/${bot.id}`, { method: "PATCH", body: edits });
    else await api("bots", { body: b });
    onClose();
  }, "Saved");
  const prov = s?.providers?.find((p: Provider) => p.id === b.providerId);
  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={() => onClose()} aria-label="Back">
          <IconBack />
        </button>
        <h1>{bot ? `Edit ${bot.name}` : "New bot"}</h1>
        <button class="btn small" onClick={save}>
          Save
        </button>
      </div>
      <div class="page">
        <div class="section">
          <div class="inline">
            <input style={{ maxWidth: 70, textAlign: "center", fontSize: 22 }} value={b.emoji} onInput={(e) => set({ emoji: val(e) })} />
            <input value={b.name} onInput={(e) => set({ name: val(e) })} placeholder="Name" />
            <input type="color" style={{ maxWidth: 60, padding: 2, height: 44 }} value={b.color} onInput={(e) => set({ color: val(e) })} />
          </div>
          <div class="field" style={{ marginTop: 10 }}>
            <label>Personality and job</label>
            <textarea rows={5} value={b.persona} onInput={(e) => set({ persona: val(e) })} placeholder="e.g. You manage my school admin: summarise Compass notices, track deadlines, draft emails for my approval." />
          </div>
        </div>
        <div class="section">
          <h2>Brain</h2>
          <div class="field">
            <label>AI</label>
            <select value={b.providerId ?? ""} onChange={(e) => set({ providerId: val(e) || null, model: null })}>
              <option value="">Default ({s?.providers?.find((p: Provider) => p.id === s?.defaultProvider)?.label ?? "none set"})</option>
              {s?.providers
                ?.filter((p: Provider) => p.enabled)
                .map((p: Provider) => (
                  <option value={p.id}>{p.label}</option>
                ))}
            </select>
          </div>
          {prov ? <ModelPicker providerId={prov.id} value={b.model ?? null} onChange={(m) => set({ model: m })} /> : null}
          <p class="help">Each bot can use a different AI and model, e.g. a quick Haiku bot for alerts and an Opus bot for research. Turn AIs on in Settings → AI.</p>
        </div>
        <div class="section">
          <h2>What it may do</h2>
          {(
            [
              ["web", "Search and read the web"],
              ["browser", "Use the background browser (with your logins)"],
              ["apps", "Use connected apps (Composio)"],
            ] as const
          ).map(([k, label]) => (
            <label class="toggle">
              <span>{label}</span>
              <input type="checkbox" checked={b.tools?.[k]} onChange={() => set({ tools: { ...b.tools!, [k]: !b.tools?.[k] } })} />
            </label>
          ))}
          <div class="field">
            <label>Approvals</label>
            <select value={b.approvalMode} onChange={(e) => set({ approvalMode: val(e) as Bot["approvalMode"] })}>
              <option value="ask-risky">Ask before sending, buying, posting or changing things (recommended)</option>
              <option value="ask-all">Ask before every action</option>
              <option value="auto">Never ask (not recommended)</option>
            </select>
          </div>
        </div>
        <BotTools b={b} set={set} />
        {skills?.length ? (
          <div class="section">
            <h2>Skills</h2>
            <p class="help">None ticked = all skills available.</p>
            {skills.map((sk) => (
              <label class="toggle">
                <span>{sk.name}</span>
                <input type="checkbox" checked={b.skills?.includes(sk.name)} onChange={() => set({ skills: b.skills?.includes(sk.name) ? b.skills.filter((x) => x !== sk.name) : [...(b.skills ?? []), sk.name] })} />
              </label>
            ))}
          </div>
        ) : null}
        {bot ? (
          <div class="section">
            <h2>Permissions</h2>
            <p class="help">
              When this bot needs your OK, you can <strong>Allow once</strong> (just this time) or <strong>Always allow</strong> that type of access (it won't ask again for that type until you revoke it here).
            </p>
            {(b.alwaysAllow ?? []).length ? (
              (b.alwaysAllow ?? []).map((k) => (
                <div class="toggle">
                  <span>Always allowed: {permissionLabel(k)}</span>
                  <button class="btn secondary small" onClick={() => set({ alwaysAllow: (b.alwaysAllow ?? []).filter((x) => x !== k) })}>
                    Revoke
                  </button>
                </div>
              ))
            ) : (
              <p class="muted" style={{ fontSize: ".85rem" }}>
                Nothing is always allowed. It asks every time.
              </p>
            )}
            <p class="help">Tap Save at the top after revoking.</p>
          </div>
        ) : null}
        {bot ? (
          <div class="section">
            <div class="inline">
              <button class="btn secondary" onClick={run(async () => (await api(`bots/${bot.id}/clear`, { body: {} }), onClose()), "Chat cleared")}>
                Clear chat
              </button>
              <button class="btn danger" onClick={run(async () => {
                if (!confirm(`Delete ${bot.name} and its chat?`)) return;
                await api(`bots/${bot.id}`, { method: "DELETE" });
                onClose(true);
              })}>
                Delete bot
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}
