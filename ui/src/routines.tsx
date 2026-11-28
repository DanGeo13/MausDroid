import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import type { Bot } from "./types.ts";

/**
 * Routines: list, create/edit with the four options (Upon Alert, Once a
 * Day, Once a Week, Custom), a live preview, and each routine's run history.
 */
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const OPTIONS = [
  { kind: "alert", label: "Upon Alert", hint: "When an alert or event arrives" },
  { kind: "daily", label: "Once a Day", hint: "At a set time" },
  { kind: "weekly", label: "Once a Week", hint: "On chosen weekdays" },
  { kind: "custom", label: "Custom", hint: "Intervals, dates, repeats" },
] as const;
const SCHEDULE_TEMPLATES = ["Kids care routine", "Work routine"] as const;
type ScheduleTemplate = (typeof SCHEDULE_TEMPLATES)[number];

const STATUS: Record<string, string> = { succeeded: "ok", failed: "bad", timed_out: "bad", missed: "warn", skipped: "warn", running: "warn", queued: "" };

const v = (e: Event) => (e.target as HTMLInputElement).value;
const toast = (m: string) => {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = m;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

function Days({ value, onChange }: { value: number[]; onChange: (d: number[]) => void }) {
  return (
    <div class="seg" style={{ flexWrap: "wrap" }}>
      {DAYS.map((d, i) => (
        <button class={value.includes(i) ? "on" : ""} onClick={() => onChange(value.includes(i) ? value.filter((x) => x !== i) : [...value, i].sort())}>
          {d}
        </button>
      ))}
    </div>
  );
}

function Editor({ bots, routine, template, onDone }: { bots: Bot[]; routine?: any; template?: ScheduleTemplate; onDone: () => void }) {
  const sc = routine?.schedule ?? {};
  const [botId, setBotId] = useState(routine?.botId ?? bots[0]?.id);
  const [title, setTitle] = useState(routine?.title ?? template ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [kind, setKind] = useState<string>(["daily", "weekly", "alert", "custom"].includes(sc.kind) ? sc.kind : sc.kind === "interval" ? "custom" : template ? "weekly" : "daily");
  const [time, setTime] = useState(sc.time ?? "07:30");
  const [days, setDays] = useState<number[]>(sc.days ?? [1, 2, 3, 4, 5]);
  const [tz, setTz] = useState(sc.timeZone ?? "local");
  const [mode, setMode] = useState(sc.custom?.mode ?? (sc.kind === "interval" ? "interval" : "interval"));
  const [minutes, setMinutes] = useState(sc.custom?.minutes ?? sc.minutes ?? 60);
  const [dates, setDates] = useState<string>((sc.custom?.dates ?? []).join("\n"));
  const [everyDays, setEveryDays] = useState(sc.custom?.everyDays ?? 1);
  const [times, setTimes] = useState<string>((sc.custom?.times ?? ["08:00"]).join(", "));
  const [cdays, setCdays] = useState<number[]>(sc.custom?.days ?? []);
  const [useWindow, setUseWindow] = useState(Boolean(sc.window));
  const [wStart, setWStart] = useState(sc.window?.start ?? "08:00");
  const [wEnd, setWEnd] = useState(sc.window?.end ?? "17:00");
  const [conditions, setConditions] = useState(sc.conditions ?? "");
  const [aType, setAType] = useState(sc.alert?.type ?? "");
  const [aSource, setASource] = useState(sc.alert?.source ?? "");
  const [aContains, setAContains] = useState(sc.alert?.contains ?? "");
  const [aPriority, setAPriority] = useState(sc.alert?.minPriority ?? "low");
  const [missed, setMissed] = useState(sc.missedPolicy ?? "run-once");
  const [preview, setPreview] = useState<{ text: string | null; problems: string[]; upcoming: string[] } | null>(null);

  const schedule = () => {
    const s: any = { kind, conditions: conditions || undefined, missedPolicy: missed, timeZone: tz === "local" ? undefined : tz };
    if (kind === "daily" || kind === "weekly") s.time = time;
    if (kind === "weekly") s.days = days;
    if (kind === "alert") s.alert = { type: aType || undefined, source: aSource || undefined, contains: aContains || undefined, minPriority: aPriority };
    if (kind === "custom")
      s.custom =
        mode === "interval"
          ? { mode, minutes: Number(minutes) }
          : mode === "dates"
            ? { mode, dates: dates.split(/[\n,]+/).map((x) => x.trim().replace(" ", "T")).filter(Boolean) }
            : { mode, everyDays: Number(everyDays), times: times.split(/[ ,]+/).filter(Boolean), days: cdays.length ? cdays : undefined };
    if (useWindow && kind !== "alert") s.window = { start: wStart, end: wEnd };
    return s;
  };

  useEffect(() => {
    const t = setTimeout(() => void api("routines/preview", { body: { schedule: schedule() } }).then(setPreview).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [kind, time, days.join(), tz, mode, minutes, dates, everyDays, times, cdays.join(), useWindow, wStart, wEnd, conditions, aType, aSource, aContains, aPriority]);

  const save = async () => {
    try {
      const body = { botId, title, prompt, schedule: schedule() };
      if (routine) await api(`routines/${routine.id}`, { method: "PATCH", body: { title, prompt, schedule: body.schedule } });
      else await api("routines", { body });
      toast(routine ? "Routine updated" : "Routine created");
      onDone();
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
  };

  return (
    <div class="section">
      <h2>{routine ? `Edit “${routine.title}”` : "New routine"}</h2>
      <div class="field">
        <label>Name</label>
        <input value={title} onInput={(e) => setTitle(v(e))} placeholder="e.g. Morning brief" />
      </div>
      {!routine ? (
        <div class="field">
          <label>Bot</label>
          <select value={botId} onChange={(e) => setBotId(v(e))}>
            {bots.map((b) => (
              <option value={b.id}>
                {b.emoji} {b.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div class="field">
        <label>What should the bot do each time?</label>
        <textarea rows={4} value={prompt} onInput={(e) => setPrompt(v(e))} placeholder="e.g. Check my calendar and Staff Update, then send me a short brief." />
      </div>
      <div class="field">
        <label>When</label>
        <div class="grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
          {OPTIONS.map((o) => (
            <button class="app-tile" style={kind === o.kind ? { outline: "2px solid var(--accent)" } : {}} onClick={() => setKind(o.kind)}>
              <strong>{o.label}</strong>
              <span class="muted" style={{ fontSize: ".78rem" }}>
                {o.hint}
              </span>
            </button>
          ))}
        </div>
      </div>
      {kind === "daily" || kind === "weekly" ? (
        <>
          {kind === "weekly" ? (
            <div class="field">
              <label>Days</label>
              <Days value={days} onChange={setDays} />
            </div>
          ) : null}
          <div class="field">
            <label>Time</label>
            <input type="time" value={time} onInput={(e) => setTime(v(e))} />
          </div>
        </>
      ) : null}
      {kind === "alert" ? (
        <>
          <div class="field">
            <label>From (source contains)</label>
            <input value={aSource} onInput={(e) => setASource(v(e))} placeholder="e.g. Compass, Gmail, Inbox bot (empty = any)" />
          </div>
          <div class="field">
            <label>Mentions (optional)</label>
            <input value={aContains} onInput={(e) => setAContains(v(e))} placeholder="e.g. excursion" />
          </div>
          <div class="inline">
            <select value={aType} onChange={(e) => setAType(v(e))}>
              <option value="">Any kind of alert</option>
              <option value="bot-alert">Bot alerts</option>
              <option value="app-event">App events</option>
              <option value="phone-notification">Phone notifications</option>
              <option value="routine-result">Routine results</option>
              <option value="external">From other apps</option>
              <option value="share">Things I share to DanDroid</option>
            </select>
            <select value={aPriority} onChange={(e) => setAPriority(v(e))}>
              <option value="low">Any priority</option>
              <option value="normal">Normal and high</option>
              <option value="high">High only</option>
            </select>
          </div>
          <p class="help">The same event never starts it twice within an hour.</p>
        </>
      ) : null}
      {kind === "custom" ? (
        <>
          <div class="seg" style={{ marginBottom: ".6rem" }}>
            {(
              [
                ["interval", "Every X minutes"],
                ["dates", "Specific dates"],
                ["recurring", "Repeat"],
              ] as const
            ).map(([k, l]) => (
              <button class={mode === k ? "on" : ""} onClick={() => setMode(k)}>
                {l}
              </button>
            ))}
          </div>
          {mode === "interval" ? (
            <div class="field">
              <label>Minutes between runs (15 or more)</label>
              <input type="number" min="15" value={minutes} onInput={(e) => setMinutes(Number(v(e)))} />
            </div>
          ) : mode === "dates" ? (
            <div class="field">
              <label>Dates and times, one per line (YYYY-MM-DD HH:MM)</label>
              <textarea rows={3} value={dates} onInput={(e) => setDates(v(e))} placeholder={"2026-12-01 07:30\n2026-12-15 16:00"} />
            </div>
          ) : (
            <>
              <div class="inline">
                <label class="muted">Every</label>
                <input type="number" min="1" style={{ maxWidth: "5rem" }} value={everyDays} onInput={(e) => setEveryDays(Number(v(e)))} />
                <label class="muted">day(s) at</label>
                <input value={times} onInput={(e) => setTimes(v(e))} placeholder="08:00, 15:00" />
              </div>
              <div class="field" style={{ marginTop: ".5rem" }}>
                <label>Only on (optional)</label>
                <Days value={cdays} onChange={setCdays} />
              </div>
            </>
          )}
        </>
      ) : null}
      {kind !== "alert" ? (
        <>
          <label class="toggle">
            <span>Only between certain times</span>
            <input type="checkbox" checked={useWindow} onChange={() => setUseWindow(!useWindow)} />
          </label>
          {useWindow ? (
            <div class="inline">
              <input type="time" value={wStart} onInput={(e) => setWStart(v(e))} />
              <span class="muted">to</span>
              <input type="time" value={wEnd} onInput={(e) => setWEnd(v(e))} />
            </div>
          ) : null}
          <div class="field" style={{ marginTop: ".5rem" }}>
            <label>Time zone</label>
            <select value={tz} onChange={(e) => setTz(v(e))}>
              <option value="local">Phone's time zone</option>
              <option value="Australia/Sydney">Australia/Sydney</option>
              <option value="Australia/Brisbane">Australia/Brisbane</option>
              <option value="Australia/Perth">Australia/Perth</option>
              <option value="UTC">UTC</option>
            </select>
          </div>
          <div class="field">
            <label>If the phone misses a run</label>
            <select value={missed} onChange={(e) => setMissed(v(e))}>
              <option value="run-once">Run it once when possible (up to 12 hours late)</option>
              <option value="skip">Skip it</option>
            </select>
          </div>
        </>
      ) : null}
      <div class="field">
        <label>Only if (optional condition the bot checks)</label>
        <input value={conditions} onInput={(e) => setConditions(v(e))} placeholder="e.g. it's a school day" />
      </div>
      <div class="section" style={{ background: "var(--panel2)", boxShadow: "none" }}>
        {preview?.problems.length ? (
          <span style={{ color: "var(--danger)" }}>⚠️ {preview.problems.join(" ")}</span>
        ) : (
          <>
            <strong>{preview?.text ?? "…"}</strong>
            {preview?.upcoming.length ? (
              <div class="muted" style={{ fontSize: ".8rem", marginTop: ".3rem" }}>
                Next: {preview.upcoming.map((x) => new Date(x).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })).join(" · ")}
              </div>
            ) : null}
          </>
        )}
      </div>
      <div class="inline">
        <button class="btn" disabled={!title.trim() || !prompt.trim() || Boolean(preview?.problems.length)} onClick={save}>
          {routine ? "Save changes" : "Create routine"}
        </button>
        <button class="btn secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function History({ id }: { id: string }) {
  const [runs, setRuns] = useState<any[] | null>(null);
  useEffect(() => void api(`routines/${id}/runs?limit=15`).then(setRuns), [id]);
  if (!runs) return <p class="muted">Loading…</p>;
  if (!runs.length) return <p class="muted">No runs yet.</p>;
  return (
    <div style={{ marginTop: ".5rem" }}>
      {runs.map((r) => (
        <div style={{ padding: ".4rem 0", borderTop: "1px solid var(--line)", fontSize: ".82rem" }}>
          <span class={`pill ${STATUS[r.status] ?? ""}`}>{r.status.replace("_", " ")}</span> {new Date(r.queuedAt).toLocaleString()} · {r.trigger}
          {r.attempt > 1 ? ` · attempt ${r.attempt}` : ""}
          {r.result || r.error ? <div class="muted">{(r.result ?? r.error).slice(0, 240)}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function Routines({ bots }: { bots: Bot[] }) {
  const [list, setList] = useState<any[] | null>(null);
  const [editing, setEditing] = useState<{ routine?: any; template?: ScheduleTemplate } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const reload = () => void api("routines").then(setList);
  useEffect(reload, []);
  const name = (id: string) => {
    const b = bots.find((x) => x.id === id);
    return b ? `${b.emoji} ${b.name}` : "?";
  };
  const act = (p: Promise<unknown>, msg?: string) =>
    p.then(() => (msg && toast(msg), reload())).catch((e) => toast(`⚠️ ${(e as Error).message}`));
  if (editing) return <Editor bots={bots} {...editing} onDone={() => (setEditing(null), reload())} />;
  return (
    <>
      <div class="section">
        <h2>Scheduling</h2>
        <p class="help">Choose the days and time, then tell your bot what to do.</p>
        <div class="inline">
          {SCHEDULE_TEMPLATES.map((name) => (
            <button class="btn secondary" key={name} disabled={!bots.length} onClick={() => setEditing({ template: name })}>
              {name}
            </button>
          ))}
        </div>
      </div>
      <div class="section">
        <div class="inline" style={{ justifyContent: "space-between" }}>
          <h2>Routines</h2>
          <button class="btn small" onClick={() => setEditing({})}>
            + New routine
          </button>
        </div>
        <p class="help">Or ask a bot: “every weekday at 7am give me a briefing”, “when Compass posts a notice, summarise it”.</p>
        {!list ? <p class="muted">Loading…</p> : !list.length ? <p class="muted">No routines yet.</p> : null}
        {list?.map((r) => (
          <div style={{ padding: ".7rem 0", borderTop: "1px solid var(--line)" }}>
            <div class="inline" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
              <div style={{ minWidth: 0 }}>
                <strong>{r.title}</strong> <span class="muted">· {name(r.botId)}</span> {!r.enabled ? <span class="pill">paused</span> : null}
                <div class="muted" style={{ fontSize: ".82rem" }}>{r.scheduleText}</div>
                <div class="muted" style={{ fontSize: ".78rem" }}>
                  Next: {r.nextRunAt ? new Date(r.nextRunAt).toLocaleString() : r.schedule.kind === "alert" ? "when an alert matches" : "—"}
                  {r.lastResult ? (
                    <>
                      {" "}
                      · Last: <span class={`pill ${STATUS[r.lastResult.status] ?? ""}`}>{r.lastResult.status.replace("_", " ")}</span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
            <div class="inline" style={{ marginTop: ".4rem" }}>
              <button class="btn secondary small" onClick={() => act(api(`routines/${r.id}/run`, { body: {} }), "Started — see History")}>
                Run now
              </button>
              <button class="btn secondary small" onClick={() => act(api(`routines/${r.id}/${r.enabled ? "pause" : "resume"}`, { body: {} }))}>
                {r.enabled ? "Pause" : "Resume"}
              </button>
              <button class="btn secondary small" onClick={() => setEditing({ routine: r })}>
                Edit
              </button>
              <button class="btn secondary small" onClick={() => setOpen(open === r.id ? null : r.id)}>
                History
              </button>
              <button class="btn secondary small" onClick={() => confirm(`Delete “${r.title}”?`) && act(api(`routines/${r.id}`, { method: "DELETE" }), "Deleted")}>
                Delete
              </button>
            </div>
            {open === r.id ? <History id={r.id} /> : null}
          </div>
        ))}
      </div>
    </>
  );
}
