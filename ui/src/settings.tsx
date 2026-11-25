import { useEffect, useState } from "preact/hooks";
import qrcode from "qrcode-generator";
import { api } from "./api.ts";
import type { Bot, Provider } from "./types.ts";

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
  const isCli = p.kind.startsWith("cli-");
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
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AiTab() {
  const [s, reload] = useLoad<any>("settings");
  if (!s) return <p class="muted">Loading…</p>;
  return (
    <>
      <p class="help">Turn on at least one. Free choices: Gemini (free key from Google AI Studio), OpenRouter free models, Groq, or a local model. Claude Code and Codex use your existing subscriptions.</p>
      {s.providers.map((p: Provider) => (
        <ProviderRow p={p} key={p.id} isDefault={s.defaultProvider === p.id} reload={reload} />
      ))}
    </>
  );
}

// ---------------- Connected apps ----------------
function AppsTab() {
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
      <div class="section">
        <h2>Add an app</h2>
        <input value={search} onInput={(e) => setSearch(val(e))} placeholder="Search: gmail, drive, outlook, canva…" />
        <div class="grid" style={{ marginTop: 10 }}>
          {kits.map((k) => (
            <button
              class="app-tile"
              onClick={run(async () => {
                const alias = (conns ?? []).some((c) => c.toolkit === k.slug) ? prompt(`Name this extra ${k.name} account (e.g. work, personal):`) ?? undefined : undefined;
                const r = await api("composio/link", { body: { toolkit: k.slug, alias } });
                if (!(window as any).MausDroidNative) window.open(r.url, "_blank");
              }, "Finish signing in, then come back and tap Refresh")}
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
  const [list, reload] = useLoad<any[]>("routines");
  const [alerts, reloadAlerts] = useLoad<any[]>("alerts");
  const [s, reloadS] = useLoad<any>("settings");
  const name = (id: string) => bots.find((b) => b.id === id)?.name ?? "?";
  const describe = (sc: any) =>
    sc.kind === "once" ? `once at ${new Date(sc.at).toLocaleString()}` : sc.kind === "interval" ? `every ${sc.minutes} min` : sc.kind === "daily" ? `daily at ${sc.time}` : `weekly ${(sc.days ?? []).map((d: number) => "SMTWTFS"[d]).join("")} at ${sc.time}`;
  return (
    <>
      <div class="section">
        <h2>Routines &amp; watchers</h2>
        <p class="help">Ask any bot, e.g. "Every weekday at 7am give me a briefing", or "Check this page every hour and only alert me if the price drops below $200".</p>
        {list?.length ? (
          list.map((r) => (
            <div class="toggle">
              <span>
                <strong>{r.title}</strong> · {name(r.botId)}
                <br />
                <span class="muted" style={{ fontSize: 13 }}>
                  {describe(r.schedule)} · next {r.nextRunAt ? new Date(r.nextRunAt).toLocaleString() : "—"}
                </span>
              </span>
              <span class="inline">
                <input type="checkbox" checked={r.enabled} onChange={run(async () => (await api(`routines/${r.id}`, { method: "PATCH", body: { enabled: !r.enabled } }), reload()))} />
                <button class="btn secondary small" onClick={run(async () => api(`routines/${r.id}/run`, { body: {} }), "Started")}>
                  Run now
                </button>
                <button class="btn secondary small" onClick={run(async () => (await api(`routines/${r.id}`, { method: "DELETE" }), reload()))}>
                  ✕
                </button>
              </span>
            </div>
          ))
        ) : (
          <p class="muted">No routines yet.</p>
        )}
      </div>
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
  const [pair, setPair] = useState<{ link: string; expiresAt: string } | null>(null);
  if (!s) return <p class="muted">Loading…</p>;
  return (
    <>
      <div class="section">
        <h2>Always-on website</h2>
        <p class="help">
          Control your bots from any browser. Uses a free Cloudflare Worker you deploy once (instructions in the MausDroid repo: <code>relay/README.md</code>). The website only passes messages to your phone; your data stays on the phone, and every device must scan a QR code and know your password.
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
        <h2>Add a device (QR code)</h2>
        <p class="help">Scan with the other device's camera. It opens your website, links that device, then asks for your password. The code works once and expires in 10 minutes.</p>
        <button class="btn" disabled={!s.website.passwordSet} onClick={run(async () => setPair(await api("pair/create", { body: {} })))}>
          Show QR code
        </button>
        {!s.website.passwordSet ? <p class="help">Set a website password first.</p> : null}
        {pair ? (
          <div style={{ marginTop: 12, textAlign: "center" }}>
            <Qr text={pair.link} />
            <p class="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
              {pair.link}
            </p>
          </div>
        ) : null}
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

// ---------------- Memory ----------------
function MemoryTab() {
  const [m, reload] = useLoad<any>("memory/about-me");
  const [text, setText] = useState<string | null>(null);
  const [gh, setGh] = useState("");
  return (
    <>
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
        <p class="help">Raises GitHub's limit for skills searches from 60 to 5,000 an hour. A token with no permissions is enough.</p>
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

export const SETTINGS_TABS = ["AI", "Connected apps", "Skills", "Routines & alerts", "Phone", "Website & devices", "Memory"] as const;

export function Settings({ tab, setTab, bots, onBack }: { tab: string; setTab: (t: string) => void; bots: Bot[]; onBack: () => void }) {
  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={onBack}>
          ‹
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
        {tab === "AI" ? <AiTab /> : tab === "Connected apps" ? <AppsTab /> : tab === "Skills" ? <SkillsTab /> : tab === "Routines & alerts" ? <RoutinesTab bots={bots} /> : tab === "Phone" ? <PhoneTab /> : tab === "Website & devices" ? <WebsiteTab /> : <MemoryTab />}
      </div>
    </>
  );
}

// ---------------- Bot editor ----------------
export function BotEditor({ bot, onClose }: { bot: Bot | null; onClose: (deleted?: boolean) => void }) {
  const [s] = useLoad<any>("settings");
  const [skills] = useLoad<any[]>("skills");
  const [b, setB] = useState<Partial<Bot>>(bot ?? { name: "", emoji: "🤖", color: "#6c5ce7", persona: "", approvalMode: "ask-risky", tools: { web: true, browser: true, apps: true, phone: false }, skills: [] });
  const set = (patch: Partial<Bot>) => setB({ ...b, ...patch });
  const save = run(async () => {
    if (bot) await api(`bots/${bot.id}`, { method: "PATCH", body: b });
    else await api("bots", { body: b });
    onClose();
  }, "Saved");
  const prov = s?.providers?.find((p: Provider) => p.id === b.providerId);
  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={() => onClose()}>
          ‹
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
          {prov ? (
            <div class="field">
              <label>Model</label>
              <input value={b.model ?? ""} onInput={(e) => set({ model: val(e) || null })} placeholder={prov.defaultModel} list="bot-models" />
              <datalist id="bot-models">
                {prov.models.map((m: string) => (
                  <option value={m} />
                ))}
              </datalist>
            </div>
          ) : null}
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
