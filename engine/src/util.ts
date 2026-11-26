import zlib from "node:zlib";
import { randomUUID } from "node:crypto";

export const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const now = () => new Date().toISOString();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Trims long tool output so one web page cannot fill the model's context. */
export function clip(text: string, max = 24_000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[… ${text.length - max} more characters cut]`;
}

/** Very small HTML → readable text conversion for fetched pages. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, "\n")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();
}

/**
 * Terminal output to plain text. The screen places words with "move to
 * column N" codes instead of spaces, so cursor moves become spaces (a key
 * must never get the next word glued on); colours and links are dropped.
 */
export const terminalText = (s: string) =>
  s
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;]*[GCHfd]/g, " ")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");

/**
 * Text of a Word (.docx) file, without extra libraries: finds word/document.xml
 * in the zip and turns paragraphs into lines (headings as #, tables as | cells |).
 */
export function docxText(buf: Buffer): string {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("That isn't a Word (.docx) file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  let xml: string | null = null;
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    if (name === "word/document.xml") {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      xml = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8");
      break;
    }
    p += 46 + nlen + elen + clen;
  }
  if (!xml) throw new Error("No text found in that Word file.");
  const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  const para = (p: string) => {
    const t = unesc(p.replace(/<w:tab\/>/g, " ").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "")).trim();
    const h = p.match(/<w:pStyle w:val="(?:Heading|heading)(\d)"/);
    return t && h ? `${"#".repeat(Math.min(6, Number(h[1])))} ${t}` : t;
  };
  const out: string[] = [];
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g;
  for (const m of xml.match(re) ?? []) {
    if (m.startsWith("<w:tbl>")) {
      for (const row of m.match(/<w:tr[ >][\s\S]*?<\/w:tr>/g) ?? []) {
        const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map((c) => (c.match(/<w:p[ >][\s\S]*?<\/w:p>/g) ?? []).map(para).filter(Boolean).join(" "));
        if (cells.some(Boolean)) out.push(`| ${cells.join(" | ")} |`);
      }
    } else {
      const t = para(m);
      if (t) out.push(t);
    }
  }
  return out.join("\n");
}
