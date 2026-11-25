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
      toast(what === "approve" ? (r.status === "applied" ? `✅ ${r.result}` : r.status === "applying" ? "Approved — Improver is working on it" : `⚠️ ${r.result}`) : what === "snooze" ? "Moved to tomorrow" : "Dismissed");
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
      {p.area === "code" || p.area === "other" ? <p class="help">Approving hands this to Improver. Anything it needs to do that's risky still asks you first.</p> : null}
      <div class="actions">
        <button class="btn" disabled={busy} onClick={() => act("approve")}>
          Approve
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
      <p class="help">
        Bot: {o.bot ? `${o.bot.emoji} ${o.bot.name} (${o.bot.providerId ?? "default AI"}, ${o.bot.model ?? "default model"})` : "none"} — change its AI and model by editing the bot. At most 5 suggestions a night. Nothing changes without your approval.
      </p>
      <button class="btn" onClick={save}>
        Save
      </button>
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
          <Settings o={o} onDone={() => (setMode("view"), load())} />
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
