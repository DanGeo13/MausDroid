// Small, safe Markdown renderer: everything is escaped first, then a few
// patterns become formatting. Bot replies never inject raw HTML.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

export function renderMarkdown(md: string): string {
  const out: string[] = [];
  const parts = md.split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      out.push(`<pre><code>${esc(part.replace(/^[a-z0-9+-]*\n/i, ""))}</code></pre>`);
      return;
    }
    const lines = part.split("\n");
    let list: "ul" | "ol" | null = null;
    let para: string[] = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push(`</${list}>`);
      list = null;
    };
    for (const line of lines) {
      const h = line.match(/^(#{1,4})\s+(.*)/);
      const ul = line.match(/^\s*[-*•]\s+(.*)/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
      if (h) {
        flushPara();
        closeList();
        out.push(`<p><strong>${inline(h[2])}</strong></p>`);
      } else if (ul || ol) {
        flushPara();
        const kind = ul ? "ul" : "ol";
        if (list !== kind) {
          closeList();
          out.push(`<${kind}>`);
          list = kind;
        }
        out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      } else if (!line.trim()) {
        flushPara();
        closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    flushPara();
    closeList();
  });
  return out.join("");
}

/** Delivery cues in spoken replies ("{pause 300}", "{react mm-hmm}"…) are for the voice only, never shown. */
const CUES = /\{\s*(?:pause\s+\d+(?:ms)?|faster|slower|higher|lower|laugh|chuckle|sigh|breath|(?:rate|speed|pitch)\s+[\d.]+|react\s+[a-z-]+|source\s+[^{}]*)\s*\}|[\[<]\s*(?:laughs?|laughing|chuckles?|sighs?|breath|breathes|inhales)\s*[\]>]/gi;
export const hideCues = (t: string) => t.replace(CUES, "").replace(/ {2,}/g, " ");

export function Markdown({ text }: { text: string }) {
  return <div dangerouslySetInnerHTML={{ __html: renderMarkdown(hideCues(text)) }} />;
}
