import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";

/**
 * A hands-free voice call with Maus: it listens, thinks, answers aloud, and
 * listens again until you hang up. Works for calls you start and for
 * answered calls from Maus.
 */
type Phase = "connecting" | "listening" | "thinking" | "speaking" | "on-hold" | "ended";

/**
 * The engine runs the conversation (it keeps going with the screen off);
 * this screen shows it live. Just start talking to interrupt Maus.
 */
export function CallScreen({ callId, botId, onEnd }: { callId?: string; botId?: string; onEnd: () => void }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [lines, setLines] = useState<{ who: "you" | "maus"; text: string; interrupted?: boolean }[]>([]);
  const [bot, setBot] = useState<{ name: string; emoji: string } | null>(null);
  const [note, setNote] = useState("");
  const id = useRef<string | undefined>(callId);
  const ended = useRef(false);
  useEffect(() => {
    let timer: any;
    (async () => {
      try {
        const info = await api("calls");
        if (!id.current) id.current = (await api("calls/start", { body: botId ? { botId } : {} })).id;
        // The bot on this call (any bot can be called from its chat).
        const call = await api(`calls/${id.current}`).catch(() => null);
        const bots = (await api("state").catch(() => ({ bots: [] }))).bots ?? [];
        setBot(bots.find((b: any) => b.id === call?.botId) ?? info.bot);
        await api(`calls/${id.current}/run`, { body: {} });
        const poll = async () => {
          try {
            const l = await api(`calls/${id.current}/live`);
            setPhase(l.phase);
            setLines(l.lines);
            setNote(l.note ?? "");
            setHoldTap(Boolean(l.onHold && !l.canResumeByVoice));
            setStats(l);
            if (l.phase === "ended") return void (ended.current = true);
          } catch {
            /* keep trying */
          }
          timer = setTimeout(poll, 350);
        };
        void poll();
      } catch (e) {
        setNote((e as Error).message);
        setPhase("ended");
      }
    })();
    return () => clearTimeout(timer);
  }, []);
  const [holdTap, setHoldTap] = useState(false);
  const [stats, setStats] = useState<any>(null);
  const hangUp = () => {
    if (ended.current) return;
    ended.current = true;
    setPhase("ended");
    if (id.current) void api(`calls/${id.current}/end`, { body: {} }).catch(() => {});
  };
  const label: Record<Phase, string> = { connecting: "Connecting…", listening: "Listening…", thinking: "Thinking… (talk to interrupt)", speaking: "Speaking… (talk to interrupt)", "on-hold": "On hold", ended: "Call ended" };
  return (
    <div class="call">
      <div class="call-top">
        <div class={`call-avatar ${phase}`}>{bot?.emoji ?? "🐭"}</div>
        <h2>{bot?.name ?? "Maus"}</h2>
        <div class="muted">{label[phase]}</div>
        {stats?.working ? <div class="muted" style={{ fontSize: ".8rem" }}>Working on {stats.working === 1 ? "a job" : `${stats.working} jobs`} in the background</div> : null}
        {stats?.firstAudioMs?.length || stats?.interruptMs?.length ? (
          <div class="muted" style={{ fontSize: ".72rem", opacity: 0.7 }}>
            {stats.firstAudioMs?.length ? `first audio ${stats.firstAudioMs.at(-1)} ms` : ""}
            {stats.firstAudioMs?.length && stats.interruptMs?.length ? " · " : ""}
            {stats.interruptMs?.length ? `interrupt ${stats.interruptMs.at(-1)} ms` : ""}
          </div>
        ) : null}
        {note ? <p style={{ color: "var(--danger)" }}>{note}</p> : null}
        {/microphone/i.test(note) ? (
          <button class="btn secondary small" onClick={() => void api("system/microphone", { body: {} }).catch(() => {})}>
            Allow microphone
          </button>
        ) : null}
      </div>
      <div class="call-lines">
        {lines.slice(-6).map((l) => (
          <p class={l.who === "you" ? "mine" : ""}>
            <strong>{l.who === "you" ? "You" : bot?.name ?? "Maus"}:</strong> {l.text}
            {l.interrupted ? <span class="muted"> (interrupted)</span> : null}
          </p>
        ))}
      </div>
      {holdTap ? (
        <button class="btn call-btn" onClick={() => void api(`calls/${id.current}/resume`, { body: {} })}>
          Resume
        </button>
      ) : null}
      {phase === "ended" ? (
        <button class="btn secondary call-btn" onClick={onEnd}>
          Back to chat
        </button>
      ) : (
        <button class="btn danger call-btn" onClick={hangUp}>
          Hang up
        </button>
      )}
    </div>
  );
}

/** Settings → Voice & assistant → Calls with Maus. */
export function CallSettings() {
  const [d, setD] = useState<any | null>(null);
  const [may, setMay] = useState<{ ok: boolean; reason: string } | null>(null);
  const load = () => void api("calls").then(setD);
  useEffect(() => {
    load();
    void api("calls/may").then(setMay).catch(() => {});
  }, []);
  if (!d) return <p class="muted">Loading…</p>;
  const s = d.settings;
  const save = async (p: any) => {
    await api("calls/settings", { method: "PUT", body: p });
    load();
    void api("calls/may").then(setMay).catch(() => {});
  };
  const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
  const setLock = (i: number, p: any) => save({ lockouts: s.lockouts.map((w: any, j: number) => (j === i ? { ...w, ...p } : w)) });
  return (
    <div class="section">
      <h2>Calls with {d.bot ? `${d.bot.emoji} ${d.bot.name}` : "Maus"}</h2>
      <p class="help">Only this bot can call you, and you can call it from its chat (📞). It never rings during an event in your calendars (10 minutes either side), during lock-out times, or more than {s.maxPerHour} times an hour. If your calendar can't be checked, it doesn't ring — it leaves a quiet note.</p>
      <label class="toggle">
        <span>Allow calls</span>
        <input type="checkbox" checked={s.enabled} onChange={() => save({ enabled: !s.enabled })} />
      </label>
      {may ? (
        <p class="help">
          Right now: {may.ok ? <span class="pill ok">Maus could call</span> : <span class="pill warn">no calls</span>} {may.ok ? "" : may.reason}
        </p>
      ) : null}
      <h2 style={{ marginTop: ".8rem" }}>Lock-out times (no calls)</h2>
      {s.lockouts.map((w: any, i: number) => (
        <div style={{ padding: ".4rem 0", borderTop: "1px solid var(--line)" }}>
          <div class="inline">
            <input style={{ maxWidth: "8rem" }} value={w.label ?? ""} placeholder="Label" onChange={(e) => setLock(i, { label: (e.target as HTMLInputElement).value })} />
            <input type="time" value={w.start} onChange={(e) => setLock(i, { start: (e.target as HTMLInputElement).value })} />
            <span class="muted">to</span>
            <input type="time" value={w.end} onChange={(e) => setLock(i, { end: (e.target as HTMLInputElement).value })} />
            <button class="btn secondary small" onClick={() => save({ lockouts: s.lockouts.filter((_: any, j: number) => j !== i) })}>
              ✕
            </button>
          </div>
          <div class="seg" style={{ marginTop: ".3rem" }}>
            {DAYS.map((dname, di) => (
              <button class={w.days.includes(di) ? "on" : ""} onClick={() => setLock(i, { days: w.days.includes(di) ? w.days.filter((x: number) => x !== di) : [...w.days, di].sort() })}>
                {dname}
              </button>
            ))}
          </div>
        </div>
      ))}
      <button class="btn secondary small" style={{ marginTop: ".4rem" }} onClick={() => save({ lockouts: [...s.lockouts, { days: [1, 2, 3, 4, 5], start: "08:30", end: "15:15", label: "School" }] })}>
        + Add lock-out time
      </button>
      <div class="field" style={{ marginTop: ".8rem" }}>
        <label>Your name (Maus greets you with it: “Morning, Dan!”)</label>
        <input value={s.userName ?? ""} placeholder={d.knownName || "e.g. Dan"} onChange={(e) => save({ userName: (e.target as HTMLInputElement).value.trim() })} />
      </div>
      <div class="field">
        <label>Most calls per hour</label>
        <input type="number" min="1" max="10" value={s.maxPerHour} onChange={(e) => save({ maxPerHour: Number((e.target as HTMLInputElement).value) || 1 })} />
      </div>
      <button
        class="btn secondary"
        onClick={async () => {
          const c = await api("calls/test", { body: { reason: "Test call" } });
          if (c.state === "blocked") alert(`No ring: ${c.detail}`);
          load();
        }}
      >
        Test: have {d.bot?.name ?? "Maus"} call me
      </button>
      {d.log.length ? (
        <>
          <h2 style={{ marginTop: ".8rem" }}>Recent calls</h2>
          {d.log.slice(0, 8).map((c: any) => (
            <div class="muted" style={{ fontSize: ".8rem" }}>
              {new Date(c.at).toLocaleString()} · {c.direction === "incoming" ? "Maus → you" : "you → Maus"} · {c.state}
              {c.detail ? ` (${c.detail})` : ""}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
