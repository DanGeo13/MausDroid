import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import { ResponseActions } from "./actions.tsx";
import { ReplyCard } from "./reply.tsx";
import type { Bot, Card, Msg } from "./types.ts";
import { IconBack, IconCamera, IconClip, IconEdit, IconMic, IconSend, IconStop, IconX } from "./icons.tsx";
import { fileIcon, fileSize, uploadFile, type Attachment } from "./files.ts";

/** Bot picture: emoji on its colour. `size` in rem so it follows the text-size setting. */
/**
 * Speech to text. In the app: Google's speech pop-up on the visible screen
 * (the most reliable way); otherwise the phone's background listener.
 */
function dictate(): Promise<string> {
  const shell = (window as any).MausDroidShell;
  if (shell?.dictate) {
    return new Promise((resolve, reject) => {
      (window as any).mausdroidDictation = (text: string | null, error: string | null) => {
        delete (window as any).mausdroidDictation;
        if (error) reject(new Error(error));
        else resolve(text ?? "");
      };
      if (!shell.dictate()) {
        delete (window as any).mausdroidDictation;
        reject(new Error("Speech input isn't available."));
      }
    });
  }
  return api<{ text: string; error?: string }>("voice/listen", { body: { soft: true } }).then((r) => {
    if (r.error) throw new Error(r.error);
    return r.text ?? "";
  });
}

export function Avatar({ bot, size = 3, live = false }: { bot: Pick<Bot, "emoji" | "color">; size?: number; live?: boolean }) {
  return (
    <div class="avatar" style={{ background: `linear-gradient(135deg, ${bot.color}, ${bot.color}cc)`, width: `${size}rem`, height: `${size}rem`, fontSize: `${size / 2}rem` }}>
      {bot.emoji}
      {live ? <span class="live" /> : null}
    </div>
  );
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

const SUGGESTIONS = ["What can you do for me?", "Give me a morning briefing every weekday at 7am", "Summarise today's news in 5 points", "Find the best price for…"];

export function CardView({ card, onDone }: { card: Card; onDone?: () => void }) {
  const [answer, setAnswer] = useState("");
  const send = async (body: object) => {
    await api(`cards/${card.id}`, { body });
    onDone?.();
  };
  if (card.kind === "question")
    return (
      <div class="card">
        <h3>❓ {card.title}</h3>
        {card.options?.length ? (
          <div class="actions">
            {card.options.map((o) => (
              <button class="btn secondary small" onClick={() => send({ allow: true, answer: o })}>
                {o}
              </button>
            ))}
          </div>
        ) : null}
        <div class="inline" style={{ marginTop: 8 }}>
          <input value={answer} onInput={(e) => setAnswer((e.target as HTMLInputElement).value)} placeholder="Type an answer" />
          <button class="btn small" disabled={!answer.trim()} onClick={() => send({ allow: true, answer })}>
            Send
          </button>
        </div>
      </div>
    );
  return (
    <div class="card">
      <h3>✋ Needs your OK: {card.title}</h3>
      {card.detail ? <pre>{card.detail}</pre> : null}
      <div class="actions">
        <button class="btn small" onClick={() => send({ allow: true })}>
          Allow once
        </button>
        {card.tool ? (
          <button class="btn secondary small" onClick={() => send({ allow: true, always: true })}>
            Always allow {card.toolLabel ?? card.tool}
          </button>
        ) : null}
        <button class="btn danger small" onClick={() => send({ allow: false })}>
          Deny
        </button>
      </div>
    </div>
  );
}

function ToolLine({ m }: { m: Msg }) {
  const [open, setOpen] = useState(false);
  const t = m.tool!;
  const icon = t.status === "running" ? "⏳" : t.status === "denied" ? "🚫" : t.isError ? "⚠️" : "✓";
  const nice = t.name.replace(/^composio__COMPOSIO_/, "apps · ").replace(/^composio__/, "apps · ").replace(/_/g, " ").toLowerCase();
  return (
    <button class={`tool ${open ? "open" : ""}`} onClick={() => setOpen(!open)}>
      <span>
        {icon} {nice}
      </span>
      {open ? (
        <pre>
          {JSON.stringify(t.input, null, 1)}
          {t.result ? `\n\n→ ${t.result}` : ""}
        </pre>
      ) : null}
    </button>
  );
}

/** A file in a message: pictures as thumbnails, other files as a card that opens it. */
function FileChip({ a }: { a: Attachment }) {
  if (a.kind === "image")
    return (
      <a href={`api/files/${a.id}`} target="_blank" class="thumb">
        <img src={`api/files/${a.id}`} alt={a.name} loading="lazy" />
      </a>
    );
  if (a.kind === "video") return <video class="thumb" src={`api/files/${a.id}`} controls preload="metadata" />;
  if (a.kind === "audio") return <audio src={`api/files/${a.id}`} controls preload="metadata" style={{ maxWidth: "100%" }} />;
  return (
    <a href={`api/files/${a.id}`} target="_blank" class="file-chip">
      <span>{fileIcon(a)}</span>
      <span class="fname">{a.name}</span>
      <span class="muted">{fileSize(a.size)}</span>
    </a>
  );
}

export function Chat({ bot, messages, cards, onBack, onEdit, refresh, busy, voiceOk, remote, initial, openSettings, onCall, openBot }: {
  bot: Bot; messages: Msg[]; cards: Card[]; busy: boolean; onBack: () => void; onEdit: () => void; refresh: () => void; voiceOk: boolean;
  remote: boolean; initial?: { text?: string; attachments?: Attachment[] }; openSettings?: (tab: string) => void; onCall?: () => void; openBot?: (botId: string, text: string) => void;
}) {
  const [text, setText] = useState(initial?.text ?? "");
  const [pending, setPending] = useState<Attachment[]>(initial?.attachments ?? []);
  const [uploading, setUploading] = useState(0);
  const picker = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (initial?.attachments?.length) setPending(initial.attachments);
    if (initial?.text) setText(initial.text);
  }, [initial]);
  const addFiles = async (list: FileList | File[] | null) => {
    if (!list) return;
    for (const f of Array.from(list)) {
      setUploading((n) => n + 1);
      try {
        const a = await uploadFile(f, remote);
        setPending((p) => [...p, a]);
      } catch (e) {
        alert((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const [listening, setListening] = useState(false);
  // Only the call bot (Maus) shows the Call button.
  const [canCall, setCanCall] = useState(false);
  useEffect(() => {
    if (!voiceOk) return;
    // Every bot can be called from its chat.
    void api("calls").then((c) => setCanCall(Boolean(c.settings.enabled))).catch(() => {});
  }, [bot.id, voiceOk]);
  const [skills, setSkills] = useState<{ name: string; description: string }[]>([]);
  useEffect(() => {
    void api("skills").then(setSkills).catch(() => {});
  }, []);
  // Typing "/" lists the skills this bot can use.
  const slash = text.startsWith("/") && !text.includes(" ") ? text.slice(1).toLowerCase() : null;
  const usable = skills.filter((s) => !bot.skills?.length || bot.skills.includes(s.name));
  const matches = slash !== null ? usable.filter((s) => s.name.toLowerCase().includes(slash)).slice(0, 8) : [];
  const talk = async () => {
    setListening(true);
    try {
      const said = (await dictate()).trim();
      if (said) await api(`bots/${bot.id}/voice`, { body: { text: said } });
    } catch (e) {
      alert(`🎤 ${(e as Error).message}`);
    } finally {
      setListening(false);
    }
  };
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages.length, cards.length, messages[messages.length - 1]?.text]);
  useEffect(() => {
    void api(`bots/${bot.id}/read`, { body: {} }).catch(() => {});
  }, [bot.id, messages.length]);

  const send = async () => {
    const t = text.trim();
    if (!t && !pending.length) return;
    setSending(true);
    setText("");
    const files = pending;
    setPending([]);
    try {
      await api(`bots/${bot.id}/messages`, { body: { text: t, attachments: files.map((a) => a.id) } });
    } catch (e) {
      alert((e as Error).message);
      setText(t);
      setPending(files);
    } finally {
      setSending(false);
    }
  };

  const send2 = (t: string) => {
    setText(t);
  };
  let lastDay = "";
  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={onBack} aria-label="Back">
          <IconBack />
        </button>
        <Avatar bot={bot} size={2.3} live={busy} />
        <h1 style={{ display: "block" }}>
          {bot.name}
          <span class="sub">{busy ? "working…" : bot.model ? `${bot.providerId ?? "default AI"} · ${bot.model}` : bot.persona ? bot.persona.slice(0, 48) : "bot"}</span>
        </h1>
        {busy ? (
          <button class="icon-btn" aria-label="Stop" title="Stop" onClick={() => api(`bots/${bot.id}/stop`, { body: {} })}>
            <IconStop />
          </button>
        ) : null}
        {canCall && onCall ? (
          <button class="icon-btn" onClick={onCall} aria-label={`Call ${bot.name}`} title={`Call ${bot.name}`}>
            📞
          </button>
        ) : null}
        <button class="icon-btn" onClick={onEdit} aria-label="Bot settings" title="Edit bot">
          <IconEdit />
        </button>
      </div>
      <div class="messages">
        {messages.length === 0 ? (
          <div class="empty">
            <div class="big">{bot.emoji}</div>
            <p>
              Say hello to <strong>{bot.name}</strong>.
            </p>
            <div class="chips">
              {SUGGESTIONS.map((q) => (
                <button class="chip" onClick={() => send2(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        {messages.map((m) => {
          const d = dayLabel(m.at);
          const sep = d !== lastDay ? <div class="day">{d}</div> : null;
          lastDay = d;
          if (m.role === "tool") return [sep, <ToolLine m={m} key={m.id} />];
          if (m.role === "note" && m.card?.kind === "reply") return [sep, <ReplyCard id={m.card.id} key={m.id} openBot={openBot} />];
          if (m.role === "note")
            return [
              sep,
              <div class="note" key={m.id}>
                {m.text}
              </div>,
            ];
          if (m.role === "assistant" && !m.text && m.status !== "streaming") return sep;
          if (m.role === "assistant" && !m.text) return sep;
          return [
            sep,
            <div class={`msg ${m.role === "user" ? "mine" : ""}`} key={m.id}>
              <div class={`bubble ${m.status === "error" ? "error" : ""}`}>
                {m.source && m.source !== "you" ? <div class="source">⏰ {m.source}</div> : null}
                {m.attachments?.length ? (
                  <div class="files">
                    {m.attachments.map((a) => (
                      <FileChip a={a} />
                    ))}
                  </div>
                ) : null}
                {m.role === "user" ? m.text : <Markdown text={m.text} />}
                {m.status === "error" && /Settings → AI/.test(m.text) && openSettings ? (
                  <div style={{ marginTop: ".5rem" }}>
                    <button class="btn small" onClick={() => openSettings("AI")}>
                      Open sign-in
                    </button>
                  </div>
                ) : null}
              </div>
              {m.role === "assistant" && m.status !== "streaming" && m.status !== "error" ? <ResponseActions id={m.id} text={m.text} title={bot.name} openBot={openBot} /> : null}
              <div class="stamp">{time(m.at)}</div>
            </div>,
          ];
        })}
        {busy && !(messages[messages.length - 1]?.status === "streaming" && messages[messages.length - 1]?.text) ? (
          <div class="typing" aria-label="Working">
            <i />
            <i />
            <i />
          </div>
        ) : null}
        {cards.map((c) => (
          <CardView card={c} key={c.id} onDone={refresh} />
        ))}
        <div ref={end} />
      </div>
      {matches.length ? (
        <div class="slash">
          {matches.map((s) => (
            <button class="slash-item" onClick={() => setText(`Use the ${s.name} skill: `)}>
              <strong>/{s.name}</strong>
              <span class="muted">{s.description.slice(0, 90)}</span>
            </button>
          ))}
        </div>
      ) : slash !== null && !usable.length ? (
        <div class="slash">
          <div class="slash-item muted">No skills yet. Add some in Settings → Skills.</div>
        </div>
      ) : null}
      {pending.length || uploading ? (
        <div class="pending">
          {pending.map((a) => (
            <span class="file-chip">
              <span>{fileIcon(a)}</span>
              <span class="fname">{a.name}</span>
              <button class="x" aria-label={`Remove ${a.name}`} onClick={() => setPending((p) => p.filter((x) => x.id !== a.id))}>
                <IconX />
              </button>
            </span>
          ))}
          {uploading ? <span class="muted" style={{ fontSize: ".8rem" }}>Uploading {uploading}…</span> : null}
        </div>
      ) : null}
      <div
        class="composer"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          void addFiles(e.dataTransfer?.files ?? null);
        }}
      >
        <input ref={picker} type="file" multiple hidden onChange={(e) => (void addFiles((e.target as HTMLInputElement).files), ((e.target as HTMLInputElement).value = ""))} />
        <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (void addFiles((e.target as HTMLInputElement).files), ((e.target as HTMLInputElement).value = ""))} />
        <button class="send mic" aria-label="Add files" title="Add files (any type)" onClick={() => picker.current?.click()}>
          <IconClip />
        </button>
        <button class="send mic" aria-label="Take a photo" title="Take a photo" onClick={() => camera.current?.click()}>
          <IconCamera />
        </button>
        {voiceOk ? (
          <button class={`send mic ${listening ? "on" : ""}`} aria-label="Talk" title="Talk" onClick={talk} disabled={listening}>
            <IconMic />
          </button>
        ) : null}
        <textarea
          rows={1}
          value={text}
          placeholder={listening ? "Listening…" : `Message ${bot.name} · / for skills`}
          onPaste={(e) => {
            const f = e.clipboardData?.files;
            if (f?.length) {
              e.preventDefault();
              void addFiles(f);
            }
          }}
          onInput={(e) => {
            const el = e.target as HTMLTextAreaElement;
            setText(el.value);
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(min-width: 800px)").matches) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button class="send" aria-label="Send" disabled={sending || uploading > 0 || (!text.trim() && !pending.length)} onClick={send}>
          <IconSend />
        </button>
      </div>
    </>
  );
}
