import fs from "node:fs";
import path from "node:path";
import { bridge, bridgeAvailable } from "./bridge.ts";
import { collection, dataPath } from "./store.ts";
import { emit } from "./events.ts";
import { notifyUser } from "./notify.ts";
import { deleteFile, filePath, getFile, saveFile } from "./files.ts";
import { deleteDownload, driveIdFrom, fetchForDownload, saveToDownloads, type SavedDownload } from "./downloads.ts";
import { settings } from "./settings.ts";
import { join, readWav, seconds, writeWav, type Pcm } from "./wav.ts";
import { clip, errorText, id as newId, now } from "./util.ts";
import { CUE_GUIDE, SPOKEN_STYLE, planPhrase, stripCues } from "./speech-style.ts";
import { localParts } from "./time.ts";

/**
 * Weekly audio overview: when a new Staff Update is published and shared
 * with the person, the main assistant writes a short two-host conversation
 * about the week ahead, and the phone's own voices (e.g. Kokoro) record it.
 * Never longer than the limit (10 minutes): lines that won't fit are left
 * out and a closing line points to the full update. The person gets a
 * notification with a link; the Morning Brief screen shows the latest one.
 */
export interface AudioOverview {
  id: string;
  title: string;
  week?: string;
  staffUpdate?: { name?: string; link?: string };
  createdAt: string;
  status: "recording" | "ready" | "failed";
  progress?: string;
  fileId?: string;
  seconds?: number;
  /** Lines left out to stay under the limit. */
  linesLeftOut?: number;
  downloads?: SavedDownload;
  error?: string;
  /** Who says what, when (ms from the start), and where in the source it comes from. */
  segments?: Segment[];
  /** The source the hosts discussed is kept on the phone (for "explain that last bit"). */
  hasSource?: boolean;
  /** The source and its resources as PDFs, in Downloads › MausDroid Review Podcast (removed when the next overview is made). */
  pdfs?: PodcastPdf[];
  pdfNote?: string;
}

export interface PodcastPdf {
  fileId: string;
  name: string;
  location: string;
  uri: string;
  kind: "source" | "resource";
}
export const PDF_FOLDER = "MausDroid Review Podcast";

export interface PodcastInput {
  title: string;
  week?: string;
  script: string;
  staff_update_name?: string;
  staff_update_link?: string;
  source_text?: string;
  drive_file_id?: string;
  resources?: { name?: string; url?: string; drive_file_id?: string }[];
}

export interface Segment {
  speaker: "A" | "B";
  host: "female" | "male";
  text: string;
  startMs: number;
  endMs: number;
  /** A short quote from the source this line is based on; url jumps to it where the source supports that. */
  source?: { quote: string; url?: string; pdf?: string; page?: number };
}

export interface AudioSettings {
  enabled: boolean;
  /** Voice names for the two hosts (blank = your chosen voice / another voice of the same engine). */
  voiceA: string;
  voiceB: string;
  /** The podcast hosts: one female and one male voice of the voice engine (e.g. Phonon). Host A is female, host B male. */
  voiceFemale: string;
  voiceMale: string;
  maxMinutes: number;
  saveToDownloads: boolean;
}

interface State {
  settings: AudioSettings;
  overviews: AudioOverview[];
  /** Staff Updates already handled (Drive file ids), so each gets one overview. */
  seen: string[];
}

const DEFAULTS: AudioSettings = { enabled: true, voiceA: "", voiceB: "", voiceFemale: "", voiceMale: "", maxMinutes: 10, saveToDownloads: true };
const store = collection<State>("audio-overviews", { settings: DEFAULTS, overviews: [], seen: [] });
store.update((s) => (s.settings = { ...DEFAULTS, ...s.settings }));

/** Plain spoken text (no Markdown or links); voice.ts isn't imported to keep start-up order simple. */
const speakable = (t: string) => t.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "").replace(/[*_#>`|]/g, "").replace(/\s+/g, " ").trim();
function voiceParams() {
  const v = settings().voice;
  return { rate: v.rate, engine: v.ttsEngine ?? "", voice: v.voiceName ?? "", pitch: v.pitch ?? 1 };
}

export const AUDIO_SYSTEM = "audio-overview";
export const audioSettings = () => store.get().settings;
export function saveAudioSettings(patch: Partial<AudioSettings>) {
  store.update((s) => {
    const n = { ...s.settings, ...patch };
    n.maxMinutes = Math.min(10, Math.max(1, Number(n.maxMinutes) || 10));
    s.settings = n;
  });
  emit("settings.changed");
  return audioSettings();
}
export const listOverviews = () => store.get().overviews.slice().reverse();
export const getOverview = (oid: string) => store.get().overviews.find((o) => o.id === oid);
export const latestOverview = () => listOverviews().find((o) => o.status === "ready") ?? null;

function patch(oid: string, p: Partial<AudioOverview>) {
  store.update((s) => Object.assign(s.overviews.find((o) => o.id === oid) ?? {}, p));
  emit("audio-overview", { id: oid });
}

// ---------------- The script ----------------

export interface Line {
  speaker: "A" | "B";
  text: string;
}

/**
 * Turns the written script into lines for the two hosts. Accepts "A:" / "B:",
 * "Host A:", or two names ("Sam: … Jo: …"); anything else alternates by paragraph.
 */
export function parseScript(script: string): Line[] {
  const raw = script.replace(/\r/g, "").split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const names: string[] = [];
  const tagged = raw.map((l) => {
    const m = /^(?:\*\*)?(?:host\s+)?([A-Za-z][\w .'-]{0,24}?)(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(.+)$/i.exec(l);
    if (!m) return { who: null as string | null, text: l };
    const who = m[1].trim().toLowerCase();
    if (!names.includes(who) && names.length < 2) names.push(who);
    return { who: names.includes(who) ? who : null, text: m[2] };
  });
  const usable = tagged.filter((t) => t.who).length >= Math.min(2, tagged.length);
  const out: Line[] = [];
  let last: "A" | "B" = "B";
  for (const t of tagged) {
    let sp: "A" | "B";
    if (usable && t.who) sp = t.who === "a" || (t.who !== "b" && names.indexOf(t.who) === 0) ? "A" : "B";
    else if (usable) sp = last; // an untagged line continues the same speaker
    else sp = last === "A" ? "B" : "A";
    const text = speakable(t.text);
    if (!text) continue;
    if (usable && !t.who && out.length) out[out.length - 1].text += ` ${text}`;
    else out.push({ speaker: sp, text });
    last = sp;
  }
  return out;
}

/** About 150 spoken words a minute; a little room is kept for pauses. */
export const wordsFor = (minutes: number) => Math.floor(minutes * 140);
const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** Long lines are split at sentence ends so each recording stays small. */
function pieces(text: string, max = 600): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const s of text.split(/(?<=[.!?])\s+/)) {
    if (cur && (cur + " " + s).length > max) (out.push(cur), (cur = ""));
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

// ---------------- Recording ----------------

/** The two hosts' voices: your chosen voice, and a different voice of the same engine. */
async function hostVoices(s: AudioSettings) {
  const base = voiceParams();
  let a = s.voiceFemale || s.voiceA || base.voice;
  let b = s.voiceMale || s.voiceB;
  let pitchB = base.pitch;
  if (!a || !b) {
    try {
      const r = await bridge<{ voices: { name: string; locale: string; notInstalled?: boolean; network?: boolean }[] }>("/voice/voices", { engine: base.engine }, 15_000);
      // Voices that work offline first.
      const list = (r.voices ?? []).filter((v) => !v.notInstalled).sort((x, y) => Number(Boolean(x.network)) - Number(Boolean(y.network)));
      if (!a) a = list.find((v) => v.locale.startsWith("en-AU"))?.name ?? list.find((v) => v.locale.startsWith("en"))?.name ?? list[0]?.name ?? "";
      if (!b) {
        const mine = list.find((v) => v.name === a);
        const lang = (mine?.locale ?? "en").split("-")[0];
        const others = list.filter((v) => v.name !== a && v.locale.split("-")[0] === lang);
        // Prefer the same accent.
        b = (others.find((v) => v.locale === mine?.locale) ?? others[0])?.name ?? "";
      }
    } catch {
      /* the phone's default voice */
    }
    // Only one voice available: the second host speaks a little lower.
    if (!b || b === a) pitchB = Math.max(0.6, base.pitch * 0.85);
  }
  return { engine: base.engine, rate: base.rate, A: { voice: a, pitch: base.pitch }, B: { voice: b || a, pitch: pitchB } };
}

async function synth(text: string, v: { voice: string; pitch: number }, engine: string, rate: number, out: string, cue: { rate?: number; pitch?: number } = {}): Promise<Pcm> {
  fs.rmSync(out, { force: true });
  try {
    // A phrase's delivery cue (speed / pitch) is applied on the phone with Sonic.
    await bridge("/voice/synthesize", { text, engine, voice: v.voice, pitch: v.pitch, rate, out, ...(cue.rate ? { sonicRate: cue.rate } : {}), ...(cue.pitch ? { sonicPitch: cue.pitch } : {}) }, 180_000);
  } catch (e) {
    if (/unknown \/voice\/synthesize/.test(errorText(e))) throw new Error("Recording audio needs the newer MausDroid app (0.11.0 or later): Settings → Updates → install the app update.");
    throw e;
  }
  if (!fs.existsSync(out) || fs.statSync(out).size < 100) throw new Error("The phone's voice engine didn't record anything. Check Settings → Voice (try another voice engine).");
  return readWav(fs.readFileSync(out));
}

const running = new Set<string>();
const sourcePath = (oid: string) => dataPath("audio-sources", `${oid}.txt`);
export const overviewSource = (oid: string) => {
  try {
    return fs.readFileSync(sourcePath(oid), "utf8");
  } catch {
    return "";
  }
};

/** "{source "a short quote"}" on a line: where it comes from (not spoken). */
const SOURCE_CUE = /\{\s*source\s+["“]?([^{}"”]+?)["”]?\s*\}/i;
export function splitSource(line: string): { text: string; quote?: string } {
  const m = SOURCE_CUE.exec(line);
  return m ? { text: line.replace(SOURCE_CUE, " ").replace(/\s{2,}/g, " ").trim(), quote: m[1].trim() } : { text: line };
}
/** A link that opens the source at the quote: web pages support text fragments; Google Docs don't (no jump then). */
export function sourceJump(link: string | undefined, quote: string | undefined): string | undefined {
  if (!link || !quote || !/^https?:\/\//.test(link) || /docs\.google\.com|drive\.google\.com/.test(link)) return undefined;
  const q = quote.split(/\s+/).slice(0, 8).join(" ");
  return `${link.split("#")[0]}#:~:text=${encodeURIComponent(q)}`;
}

/**
 * Records an overview from a written script (in the background). Returns at
 * once; the person is notified when it's ready (or if it fails).
 */
export function createOverview(input: PodcastInput): AudioOverview {
  const lines = parseScript(String(input.script ?? ""));
  if (lines.length < 2) throw new Error("Write the script as a conversation, one line per turn, starting each with A: or B:.");
  const o: AudioOverview = {
    id: newId("aud"),
    title: clip(String(input.title || "Weekly audio overview").trim(), 120),
    week: input.week ? clip(String(input.week), 40) : undefined,
    staffUpdate: input.staff_update_name || input.staff_update_link ? { name: input.staff_update_name, link: input.staff_update_link } : undefined,
    createdAt: now(),
    status: "recording",
    progress: "Starting…",
  };
  store.update((s) => {
    s.overviews.push(o);
    if (s.overviews.length > 30) s.overviews.splice(0, s.overviews.length - 30);
  });
  if (input.source_text && String(input.source_text).trim().length > 40) {
    fs.mkdirSync(path.dirname(sourcePath(o.id)), { recursive: true });
    fs.writeFileSync(sourcePath(o.id), clip(String(input.source_text), 60_000));
    o.hasSource = true;
  }
  emit("audio-overview", { id: o.id });
  running.add(o.id);
  void record(o, lines, input).finally(() => running.delete(o.id));
  return o;
}

/**
 * The source (a Google Doc becomes a PDF) and any Drive / PDF resources, saved
 * to Downloads › MausDroid Review Podcast. Web pages that aren't PDFs stay links.
 */
async function preparePdfs(o: AudioOverview, input: PodcastInput): Promise<{ pdfs: PodcastPdf[]; notes: string[] }> {
  const want: { name: string; kind: PodcastPdf["kind"]; drive_file_id?: string; url?: string }[] = [];
  const srcId = input.drive_file_id || driveIdFrom(input.staff_update_link);
  const srcName = (input.staff_update_name || o.title).replace(/\.pdf$/i, "");
  if (srcId) want.push({ name: `${srcName}.pdf`, kind: "source", drive_file_id: srcId });
  else if (input.staff_update_link && /\.pdf($|\?)/i.test(input.staff_update_link)) want.push({ name: `${srcName}.pdf`, kind: "source", url: input.staff_update_link });
  for (const r of (input.resources ?? []).slice(0, 10)) {
    const id = r.drive_file_id || driveIdFrom(r.url);
    const name = `${String(r.name || "Resource").replace(/\.pdf$/i, "").slice(0, 80)}.pdf`;
    if (id) want.push({ name, kind: "resource", drive_file_id: id });
    else if (r.url && /^https?:\/\//.test(r.url)) want.push({ name, kind: "resource", url: r.url });
  }
  const pdfs: PodcastPdf[] = [];
  const notes: string[] = [];
  for (const w of want) {
    try {
      const a = await fetchForDownload({ drive_file_id: w.drive_file_id, url: w.url, name: w.name });
      const head = fs.readFileSync(filePath(a)).subarray(0, 5).toString();
      if (head !== "%PDF-") {
        deleteFile(a.id);
        notes.push(`${w.name.replace(/\.pdf$/, "")} isn't a PDF or Google file, so it stays a link.`);
        continue;
      }
      const saved = await saveToDownloads(a, w.name, PDF_FOLDER);
      pdfs.push({ fileId: a.id, name: saved.name, location: saved.location, uri: saved.uri, kind: w.kind });
    } catch (e) {
      const what = w.name.replace(/\.pdf$/, "");
      notes.push(/gives a web page/.test(errorText(e)) ? `${what} isn't a PDF or Google file, so it stays a link.` : `${what}: ${errorText(e)}`);
    }
  }
  return { pdfs, notes };
}

/** Which PDF page each line's quote is on (the source first, then resources). */
async function placeQuotes(segments: Segment[], pdfs: PodcastPdf[]) {
  for (const pdf of pdfs) {
    const open = segments.filter((sg) => sg.source?.quote && sg.source.page === undefined);
    if (!open.length) return;
    const f = getFile(pdf.fileId);
    if (!f) continue;
    const r = await bridge<{ pages?: number[] }>("/pdf/find", { path: filePath(f), quotes: open.map((sg) => sg.source!.quote) }, 60_000).catch(() => null);
    open.forEach((sg, i) => {
      const page = r?.pages?.[i] ?? -1;
      if (page >= 0) Object.assign(sg.source!, { pdf: pdf.fileId, page });
    });
  }
  // Not found in any PDF: the source PDF still opens (at page 1).
  const src = pdfs.find((p) => p.kind === "source");
  if (src) for (const sg of segments) if (sg.source?.quote && !sg.source.pdf) sg.source.pdf = src.fileId;
}

/** The previous overviews' PDFs are deleted from the phone when a new one is made. */
async function removeOldPdfs(keepId: string) {
  for (const old of store.get().overviews) {
    if (old.id === keepId || !old.pdfs?.length) continue;
    for (const p of old.pdfs) {
      await deleteDownload(p.uri);
      deleteFile(p.fileId);
    }
    patch(old.id, { pdfs: [], segments: old.segments?.map((sg) => (sg.source ? { ...sg, source: { quote: sg.source.quote, url: sg.source.url } } : sg)) });
  }
}

async function record(o: AudioOverview, lines: Line[], input: PodcastInput = { title: o.title, script: "" }) {
  const s = audioSettings();
  const limit = s.maxMinutes * 60;
  const dir = dataPath("audio-work", o.id);
  try {
    if (!bridgeAvailable()) throw new Error("Recording audio needs the Android app.");
    fs.mkdirSync(dir, { recursive: true });
    // Never more words than fit (checked again against the real length below).
    let budget = wordsFor(s.maxMinutes);
    const kept: Line[] = [];
    for (const l of lines) {
      const w = words(stripCues(splitSource(l.text).text));
      if (w > budget) break;
      kept.push(l);
      budget -= w;
    }
    const voices = await hostVoices(s);
    const closing: Line = { speaker: "A", text: "That's the overview for the week. The full Staff Update has all the details." };
    const closingPcm = await synth(closing.text, voices.A, voices.engine, voices.rate, path.join(dir, "closing.wav"));
    const parts: Pcm[] = [];
    const segments: Segment[] = [];
    const clips = new Map<string, Pcm>();
    let total = 0;
    let used = 0;
    const GAP = 0.35;
    for (const [i, l] of kept.entries()) {
      patch(o.id, { progress: `Recording line ${i + 1} of ${kept.length}` });
      const { text: spoken, quote } = splitSource(l.text);
      const v = voices[l.speaker];
      // Words, pauses and reactions in order; each phrase's speed/pitch cue applies to it alone.
      const segs: Pcm[] = [];
      let k = 0;
      for (const item of planPhrase(spoken)) {
        if (item.kind === "pause") segs.push({ sampleRate: segs[0]?.sampleRate ?? 24000, samples: new Int16Array(Math.round(((segs[0]?.sampleRate ?? 24000) * item.ms) / 1000)) });
        else if (item.kind === "clip") {
          const key = `${l.speaker}:${item.name}`;
          if (!clips.has(key)) {
            const say: Record<string, string> = { "mm-hmm": "Mm-hmm.", "uh-huh": "Uh-huh.", hmm: "Hmm.", oh: "Oh!", right: "Right.", yeah: "Yeah.", ah: "Ah." };
            const c = await synth(say[item.name] ?? "Mm.", v, voices.engine, voices.rate, path.join(dir, `clip-${key.replace(/\W/g, "")}.wav`)).catch(() => null);
            // A reaction the voice reads oddly (too long) is left out.
            if (c && seconds(c) <= 1.2) clips.set(key, c);
          }
          const c = clips.get(key);
          if (c) segs.push(c);
        } else for (const t of pieces(item.text)) segs.push(await synth(t, v, voices.engine, voices.rate, path.join(dir, `${i}-${k++}.wav`), { rate: item.rate, pitch: item.pitch }));
      }
      if (!segs.length) continue;
      const line = join(segs, 0.08);
      // Keep room for the closing line and pauses: stop before the limit.
      if (total + seconds(line) + seconds(closingPcm) + GAP * (parts.length + 2) > limit - 2) break;
      const startMs = Math.round((total + GAP * parts.length) * 1000);
      segments.push({ speaker: l.speaker, host: l.speaker === "A" ? "female" : "male", text: stripCues(spoken), startMs, endMs: startMs + Math.round(seconds(line) * 1000), ...(quote ? { source: { quote, url: sourceJump(o.staffUpdate?.link, quote) } } : {}) });
      parts.push(line);
      total += seconds(line);
      used++;
    }
    if (!parts.length) throw new Error("Nothing could be recorded within the time limit.");
    const leftOut = lines.length - used;
    if (leftOut > 0) {
      const startMs = Math.round((total + GAP * parts.length) * 1000);
      segments.push({ speaker: "A", host: "female", text: closing.text, startMs, endMs: startMs + Math.round(seconds(closingPcm) * 1000) });
      parts.push(closingPcm);
    }
    const audio = join(parts, GAP);
    const len = seconds(audio);
    if (len > limit) throw new Error("The recording came out longer than the limit."); // can't happen; never publish one that's too long
    const fileName = `${o.title.replace(/[\\/:*?"<>|]+/g, " ").trim()}.wav`;
    const file = saveFile(fileName, "audio/wav", writeWav(audio), "Weekly audio overview");
    let downloads: SavedDownload | undefined;
    let dlNote = "";
    if (s.saveToDownloads) {
      try {
        downloads = await saveToDownloads(file);
      } catch (e) {
        dlNote = ` (Couldn't also save it to Downloads: ${errorText(e)})`;
      }
    }
    patch(o.id, { progress: "Saving the sources as PDFs" });
    const { pdfs, notes } = await preparePdfs(o, input).catch((e) => ({ pdfs: [] as PodcastPdf[], notes: [errorText(e)] }));
    if (pdfs.length) await placeQuotes(segments, pdfs);
    patch(o.id, { status: "ready", progress: undefined, fileId: file.id, seconds: Math.round(len), linesLeftOut: leftOut || undefined, downloads, segments, pdfs, pdfNote: notes.length ? notes.join(" ") : undefined });
    await removeOldPdfs(o.id).catch(() => {});
    const mins = `${Math.floor(len / 60)}:${String(Math.round(len % 60)).padStart(2, "0")}`;
    await notifyUser({
      title: `🎧 ${o.title} is ready`,
      body: `${mins} long. Tap to listen — it's also on the Morning Brief screen.${downloads ? ` Saved to ${downloads.location}.` : ""}${dlNote}`,
      type: "audio-overview",
      source: "Weekly audio overview",
      link: `audio:${o.id}`,
    });
  } catch (e) {
    patch(o.id, { status: "failed", progress: undefined, error: errorText(e) });
    await notifyUser({ title: `Audio overview didn't work`, body: clip(errorText(e), 300), type: "audio-overview", source: "Weekly audio overview", link: `audio:${o.id}` });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function deleteOverview(oid: string) {
  if (running.has(oid)) throw new Error("It's still recording.");
  // Its PDFs go too, so nothing is left behind in Downloads.
  for (const p of getOverview(oid)?.pdfs ?? []) {
    void deleteDownload(p.uri);
    deleteFile(p.fileId);
  }
  store.update((s) => {
    s.overviews = s.overviews.filter((o) => o.id !== oid);
  });
  emit("audio-overview", { id: oid });
}

export const overviewFile = (o: AudioOverview) => (o.fileId ? getFile(o.fileId) : null);

// ---------------- Watching for a new Staff Update ----------------

export const PODCAST_STYLE = `Write it as one real conversation between two hosts — host A (a woman) and host B (a man) — grounded only in the source:
- They respond to each other: follow-up questions, quick clarifications, the odd "wait, so…" or gentle challenge, short reactions. Vary who leads each topic; don't alternate mechanically.
- Clean handoffs: one line per turn, starting with "A:" or "B:".
- After a line based on a specific part of the source, add {source "a short exact quote from it"} (it's not spoken; it lets the listener jump to that spot).
${SPOKEN_STYLE}
${CUE_GUIDE}`;

export const AUDIO_PROMPT = `A new Staff Update has been published and shared with me (details below). Make this week's audio overview.
1. Read the whole Staff Update (Google Docs/Drive through connected apps, or web_fetch its link).
2. Cover what's taking place NEXT WEEK: day by day, key dates and times, deadlines, events, duties and anything I need to do or bring. Only facts from the update — never guess.
${PODCAST_STYLE}
3. Keep it under 1,300 words (it must stay under 10 minutes). No headings, lists or links.
4. Call audio_overview_record with: title like "Week 8 audio overview", week (e.g. "Term 4 Week 8"), staff_update_name, staff_update_link, drive_file_id (the Drive file id below), source_text (the update's text, so I can ask about it while listening), resources (other Google Docs, Drive files or PDFs the update links to, with names) and the script. They're saved as PDFs on my phone so I can jump to each line's source.
It records in the background and notifies me with a link when it's ready. If you can't read the update, say so plainly instead.`;

/** Checks Drive for a Staff Update not handled yet; raises a (silent) alert that starts the routine. */
export async function checkForNewStaffUpdate(find: () => Promise<{ file: { id: string; name: string; webViewLink?: string; modifiedTime: string } | null }>): Promise<string | null> {
  if (!audioSettings().enabled) return null;
  const { file } = await find();
  if (!file || store.get().seen.includes(file.id)) return null;
  store.update((s) => {
    s.seen.push(file.id);
    if (s.seen.length > 100) s.seen.splice(0, s.seen.length - 100);
  });
  await notifyUser({
    title: `New Staff Update: ${file.name}`,
    body: `Drive file id: ${file.id}\nLink: ${file.webViewLink ?? ""}\nModified: ${file.modifiedTime}`,
    type: "staff-update",
    source: "Google Drive",
    eventId: `staff-update:${file.id}`,
    silentRecord: true,
  });
  return file.id;
}

let timer: NodeJS.Timeout | null = null;
/** Every 30 minutes between 6 am and 9 pm. */
export function startStaffUpdateWatch(find: Parameters<typeof checkForNewStaffUpdate>[0]) {
  if (timer) return;
  const tick = () => {
    const hm = localParts(new Date()).hm;
    if (hm < "06:00" || hm > "21:00") return;
    void checkForNewStaffUpdate(find).catch(() => {});
  };
  timer = setInterval(tick, 30 * 60_000);
  setTimeout(tick, 90_000);
}
