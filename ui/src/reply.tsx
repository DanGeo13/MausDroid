import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import { IconBack } from "./icons.tsx";
import { ResponseActions, copyText, toast } from "./actions.tsx";

const when = (iso: string) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) + " " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

/**
 * One message that may need a reply, with its draft: the same card in Reply
 * Desk and in any bot's chat. The accent colour shows the service. Email is
 * sent only after you approve the exact final text and recipient (any edit
 * needs approving again); WhatsApp opens with the draft prefilled; other apps
 * get Copy reply + Open conversation. Opening or copying keeps it pending.
 */
export function ReplyCard({ id, openBot, onChange }: { id: string; openBot?: (botId: string, text: string) => void; onChange?: () => void }) {
  const [it, setIt] = useState<any | null>(null);
  const [text, setText] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState("");
  const [review, setReview] = useState<{ body: string; to: string } | null>(null);
  const [approved, setApproved] = useState<string | null>(null);
  const [showCtx, setShowCtx] = useState(false);
  const [snooze, setSnooze] = useState(false);
  const load = () =>
    void api(`replies/${id}`)
      .then((x) => {
        setIt(x);
        setText((t) => (t && t !== x.draft?.text && document.activeElement?.tagName === "TEXTAREA" ? t : x.draft?.text ?? ""));
        setTo((t) => t || x.draft?.to || (x.source?.kind === "email" ? x.source.from : ""));
      })
      .catch(() => setIt(false));
  useEffect(load, [id]);
  if (it === false) return <div class="note">This Reply Desk message is gone.</div>;
  if (!it) return <div class="note">Loading…</div>;
  const svc = it.serviceInfo ?? { label: it.service, accent: "#777", reply: "copy" };
  const done = it.status !== "pending";
  const act = async (label: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(label);
    try {
      await fn();
      if (ok) toast(ok);
      load();
      onChange?.();
    } catch (e) {
      toast(`⚠️ ${(e as Error).message}`);
    } finally {
      setBusy("");
    }
  };
  // Any change to the text or recipient after approving needs a fresh approval.
  const edit = (v: string) => {
    setText(v);
    setApproved(null);
    setReview(null);
  };
  const editTo = (v: string) => {
    setTo(v);
    setApproved(null);
    setReview(null);
  };
  const save = () => api(`replies/${id}/draft`, { method: "PUT", body: { text, to } });
  const statusLabel: Record<string, string> = { handled: "✓ Handled", "no-reply": "No reply needed", snoozed: `Snoozed${it.snoozeUntil ? ` until ${when(it.snoozeUntil)}` : ""}` };
  return (
    <div class="reply-card" style={{ borderLeftColor: svc.accent }}>
      <div class="reply-head">
        <span class="svc" style={{ background: svc.accent }}>
          {svc.label}
        </span>
        <strong>{it.sender}</strong>
        {it.conversation && it.conversation !== it.sender ? <span class="muted"> · {it.conversation}</span> : null}
        <span class="muted" style={{ marginLeft: "auto", fontSize: ".8rem" }}>
          {when(it.at)}
        </span>
      </div>
      {it.subject ? <div style={{ fontWeight: 600, marginTop: ".2rem" }}>{it.subject}</div> : null}
      <div class="reply-text">{it.text}</div>
      <div class="muted" style={{ fontSize: ".78rem" }}>
        {it.preview ? <span class="pill">Preview</span> : null} {it.likely ? `May need a reply — ${it.reason}` : it.reason}
        {it.openedAt && !done ? " · opened, still pending" : ""}
        {it.copiedAt && !done ? " · copied, still pending" : ""}
        {done ? ` · ${statusLabel[it.status] ?? it.status}` : ""}
        {it.sent ? ` · sent via ${it.sent.via}` : ""}
      </div>
      {it.context?.length ? (
        <div style={{ marginTop: ".3rem" }}>
          <button class="btn secondary small" onClick={() => setShowCtx(!showCtx)}>
            {showCtx ? "Hide conversation" : `Conversation (${it.context.length})`}
          </button>
          {showCtx ? (
            <div class="reply-ctx">
              {it.context.map((m: any) => (
                <div>
                  <strong>{m.who || "?"}:</strong> {m.text}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {it.source?.kind === "email" ? (
        <label class="field" style={{ marginTop: ".5rem" }}>
          <span class="muted" style={{ fontSize: ".8rem" }}>
            To
          </span>
          <input value={to} onInput={(e) => editTo((e.target as HTMLInputElement).value)} aria-label="Recipient" />
        </label>
      ) : null}
      <textarea class="reply-draft" rows={Math.min(12, Math.max(3, text.split("\n").length + 1))} placeholder="Your reply…" value={text} onInput={(e) => edit((e.target as HTMLTextAreaElement).value)} onBlur={() => text !== (it.draft?.text ?? "") && void save()} aria-label="Reply draft" />
      {text ? <ResponseActions id={`draft-${id}`} text={text} title={`Reply to ${it.sender}`} openBot={openBot} /> : null}
      {review ? (
        <div class="reply-review">
          <div>
            <strong>Send to:</strong> {review.to}
          </div>
          <pre>{review.body}</pre>
          <div class="inline" style={{ gap: ".4rem" }}>
            <button
              class="btn small"
              disabled={Boolean(busy)}
              onClick={() =>
                act(
                  "send",
                  async () => {
                    // Approval is for exactly this text and recipient.
                    await api(`replies/${id}/approve`, { body: { text, to } });
                    setApproved(review.body);
                    await api(`replies/${id}/send`, { body: { text, to } });
                    setReview(null);
                  },
                  "Sent ✓",
                )
              }
            >
              Approve &amp; send
            </button>
            <button class="btn secondary small" onClick={() => setReview(null)}>
              Back to editing
            </button>
          </div>
          {approved ? <p class="help">Approved this exact text.</p> : null}
        </div>
      ) : null}
      <div class="reply-buttons">
        <button class="btn secondary small" disabled={Boolean(busy)} onClick={() => act("draft", () => api(`replies/${id}/draft`, { body: {} }), "Draft ready — check it before sending.")}>
          {busy === "draft" ? "Drafting…" : text ? "Redraft" : "Draft reply"}
        </button>
        {svc.reply === "send" && it.source?.kind === "email" ? (
          <button
            class="btn small"
            style={{ background: svc.accent }}
            disabled={!text.trim() || !to.trim() || Boolean(busy)}
            onClick={() => act("review", async () => setReview({ body: (await api<{ body: string }>(`replies/${id}/preview`, { body: { text } })).body, to }))}
          >
            Review &amp; send
          </button>
        ) : null}
        {it.service === "whatsapp" ? (
          <button class="btn small" style={{ background: svc.accent }} disabled={!text.trim() || Boolean(busy)} onClick={() => act("wa", () => api(`replies/${id}/whatsapp`, { body: { text } }), "WhatsApp opened with your reply — pick the chat and send.")}>
            Open in WhatsApp
          </button>
        ) : null}
        {svc.reply === "copy" || (svc.reply === "send" && it.source?.kind !== "email") ? (
          <button
            class="btn small"
            style={{ background: svc.accent }}
            disabled={!text.trim() || Boolean(busy)}
            onClick={() =>
              act("copy", async () => {
                await copyText(text);
                await api(`replies/${id}/copied`, { body: { text } });
              }, "Reply copied — paste it in the conversation.")
            }
          >
            Copy reply
          </button>
        ) : null}
        {it.service !== "whatsapp" || !text ? (
          <button class="btn secondary small" disabled={Boolean(busy)} onClick={() => act("open", () => api(`replies/${id}/open`, { body: {} }))}>
            Open conversation
          </button>
        ) : null}
      </div>
      <div class="reply-buttons">
        <button class="btn secondary small" onClick={() => act("mark", () => api(`replies/${id}/mark`, { body: { status: "handled" } }), "Marked handled")}>
          Handled
        </button>
        <button class="btn secondary small" onClick={() => act("mark", () => api(`replies/${id}/mark`, { body: { status: "no-reply" } }), "No reply needed")}>
          No reply needed
        </button>
        <button class="btn secondary small" aria-expanded={snooze} onClick={() => setSnooze(!snooze)}>
          Snooze
        </button>
        {done ? (
          <button class="btn secondary small" onClick={() => act("mark", () => api(`replies/${id}/mark`, { body: { status: "pending" } }))}>
            Back to pending
          </button>
        ) : null}
      </div>
      {snooze ? (
        <div class="reply-buttons">
          {[
            ["hour", "1 hour"],
            ["evening", "This evening"],
            ["tomorrow", "Tomorrow morning"],
          ].map(([k, label]) => (
            <button class="btn secondary small" onClick={() => (setSnooze(false), act("mark", () => api(`replies/${id}/mark`, { body: { status: "snoozed", snooze: k } }), `Snoozed: ${label}`))}>
              {label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Reply Desk: everything that may need your reply, in one place. */
export function ReplyDesk({ focusId, onBack, openBot }: { focusId?: string; onBack: () => void; openBot?: (botId: string, text: string) => void }) {
  const [tab, setTab] = useState<"pending" | "snoozed" | "handled" | "no-reply">("pending");
  const [items, setItems] = useState<any[] | null>(null);
  const [src, setSrc] = useState<any | null>(null);
  const [setup, setSetup] = useState(false);
  const load = () => void api(`replies?status=${tab}`).then((r) => setItems(r.items)).catch(() => setItems([]));
  useEffect(load, [tab]);
  useEffect(() => {
    void api("replies/sources").then(setSrc).catch(() => {});
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [tab]);
  const toggle = async (service: string, on: boolean) => setSrc(await api(`replies/sources/${service}`, { method: "PUT", body: { on } }).catch((e) => (toast(`⚠️ ${(e as Error).message}`), src)));
  const sorted = focusId && items ? [...items.filter((x) => x.id === focusId), ...items.filter((x) => x.id !== focusId)] : items;
  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={onBack} aria-label="Back">
          <IconBack />
        </button>
        <h1>Reply Desk</h1>
        <button class="btn secondary small" onClick={() => void api("replies/refresh", { body: {} }).then((r) => (load(), toast(r.problems?.length ? `⚠️ ${r.problems[0]}` : `Email checked${r.added ? `: ${r.added} new` : ""}`)))}>
          Refresh
        </button>
        <button class="btn secondary small" onClick={() => setSetup(!setup)}>
          Sources
        </button>
      </div>
      <div class="page">
        {setup && src ? (
          <div class="section">
            <h2>What Reply Desk reads</h2>
            <p class="help">Email comes from Gmail in Connected apps (full messages, sending after your approval). Messaging apps are read from their notifications (previews only), and only the ones you switch on.{src.notificationAccess ? "" : " MausDroid needs notification access first: Settings → Phone → Notification reading."}</p>
            {src.services
              .filter((s: any) => s.installed || s.service === "gmail")
              .map((s: any) => (
                <label class="toggle">
                  <span>
                    <span class="dot" style={{ background: s.accent }} /> {s.label} <span class="muted">· {s.reply === "send" ? "send after approval" : s.reply === "prefill" ? "opens prefilled" : "copy + open"}</span>
                  </span>
                  {s.service === "gmail" ? <span class="muted">{s.reading ? "connected" : "connect in Settings → Connected apps"}</span> : <input type="checkbox" checked={s.reading} onChange={(e) => toggle(s.service, (e.target as HTMLInputElement).checked)} />}
                </label>
              ))}
          </div>
        ) : null}
        <div class="seg" style={{ marginBottom: ".6rem" }}>
          {(
            [
              ["pending", "Pending"],
              ["snoozed", "Snoozed"],
              ["handled", "Handled"],
              ["no-reply", "No reply"],
            ] as const
          ).map(([k, label]) => (
            <button class={tab === k ? "on" : ""} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        {!sorted ? <p class="muted">Loading…</p> : !sorted.length ? <p class="muted">{tab === "pending" ? "Nothing waiting for a reply." : "Nothing here."}</p> : sorted.map((x) => <ReplyCard id={x.id} key={x.id} openBot={openBot} onChange={load} />)}
      </div>
    </>
  );
}
