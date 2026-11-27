import fs from "node:fs";
import { bridge, bridgeAvailable } from "./bridge.ts";
import { argsFor, executeTool, listConnections } from "./composio.ts";
import { filePath, getFile, guessMime, saveFile, type Attachment } from "./files.ts";
import { errorText } from "./util.ts";

/**
 * Saving files to the phone's Downloads folder (Download/MausDroid), where
 * every app's file picker (Gemini, Gmail, Files…) can find them. The phone
 * checks the file arrived with the right size before this says it's saved.
 */
export interface SavedDownload {
  name: string;
  /** Where it is on the phone, e.g. "Download/MausDroid/Week 8.pdf". */
  location: string;
  uri: string;
  size: number;
}

export async function saveToDownloads(a: Attachment, asName?: string): Promise<SavedDownload> {
  if (!bridgeAvailable()) throw new Error("Saving to Downloads needs the Android app.");
  const src = filePath(a);
  const size = fs.statSync(src).size;
  let r: any;
  try {
    r = await bridge("/files/save-download", { path: src, name: (asName?.trim() || a.name).replace(/[\\/:*?"<>|]+/g, " ").trim(), mime: a.mime, folder: "MausDroid" }, 120_000);
  } catch (e) {
    if (/unknown \/files\/save-download/.test(errorText(e))) throw new Error("This needs the newer MausDroid app (0.11.0 or later): Settings → Updates → install the app update.");
    throw e;
  }
  if (Number(r.size) !== size) throw new Error(`The copy in Downloads is ${r.size} bytes but should be ${size}, so it wasn't saved properly.`);
  return { name: String(r.name ?? a.name), location: String(r.location ?? `Download/MausDroid/${a.name}`), uri: String(r.uri ?? ""), size };
}

/** The first link to the file's bytes anywhere in a Composio response. */
function findFileUrl(data: any): string | null {
  if (!data || typeof data !== "object") return null;
  for (const k of ["s3url", "s3_url", "download_url", "downloadUrl", "url", "uri", "webContentLink"]) if (typeof data[k] === "string" && /^https?:\/\//.test(data[k])) return data[k];
  for (const v of Object.values(data)) {
    const hit = v && typeof v === "object" ? findFileUrl(v) : null;
    if (hit) return hit;
  }
  return null;
}

/** Gets a file from a link, a MausDroid file, or Google Drive (Docs are exported as PDF). */
export async function fetchForDownload(i: { url?: string; file_id?: string; drive_file_id?: string; name?: string; account_id?: string }): Promise<Attachment> {
  if (i.file_id) {
    const a = getFile(i.file_id);
    if (!a) throw new Error("No MausDroid file with that id.");
    return a;
  }
  let url = i.url;
  if (i.drive_file_id) {
    const args = await argsFor("GOOGLEDRIVE_DOWNLOAD_FILE", { id: { names: ["file_id", "fileId"], value: i.drive_file_id }, mime: { names: ["mime_type", "mimeType"], value: "application/pdf" } });
    const accounts = (await listConnections()).filter((a: any) => a.toolkit === "googledrive" && a.status === "ACTIVE");
    const account = i.account_id ?? accounts[0]?.id;
    if (!account) throw new Error("Google Drive isn't connected (Settings → Apps).");
    const data = await executeTool("GOOGLEDRIVE_DOWNLOAD_FILE", args, account);
    url = findFileUrl(data) ?? undefined;
    if (!url) throw new Error("Google Drive didn't return the file. Try again with the file's download link (url).");
  }
  if (!url || !/^https?:\/\//.test(url)) throw new Error("Give a link (url), a MausDroid file_id or a drive_file_id.");
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`The download failed (HTTP ${res.status}). If it's a private Drive file, use drive_file_id instead.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("The download was empty.");
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (/text\/html/.test(type) && !/\.html?$/i.test(i.name ?? "")) throw new Error("That link gives a web page, not the file itself (it may need signing in). For Drive files use drive_file_id.");
  const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)/i.exec(res.headers.get("content-disposition") ?? "")?.[1];
  let name = i.name || (fromHeader ? decodeURIComponent(fromHeader) : decodeURIComponent(new URL(url).pathname.split("/").pop() || "download"));
  if (!/\.[a-z0-9]{2,5}$/i.test(name)) name += type === "application/pdf" || buf.subarray(0, 4).toString() === "%PDF" ? ".pdf" : "";
  return saveFile(name, type && type !== "application/octet-stream" ? type : guessMime(name), buf);
}
