import { bridge, bridgeAvailable } from "./bridge.ts";
import { collection } from "./store.ts";
import { emit } from "./events.ts";
import { settings } from "./settings.ts";
import { clip, errorText, id as newId, now } from "./util.ts";
import { pronounce } from "./speech-style.ts";

/**
 * MausDroid checks its own voice: it makes (or takes) speech, recognises it
 * offline with the phone's on-device recognizer, and compares what was heard
 * with what it meant to say — clarity (word accuracy) and speed (words a
 * second). Calls add first-audio and interruption times. Results are judged
 * against your success criteria; Improver reviews them each night and
 * suggests fixes (another voice, slower speed) for your approval.
 */
export interface VoiceCriteria {
  /** Share of words recognised correctly (0–1). */
  clarity: number;
  /** Words a second, comfortable range. */
  minWps: number;
  maxWps: number;
  /** Calls: until the first word is heard, and until it goes quiet when you cut in (ms). */
  firstAudioMs: number;
  interruptMs: number;
}
export const DEFAULT_CRITERIA: VoiceCriteria = { clarity: 0.95, minWps: 2.3, maxWps: 3.0, firstAudioMs: 800, interruptMs: 150 };

export interface CheckResult {
  id: string;
  at: string;
  kind: "sample" | "audition" | "podcast" | "call";
  engine?: string;
  voice?: string;
  rate?: number;
  expected?: string;
  heard?: string;
  clarity?: number;
  wps?: number;
  firstAudioMs?: number;
  interruptMs?: number;
  pass: boolean;
  problems: string[];
  error?: string;
  /** Words meant but not heard (often names the voice says wrong). */
  missed?: string[];
}

const store = collection<{ criteria: VoiceCriteria; results: CheckResult[] }>("voice-checks", { criteria: DEFAULT_CRITERIA, results: [] });
store.update((s) => (s.criteria = { ...DEFAULT_CRITERIA, ...s.criteria }));
export const voiceCriteria = () => store.get().criteria;
export function saveCriteria(patch: Partial<VoiceCriteria>) {
  store.update((s) => {
    const c = { ...s.criteria };
    for (const k of Object.keys(DEFAULT_CRITERIA) as (keyof VoiceCriteria)[]) {
      const v = Number((patch as any)[k]);
      if ((patch as any)[k] !== undefined && Number.isFinite(v) && v >= 0) c[k] = v;
    }
    c.clarity = Math.min(1, c.clarity > 1 ? c.clarity / 100 : c.clarity);
    if (c.minWps > c.maxWps) [c.minWps, c.maxWps] = [c.maxWps, c.minWps];
    s.criteria = c;
  });
  emit("settings.changed");
  return voiceCriteria();
}
export const recentChecks = (n = 30) => store.get().results.slice(-n).reverse();

function record(r: Omit<CheckResult, "id" | "at" | "pass" | "problems"> & { problems?: string[] }): CheckResult {
  const problems = r.problems ?? judge(r, voiceCriteria());
  const full: CheckResult = { ...r, id: newId("vchk"), at: now(), problems, pass: !r.error && problems.length === 0 };
  store.update((s) => {
    s.results.push(full);
    if (s.results.length > 300) s.results.splice(0, s.results.length - 300);
  });
  emit("voice-check", { id: full.id });
  return full;
}

// ---------------- Scoring ----------------

const NUM: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", fifteen: "15", twenty: "20", thirty: "30" };
/** Words for comparing: lower case, no punctuation, "it's" = "its", number words = digits. */
export function normalizeWords(t: string): string[] {
  return t
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => NUM[w] ?? w);
}

/** Word error rate: edits needed to turn what was meant into what was heard, per word meant. */
export function wordErrorRate(expected: string, heard: string): number {
  const a = normalizeWords(expected);
  const b = normalizeWords(heard);
  if (!a.length) return b.length ? 1 : 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length] / a.length;
}

/** Words in what was meant that weren't heard (original spelling, e.g. names), most useful first. */
export function missedWords(expected: string, heard: string): string[] {
  const got = new Set(normalizeWords(heard));
  const common = new Set(["a", "an", "the", "and", "to", "of", "in", "on", "at", "is", "it", "so", "for", "with"]);
  const out: string[] = [];
  for (const w of expected.split(/\s+/)) {
    const n = normalizeWords(w)[0];
    if (!n || common.has(n) || got.has(n)) continue;
    const clean = w.replace(/[^A-Za-z0-9'’-]+/g, "").replace(/['’]s$/i, "");
    if (clean && /[A-Za-z]{3,}/.test(clean) && !out.includes(clean)) out.push(clean);
  }
  return out.slice(0, 8);
}

/** What falls short of the criteria, in plain words. */
export function judge(r: Partial<CheckResult>, c: VoiceCriteria): string[] {
  const out: string[] = [];
  if (r.clarity !== undefined && r.clarity < c.clarity) out.push(`clarity ${Math.round(r.clarity * 100)}% (want ${Math.round(c.clarity * 100)}%+)`);
  if (r.wps !== undefined && r.wps > c.maxWps) out.push(`too fast: ${r.wps.toFixed(1)} words/s (want ≤ ${c.maxWps})`);
  if (r.wps !== undefined && r.wps < c.minWps) out.push(`too slow: ${r.wps.toFixed(1)} words/s (want ≥ ${c.minWps})`);
  if (r.firstAudioMs !== undefined && r.firstAudioMs > c.firstAudioMs) out.push(`first audio ${r.firstAudioMs} ms (want ≤ ${c.firstAudioMs})`);
  if (r.interruptMs !== undefined && r.interruptMs > c.interruptMs) out.push(`interruption ${r.interruptMs} ms (want ≤ ${c.interruptMs})`);
  return out;
}

// ---------------- Checks ----------------

export const TEST_SENTENCES = [
  "Your next class is at 11:15 in room 4, and sport is on Thursday afternoon.",
  "Quick reminder, Dan: the staff meeting moved to Wednesday, so bring the reports with you.",
];

type SelfCheck = { heard?: string; speechMs?: number; audioMs?: number; error?: string };
async function selfCheck(body: Record<string, unknown>): Promise<SelfCheck> {
  if (!bridgeAvailable()) return { error: "Voice checks need the Android app." };
  try {
    return await bridge<SelfCheck>("/voice/self-check", body, 150_000);
  } catch (e) {
    const msg = errorText(e);
    return { error: /unknown \/voice\/self-check/.test(msg) ? "Voice checks need the newer MausDroid app." : msg };
  }
}

function voiceNow(over: { engine?: string; voice?: string; rate?: number } = {}) {
  const v = settings().voice;
  return { engine: over.engine ?? v.ttsEngine ?? "", voice: over.voice ?? v.voiceName ?? "", rate: over.rate ?? v.rate ?? 1, pitch: v.pitch ?? 1 };
}

function score(kind: CheckResult["kind"], expected: string, r: SelfCheck, v: { engine: string; voice: string; rate: number }): CheckResult {
  if (r.error || !r.heard) return record({ kind, engine: v.engine, voice: v.voice, rate: v.rate, expected: clip(expected, 400), heard: r.heard, error: r.error || "Nothing was recognised.", problems: [r.error || "nothing recognised"] });
  const clarity = Math.max(0, Math.round((1 - wordErrorRate(expected, r.heard)) * 1000) / 1000);
  const wps = r.speechMs ? Math.round((normalizeWords(expected).length / (r.speechMs / 1000)) * 100) / 100 : undefined;
  return record({ kind, engine: v.engine, voice: v.voice, rate: v.rate, expected: clip(expected, 400), heard: clip(r.heard, 400), clarity, wps, missed: missedWords(expected, r.heard) });
}

/** Speaks test sentences (silently, to a file) with the current voice or another one, and scores them. */
export async function checkVoice(over: { engine?: string; voice?: string; rate?: number; text?: string } = {}, kind: CheckResult["kind"] = "sample", sentences = over.text ? [over.text] : TEST_SENTENCES): Promise<CheckResult> {
  const v = voiceNow(over);
  const text = sentences.join(" ");
  // Spoken with your pronunciations; judged against the real words.
  return score(kind, text, await selfCheck({ text: pronounce(text), ...v }), v);
}

/** Checks part of a recording (e.g. a podcast line) against what it should say. */
export async function checkRecording(path: string, expected: string, startMs?: number, endMs?: number, kind: CheckResult["kind"] = "podcast"): Promise<CheckResult> {
  const v = voiceNow();
  return score(kind, expected, await selfCheck({ path, startMs, endMs }), v);
}

/** A call's timing, against the criteria. */
export function recordCall(firstAudioMs: number[], interruptMs: number[]) {
  const avg = (a: number[]) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : undefined);
  const f = avg(firstAudioMs);
  const i = avg(interruptMs);
  if (f === undefined && i === undefined) return null;
  const v = voiceNow();
  return record({ kind: "call", engine: v.engine, voice: v.voice, rate: v.rate, firstAudioMs: f, interruptMs: i });
}

/**
 * Tries the engine's English voices (and speeds for the best one) and ranks
 * them against the criteria: best first. Nothing is changed; the person (or an
 * approved Improver suggestion) picks.
 */
export async function audition(maxVoices = 6): Promise<CheckResult[]> {
  const base = voiceNow();
  let voices: { name: string; locale: string; network?: boolean; notInstalled?: boolean }[] = [];
  try {
    voices = (await bridge<{ voices: typeof voices }>("/voice/voices", { engine: base.engine }, 20_000)).voices ?? [];
  } catch {
    /* only the current voice */
  }
  const english = voices.filter((v) => !v.notInstalled && !v.network && /^en/i.test(v.locale));
  const names = [...new Set([base.voice, ...english.map((v) => v.name)].filter(Boolean))].slice(0, maxVoices);
  if (!names.length) names.push("");
  const results: CheckResult[] = [];
  for (const name of names) results.push(await checkVoice({ voice: name, rate: base.rate }, "audition", [TEST_SENTENCES[0]]));
  const rank = (r: CheckResult) => (r.error ? -1 : (r.clarity ?? 0) * 10 - (r.wps ? Math.max(0, r.wps - voiceCriteria().maxWps, voiceCriteria().minWps - r.wps) : 1));
  results.sort((a, b) => rank(b) - rank(a));
  // The best voice at a couple of speeds, if its speed is off.
  const best = results[0];
  const c = voiceCriteria();
  if (best && !best.error && best.wps && (best.wps > c.maxWps || best.wps < c.minWps)) {
    const target = (c.minWps + c.maxWps) / 2;
    const rate = Math.round(Math.min(1.6, Math.max(0.6, (best.rate ?? 1) * (target / best.wps))) * 100) / 100;
    const tuned = await checkVoice({ voice: best.voice, rate }, "audition", [TEST_SENTENCES[0]]);
    results.push(tuned);
    results.sort((a, b) => rank(b) - rank(a));
  }
  return results;
}

/** For Improver's nightly review: how the voice has done lately against the criteria. */
export function voiceSummary(days = 7) {
  const since = Date.now() - days * 86400_000;
  const recent = store.get().results.filter((r) => new Date(r.at).getTime() > since);
  const failing = recent.filter((r) => !r.pass);
  const avg = (k: "clarity" | "wps" | "firstAudioMs" | "interruptMs") => {
    const v = recent.map((r) => r[k]).filter((x): x is number => typeof x === "number");
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100 : null;
  };
  return {
    criteria: voiceCriteria(),
    checks: recent.length,
    passing: recent.length - failing.length,
    averages: { clarity: avg("clarity"), wordsPerSecond: avg("wps"), firstAudioMs: avg("firstAudioMs"), interruptMs: avg("interruptMs") },
    currentVoice: voiceNow(),
    pronunciations: settings().voice.pronunciations ?? [],
    // Words misheard again and again (usually names): candidates for a pronunciation.
    // (Only from checks that were otherwise clear: a voice that garbles everything needs a different voice.)
    oftenMisheard: Object.entries(recent.filter((r) => (r.clarity ?? 0) >= 0.5).flatMap((r) => r.missed ?? []).reduce<Record<string, number>>((m, w) => ((m[w] = (m[w] ?? 0) + 1), m), {}))
      .filter(([, n]) => n >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([word, times]) => ({ word, times })),
    worst: failing.slice(-5).map((r) => ({ kind: r.kind, voice: r.voice, rate: r.rate, problems: r.problems, expected: r.expected, heard: r.heard })),
  };
}
