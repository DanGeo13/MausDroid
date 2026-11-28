import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, listen, type EngineEvent } from "./api.ts";
import { Avatar, Chat } from "./chat.tsx";
import { BotEditor, Settings, toast } from "./settings.tsx";
import type { Bot, Card, Msg } from "./types.ts";
import { IconBell, IconGear, IconInbox, IconLink, IconPlus, IconSearch } from "./icons.tsx";
import { applyAppearance, loadAppearance } from "./appearance.ts";
import { fileIcon, type Attachment } from "./files.ts";
import { Briefing } from "./briefing.tsx";
import { Improve } from "./improve.tsx";
import { CallScreen } from "./call.tsx";
import { ReplyDesk } from "./reply.tsx";
import { Resources } from "./resources.tsx";

applyAppearance(loadAppearance());

function when(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (Date.now() - d.getTime() < 6 * 86400_000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

type View = { kind: "list" } | { kind: "chat"; botId: string } | { kind: "edit"; botId: string | null } | { kind: "settings"; tab: string } | { kind: "briefing"; id?: string; audioId?: string } | { kind: "improve" } | { kind: "call"; callId?: string; botId?: string } | { kind: "replydesk"; id?: string } | { kind: "resources" };

function Home({ poll }: { poll: boolean }) {
  const [bots, setBots] = useState<Bot[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [view, setViewState] = useState<View>({ kind: "list" });
  const depth = useRef(0);
  /** Opens a screen and records it, so Back returns to the previous one. */
  const setView = (v: View) => {
    if (v.kind === "list") {
      // Going home: unwind instead of stacking more screens.
      if (depth.current > 0) history.go(-depth.current);
      else setViewState(v);
      return;
    }
    depth.current += 1;
    history.pushState({ v, depth: depth.current }, "");
    setViewState(v);
  };
  /** Changes the current screen without adding a Back step (e.g. switching settings tabs). */
  const replaceView = (v: View) => {
    history.replaceState({ v, depth: depth.current }, "");
    setViewState(v);
  };
  const goBack = () => {
    if (depth.current > 0) history.back();
    else setViewState({ kind: "list" });
  };
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [onboarding, setOnboarding] = useState(false);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const [pendingReplies, setPendingReplies] = useState(0);
  /** Carries text (e.g. a shared response) into a bot's chat, ready to review before sending. */
  const openBot = (botId: string, text: string) => {
    setInitial({ botId, text });
    setView({ kind: "chat", botId });
  };
  const [query, setQuery] = useState("");
  const [voiceOk, setVoiceOk] = useState(false);
  // Location indicator: who is using location right now (or just did).
  const [loc, setLoc] = useState<{ state: "active" | "done"; requester: string; outcome?: string } | null>(null);
  // Files/text shared to MausDroid from another app, waiting for "which bot?".
  const [shared, setShared] = useState<{ attachments: Attachment[]; text?: string } | null>(null);
  const [initial, setInitial] = useState<{ botId: string; text?: string; attachments?: Attachment[] } | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const refreshTimer = useRef<number | null>(null);

  const loadState = async () => {
    const s = await api("state");
    // The engine updated while this screen was open: load the new screens.
    const shown = document.querySelector('meta[name="md-version"]')?.getAttribute("content");
    if (shown && s.version?.engine && decodeURIComponent(shown) !== s.version.engine) {
      location.reload();
      return s;
    }
    setBots(s.bots);
    setCards(s.cards);
    setUnreadAlerts(s.unreadAlerts);
    setPendingReplies(s.pendingReplies ?? 0);
    setVoiceOk(Boolean(s.nativeBridge) && !poll);
    if (!s.onboardingDone && !poll) setOnboarding(true);
    return s;
  };
  const softRefresh = () => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void loadState();
    }, 400);
  };
  const loadMsgs = (botId: string) => api<Msg[]>(`bots/${botId}/messages`).then(setMsgs);

  useEffect(() => {
    let off = () => {};
    void loadState().then((s) => {
      off = listen((e: EngineEvent) => {
        const v = viewRef.current;
        const here = v.kind === "chat" && e.botId === v.botId;
        if (e.type === "message" && here) setMsgs((m) => (m.some((x) => x.id === e.message.id) ? m : [...m, e.message]));
        else if (e.type === "message.delta" && here) setMsgs((m) => m.map((x) => (x.id === e.messageId ? { ...x, text: x.text + e.delta } : x)));
        else if (e.type === "message.updated" && here) void loadMsgs(e.botId);
        if (e.type === "location") {
          setLoc({ state: e.state, requester: e.requester, outcome: e.outcome });
          if (e.state === "done") setTimeout(() => setLoc((cur) => (cur?.state === "done" ? null : cur)), 8000);
        }
        if (e.type === "card") setCards((c) => [...c.filter((x) => x.id !== e.card.id), e.card]);
        if (e.type === "card.settled") setCards((c) => c.filter((x) => x.id !== e.cardId));
        if (e.type === "bot.busy") setBots((b) => b.map((x) => (x.id === e.botId ? { ...x, busy: e.busy } : x)));
        if (e.type === "alert") {
          setUnreadAlerts((n) => n + 1);
          if (document.visibilityState === "visible" && !e.alert.cardId) toast(`${e.alert.title}: ${e.alert.body}`.slice(0, 140));
        }
        if (["message", "message.updated", "settings.changed"].includes(e.type)) softRefresh();
        if (e.type === "reply-desk") setPendingReplies(e.pending ?? 0);
      }, s.seq, poll);
    });
    // Notification taps open the right chat: the shell calls window.mausdroidOpen(botId).
    (window as any).mausdroidOpen = (botId: string) => setView({ kind: "chat", botId });
    // Notification links, e.g. "briefing:<id>" opens that Morning Brief.
    (window as any).mausdroidLink = (link: string) => {
      if (link.startsWith("briefing:")) setView({ kind: "briefing", id: link.slice(9) || undefined });
      else if (link.startsWith("audio:")) setView({ kind: "briefing", audioId: link.slice(6) || undefined });
      if (link.startsWith("call:")) setView({ kind: "call", callId: link.slice(5) });
      if (link.startsWith("improve:")) setView({ kind: "improve" });
      if (link.startsWith("replydesk:")) setView({ kind: "replydesk", id: link.slice(10) || undefined });
      if (link.startsWith("resources:")) setView({ kind: "resources" });
    };
    // The Android app hands over shared files (already saved) and text.
    (window as any).mausdroidShare = (payload: { attachments: Attachment[]; text?: string }) => setShared(payload);
    const hash = new URLSearchParams(location.hash.slice(1));
    if (hash.get("bot")) setView({ kind: "chat", botId: hash.get("bot")! });
    if (hash.get("link")) (window as any).mausdroidLink(hash.get("link"));
    // Check now and then (the engine may have updated itself in the background).
    const timer = setInterval(() => void loadState().catch(() => {}), 60_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (view.kind === "chat") void loadMsgs(view.botId);
  }, [view.kind === "chat" ? view.botId : null]);

  // Back (phone navigation bar / gesture, or the browser's Back) moves one screen back.
  useEffect(() => {
    if (!history.state) history.replaceState({ v: { kind: "list" }, depth: 0 }, "");
    const onPop = (e: PopStateEvent) => {
      depth.current = e.state?.depth ?? 0;
      setViewState(e.state?.v ?? { kind: "list" });
    };
    window.addEventListener("popstate", onPop);
    // Called by the Android app; returns false when already on the home screen.
    (window as any).mausdroidBack = () => {
      if (depth.current > 0) {
        history.back();
        return true;
      }
      return false;
    };
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const sorted = useMemo(
    () => bots.filter((b) => !b.hidden).sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? b.id).localeCompare(a.lastMessageAt ?? a.id)),
    [bots],
  );
  const current = view.kind === "chat" ? bots.find((b) => b.id === view.botId) : undefined;
  const shown = sorted.filter((b) => !query.trim() || `${b.name} ${b.persona}`.toLowerCase().includes(query.trim().toLowerCase()));

  if (onboarding) return <Onboarding onDone={() => (setOnboarding(false), void api("settings/general", { method: "PUT", body: { onboardingDone: true } }))} />;

  const shareSheet = shared ? (
    <div class="sheet-bg" onClick={() => setShared(null)}>
      <div class="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>Send to which bot?</h2>
        <div class="pending" style={{ border: 0, padding: "0 .6rem .6rem" }}>
          {shared.attachments.map((a) => (
            <span class="file-chip">
              {fileIcon(a)} <span class="fname">{a.name}</span>
            </span>
          ))}
          {shared.text ? <span class="file-chip">🔗 <span class="fname">{shared.text}</span></span> : null}
        </div>
        {sorted.map((b) => (
          <button
            class="row"
            onClick={() => {
              setInitial({ botId: b.id, text: shared.text, attachments: shared.attachments });
              setShared(null);
              setView({ kind: "chat", botId: b.id });
            }}
          >
            <Avatar bot={b} />
            <div class="meta">
              <div class="name">{b.name}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  ) : null;

  const locBanner = loc ? (
    <div class={`loc-banner ${loc.state}`} role="status">
      📍 {loc.state === "active" ? `Using your location — asked by ${loc.requester}` : `Location ${loc.outcome === "ok" ? "used" : `request ended (${loc.outcome})`} by ${loc.requester}`}
    </div>
  ) : null;

  return (
    <div class={`layout ${view.kind !== "list" ? "in-chat" : ""}`}>
      {locBanner}
      {shareSheet}
      <div class="sidebar">
        <div class="topbar">
          <h1 class="brand">
            <img src="icon.svg" alt="" /> MausDroid
          </h1>
          <button class="icon-btn" title="Reply Desk" aria-label={`Reply Desk${pendingReplies ? `, ${pendingReplies} waiting` : ""}`} onClick={() => setView({ kind: "replydesk" })}>
            <IconInbox />
            {pendingReplies ? <span class="badge">{pendingReplies > 99 ? "99+" : pendingReplies}</span> : null}
          </button>
          <button class="icon-btn" title="Resources" aria-label="Resources" onClick={() => setView({ kind: "resources" })}>
            <IconLink />
          </button>
          <button class="icon-btn" title="Morning Brief" aria-label="Morning Brief" onClick={() => setView({ kind: "briefing" })}>
            📰
          </button>
          <button class="icon-btn" title="Improvements" aria-label="Improvements" onClick={() => setView({ kind: "improve" })}>
            🛠️
          </button>
          <button class="icon-btn" title="Alerts" aria-label="Alerts" onClick={() => setView({ kind: "settings", tab: "Routines & alerts" })}>
            <IconBell />
            {unreadAlerts ? <span class="badge">{unreadAlerts > 99 ? "99+" : unreadAlerts}</span> : null}
          </button>
          <button class="icon-btn" title="Settings" aria-label="Settings" onClick={() => setView({ kind: "settings", tab: "AI" })}>
            <IconGear />
          </button>
        </div>
        <div class="search">
          <IconSearch />
          <input value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} placeholder="Search bots" />
        </div>
        <div class="list">
          {cards.length ? (
            <button class="banner" onClick={() => setView({ kind: "chat", botId: cards[0].botId })}>
              ✋ <span style={{ flex: 1 }}>{cards.length === 1 ? "1 bot is waiting for your OK" : `${cards.length} bots are waiting for your OK`}</span> <strong>Open</strong>
            </button>
          ) : null}
          {[
            ["Pinned", shown.filter((b) => b.pinned)],
            [shown.some((b) => b.pinned) ? "Bots" : "", shown.filter((b) => !b.pinned)],
          ].map(([label, list]) =>
            (list as Bot[]).length ? (
              <>
                {label ? <div class="list-label">{label as string}</div> : null}
                {(list as Bot[]).map((b) => (
                  <button class={`row ${current?.id === b.id ? "active" : ""}`} onClick={() => setView({ kind: "chat", botId: b.id })}>
                    <Avatar bot={b} live={b.busy} />
                    <div class="meta">
                      <div class="top">
                        <span class="name">{b.name}</span>
                        <span class="time">{when(b.last?.at ?? b.lastMessageAt)}</span>
                      </div>
                      <div class="top">
                        <span class={`preview ${b.busy ? "working" : ""}`} style={{ flex: 1 }}>
                          {b.busy ? "working…" : b.last ? `${b.last.role === "user" ? "You: " : ""}${b.last.text.replace(/\s+/g, " ").slice(0, 80)}` : b.persona.slice(0, 80)}
                        </span>
                        {cards.some((c) => c.botId === b.id) ? <span class="badge warn">!</span> : b.unread ? <span class="badge">{b.unread}</span> : null}
                      </div>
                    </div>
                  </button>
                ))}
              </>
            ) : null,
          )}
          {!shown.length ? <div class="empty">No bots match “{query}”.</div> : null}
        </div>
        <button class="fab" aria-label="New bot" title="New bot" onClick={() => setView({ kind: "edit", botId: null })}>
          <IconPlus />
        </button>
      </div>
      <div class="main">
        {view.kind === "chat" && current ? (
          <Chat
            bot={current}
            busy={Boolean(current.busy)}
            messages={msgs}
            cards={cards.filter((c) => c.botId === current.id)}
            onBack={goBack}
            onEdit={() => setView({ kind: "edit", botId: current.id })}
            refresh={() => void loadState()}
            voiceOk={voiceOk}
            remote={poll}
            openSettings={(tab) => setView({ kind: "settings", tab })}
            onCall={() => setView({ kind: "call", botId: current.id })}
            initial={initial?.botId === current.id ? initial : undefined}
            openBot={openBot}
          />
        ) : view.kind === "edit" ? (
          <BotEditor
            bot={view.botId ? bots.find((b) => b.id === view.botId) ?? null : null}
            onClose={(deleted) => {
              void loadState();
              if (deleted) setView({ kind: "list" });
              else goBack();
            }}
          />
        ) : view.kind === "call" ? (
          <CallScreen callId={view.callId} botId={view.botId} onEnd={() => setView(view.botId ? { kind: "chat", botId: view.botId } : { kind: "list" })} />
        ) : view.kind === "replydesk" ? (
          <ReplyDesk focusId={view.id} onBack={goBack} openBot={openBot} />
        ) : view.kind === "resources" ? (
          <Resources onBack={goBack} />
        ) : view.kind === "improve" ? (
          <Improve onBack={() => setView({ kind: "list" })} openBot={(id) => setView({ kind: "chat", botId: id })} />
        ) : view.kind === "briefing" ? (
          <Briefing initialId={view.id} audioId={view.audioId} onBack={() => setView({ kind: "list" })} />
        ) : view.kind === "settings" ? (
          <Settings tab={view.tab} setTab={(tab) => replaceView({ kind: "settings", tab })} bots={bots} onBack={() => (goBack(), void loadState())} />
        ) : (
          <div class="empty">
            <img class="hero-logo" src="icon.svg" alt="" />
            <p>Choose a bot to chat with.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Onboarding({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const steps = [
    {
      title: "Welcome to MausDroid",
      body: "Your own team of AI bots, running on this phone. They can research, use your apps, work in a background browser and alert you when something matters — and they ask before anything risky.",
    },
    {
      title: "1. Give your bots a brain",
      body: "Next you'll choose an AI. Free options: a Gemini key from aistudio.google.com, or OpenRouter's free models. You can also use Claude, ChatGPT, your Claude Code / Codex subscriptions, or local models.",
    },
    {
      title: "2. Let them work in the background",
      body: "So tasks keep running while you use other apps or the screen is off, allow notifications, turn off battery restrictions and allow Autostart (HyperOS). You'll find these in Settings → Phone.",
    },
    { title: "You're set", body: "Optional extras in Settings: Connected apps (Composio), built-in Tailscale, the always-on website with QR pairing, and the skills marketplace." },
  ];
  const s = steps[step];
  return (
    <div class="center">
      <div class="box">
        <img class="hero-logo" src="icon.svg" alt="" />
        <div class="dots">
          {steps.map((_, i) => (
            <i class={i === step ? "on" : ""} />
          ))}
        </div>
        <h2>{s.title}</h2>
        <p class="muted">{s.body}</p>
        <div class="inline" style={{ justifyContent: "center" }}>
          {step === 2 ? (
            <>
              <button class="btn secondary" onClick={() => api("system/notifications", { body: {} }).catch(() => {})}>
                Notifications
              </button>
              <button class="btn secondary" onClick={() => api("system/battery", { body: {} }).catch(() => {})}>
                Battery
              </button>
              <button class="btn secondary" onClick={() => api("system/autostart", { body: {} }).catch(() => {})}>
                Autostart
              </button>
            </>
          ) : null}
          <button class="btn" onClick={() => (step < steps.length - 1 ? setStep(step + 1) : onDone())}>
            {step < steps.length - 1 ? "Next" : "Start"}
          </button>
        </div>
        {step === 1 ? <p class="muted" style={{ fontSize: 13 }}>Settings → AI opens after this tour.</p> : null}
      </div>
    </div>
  );
}

function RemoteGate() {
  const [stage, setStage] = useState<"loading" | "pair" | "password" | "in">("loading");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    (async () => {
      const hash = new URLSearchParams(location.hash.slice(1));
      const code = hash.get("pair");
      if (code) {
        try {
          await api("pair/redeem", { body: { code, name: deviceName() } });
          history.replaceState(null, "", location.pathname);
        } catch (e) {
          setErr((e as Error).message);
        }
      }
      const who = await api("whoami");
      setStage(who.auth === "owner" ? "in" : who.auth === "paired" ? "password" : "pair");
    })().catch((e) => (setErr(e.message), setStage("pair")));
  }, []);
  if (stage === "in") return <Home poll />;
  if (stage === "loading") return <div class="center">Connecting to your phone…</div>;
  return (
    <div class="center">
      <div class="box">
        <img class="hero-logo" src="icon.svg" alt="" />
        <h2>MausDroid</h2>
        {stage === "pair" ? (
          <p class="muted">Open MausDroid on your phone → Settings → Website &amp; devices → Show QR code, and scan it with this device.</p>
        ) : (
          <>
            <p class="muted">This device is linked. Enter your MausDroid password.</p>
            <input type="password" value={pw} onInput={(e) => setPw((e.target as HTMLInputElement).value)} autofocus />
            <button
              class="btn"
              style={{ marginTop: 10, width: "100%" }}
              onClick={async () => {
                try {
                  await api("login", { body: { password: pw } });
                  setStage("in");
                } catch (e) {
                  setErr((e as Error).message);
                }
              }}
            >
              Sign in
            </button>
          </>
        )}
        {err ? <p style={{ color: "var(--danger)" }}>{err}</p> : null}
      </div>
    </div>
  );
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${br} on ${os}`;
}

function App() {
  const [mode, setMode] = useState<"local" | "remote" | null>(null);
  useEffect(() => {
    api("whoami")
      .then((w) => setMode(w.via === "local" && w.auth === "owner" ? "local" : "remote"))
      .catch(() => setMode("remote"));
  }, []);
  if (!mode) return <div class="center">Starting…</div>;
  return mode === "local" ? <Home poll={false} /> : <RemoteGate />;
}

render(<App />, document.getElementById("app")!);
