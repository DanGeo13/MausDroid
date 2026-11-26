// Copying text out of the chat: turns Markdown into clean plain text and puts it on the phone's clipboard.
// No Intl, TextDecoder or \p{…} regexes: this also runs on the phone's WebView.

/** Markdown (as bots write it) to plain text: keeps line breaks, bullets, table rows and code; drops **, # and links become their URL. */
export function markdownToPlain(md: string): string {
  const out: string[] = [];
  const parts = String(md ?? "").replace(/\r\n?/g, "\n").split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // A code block: drop the fence and the language name, keep the code as it is.
      out.push(part.replace(/^[a-z0-9+#._-]*\n/i, "").replace(/\n$/, ""));
      return;
    }
    for (const raw of part.split("\n")) {
      let line = raw;
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes("|")) continue; // table divider row
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // horizontal rule
      line = line.replace(/^(\s*)#{1,6}\s+/, "$1").replace(/\s+#+\s*$/, "");
      line = line.replace(/^(\s*)[-*+•]\s+/, "$1• ");
      line = line.replace(/^(\s*)>\s?/, "$1");
      line = line
        .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, "$2")
        .replace(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, "$2")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/(^|[^*\w])\*([^*\n]+)\*/g, "$1$2")
        .replace(/~~([^~]+)~~/g, "$1")
        .replace(/`([^`]+)`/g, "$1");
      out.push(line.replace(/\s+$/, ""));
    }
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** What "Copy" should copy for a chat message: its text, or the file names when it's only a file. */
export function messageCopyText(m: { role: string; text?: string; attachments?: { name: string }[]; tool?: { name: string; input?: unknown; result?: string } }): string {
  if (m.role === "tool" && m.tool) {
    let input = "";
    try {
      input = m.tool.input === undefined ? "" : JSON.stringify(m.tool.input, null, 1);
    } catch {}
    return [m.tool.name, input, m.tool.result ? `→ ${m.tool.result}` : ""].filter(Boolean).join("\n\n");
  }
  const text = m.role === "user" || m.role === "note" ? String(m.text ?? "").trim() : markdownToPlain(m.text ?? "");
  if (text) return text;
  return (m.attachments ?? []).map((a) => a.name).filter(Boolean).join("\n");
}

/** Copy text for an approval / question card. */
export function cardCopyText(c: { title: string; detail?: string; options?: string[] }): string {
  return [c.title, c.detail, c.options?.length ? c.options.join("\n") : ""].filter(Boolean).join("\n\n");
}

/** Android 13 and newer show their own "copied" message. */
export function systemShowsCopyNotice(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  const m = /Android (\d+)/.exec(ua);
  return Boolean(m && Number(m[1]) >= 13);
}

/** Puts text on the clipboard. Tries the browser clipboard, then the old copy command, then the app's own bridge. */
export async function copyText(text: string): Promise<boolean> {
  const g = globalThis as any;
  try {
    if (g.navigator?.clipboard?.writeText) {
      await g.navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  try {
    const doc = g.document;
    if (doc?.body) {
      const ta = doc.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
      doc.body.appendChild(ta);
      ta.select?.();
      ta.setSelectionRange?.(0, text.length);
      const ok = Boolean(doc.execCommand?.("copy"));
      ta.remove();
      if (ok) return true;
    }
  } catch {}
  try {
    // The app's Android bridge, if this version of the app has a clipboard method.
    const shell = g.MausDroidShell;
    if (typeof shell?.copyText === "function") return shell.copyText(text) !== false;
  } catch {}
  return false;
}

export function showToast(message: string) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1800);
}

/** Copy, then tell the person (a "Copied" toast, except where Android already does). */
export async function copyWithFeedback(text: string): Promise<boolean> {
  const ok = await copyText(text);
  if (ok) {
    if (!systemShowsCopyNotice()) showToast("Copied");
  } else showToast("Couldn't copy. Try selecting the text instead.");
  return ok;
}
