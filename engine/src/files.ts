import fs from "node:fs";
import path from "node:path";
import { dataPath } from "./store.ts";
import { id as newId, clip, htmlToText } from "./util.ts";
import type { Block } from "./types.ts";

/**
 * Files you give a bot: images, voice notes, videos, documents, JSON, HTML,
 * Markdown, code — anything. Each file is kept on the phone; bots get the
 * best form they can use:
 *  - pictures are shown to the AI (when the model can see images),
 *  - text-like files (txt, md, json, html, csv, xml, code…) are read in,
 *  - anything else (PDF, Word, audio, video…) is saved where Claude Code /
 *    Codex can open it, and other bots get its details and the file_read tool.
 */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "text" | "audio" | "video" | "document" | "other";
  /** Screen captured by the assistant, etc. */
  note?: string;
}

const root = () => path.dirname(dataPath("files", ".keep"));
const meta = (id: string) => path.join(root(), id, "meta.json");

const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|html?|xml|csv|tsv|ya?ml|toml|ini|log|js|mjs|cjs|ts|tsx|jsx|py|java|kt|c|h|cpp|cs|go|rs|rb|php|sh|sql|css|scss|svg|tex|rtf|srt|vtt|ics|vcf)$/i;

export function kindOf(name: string, mime: string): Attachment["kind"] {
  if (mime.startsWith("image/") && !mime.includes("svg")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || /json|xml|javascript|yaml|csv|svg/.test(mime) || TEXT_EXT.test(name)) return "text";
  if (/pdf|word|officedocument|opendocument|msword|powerpoint|excel|epub/.test(mime) || /\.(pdf|docx?|pptx?|xlsx?|odt|ods|odp|epub|pages|key|numbers)$/i.test(name)) return "document";
  return "other";
}

export function guessMime(name: string): string {
  const ext = path.extname(name).toLowerCase().slice(1);
  const m: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic",
    mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/opus", aac: "audio/aac",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", "3gp": "video/3gpp",
    pdf: "application/pdf", json: "application/json", html: "text/html", htm: "text/html", md: "text/markdown", txt: "text/plain",
    csv: "text/csv", xml: "application/xml", svg: "image/svg+xml", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return m[ext] ?? "application/octet-stream";
}

function safeName(name: string) {
  return (path.basename(name || "file").replace(/[^\w.\- ()]+/g, "_").slice(-120) || "file").trim();
}

export function filePath(a: Pick<Attachment, "id" | "name">) {
  return path.join(root(), a.id, safeName(a.name));
}

/** Saves bytes as a new attachment. */
export function saveFile(name: string, mime: string | undefined, data: Buffer, note?: string): Attachment {
  const n = safeName(name);
  const m = mime && mime !== "application/octet-stream" ? mime : guessMime(n);
  const a: Attachment = { id: newId("file"), name: n, mime: m, size: data.length, kind: kindOf(n, m), ...(note ? { note } : {}) };
  fs.mkdirSync(path.join(root(), a.id), { recursive: true });
  fs.writeFileSync(filePath(a), data);
  fs.writeFileSync(meta(a.id), JSON.stringify(a));
  return a;
}

/** Starts a streamed upload (large videos etc.); returns the attachment and a write stream. */
export function startUpload(name: string, mime: string | undefined) {
  const n = safeName(name);
  const m = mime && mime !== "application/octet-stream" ? mime : guessMime(n);
  const a: Attachment = { id: newId("file"), name: n, mime: m, size: 0, kind: kindOf(n, m) };
  fs.mkdirSync(path.join(root(), a.id), { recursive: true });
  return { attachment: a, stream: fs.createWriteStream(filePath(a)), finish: (size: number) => fs.writeFileSync(meta(a.id), JSON.stringify({ ...a, size })) };
}

export function getFile(id: string): Attachment | null {
  if (!/^file_[a-f0-9]{16}$/.test(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(meta(id), "utf8"));
  } catch {
    return null;
  }
}

export function deleteFile(id: string) {
  if (getFile(id)) fs.rmSync(path.join(root(), id), { recursive: true, force: true });
}

const human = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/** Readable text of a text-like file (HTML → text, JSON pretty). */
export function readText(a: Attachment, max = 60_000): string {
  const raw = fs.readFileSync(filePath(a), "utf8");
  if (/html/.test(a.mime) || /\.html?$/i.test(a.name)) return clip(htmlToText(raw), max);
  if (/json/.test(a.mime)) {
    try {
      return clip(JSON.stringify(JSON.parse(raw), null, 1), max);
    } catch {
      /* not valid JSON: show as is */
    }
  }
  return clip(raw, max);
}

export function describe(a: Attachment) {
  return `${a.name} (${a.kind}, ${a.mime}, ${human(a.size)})${a.note ? ` — ${a.note}` : ""}`;
}

/** Model content for API-based bots. */
export function toBlocks(list: Attachment[], vision = true): Block[] {
  const blocks: Block[] = [];
  for (const a of list) {
    try {
      if (a.kind === "image" && vision && a.size < 5_000_000 && /png|jpe?g|gif|webp/.test(a.mime)) {
        blocks.push({ type: "text", text: `[Image: ${describe(a)}]` });
        blocks.push({ type: "image", mediaType: a.mime, data: fs.readFileSync(filePath(a)).toString("base64") });
      } else if (a.kind === "text" && a.size < 2_000_000) {
        blocks.push({ type: "text", text: `[File: ${describe(a)}]\n${readText(a, 40_000)}\n[End of ${a.name}]` });
      } else {
        blocks.push({ type: "text", text: `[Attached file: ${describe(a)}. File id ${a.id}. Use file_read to look inside it if it's readable.]` });
      }
    } catch {
      blocks.push({ type: "text", text: `[Attached file ${a.name} could not be read.]` });
    }
  }
  return blocks;
}

/** Copies attachments into a folder the official programs can open; returns relative paths. */
export function exportTo(dir: string, list: Attachment[]): string[] {
  const out: string[] = [];
  fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
  for (const a of list) {
    const rel = path.join("attachments", `${a.id.slice(5, 11)}-${safeName(a.name)}`);
    try {
      fs.copyFileSync(filePath(a), path.join(dir, rel));
      out.push(rel);
    } catch {
      /* missing file: skip */
    }
  }
  return out;
}
