import { api } from "./api.ts";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "text" | "audio" | "video" | "document" | "other";
  note?: string;
}

/**
 * Uploads a file. In the app it streams the raw file (any size); through the
 * website it goes as JSON (the website carries up to about 3 MB per file).
 */
export async function uploadFile(file: File, remote: boolean): Promise<Attachment> {
  if (!remote) {
    const res = await fetch("api/files", {
      method: "POST",
      body: file,
      headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name || "file") },
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`Upload failed (HTTP ${res.status})`);
    return res.json();
  }
  if (file.size > 3_000_000) throw new Error(`${file.name} is too big to send through the website (max 3 MB). Send it from the phone instead.`);
  const b64 = await new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] ?? "");
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });
  return api<Attachment>("files/json", { body: { name: file.name, mime: file.type, b64 } });
}

export const fileIcon = (a: Attachment) => ({ image: "🖼️", text: "📄", audio: "🎵", video: "🎬", document: "📑", other: "📎" })[a.kind] ?? "📎";
export const fileSize = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
