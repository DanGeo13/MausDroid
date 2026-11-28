/**
 * A clean, readable page of a response (Share → Chrome): headings, lists,
 * bold, clickable links and line breaks kept. Everything is escaped first, so
 * the text can't inject markup.
 */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  return esc(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function renderMarkdownHtml(title: string, text: string): string {
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) (close(), out.push(`<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>`));
    else if (ul) (list !== "ul" && (close(), out.push("<ul>"), (list = "ul")), out.push(`<li>${inline(ul[1])}</li>`));
    else if (ol) (list !== "ol" && (close(), out.push("<ol>"), (list = "ol")), out.push(`<li>${inline(ol[1])}</li>`));
    else if (!line.trim()) (close(), out.push(""));
    else (close(), out.push(`<p>${inline(line)}</p>`));
  }
  close();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:17px/1.6 system-ui,sans-serif;max-width:42rem;margin:0 auto;padding:1.2rem 1rem 3rem;color:#1d1d1f;background:#fff}h1{font-size:1.15rem;color:#666;font-weight:600}a{color:#1a73e8;word-break:break-word}code{background:#f2f2f2;padding:0 .25em;border-radius:4px}p{margin:.55em 0}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}h1{color:#aaa}a{color:#8ab4f8}code{background:#222}}</style></head>
<body><h1>${esc(title)}</h1>${out.join("\n")}</body></html>`;
}
