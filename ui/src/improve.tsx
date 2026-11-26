import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import { IconBack } from "./icons.tsx";

/** Improver's suggestions: cards to approve, postpone or dismiss, plus settings and history. */
const toast = (m: string) => {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = m;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

const AREA: Record<string, string> = { routine: "🔁 Routine", skill: "🧩 Skill", code: "💻 Code", other: "⚙️ Other" };
const STATUS: Record<string, [string, string]> = {
  building: ["Building in the cloud…", "warn"],
  applied: ["Applied", "ok"],
  applying: ["Working on it…", "warn"],
  failed: ["Didn't work", "bad"],
  declined: ["Dismissed", ""],
  expired: ["Expired", ""],
};
const FIELD: Record<string, string> = { timeoutMinutes: "Time limit (minutes)", prompt: "Instructions", schedule: "Schedule", enabled: "Switched on", title: "Name" };
const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 1));
const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "—");

function Change({ p }: { p: any }) {
  if (p.routinePatch)
    return (
      <details>
        <summary class="muted">Exact change to “{p.routinePatch.routineTitle}”</summary>
        {Object.keys(p.routinePatch.after).map((k) => (
          <div>
            <b>{FIELD[k] ?? k}</b>
            <pre>− {show(p.routinePatch.before[k])}</pre>
            <pre>+ {show(p.routinePatch.after[k])}</pre>
          </div>
        ))}
      </details>
    );
  if (p.skill)
    return (
      <details>
        <summary class="muted">{p.skill.before ? "New version" : "New skill"}: {p.skill.name}</summary>
        <pre>{p.skill.after}</pre>
      </details>
    );
  return null;
}

function SuggestionCard({ p, onDone }: { p: any; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (what: "approve" | "snooze" | "dismiss") => {
    setBusy(true);
    try {
      const r = await api(`improve/${p.id}/${what}`, { method: "POST" });
      toast(what === "approve" ? (r.status === "applied" ? `✅ ${r.result}` : r.status === "building" ? "Building in the cloud — you'll get a notification" : r.status === "applying" ? "Approved — Improver is working on it" : `⚠️ ${r.result}`) : what === "snooze" ? "Moved to tomorrow" : "Dismissed");
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
    setBusy(false);
    onDone();
  };
  return (
    <div class="card improve-card">
      <div class="inline" style={{ gap: ".4rem", flexWrap: "wrap" }}>
        <span class="pill">{AREA[p.area] ?? p.area}</span>
        <span class={`pill ${p.risk === "low" ? "ok" : p.risk === "high" ? "bad" : "warn"}`}>{p.risk} risk</span>
      </div>
      <h3>{p.title}</h3>
      <p>
        <b>Problem:</b> {p.problem}
      </p>
      <p>
        <b>Change:</b> {p.change}
      </p>
      {p.evidence ? <p class="muted" style={{ fontSize: ".8rem" }}>Evidence: {p.evidence}</p> : null}
      <Change p={p} />
      {p.area === "code" && p.build?.prUrl ? (
        <p class="help">
          Built in the cloud and every test passed. <a href={p.build.prUrl} target="_blank" rel="noopener">See the changes</a>. Approve installs it; MausDroid restarts with it in a few minutes, and you can roll back below.
        </p>
      ) : p.area === "code" ? (
        <p class="help">Approving builds it in the cloud (Claude Code makes the change and runs every test), then asks you to install it.</p>
      ) : p.area === "other" ? (
        <p class="help">Approving hands this to Improver. Anything it needs to do that's risky still asks you first.</p>
      ) : null}
      <div class="actions">
        <button class="btn" disabled={busy} onClick={() => act("approve")}>
          {p.area === "code" && p.build?.prUrl ? "Install" : "Approve"}
        </button>
        <button class="btn secondary" disabled={busy} onClick={() => act("snooze")}>
          Not now
        </button>
        <button class="btn secondary" disabled={busy} onClick={() => act("dismiss")}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Adds a key to GitHub from a file on the phone (encrypted on the phone first). */
function FileSecret({ name, accept, onDone }: { name: string; accept: string; onDone: () => void }) {
  const pick = async (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    (e.target as HTMLInputElement).value = "";
    if (!f) return;
    try {
      await api("improve/cloud/secret", { body: { name, value: await f.text() } });
      toast("Saved to GitHub ✓");
    } catch (err) {
      toast(`⚠️ ${(err as Error).message}`);
    }
    onDone();
  };
  return (
    <label class="btn secondary small" style={{ display: "inline-block" }}>
      Add from file
      <input type="file" accept={accept} hidden onChange={pick} />
    </label>
  );
}

/** Cloud builds set-up: a checklist and "Connect with Claude" (all from the phone). */
function CloudSetup() {
  const [d, setD] = useState<any | null>(null);
  const [code, setCode] = useState("");
  const load = () => api("improve/cloud").then(setD).catch((e) => setD({ error: (e as Error).message }));
  useEffect(() => {
    void load();
  }, []);
  const busy = d?.connect?.stage === "signing-in" || d?.connect?.stage === "saving";
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [busy]);
  if (!d) return <p class="muted">Checking cloud build set-up…</p>;
  if (d.error) return <p class="help">⚠️ {d.error}</p>;
  const c = d.checklist;
  const has = (n: string) => c.secrets?.[n];
  const Row = ({ ok, children }: { ok: boolean | null | undefined; children: any }) => (
    <div style={{ padding: ".25rem 0" }}>
      {ok ? "✅" : ok === false ? "⬜" : "❔"} {children}
    </div>
  );
  const act = async (path: string, body: object = {}) => {
    try {
      setD({ ...d, connect: await api(path, { body }) });
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
    setTimeout(load, 800);
  };
  return (
    <div class="section">
      <h2>Cloud builds set-up</h2>
      <p class="help">What program changes built in the cloud need, in your GitHub repository {c.repo}. Keys are stored as GitHub secrets — they can't be read back, only replaced.</p>
      <Row ok={c.githubToken}>GitHub token on this phone</Row>
      {c.problem ? <p class="help">⚠️ {c.problem}</p> : null}
      <Row ok={has("CLAUDE_CODE_OAUTH_TOKEN")}>
        Claude key for cloud builds{" "}
        {!busy ? (
          <button class="btn small" disabled={!c.githubToken} onClick={() => act("improve/cloud/connect")}>
            {has("CLAUDE_CODE_OAUTH_TOKEN") ? "Reconnect" : "Connect with Claude"}
          </button>
        ) : null}
      </Row>
      {d.connect?.stage !== "idle" && d.connect?.message ? <p class="help">{d.connect.message}</p> : null}
      {d.connect?.loginUrl && busy ? (
        <p class="help">
          <a href={d.connect.loginUrl} target="_blank" rel="noopener">
            Open Claude's sign-in page
          </a>
        </p>
      ) : null}
      {d.connect?.needsCode ? (
        <div class="inline">
          <input value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value)} placeholder="Paste the code from Claude's page" />
          <button class="btn small" disabled={!code.trim()} onClick={() => (act("improve/cloud/code", { code }), setCode(""))}>
            Send
          </button>
        </div>
      ) : null}
      {busy ? (
        <button class="btn secondary small" onClick={() => act("improve/cloud/cancel")}>
          Cancel
        </button>
      ) : null}
      <Row ok={has("MAUSDROID_UPDATE_KEY_PEM")}>Update signing key (lets GitHub publish updates)</Row>
      {has("MAUSDROID_UPDATE_KEY_PEM") === false ? (
        <p class="help">
          Pick the file <b>update-signing-key.pem</b>: <FileSecret name="MAUSDROID_UPDATE_KEY_PEM" accept=".pem,text/plain,application/x-pem-file,*/*" onDone={load} />
        </p>
      ) : null}
      <Row ok={has("CODEX_AUTH_JSON") || has("OPENAI_API_KEY")}>Codex key (only if you choose GitHub + Codex)</Row>
      <button class="btn secondary small" onClick={load}>
        Check again
      </button>
    </div>
  );
}

function Settings({ o, onDone }: { o: any; onDone: () => void }) {
  const [s, setS] = useState({ ...o.settings });
  const save = async () => {
    try {
      await api("improve/settings", { method: "PUT", body: s });
      toast("Saved");
      onDone();
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
  };
  return (
    <div class="section">
      <h2>Settings</h2>
      <label class="inline">
        <input type="checkbox" checked={s.enabled} onChange={() => setS({ ...s, enabled: !s.enabled })} /> Nightly check on
      </label>
      <div class="field">
        <label>Check at night (takes 10 minutes at most)</label>
        <input type="time" value={s.nightTime} onInput={(e) => setS({ ...s, nightTime: (e.target as HTMLInputElement).value })} />
      </div>
      <div class="field">
        <label>Show suggestions at</label>
        <input type="time" value={s.showTime} onInput={(e) => setS({ ...s, showTime: (e.target as HTMLInputElement).value })} />
      </div>
      <div class="field">
        <label>Coding platform for program changes</label>
        <select value={s.codingPlatform ?? "github-claude"} onChange={(e) => setS({ ...s, codingPlatform: (e.target as HTMLSelectElement).value })}>
          <option value="github-claude">GitHub + Claude Code (your Claude subscription)</option>
          <option value="github-codex">GitHub + Codex (your ChatGPT subscription or an OpenAI key)</option>
          <option value="off">Off — only keep them as suggestions</option>
        </select>
        <p class="help">Changes are built in the cloud, in the background; you get progress updates and any questions. Each platform needs its key added on GitHub once (see the MausDroid repo: .github/workflows/improver.yml).</p>
      </div>
      <label class="inline">
        <input type="checkbox" checked={!s.askBeforeInstall} onChange={() => setS({ ...s, askBeforeInstall: !s.askBeforeInstall })} /> Program changes I ask Improver for install by themselves once every test passes
      </label>
      <p class="help">
        Bot: {o.bot ? `${o.bot.emoji} ${o.bot.name} (${o.bot.providerId ?? "default AI"}, ${o.bot.model ?? "default model"})` : "none"} — change its AI and model by editing the bot. At most 5 suggestions a night. Nothing changes without your approval.
      </p>
      <button class="btn" onClick={save}>
        Save
      </button>
    </div>
  );
}

/** One cloud build: its progress, and any questions with an answer box. */
function BuildItem({ p, onDone }: { p: any; onDone: () => void }) {
  const [ans, setAns] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await api(`improve/${p.id}/answer`, { body: { answers: ans } });
      toast("Sent — carrying on");
      setAns("");
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
    setBusy(false);
    onDone();
  };
  return (
    <div style={{ padding: ".4rem 0", borderBottom: "1px solid var(--panel2)" }}>
      <span class={`pill ${p.build?.questions ? "bad" : "warn"}`}>{p.build?.questions ? "needs your answers" : "building"}</span> <b>{p.title}</b>{" "}
      {p.build?.runUrl ? (
        <a href={p.build.runUrl} target="_blank" rel="noopener">
          details
        </a>
      ) : null}
      <div class="muted" style={{ fontSize: ".82rem" }}>
        {p.build?.progress ?? "Starting"} · started {when(p.build?.startedAt)}
        {p.build?.attempt > 1 ? ` · round ${p.build.attempt}` : ""}
      </div>
      {p.build?.questions ? (
        <>
          <pre style={{ whiteSpace: "pre-wrap" }}>{p.build.questions}</pre>
          <textarea rows={3} value={ans} onInput={(e) => setAns((e.target as HTMLTextAreaElement).value)} placeholder="Your answers (or tell Improver in its chat)" />
          <button class="btn small" disabled={busy || !ans.trim()} onClick={send}>
            Send answers
          </button>
        </>
      ) : null}
    </div>
  );
}

const older = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
};

/** Program versions on the phone, with roll back. */
function Versions({ v, onDone }: { v: any; onDone: () => void }) {
  if (!v?.versions?.length) return null;
  const back = async (version: string) => {
    if (!confirm(`Go back to version ${version}? MausDroid restarts for a moment.`)) return;
    try {
      const r = await api("improve/rollback", { body: { version } });
      toast(`Going back from ${r.from} to ${r.to} — restarting…`);
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
    onDone();
  };
  return (
    <div class="section">
      <h2>Versions on this phone</h2>
      <p class="help">Running {v.running}. If an update causes trouble, go back to an earlier one — that update won't be installed again.</p>
      {v.versions.map((x: any) => (
        <div class="toggle">
          <span>
            {x.version} {x.running ? <span class="pill ok">running</span> : null} {x.bad ? <span class="pill">set aside</span> : null}
          </span>
          {x.running ? null : (
            <button class="btn secondary small" onClick={() => back(x.version)}>
              {older(x.version, v.running) ? "Roll back" : "Switch"}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function Improve({ onBack, openBot }: { onBack: () => void; openBot: (id: string) => void }) {
  const [o, setO] = useState<any | null>(null);
  const [mode, setMode] = useState<"view" | "settings">("view");
  const load = () => api("improve").then(setO).catch((e) => toast(`⚠️ ${(e as Error).message}`));
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const runNow = async () => {
    try {
      await api("improve/run", { method: "POST" });
      toast("Checking now — suggestions appear at the show time, or tap “Show now”.");
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
  };
  const revealNow = async () => {
    await api("improve/reveal", { method: "POST" }).catch(() => {});
    void load();
  };
  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={mode === "settings" ? () => setMode("view") : onBack} aria-label="Back">
          <IconBack />
        </button>
        <h1>{mode === "settings" ? "Improver settings" : "Improvements"}</h1>
        {mode === "view" ? (
          <button class="btn secondary small" onClick={() => setMode("settings")}>
            Settings
          </button>
        ) : null}
      </div>
      <div class="page">
        {!o ? (
          <p class="muted">Loading…</p>
        ) : mode === "settings" ? (
          <>
            <Settings o={o} onDone={() => (setMode("view"), load())} />
            <CloudSetup />
          </>
        ) : (
          <>
            <p class="help">
              {o.bot ? `${o.bot.emoji} ${o.bot.name}` : "Improver"} checks MausDroid each night at {o.settings.nightTime} and suggests up to 5 fixes, shown here at {o.settings.showTime}. Last check: {o.lastNight ? `${when(o.lastNight.startedAt)} — ${o.lastNight.summary ?? (o.lastNight.finishedAt ? "done" : "incomplete")}` : "not yet"}. Next: {when(o.routine?.nextRunAt)}.
            </p>
            <div class="inline" style={{ gap: ".5rem", flexWrap: "wrap" }}>
              <button class="btn secondary small" onClick={runNow}>
                Check now
              </button>
              {o.waiting ? (
                <button class="btn secondary small" onClick={revealNow}>
                  Show now ({o.waiting} waiting)
                </button>
              ) : null}
              {o.bot ? (
                <button class="btn secondary small" onClick={() => openBot(o.bot.id)}>
                  Open {o.bot.name}'s chat
                </button>
              ) : null}
            </div>
            {o.shown.length ? o.shown.map((p: any) => <SuggestionCard p={p} onDone={load} />) : <div class="empty">No suggestions to review right now.</div>}
            {o.building?.length ? (
              <div class="section">
                <h2>Building in the cloud</h2>
                {o.building.map((p: any) => (
                  <BuildItem p={p} onDone={load} />
                ))}
                <button class="btn secondary small" onClick={async () => (await api("improve/check-builds", { body: {} }).catch(() => {}), load())}>
                  Check now
                </button>
              </div>
            ) : null}
            <Versions v={o.versions} onDone={load} />
            {o.history.length ? (
              <div class="section">
                <h2>Earlier</h2>
                {o.history.map((p: any) => (
                  <details class="row-detail">
                    <summary>
                      <span class={`pill ${STATUS[p.status]?.[1] ?? ""}`}>{STATUS[p.status]?.[0] ?? p.status}</span> {p.title}
                    </summary>
                    <p class="muted">{p.change}</p>
                    {p.result ? <pre>{p.result}</pre> : null}
                  </details>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
