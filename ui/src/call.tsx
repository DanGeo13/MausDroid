import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";

/**
 * A hands-free voice call with Maus: it listens, thinks, answers aloud, and
 * listens again until you hang up. Works for calls you start and for
 * answered calls from Maus.
 */
type Phase = "connecting" | "listening" | "thinking" | "speaking" | "ended";

export function CallScreen({ callId, onEnd }: { callId?: string; onEnd: () => void }) {
  const [phase, setPhase] = useState<Phase>("connecting");
  const [lines, setLines] = useState<{ who: "you" | "maus"; text: string }[]>([]);
  const [bot, setBot] = useState<{ name: string; emoji: string } | null>(null);
  const [note, setNote] = useState("");
  const active = useRef(true);
  const id = useRef<string | undefined>(callId);
  const say = async (text: string) => {
    if (!active.current) return;
    setPhase("speaking");
    setLines((l) => [...l, { who: "maus", text }]);
    await api("voice/speak", { body: { text, wait: true } }).catch(() => {});
  };
  useEffect(() => {
    (async () => {
      try {
        const info = await api("calls");
        setBot(info.bot);
        let opening: string;
        if (id.current) {
          const c = await api(`calls/${id.current}`);
          opening = c.openingLine || `Hi, it's ${info.bot?.name ?? "Maus"}. ${c.reason}`;
        } else {
          const c = await api("calls/start", { body: {} });
          id.current = c.id;
          opening = `Hi, it's ${info.bot?.name ?? "Maus"}. What can I do for you?`;
        }
        await say(opening);
        let silences = 0;
        while (active.current) {
          setPhase("listening");
          let heard = "";
          try {
            heard = (await api<{ text: string }>("voice/listen", { body: {} })).text ?? "";
          } catch {
            heard = "";
          }
          if (!active.current) break;
          if (!heard.trim()) {
            silences++;
            if (silences >= 3) {
              await say("I'll let you go. Talk soon!");
              break;
            }
            if (silences === 2) await say("Are you still there?");
            continue;
          }
          silences = 0;
          if (/^(bye|goodbye|hang up|that's all|end call)\b/i.test(heard.trim())) {
            setLines((l) => [...l, { who: "you", text: heard }]);
            await say("Bye!");
            break;
          }
          setLines((l) => [...l, { who: "you", text: heard }]);
          setPhase("thinking");
          const r = await api<{ reply: string }>(`calls/${id.current}/turn`, { body: { text: heard } });
          await say(r.reply || "Done.");
        }
      } catch (e) {
        setNote((e as Error).message);
      }
      hangUp();
    })();
    return () => {
      active.current = false;
    };
  }, []);
  const hangUp = () => {
    if (phase === "ended" && !active.current) return;
    active.current = false;
    setPhase("ended");
    void api("voice/stop", { body: {} }).catch(() => {});
    if (id.current) void api(`calls/${id.current}/end`, { body: {} }).catch(() => {});
  };
  const label: Record<Phase, string> = { connecting: "Connecting…", listening: "Listening…", thinking: "Thinking…", speaking: "Speaking…", ended: "Call ended" };
  return (
    <div class="call">
      <div class="call-top">
        <div class={`call-avatar ${phase}`}>{bot?.emoji ?? "🐭"}</div>
        <h2>{bot?.name ?? "Maus"}</h2>
        <div class="muted">{label[phase]}</div>
        {note ? <p style={{ color: "var(--danger)" }}>{note}</p> : null}
      </div>
      <div class="call-lines">
        {lines.slice(-6).map((l) => (
          <p class={l.who === "you" ? "mine" : ""}>
            <strong>{l.who === "you" ? "You" : bot?.name ?? "Maus"}:</strong> {l.text}
          </p>
        ))}
      </div>
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
