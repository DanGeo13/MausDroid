import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Markdown } from "./markdown.tsx";
import type { Bot, Card, Msg } from "./types.ts";

export function Avatar({ bot, size = 44 }: { bot: Pick<Bot, "emoji" | "color">; size?: number }) {
  return (
    <div class="avatar" style={{ background: bot.color, width: size, height: size, fontSize: size / 2 }}>
      {bot.emoji}
    </div>
  );
}

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
  const nice = t.name.replace(/^composio__/, "apps · ").replace(/_/g, " ");
  return (
    <button class="tool" onClick={() => setOpen(!open)}>
      {icon} {nice}
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

  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <Avatar bot={bot} size={34} />
        <h1>
          {bot.name} {busy ? <span class="dot" title="Working" /> : null}
        </h1>
        {busy ? (
          <button class="btn secondary small" onClick={() => api(`bots/${bot.id}/stop`, { body: {} })}>
            Stop
          </button>
        ) : null}
        <button class="icon-btn" onClick={onEdit} aria-label="Bot settings">
          ⚙︎
        </button>
      </div>
      <div class="messages">
        {messages.length === 0 ? <div class="empty">Say hello to {bot.name}. Ask for anything: research, your inbox, a website task, a daily briefing…</div> : null}
        {messages.map((m) =>
          m.role === "tool" ? (
            <ToolLine m={m} key={m.id} />
          ) : m.role === "note" ? (
            <div class="note" key={m.id}>
              {m.text}
            </div>
          ) : m.role === "assistant" && !m.text && m.status !== "streaming" ? null : (
            <div class={`bubble ${m.role === "user" ? "mine" : ""} ${m.status === "error" ? "error" : ""}`} key={m.id}>
              {m.source && m.source !== "you" ? <div class="source">⏰ {m.source}</div> : null}
              {m.role === "user" ? m.text : <Markdown text={m.text || "…"} />}
            </div>
          ),
        )}
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
          onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && window.matchMedia("(min-width: 800px)").matches) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button class="btn" disabled={sending || !text.trim()} onClick={send}>
          Send
        </button>
      </div>
    </>
  );
}
