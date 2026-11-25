import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";

/** Calendars from every connected Google account; choose where events go; test write access. */
export function Calendars() {
  const [d, setD] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const load = (refresh = true) => {
    setBusy(true);
    api(`calendars${refresh ? "" : "?refresh=0"}`)
      .then(setD)
      .catch((e) => setMsg(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => load(false), []);
  const choose = async (c: any) => {
    try {
      const r = await api("calendars/destination", { method: "PUT", body: { accountId: c.accountId, calendarId: c.calendarId } });
      setD({ ...d, destination: r.destination });
      setMsg(`Events will go to “${c.name}” (${c.accountAlias}).`);
    } catch (e) {
      setMsg((e as Error).message);
    }
  };
  const test = async () => {
    setMsg("Testing… (adds a private test event far in the future, checks it, removes it)");
    try {
      const r = await api("calendars/test-write", { body: {} });
      setMsg(`${r.ok ? "✅" : "⚠️"} ${r.detail}`);
      load(false);
    } catch (e) {
      setMsg(`⚠️ ${(e as Error).message}`);
    }
  };
  const byAccount: Record<string, any[]> = {};
  for (const c of d?.calendars ?? []) (byAccount[c.accountAlias] ??= []).push(c);
  const dest = d?.destination;
  return (
    <div class="section">
      <div class="inline" style={{ justifyContent: "space-between" }}>
        <h2>Calendars</h2>
        <button class="btn secondary small" disabled={busy} onClick={() => load(true)}>
          {busy ? "Checking…" : "Refresh"}
        </button>
      </div>
      <p class="help">Every calendar your connected Google accounts can see. Bots add events only to the one you choose here (never the default by guess). A calendar shared with you with “Make changes to events” (e.g. CMW) shows as “can edit”.</p>
      {dest ? (
        <p style={{ fontSize: ".9rem" }}>
          Destination: <strong>{dest.name}</strong> ({dest.accountAlias}){" "}
          {dest.writeTest ? <span class={`pill ${dest.writeTest.ok ? "ok" : "bad"}`}>{dest.writeTest.ok ? "write tested" : "write test failed"}</span> : <span class="pill warn">not tested</span>}
        </p>
      ) : (
        <p class="pill warn" style={{ display: "inline-block" }}>
          No destination chosen yet
        </p>
      )}
      {Object.entries(byAccount).map(([alias, list]) => (
        <div style={{ marginTop: ".6rem" }}>
          <div class="list-label" style={{ padding: ".3rem 0" }}>
            Account: {alias}
          </div>
          {list.map((c) => {
            const chosen = dest && dest.accountId === c.accountId && dest.calendarId === c.calendarId;
            return (
              <div class="toggle">
                <span style={{ minWidth: 0 }}>
                  {c.name} {c.primary ? <span class="pill">main</span> : null}{" "}
                  <span class={`pill ${c.writable ? "ok" : ""}`}>{c.writable ? (c.accessRole === "owner" ? "owner" : "can edit") : "read-only"}</span>
                </span>
                {chosen ? (
                  <span class="pill ok">chosen</span>
                ) : c.writable ? (
                  <button class="btn secondary small" onClick={() => choose(c)}>
                    Use for events
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
      {d?.problems?.length ? (
        <div style={{ marginTop: ".6rem" }}>
          {d.problems.map((p: any) => (
            <p class="help" style={{ color: "var(--warn)" }}>
              ⚠️ {p.accountAlias ? `${p.accountAlias}: ` : ""}
              {p.error}
            </p>
          ))}
        </div>
      ) : null}
      {dest ? (
        <button class="btn secondary" style={{ marginTop: ".5rem" }} onClick={test}>
          Test write access
        </button>
      ) : null}
      {msg ? <p class="help" style={{ marginTop: ".5rem" }}>{msg}</p> : null}
    </div>
  );
}
