import { createHash } from "node:crypto";
import { collection } from "./store.ts";
import { emit } from "./events.ts";
import { notifyUser } from "./notify.ts";
import { bridge, bridgeAvailable } from "./bridge.ts";
import { argsFor, executeTool, listConnections } from "./composio.ts";
import { onPhoneNotification, type PhoneNotification } from "./phone-notifications.ts";
import { clip, errorText, htmlToText, id as newId, now } from "./util.ts";

/**
 * Reply Desk: one place for messages that may need your reply — email
 * (Gmail through connected apps: full text and thread, sending after your
 * approval) and messaging apps whose notifications DanDroid reads (previews
 * only: WhatsApp, Messenger, SMS…). One card per conversation, so the same
 * conversation never reminds you twice. You mark each Handled, No reply needed
 * or Snooze. Drafts never leave the phone by themselves: email is sent only
 * after you approve the exact final text and recipient; for messaging apps you
 * open the app (WhatsApp prefilled) or copy the reply and send it yourself.
 */

// ---------------- Services ----------------

export interface Service {
  id: string;
  label: string;
  /** Recognisable accent colour for the card. */
  accent: string;
  /** How a reply leaves DanDroid: send (after approval), prefill (open the app with the text), copy (paste it yourself). */
  reply: "send" | "prefill" | "copy";
  packages: string[];
}
export const SERVICES: Service[] = [
  { id: "gmail", label: "Gmail", accent: "#EA4335", reply: "send", packages: ["com.google.android.gm"] },
  { id: "whatsapp", label: "WhatsApp", accent: "#25D366", reply: "prefill", packages: ["com.whatsapp", "com.whatsapp.w4b"] },
  { id: "messenger", label: "Messenger", accent: "#0084FF", reply: "copy", packages: ["com.facebook.orca", "com.facebook.mlite"] },
  { id: "instagram", label: "Instagram", accent: "#E1306C", reply: "copy", packages: ["com.instagram.android"] },
  { id: "sms", label: "Messages", accent: "#1A73E8", reply: "copy", packages: ["com.google.android.apps.messaging", "com.samsung.android.messaging", "com.android.mms", "com.android.messaging"] },
  { id: "telegram", label: "Telegram", accent: "#229ED9", reply: "copy", packages: ["org.telegram.messenger", "org.telegram.messenger.web"] },
  { id: "signal", label: "Signal", accent: "#3A76F0", reply: "copy", packages: ["org.thoughtcrime.securesms"] },
  { id: "outlook", label: "Outlook", accent: "#0078D4", reply: "copy", packages: ["com.microsoft.office.outlook"] },
  { id: "slack", label: "Slack", accent: "#4A154B", reply: "copy", packages: ["com.Slack"] },
  { id: "teams", label: "Teams", accent: "#6264A7", reply: "copy", packages: ["com.microsoft.teams"] },
  { id: "linkedin", label: "LinkedIn", accent: "#0A66C2", reply: "copy", packages: ["com.linkedin.android"] },
];
export const MESSAGING_PACKAGES = SERVICES.flatMap((s) => s.packages);
export const serviceById = (sid: string) => SERVICES.find((s) => s.id === sid);
export const serviceForPackage = (pkg: string) => SERVICES.find((s) => s.packages.includes(pkg));

// ---------------- Items ----------------

export type ItemStatus = "pending" | "handled" | "no-reply" | "snoozed";
export interface ReplyItem {
  id: string;
  /** One card per conversation (service + conversation): no duplicate reminders. */
  convKey: string;
  service: string;
  sender: string;
  conversation?: string;
  group?: boolean;
  /** Only the notification's text is known (not the full conversation). */
  preview: boolean;
  at: string;
  text: string;
  subject?: string;
  context: { who: string; text: string; at?: string }[];
  source: { kind: "notification"; key: string; pkg: string } | { kind: "email"; accountId: string; threadId: string; messageId: string; from: string; to?: string };
  likely: boolean;
  reason: string;
  status: ItemStatus;
  snoozeUntil?: string;
  decidedAt?: string;
  draft?: { text: string; to?: string; by?: string; at: string };
  /** The exact text + recipient you approved (email); any change needs a fresh approval. */
  approval?: { hash: string; at: string };
  sent?: { at: string; via: string };
  openedAt?: string;
  copiedAt?: string;
  remindedAt?: string;
}

const store = collection<{ items: ReplyItem[]; seenEmail: string[]; enabled: boolean }>("reply-desk", { items: [], seenEmail: [], enabled: true });
store.update((s) => {
  s.items ??= [];
  s.seenEmail ??= [];
  s.enabled ??= true;
});

const changed = (id?: string) => emit("reply-desk", { id, pending: pendingCount() });
export const getItem = (id: string) => store.get().items.find((x) => x.id === id);
function patch(id: string, p: Partial<ReplyItem>): ReplyItem {
  let out: ReplyItem | undefined;
  store.update((s) => {
    const it = s.items.find((x) => x.id === id);
    if (!it) throw new Error("No such message in Reply Desk.");
    Object.assign(it, p);
    out = { ...it };
  });
  changed(id);
  return out!;
}

/** Snoozed items whose time has come are pending again (and remind once). */
function wake() {
  const due: string[] = [];
  store.update((s) => {
    for (const it of s.items) if (it.status === "snoozed" && it.snoozeUntil && new Date(it.snoozeUntil).getTime() <= Date.now()) {
      it.status = "pending";
      it.snoozeUntil = undefined;
      it.remindedAt = undefined;
      due.push(it.id);
    }
  });
  for (const id of due) void remind(getItem(id)!);
}

export function listItems(filter: { status?: ItemStatus | "all"; likelyOnly?: boolean } = {}) {
  wake();
  const st = filter.status ?? "pending";
  return store
    .get()
    .items.filter((x) => st === "all" || x.status === st)
    .filter((x) => !filter.likelyOnly || x.likely)
    .sort((a, b) => Number(b.likely) - Number(a.likely) || b.at.localeCompare(a.at));
}
export const pendingCount = () => listItems({ status: "pending" }).filter((x) => x.likely).length;

// ---------------- Does it need a reply? ----------------

const AUTOMATED = /\b(no-?reply|do-?not-?reply|notifications?|newsletter|mailer|bounce|alerts?|digest|receipts?|billing|marketing|updates?)\b/i;
const ASKS = /\?|\b(can you|could you|would you|will you|are you|do you|did you|have you|let me know|please|pls|when|what time|where|how about|let's|lets|call me|ring me|thoughts|free (on|at|for)|available|rsvp|confirm)\b/i;
const NOT_A_MESSAGE = /^\s*(\d+ new messages?|missed (voice |video )?call|.+ is typing|calling…|ringing|\d+ messages from \d+ chats?)\s*$/i;

/** A quick local judgement: questions, requests and direct messages from people need a reply; automated mail and group chatter usually don't. */
export function needsReply(it: { text: string; sender: string; group?: boolean; subject?: string; email?: boolean }, myName = ""): { likely: boolean; reason: string } {
  const text = `${it.subject ?? ""}\n${it.text}`;
  if (AUTOMATED.test(it.sender)) return { likely: false, reason: "automated sender" };
  if (NOT_A_MESSAGE.test(it.text)) return { likely: false, reason: "not a message" };
  const named = myName && new RegExp(`\\b${myName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
  if (it.group && !named && !/\?/.test(it.text)) return { likely: false, reason: "group chat, not addressed to you" };
  if (ASKS.test(text)) return { likely: true, reason: /\?/.test(text) ? "asks a question" : "asks something of you" };
  if (named) return { likely: true, reason: "mentions you" };
  if (it.email) return { likely: false, reason: "no question or request" };
  return { likely: !it.group, reason: it.group ? "group chat" : "a direct message" };
}

async function myName(): Promise<string> {
  try {
    return (await import("./call-session.ts")).userName();
  } catch {
    return "";
  }
}

/** One reminder per conversation (until you act on it or something new arrives after you did). */
async function remind(it: ReplyItem) {
  if (!it || it.status !== "pending" || !it.likely || it.remindedAt) return;
  patch(it.id, { remindedAt: now() });
  const svc = serviceById(it.service);
  await notifyUser({
    title: `${svc?.label ?? "Message"} from ${it.sender} may need a reply`,
    body: clip(it.text, 200),
    type: "reply-desk",
    source: svc?.label,
    eventId: `reply:${it.convKey}:${it.at}`,
    link: `replydesk:${it.id}`,
    priority: "normal",
  });
}

/** Adds or updates the conversation's card: a newer message updates it; one after you'd decided reopens it. */
function upsert(convKey: string, make: () => Omit<ReplyItem, "id" | "status" | "likely" | "reason">, judge: { likely: boolean; reason: string }): ReplyItem {
  let item: ReplyItem | undefined;
  let reopen = false;
  store.update((s) => {
    const cur = s.items.find((x) => x.convKey === convKey);
    const fresh = make();
    if (!cur) {
      item = { ...fresh, id: newId("rd"), status: "pending", likely: judge.likely, reason: judge.reason };
      s.items.push(item);
      if (s.items.length > 500) s.items.splice(0, s.items.length - 500);
      return;
    }
    if (fresh.at <= cur.at) return void (item = cur); // already have this (or newer)
    const decided = cur.status !== "pending" && cur.status !== "snoozed";
    const ctx = [...cur.context, ...fresh.context].filter((m, i, a) => a.findIndex((x) => x.text === m.text && x.who === m.who) === i).slice(-12);
    Object.assign(cur, { ...fresh, context: ctx, likely: judge.likely || (cur.likely && !decided), reason: judge.reason });
    if (decided && judge.likely) {
      cur.status = "pending";
      cur.decidedAt = undefined;
      cur.remindedAt = undefined;
      cur.draft = undefined;
      cur.approval = undefined;
      cur.sent = undefined;
      reopen = true;
    }
    item = cur;
  });
  changed(item!.id);
  if (item!.status === "pending" && (reopen || !item!.remindedAt)) void remind(item!);
  return item!;
}

// ---------------- Sources ----------------

/** A notification from a messaging app (preview only). */
export async function fromNotification(n: PhoneNotification): Promise<ReplyItem | null> {
  if (!store.get().enabled) return null;
  const svc = serviceForPackage(n.pkg);
  if (!svc || n.summary || !n.text.trim()) return null;
  const sender = (n.group ? n.title.split(/[:@]/)[0] : n.title).trim() || svc.label;
  const conversation = n.conversation || (n.group ? n.title : n.title);
  const convKey = `${svc.id}:${(conversation || sender).toLowerCase()}`;
  const judge = needsReply({ text: n.text, sender, group: n.group }, await myName());
  return upsert(
    convKey,
    () => ({
      convKey,
      service: svc.id,
      sender,
      conversation: n.conversation || undefined,
      group: n.group,
      preview: true,
      at: n.postedAt,
      text: clip(n.text, 2000),
      context: (n.messages ?? []).map((m) => ({ who: m.who, text: m.text, at: m.at ? new Date(m.at).toISOString() : undefined })),
      source: { kind: "notification", key: n.key, pkg: n.pkg },
    }),
    judge,
  );
}

const findArray = (data: any, keys: string[]): any[] => {
  if (!data || typeof data !== "object") return [];
  for (const k of keys) if (Array.isArray(data[k])) return data[k];
  for (const v of Object.values(data)) if (v && typeof v === "object") {
    const hit = findArray(v, keys);
    if (hit.length) return hit;
  }
  return [];
};
const pick = (o: any, ...ks: string[]) => ks.map((k) => o?.[k]).find((v) => v !== undefined && v !== null && v !== "");
const emailAddr = (s: string) => /<([^>]+)>/.exec(s)?.[1] ?? (/\S+@\S+/.exec(s)?.[0] ?? s);
const displayName = (s: string) => s.replace(/<[^>]+>/, "").replace(/"/g, "").trim() || emailAddr(s);

/** Unread personal email (Gmail through connected apps), newest first. */
export async function refreshEmail(): Promise<{ added: number; problems: string[] }> {
  const problems: string[] = [];
  let added = 0;
  const accounts = (await listConnections().catch(() => [])).filter((a: any) => a.toolkit === "gmail" && a.status === "ACTIVE");
  const name = await myName();
  for (const a of accounts) {
    try {
      const args = await argsFor("GMAIL_FETCH_EMAILS", { q: { names: ["query", "q"], value: "in:inbox is:unread newer_than:4d -category:promotions -category:social -category:updates -category:forums" }, n: { names: ["max_results", "maxResults"], value: 20 } });
      const data = await executeTool("GMAIL_FETCH_EMAILS", args, a.id);
      for (const m of findArray(data, ["messages", "emails"])) {
        const messageId = String(pick(m, "messageId", "message_id", "id") ?? "");
        const threadId = String(pick(m, "threadId", "thread_id") ?? messageId);
        if (!messageId) continue;
        const from = String(pick(m, "sender", "from", "From") ?? "");
        const subject = String(pick(m, "subject", "Subject") ?? "");
        const text = clip(htmlToText(String(pick(m, "messageText", "message_text", "snippet", "preview", "body") ?? "")), 4000);
        const at = new Date(pick(m, "messageTimestamp", "internalDate", "date") ? (Number(pick(m, "internalDate")) || Date.parse(String(pick(m, "messageTimestamp", "date")))) : Date.now()).toISOString();
        const known = store.get().seenEmail.includes(messageId);
        if (known) continue;
        store.update((s) => {
          s.seenEmail.push(messageId);
          if (s.seenEmail.length > 2000) s.seenEmail.splice(0, s.seenEmail.length - 2000);
        });
        const convKey = `gmail:${threadId}`;
        const judge = needsReply({ text, sender: from, subject, email: true }, name);
        upsert(convKey, () => ({ convKey, service: "gmail", sender: displayName(from), preview: false, at, text, subject, context: [], source: { kind: "email", accountId: a.id, threadId, messageId, from: emailAddr(from) } }), judge);
        added++;
      }
    } catch (e) {
      problems.push(`${a.alias ?? "Gmail"}: ${errorText(e)}`);
    }
  }
  return { added, problems };
}

/** The whole email thread, for context and drafting. */
export async function loadThread(id: string) {
  const it = getItem(id);
  if (!it || it.source.kind !== "email") return it;
  try {
    const args = await argsFor("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", { t: { names: ["thread_id", "threadId"], value: it.source.threadId } });
    const data = await executeTool("GMAIL_FETCH_MESSAGE_BY_THREAD_ID", args, it.source.accountId);
    const context = findArray(data, ["messages"]).slice(-8).map((m: any) => ({ who: displayName(String(pick(m, "sender", "from") ?? "")), text: clip(htmlToText(String(pick(m, "messageText", "snippet", "body") ?? "")), 1500), at: pick(m, "messageTimestamp") ? String(pick(m, "messageTimestamp")) : undefined }));
    if (context.length) return patch(id, { context });
  } catch {
    /* the snippet is enough to draft from */
  }
  return getItem(id);
}

// ---------------- Your decisions ----------------

export function mark(id: string, status: "handled" | "no-reply" | "snoozed" | "pending", until?: string): ReplyItem {
  if (status === "snoozed") {
    const t = until ? new Date(until) : new Date(Date.now() + 3 * 3600_000);
    if (!Number.isFinite(t.getTime())) throw new Error("When should it come back?");
    return patch(id, { status, snoozeUntil: t.toISOString(), decidedAt: now() });
  }
  return patch(id, { status, snoozeUntil: undefined, decidedAt: status === "pending" ? undefined : now() });
}
/** Snooze presets: in an hour, this evening (6 pm), tomorrow morning (8 am). */
export function snoozeTime(preset: string, at = new Date()): string {
  const d = new Date(at);
  if (preset === "evening") {
    d.setHours(18, 0, 0, 0);
    if (d <= at) d.setDate(d.getDate() + 1);
  } else if (preset === "tomorrow") {
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
  } else d.setTime(at.getTime() + 3600_000);
  return d.toISOString();
}

// ---------------- Drafts ----------------

/** Hand-written sign-offs are left out of email drafts (your Gmail signature is added instead). */
export function stripSignOff(text: string, name = ""): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const signOff = /^(cheers|thanks|thank you|many thanks|kind regards|best regards|regards|best|warm regards|all the best|sincerely|yours sincerely|talk soon|speak soon|ta)[,.!]?$/i;
  for (let k = 0; k < 3 && lines.length > 1; k++) {
    const last = lines[lines.length - 1].trim();
    const prev = (lines[lines.length - 2] ?? "").trim();
    // A name line right after a sign-off ("Cheers,\nDan") goes too, even when DanDroid doesn't know your name.
    const nameAfterSignOff = /^[A-Z][A-Za-z'-]+( [A-Z][A-Za-z'-]+){0,2}$/.test(last) && signOff.test(prev);
    if (!last || signOff.test(last) || nameAfterSignOff || (name && last.replace(/[^A-Za-z ]/g, "").trim().toLowerCase() === name.toLowerCase()) || /^-+\s*\w+$/.test(last)) lines.pop();
    else break;
  }
  return lines.join("\n").replace(/\s+$/, "");
}

const signatures = new Map<string, { text: string; at: number }>();
/** Your existing Gmail signature (as plain text), if Gmail shares it. */
export async function emailSignature(accountId: string): Promise<string> {
  const c = signatures.get(accountId);
  if (c && Date.now() - c.at < 24 * 3600_000) return c.text;
  let text = "";
  for (const slug of ["GMAIL_LIST_SEND_AS", "GMAIL_GET_SEND_AS", "GMAIL_LIST_SEND_AS_ALIASES"]) {
    try {
      const data = await executeTool(slug, await argsFor(slug, { u: { names: ["user_id", "userId"], value: "me" } }), accountId);
      const list = findArray(data, ["sendAs", "send_as", "aliases"]);
      const primary = list.find((x: any) => x.isPrimary || x.is_primary || x.isDefault) ?? list[0] ?? data;
      const sig = String(pick(primary, "signature") ?? "");
      if (sig) {
        text = htmlToText(sig).trim();
        break;
      }
    } catch {
      /* try the next way */
    }
  }
  signatures.set(accountId, { text, at: Date.now() });
  return text;
}

/** The exact email that would go out: your draft (no sign-off) + your signature. */
export async function finalEmail(id: string, draftText: string): Promise<{ body: string; signature: string }> {
  const it = getItem(id);
  if (!it || it.source.kind !== "email") throw new Error("Only email can be sent from DanDroid.");
  const signature = await emailSignature(it.source.accountId);
  const body = stripSignOff(draftText, await myName());
  return { body: signature ? `${body}\n\n${signature}` : body, signature };
}

export function saveDraft(id: string, text: string, to?: string, by = "you"): ReplyItem {
  const it = getItem(id);
  if (!it) throw new Error("No such message in Reply Desk.");
  const clean = String(text ?? "");
  const changedText = clean !== it.draft?.text || (to ?? it.draft?.to) !== it.draft?.to;
  // Any change to the text or recipient needs a fresh approval.
  return patch(id, { draft: { text: clean, to: to ?? it.draft?.to ?? (it.source.kind === "email" ? it.source.from : undefined), by, at: now() }, ...(changedText ? { approval: undefined } : {}) });
}

/** Asks a bot to write the draft (in your style; no sign-off for email). */
export async function draftWithBot(id: string, botId: string): Promise<ReplyItem> {
  const it = (await loadThread(id)) ?? getItem(id);
  if (!it) throw new Error("No such message in Reply Desk.");
  const { onTurnEnd, sendToBot } = await import("./agent.ts");
  const { HUMAN_STYLE } = await import("./speech-style.ts");
  const svc = serviceById(it.service);
  const tag = newId("rddraft");
  const reply = await new Promise<string>((resolve) => {
    const off = onTurnEnd((b, text, info) => {
      if (b !== botId || !(info?.tags ?? []).includes(tag)) return;
      off();
      resolve((text ?? "").trim());
    });
    setTimeout(() => (off(), resolve("")), 120_000);
    const ctx = it.context.length ? it.context.map((m) => `${m.who || "?"}: ${m.text}`).join("\n") : "";
    sendToBot(
      botId,
      `Draft a reply for me to this ${svc?.label ?? "message"} from ${it.sender}${it.subject ? ` (subject: ${it.subject})` : ""}:\n\n"${it.text}"${ctx ? `\n\nConversation so far:\n${ctx}` : ""}${it.preview ? "\n\n(Only the notification preview is known.)" : ""}`,
      "reply-desk",
      [],
      tag,
      `(Reply Desk draft: reply with ONLY the message text I'd send — no preamble, no quotes around it. ${it.service === "gmail" ? "It's an email: no greeting line is needed unless natural, and NO sign-off or name at the end (my signature is added automatically)." : "It's a chat message: short and natural, like I'd text."} Keep any links exactly. Don't send anything.\n${HUMAN_STYLE})`,
    );
  });
  if (!reply) throw new Error("No draft came back. Try again, or write it yourself.");
  const text = it.service === "gmail" ? stripSignOff(reply, await myName()) : reply;
  return saveDraft(id, text, undefined, botId);
}

// ---------------- Sending (email) — only what you approved ----------------

const hashOf = (text: string, to: string) => createHash("sha256").update(`${to}\n${text}`).digest("hex");

/** You approve this exact final text (with signature) to this recipient. */
export async function approveSend(id: string, draftText: string, to: string): Promise<{ hash: string; body: string; to: string }> {
  const it = getItem(id);
  if (!it || it.source.kind !== "email") throw new Error("Only email can be sent from DanDroid; for other apps, open the app or copy the reply.");
  if (!to.trim()) throw new Error("Who should it go to?");
  saveDraft(id, draftText, to);
  const { body } = await finalEmail(id, draftText);
  const hash = hashOf(body, to.trim());
  patch(id, { approval: { hash, at: now() } });
  return { hash, body, to: to.trim() };
}

/** Sends only if the final text and recipient are exactly what was approved (within 10 minutes). */
export async function sendApproved(id: string, draftText: string, to: string): Promise<ReplyItem> {
  const it = getItem(id);
  if (!it || it.source.kind !== "email") throw new Error("Only email can be sent from DanDroid.");
  const { body } = await finalEmail(id, draftText);
  const hash = hashOf(body, to.trim());
  if (!it.approval || it.approval.hash !== hash) throw new Error("The text or recipient changed since you approved it. Review and approve again.");
  if (Date.now() - new Date(it.approval.at).getTime() > 10 * 60_000) throw new Error("That approval is more than 10 minutes old. Review and approve again.");
  const args = await argsFor("GMAIL_REPLY_TO_THREAD", {
    t: { names: ["thread_id", "threadId"], value: it.source.threadId },
    b: { names: ["message_body", "body"], value: body },
    r: { names: ["recipient_email", "to"], value: to.trim() },
  });
  await executeTool("GMAIL_REPLY_TO_THREAD", args, it.source.accountId);
  return patch(id, { sent: { at: now(), via: "Gmail" }, status: "handled", decidedAt: now(), approval: undefined });
}

// ---------------- Opening and copying (stays pending) ----------------

export async function openConversation(id: string): Promise<string> {
  const it = getItem(id);
  if (!it) throw new Error("No such message in Reply Desk.");
  patch(id, { openedAt: now() });
  if (!bridgeAvailable()) return "none";
  if (it.source.kind === "notification") return (await bridge<{ opened: string }>("/conversation/open", { key: it.source.key, pkg: it.source.pkg })).opened;
  await bridge("/share/send", { kind: "url", text: `https://mail.google.com/mail/u/0/#inbox/${it.source.threadId}` });
  return "app";
}

/** WhatsApp: opens with the exact draft prefilled (you pick the chat and press send). */
export async function openWhatsApp(id: string, text: string): Promise<void> {
  saveDraft(id, text);
  patch(id, { openedAt: now() });
  if (bridgeAvailable()) await bridge("/share/send", { kind: "whatsapp", text });
}

export async function copied(id: string, text: string): Promise<void> {
  saveDraft(id, text);
  patch(id, { copiedAt: now() });
  if (bridgeAvailable()) await bridge("/clipboard", { text }).catch(() => {});
}

// ---------------- Start ----------------

let timer: NodeJS.Timeout | null = null;
export function startReplyDesk() {
  onPhoneNotification((n) => void fromNotification(n));
  if (timer) return;
  // Email every 15 minutes; snoozes checked too.
  timer = setInterval(() => {
    wake();
    if (store.get().enabled) void refreshEmail().catch(() => {});
  }, 15 * 60_000);
  setTimeout(() => void refreshEmail().catch(() => {}), 60_000);
}

/**
 * Which messaging apps are on the phone and which ones DanDroid reads (your
 * choice: only the apps you switch on are read). Email comes from connected apps.
 */
export async function sources() {
  const out: { service: string; label: string; accent: string; reply: Service["reply"]; installed: boolean; reading: boolean; packages: string[] }[] = [];
  let installed: string[] = [];
  let watched: string[] = [];
  let access = false;
  if (bridgeAvailable()) {
    installed = (await bridge<{ installed: string[] }>("/apps/installed", { packages: MESSAGING_PACKAGES }).catch(() => ({ installed: [] }))).installed ?? [];
    const st = await bridge<{ packages?: string[]; access?: boolean }>("/notifications/status", {}).catch(() => ({ packages: [] as string[], access: false }));
    watched = st.packages ?? [];
    access = Boolean(st.access);
  }
  const gmail = (await listConnections().catch(() => [])).some((a: any) => a.toolkit === "gmail" && a.status === "ACTIVE");
  for (const svc of SERVICES) {
    const pk = svc.packages.filter((p) => installed.includes(p));
    out.push({ service: svc.id, label: svc.label, accent: svc.accent, reply: svc.reply, installed: svc.id === "gmail" ? gmail || pk.length > 0 : pk.length > 0, reading: svc.id === "gmail" ? gmail : pk.some((p) => watched.includes(p)), packages: pk });
  }
  return { notificationAccess: access, gmailConnected: gmail, services: out };
}

/** Switches reading a messaging app's notifications on or off (keeps your other choices). */
export async function setReading(serviceId: string, on: boolean) {
  const svc = serviceById(serviceId);
  if (!svc || svc.id === "gmail") throw new Error("Email comes from connected apps (Settings → Connected apps).");
  if (!bridgeAvailable()) throw new Error("Reading notifications needs the Android app.");
  const st = await bridge<{ packages?: string[] }>("/notifications/status", {});
  const cur = new Set(st.packages ?? []);
  for (const p of svc.packages) on ? cur.add(p) : cur.delete(p);
  await bridge("/notifications/watch", { packages: [...cur] });
  return sources();
}

export const replyDeskEnabled = () => store.get().enabled;
export function setEnabled(on: boolean) {
  store.update((s) => void (s.enabled = on));
  changed();
}
