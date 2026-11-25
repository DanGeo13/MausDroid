import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import { IconBack } from "./icons.tsx";

/** The full Morning Brief (notifications just link here). */
const v = (e: Event) => (e.target as HTMLInputElement).value;
const toast = (m: string) => {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = m;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

function Section({ title, children }: { title: string; children: any }) {
  return (
    <div class="section">
      <h2>{title}</h2>
      {children}
    </div>
  );
}

function BriefSettings({ onDone }: { onDone: () => void }) {
  const [s, setS] = useState<any | null>(null);
  useEffect(() => void api("brief/settings").then(setS), []);
  if (!s) return <p class="muted">Loading…</p>;
  const p = s.prefs;
  const setP = (patch: any) => setS({ ...s, prefs: { ...p, ...patch } });
  const confirmed = (k: string) => p.confirmed.includes(k);
  const tick = (k: string) => setP({ confirmed: confirmed(k) ? p.confirmed.filter((x: string) => x !== k) : [...p.confirmed, k] });
  const Conf = ({ k }: { k: string }) => (
    <label class="muted" style={{ fontSize: ".78rem", display: "inline-flex", gap: ".3rem", alignItems: "center" }}>
      <input type="checkbox" checked={confirmed(k)} onChange={() => tick(k)} /> {confirmed(k) ? "confirmed" : "assumed — tick to confirm"}
    </label>
  );
  const terms = s.terms;
  const setTerms = (t: any) => setS({ ...s, terms: t });
  const save = async () => {
    try {
      await api("brief/settings", { method: "PUT", body: s });
      toast("Morning Brief settings saved");
      onDone();
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
  };
  return (
    <>
      <Section title="Sources">
        <div class="field">
          <label>Staff Update: words in its title or text</label>
          <input value={p.staffUpdateTerms.join(", ")} onInput={(e) => setP({ staffUpdateTerms: v(e).split(",").map((x) => x.trim()).filter(Boolean) })} />
          <Conf k="staffUpdateTerms" />
        </div>
        <div class="field">
          <label>Sport matrix spreadsheet (link)</label>
          <input value={p.sportSheet} onInput={(e) => setP({ sportSheet: v(e) })} placeholder="https://docs.google.com/spreadsheets/d/…" />
          <Conf k="sportSheet" />
        </div>
        <div class="field">
          <label>Your name / staff code as written on the sport matrix</label>
          <input value={p.identifiers.join(", ")} onInput={(e) => setP({ identifiers: v(e).split(",").map((x) => x.trim()).filter(Boolean) })} placeholder="e.g. Geoghegan, DGE" />
          <Conf k="identifiers" />
        </div>
      </Section>
      <Section title="Preferences">
        <div class="field">
          <label>What the brief should contain</label>
          <textarea rows={3} value={p.content} onInput={(e) => setP({ content: v(e) })} />
          <Conf k="content" />
        </div>
        <div class="field">
          <label>When information is missing</label>
          <select value={p.missingInfo} onChange={(e) => setP({ missingInfo: v(e) })}>
            <option value="warn">Say what's missing in the brief</option>
            <option value="ask">Ask me</option>
          </select>
          <Conf k="missingInfo" />
        </div>
        <div class="field">
          <label>Calendar events found in documents</label>
          <select value={p.eventCreation} onChange={(e) => setP({ eventCreation: v(e) })}>
            <option value="propose">Propose them for my approval</option>
            <option value="never">Don't propose events</option>
          </select>
          <Conf k="eventCreation" />
        </div>
        <div class="field">
          <label>On holidays and pupil-free days</label>
          <select value={p.holidays} onChange={(e) => setP({ holidays: v(e) })}>
            <option value="short">Short brief</option>
            <option value="skip">No brief</option>
          </select>
          <Conf k="holidays" />
        </div>
        <p class="help">Calendar destination: Settings → Connected apps → Calendars.</p>
      </Section>
      <Section title="School terms (CMW)">
        <p class="help">Enter the school's confirmed dates (CMW's can differ from NSW public schools). Tick "confirmed" once checked against the official calendar.</p>
        {terms.terms.map((t: any, i: number) => (
          <div class="inline" style={{ marginBottom: ".4rem" }}>
            <input style={{ maxWidth: "7rem" }} value={t.name} onInput={(e) => (terms.terms[i] = { ...t, name: v(e) }, setTerms({ ...terms }))} />
            <input type="date" value={t.start} onInput={(e) => (terms.terms[i] = { ...t, start: v(e) }, setTerms({ ...terms }))} />
            <input type="date" value={t.end} onInput={(e) => (terms.terms[i] = { ...t, end: v(e) }, setTerms({ ...terms }))} />
            <label class="muted" style={{ fontSize: ".78rem" }}>
              <input type="checkbox" checked={t.confirmed} onChange={() => (terms.terms[i] = { ...t, confirmed: !t.confirmed }, setTerms({ ...terms }))} /> confirmed
            </label>
            <button class="btn secondary small" onClick={() => (terms.terms.splice(i, 1), setTerms({ ...terms }))}>
              ✕
            </button>
          </div>
        ))}
        <button class="btn secondary small" onClick={() => setTerms({ ...terms, terms: [...terms.terms, { name: `Term ${terms.terms.length + 1}`, start: "", end: "", confirmed: false }] })}>
          + Add term
        </button>
        <h2 style={{ marginTop: "1rem" }}>Holidays, pupil-free days, events</h2>
        {terms.days.map((d: any, i: number) => (
          <div class="inline" style={{ marginBottom: ".4rem" }}>
            <input style={{ maxWidth: "9rem" }} value={d.name} onInput={(e) => (terms.days[i] = { ...d, name: v(e) }, setTerms({ ...terms }))} />
            <select style={{ maxWidth: "9rem" }} value={d.kind} onChange={(e) => (terms.days[i] = { ...d, kind: v(e) }, setTerms({ ...terms }))}>
              <option value="pupil-free">Pupil-free</option>
              <option value="public-holiday">Public holiday</option>
              <option value="holiday">Holiday</option>
              <option value="event">School event</option>
            </select>
            <input type="date" value={d.start} onInput={(e) => (terms.days[i] = { ...d, start: v(e), end: d.end || v(e) }, setTerms({ ...terms }))} />
            <input type="date" value={d.end} onInput={(e) => (terms.days[i] = { ...d, end: v(e) }, setTerms({ ...terms }))} />
            <label class="muted" style={{ fontSize: ".78rem" }}>
              <input type="checkbox" checked={d.confirmed} onChange={() => (terms.days[i] = { ...d, confirmed: !d.confirmed }, setTerms({ ...terms }))} /> confirmed
            </label>
            <button class="btn secondary small" onClick={() => (terms.days.splice(i, 1), setTerms({ ...terms }))}>
              ✕
            </button>
          </div>
        ))}
        <button class="btn secondary small" onClick={() => setTerms({ ...terms, days: [...terms.days, { name: "", start: "", end: "", kind: "pupil-free", confirmed: false }] })}>
          + Add day
        </button>
      </Section>
      <div class="inline" style={{ marginBottom: "2rem" }}>
        <button class="btn" onClick={save}>
          Save
        </button>
        <button class="btn secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </>
  );
}

export function Briefing({ initialId, onBack }: { initialId?: string; onBack: () => void }) {
  const [list, setList] = useState<any[] | null>(null);
  const [b, setB] = useState<any | null>(null);
  const [id, setId] = useState<string | undefined>(initialId);
  const [mode, setMode] = useState<"view" | "settings">("view");
  const [routine, setRoutine] = useState<any | null | undefined>(undefined);
  const load = () => {
    void api("briefings").then((l) => {
      setList(l);
      const want = id ?? l[0]?.id;
      if (want) void api(`briefings/${want}`).then(setB).catch(() => setB(null));
    });
    void api("brief/routine").then(setRoutine);
  };
  useEffect(load, [id]);
  useEffect(() => {
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [id]);
  const decide = async (eid: string, approve: boolean) => {
    try {
      const r = await api(`briefings/${b.id}/events/${eid}`, { body: { approve } });
      toast(r.status === "added" ? "Added to your calendar ✓" : r.status === "duplicate" ? "Already in your calendar" : r.status === "dismissed" ? "Dismissed" : `⚠️ ${r.detail}`);
      load();
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
  };
  const refresh = async () => {
    try {
      await api("brief/refresh", { body: {} });
      toast("Preparing a fresh brief… it appears here when ready.");
      setTimeout(load, 1500);
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    }
  };
  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={mode === "settings" ? () => setMode("view") : onBack} aria-label="Back">
          <IconBack />
        </button>
        <h1>{mode === "settings" ? "Morning Brief settings" : "Morning Brief"}</h1>
        {mode === "view" ? (
          <>
            <button class="btn secondary small" onClick={refresh}>
              Refresh
            </button>
            <button class="btn secondary small" onClick={() => setMode("settings")}>
              Settings
            </button>
          </>
        ) : null}
      </div>
      <div class="page">
        {mode === "settings" ? (
          <BriefSettings onDone={() => (setMode("view"), load())} />
        ) : !list ? (
          <p class="muted">Loading…</p>
        ) : !b ? (
          <div class="empty">
            <div class="big">📰</div>
            <p>No briefing yet.</p>
            <p class="help">{routine ? `The “${routine.title}” routine runs ${routine.scheduleText.toLowerCase()}.` : "Set it up, then tap Refresh to make the first one."}</p>
            <div class="inline" style={{ justifyContent: "center" }}>
              <button class="btn" onClick={refresh}>
                Make today's brief
              </button>
              <button class="btn secondary" onClick={() => setMode("settings")}>
                Settings
              </button>
            </div>
          </div>
        ) : (
          <>
            {list.length > 1 ? (
              <select style={{ marginBottom: ".8rem" }} value={b.id} onChange={(e) => setId(v(e))}>
                {list.map((x) => (
                  <option value={x.id}>
                    {x.date} · {new Date(x.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                    {x.warnings ? ` · ${x.warnings} to check` : ""}
                  </option>
                ))}
              </select>
            ) : null}
            <div class="section">
              <div class="muted" style={{ fontSize: ".85rem" }}>
                {new Date(`${b.date}T12:00:00`).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })} · <span class={`pill ${b.day.schoolDay ? "ok" : "warn"}`}>{b.day.schoolDay ? "school day" : "no school"}</span> {b.day.reason}
              </div>
              <div style={{ marginTop: ".6rem" }}>
                <Markdown text={b.summary} />
              </div>
            </div>
            {b.warnings.length ? (
              <div class="section" style={{ boxShadow: "inset 0 0 0 1.5px var(--warn)" }}>
                <h2>⚠️ To check</h2>
                {b.warnings.map((w: string) => (
                  <p style={{ margin: ".3rem 0", fontSize: ".88rem" }}>{w}</p>
                ))}
              </div>
            ) : null}
            <Section title="Today">
              {b.schedule.length ? (
                b.schedule.map((e: any) => (
                  <div class="toggle">
                    <span>
                      <strong>{e.time}</strong> {e.title}
                    </span>
                    <span class="muted" style={{ fontSize: ".75rem" }}>
                      {e.calendar}
                    </span>
                  </div>
                ))
              ) : (
                <p class="muted">Nothing in your calendars.</p>
              )}
              {b.day.events?.length ? <p class="help">School events: {b.day.events.join(", ")}</p> : null}
            </Section>
            <Section title="Staff Update">
              {b.staffUpdate ? (
                <>
                  <p style={{ margin: "0 0 .4rem" }}>
                    <a href={b.staffUpdate.link} target="_blank" rel="noopener">
                      {b.staffUpdate.name}
                    </a>{" "}
                    <span class="muted" style={{ fontSize: ".78rem" }}>
                      updated {new Date(b.staffUpdate.modified).toLocaleDateString()}
                    </span>
                  </p>
                  {b.staffUpdate.summary ? <Markdown text={b.staffUpdate.summary} /> : null}
                </>
              ) : (
                <p class="muted">This week's Staff Update wasn't found.</p>
              )}
            </Section>
            <Section title="Thursday sport">
              {b.sport?.sheet ? (
                <>
                  <p class="help">From tab “{b.sport.sheet}”</p>
                  {b.sport.rows.length ? (
                    <table style={{ width: "100%", fontSize: ".88rem", borderCollapse: "collapse" }}>
                      {b.sport.rows.map((r: string[]) => (
                        <tr>
                          {r.map((c) => (
                            <td style={{ padding: ".3rem", borderBottom: "1px solid var(--line)" }}>{c}</td>
                          ))}
                        </tr>
                      ))}
                    </table>
                  ) : (
                    <p class="muted">No rows for you on this week's sheet.</p>
                  )}
                </>
              ) : (
                <p class="muted">This week's sport sheet isn't available (see “To check”).</p>
              )}
            </Section>
            {b.notices.length ? (
              <Section title="Notices">
                {b.notices.map((n: string) => (
                  <p style={{ margin: ".3rem 0", fontSize: ".88rem" }}>• {n}</p>
                ))}
              </Section>
            ) : null}
            <Section title="Calendar">
              <p class="help">{b.calendarStatus}</p>
              {b.proposedEvents.length ? (
                b.proposedEvents.map((e: any) => (
                  <div style={{ padding: ".5rem 0", borderTop: "1px solid var(--line)" }}>
                    <strong>{e.summary}</strong>{" "}
                    <span class="muted" style={{ fontSize: ".8rem" }}>
                      {e.start.replace("T", " ")}
                      {e.durationMinutes ? ` · ${e.durationMinutes} min` : ""}
                    </span>
                    {e.reason ? <div class="muted" style={{ fontSize: ".8rem" }}>{e.reason}</div> : null}
                    {e.status === "proposed" || e.status === "failed" ? (
                      <div class="inline" style={{ marginTop: ".4rem" }}>
                        <button class="btn small" onClick={() => decide(e.id, true)}>
                          Add to calendar
                        </button>
                        <button class="btn secondary small" onClick={() => decide(e.id, false)}>
                          Dismiss
                        </button>
                        {e.status === "failed" ? <span class="pill bad">{e.detail}</span> : null}
                      </div>
                    ) : (
                      <div>
                        <span class={`pill ${e.status === "added" ? "ok" : ""}`}>{e.status}</span> <span class="muted" style={{ fontSize: ".78rem" }}>{e.detail}</span>
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <p class="muted" style={{ fontSize: ".85rem" }}>
                  No events proposed.
                </p>
              )}
            </Section>
            {b.sources.length ? (
              <Section title="Sources">
                {b.sources.map((s: any) => (
                  <p style={{ margin: ".3rem 0", fontSize: ".85rem" }}>
                    {s.url ? (
                      <a href={s.url} target="_blank" rel="noopener">
                        {s.label}
                      </a>
                    ) : (
                      s.label
                    )}
                  </p>
                ))}
              </Section>
            ) : null}
          </>
        )}
      </div>
    </>
  );
}
