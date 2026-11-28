import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import { IconBack } from "./icons.tsx";
import { toast } from "./actions.tsx";

const when = (iso: string) => {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
};

/**
 * Notifications: what needs you first. Updates and quiet records are kept
 * (bots and routines use them) but don't count on the bell or buzz the phone.
 */
export function Alerts({ onBack, openLink, openBot, openSettings }: { onBack: () => void; openLink: (link: string) => void; openBot: (botId: string) => void; openSettings: () => void }) {
  const [tab, setTab] = useState<"act" | "info" | "log">("act");
  const [all, setAll] = useState<any[] | null>(null);
  const [updates, setUpdates] = useState<boolean | null>(null);
  const load = () => void api<any[]>("alerts").then(setAll).catch(() => setAll([]));
  useEffect(() => {
    load();
    void api("settings").then((s) => setUpdates(Boolean(s.notifyUpdates))).catch(() => {});
  }, []);
  const shown = (all ?? []).filter((a) => a.tier === tab);
  const count = (t: string) => (all ?? []).filter((a) => a.tier === t && !a.read).length;
  const open = async (a: any) => {
    await api("alerts/read", { body: { ids: [a.id] } }).catch(() => {});
    if (a.link) openLink(a.link);
    else if (a.botId) openBot(a.botId);
    else load();
  };
  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={onBack} aria-label="Back">
          <IconBack />
        </button>
        <h1>Notifications</h1>
        <button class="btn secondary small" onClick={() => void api("alerts/read", { body: {} }).then(load).then(() => toast("All marked read"))}>
          Mark all read
        </button>
      </div>
      <div class="page">
        <div class="seg" style={{ marginBottom: ".6rem" }}>
          {(
            [
              ["act", "Needs you"],
              ["info", "Updates"],
              ["log", "Background"],
            ] as const
          ).map(([k, label]) => (
            <button class={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {label}
              {count(k) && k !== "log" ? ` (${count(k)})` : ""}
            </button>
          ))}
        </div>
        <p class="help">
          {tab === "act"
            ? "Only these buzz your phone and count on the bell: approvals, questions, missed calls, messages that need a reply, and anything urgent."
            : tab === "info"
              ? "Things that are ready or finished. They stay here without buzzing your phone."
              : "Quiet records (notifications DanDroid read from your apps, automatic triggers). Bots and routines use them; you don't need to."}
        </p>
        {all === null ? (
          <p class="muted">Loading…</p>
        ) : !shown.length ? (
          <p class="muted">{tab === "act" ? "Nothing needs you right now. 🎉" : "Nothing here."}</p>
        ) : (
          shown.slice(0, 100).map((a) => (
            <button class={`alert-row ${a.read ? "read" : ""}`} key={a.id} onClick={() => void open(a)}>
              <div class="top">
                <strong>{a.title}</strong>
                <span class="muted" style={{ fontSize: ".75rem", flex: "none" }}>
                  {when(a.at)}
                </span>
              </div>
              {a.body ? <div class="muted body">{a.body}</div> : null}
            </button>
          ))
        )}
        {shown.length ? (
          <button class="btn secondary small" style={{ marginTop: ".8rem" }} onClick={() => confirm(`Clear everything in ${tab === "act" ? "Needs you" : tab === "info" ? "Updates" : "Background"}?`) && void api("alerts/clear", { body: { tier: tab } }).then(load)}>
            Clear this list
          </button>
        ) : null}
        <div class="section" style={{ marginTop: "1.2rem" }}>
          <label class="toggle">
            <span>
              Also show updates on my phone
              <span class="muted" style={{ display: "block", fontSize: ".8rem" }}>
                Morning Brief ready, audio overview ready, routine results — silently, no buzz.
              </span>
            </span>
            <input
              type="checkbox"
              checked={Boolean(updates)}
              onChange={(e) => {
                const on = (e.target as HTMLInputElement).checked;
                setUpdates(on);
                void api("settings/general", { method: "PUT", body: { notifyUpdates: on } });
              }}
            />
          </label>
          <button class="btn secondary small" onClick={openSettings}>
            Quiet hours &amp; routines
          </button>
        </div>
      </div>
    </>
  );
}
