import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import type { Bot, Card, Msg } from "./types.ts";
import { IconBack, IconEdit, IconSend, IconStop } from "./icons.tsx";

/** Bot picture: emoji on its colour. `size` in rem so it follows the text-size setting. */
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
            Always allow {card.tool}
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

export function Chat({ bot, messages, cards, onBack, onEdit, refresh, busy }: {
  bot: Bot; messages: Msg[]; cards: Card[]; busy: boolean; onBack: () => void; onEdit: () => void; refresh: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [messages.length, cards.length, messages[messages.length - 1]?.text]);
  useEffect(() => {
    void api(`bots/${bot.id}/read`, { body: {} }).catch(() => {});
  }, [bot.id, messages.length]);

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setSending(true);
    setText("");
    try {
      await api(`bots/${bot.id}/messages`, { body: { text: t } });
    } catch (e) {
      alert((e as Error).message);
      setText(t);
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
          <span class="sub">{busy ? "working…" : bot.persona ? bot.persona.slice(0, 48) : "bot"}</span>
        </h1>
        {busy ? (
          <button class="icon-btn" aria-label="Stop" title="Stop" onClick={() => api(`bots/${bot.id}/stop`, { body: {} })}>
            <IconStop />
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
                {m.role === "user" ? m.text : <Markdown text={m.text} />}
              </div>
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
      <div class="composer">
        <textarea
          rows={1}
          value={text}
          placeholder={`Message ${bot.name}`}
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
        <button class="send" aria-label="Send" disabled={sending || !text.trim()} onClick={send}>
          <IconSend />
        </button>
      </div>
    </>
  );
}
