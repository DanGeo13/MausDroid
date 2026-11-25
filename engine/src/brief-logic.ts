/**
 * Morning Brief rules (no network here, so every case can be tested):
 *  - which Drive file is this week's Staff Update,
 *  - which sport-matrix worksheet is this week's (untidy tab names),
 *  - what the sheet says for Thursday,
 *  - whether a date is a school day (from confirmed term dates).
 */

// ---------------- Term dates ----------------

export interface TermDates {
  terms: { name: string; start: string; end: string; confirmed: boolean }[];
  /** Holidays, pupil-free days, public holidays and special events (inclusive dates). */
  days: { name: string; start: string; end: string; kind: "holiday" | "pupil-free" | "public-holiday" | "event"; confirmed: boolean }[];
}

export interface DayStatus {
  date: string;
  schoolDay: boolean;
  term?: string;
  week?: number;
  reason: string;
  /** Set when the answer relies on dates the person hasn't confirmed. */
  unconfirmed: boolean;
  events: string[];
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const parse = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

export function dayStatus(date: Date, t: TermDates): DayStatus {
  const key = ymd(date);
  const within = (a: string, b: string) => key >= a && key <= b;
  const events = t.days.filter((d) => d.kind === "event" && within(d.start, d.end)).map((d) => d.name);
  const base = { date: key, events };
  if (!t.terms.length) return { ...base, schoolDay: date.getDay() >= 1 && date.getDay() <= 5, reason: "No term dates set up yet, so weekdays are assumed to be school days.", unconfirmed: true };
  const term = t.terms.find((x) => within(x.start, x.end));
  const special = t.days.find((d) => d.kind !== "event" && within(d.start, d.end));
  if (date.getDay() === 0 || date.getDay() === 6) return { ...base, schoolDay: false, term: term?.name, reason: "Weekend.", unconfirmed: false };
  if (!term) {
    const next = t.terms.filter((x) => x.start > key).sort((a, b) => a.start.localeCompare(b.start))[0];
    return { ...base, schoolDay: false, reason: `School holidays${next ? ` (${next.name} starts ${next.start})` : ""}.`, unconfirmed: t.terms.some((x) => !x.confirmed) };
  }
  const week = Math.floor((parse(key).getTime() - parse(term.start).getTime()) / (7 * 86400_000)) + 1;
  if (special) return { ...base, schoolDay: false, term: term.name, week, reason: `${special.name} (${special.kind.replace("-", " ")}).`, unconfirmed: !special.confirmed || !term.confirmed };
  return { ...base, schoolDay: true, term: term.name, week, reason: `${term.name}, week ${week}.`, unconfirmed: !term.confirmed };
}

// ---------------- Staff Update discovery ----------------

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
  /** True when found by content rather than by name. */
  contentMatch?: boolean;
  account?: string;
}

export interface StaffUpdatePick {
  best: (DriveFile & { score: number }) | null;
  alternatives: (DriveFile & { score: number })[];
  warnings: string[];
}

const TITLE = /staff\s*(update|bulletin|news(letter)?|notices?)|weekly\s*(staff\s*)?update/i;
// "Week 5", "Wk5", "W05", "T4W5", "Term 4 Week 5".
const WEEK = /(?:\bt(?:erm)?\s*(\d)\s*)?(?:\b|(?<=\d))w(?:ee)?k?\s*0?(\d{1,2})\b/i;

export function weekOf(text: string): { term?: number; week: number } | null {
  const m = text.match(WEEK);
  return m ? { term: m[1] ? Number(m[1]) : undefined, week: Number(m[2]) } : null;
}

export function rankStaffUpdates(files: DriveFile[], now: Date, current?: { term?: number; week?: number }): StaffUpdatePick {
  const warnings: string[] = [];
  const scored = files
    .filter((f) => !/folder|shortcut/.test(f.mimeType))
    .map((f) => {
      let score = 0;
      if (TITLE.test(f.name)) score += 5;
      else if (f.contentMatch) score += 2;
      const ageDays = (now.getTime() - new Date(f.modifiedTime).getTime()) / 86400_000;
      score += ageDays <= 7 ? 3 : ageDays <= 14 ? 1 : -2;
      const w = weekOf(f.name);
      if (w && current?.week) score += w.week === current.week && (!w.term || !current.term || w.term === current.term) ? 3 : -3;
      if (/document|pdf|wordprocessing|msword|text\//.test(f.mimeType)) score += 1;
      if (/spreadsheet|presentation|image|video/.test(f.mimeType)) score -= 1;
      if (/copy of|draft|template|old\b/i.test(f.name)) score -= 3;
      return { ...f, score, ageDays };
    })
    .sort((a, b) => b.score - a.score || new Date(b.modifiedTime).getTime() - new Date(a.modifiedTime).getTime());
  const valid = scored.filter((f) => f.score >= 4 && f.ageDays <= 10);
  const best = valid[0] ?? null;
  if (!best) warnings.push(scored.length ? `No current Staff Update found (closest: "${scored[0].name}", modified ${scored[0].modifiedTime.slice(0, 10)}).` : "No Staff Update found in Google Drive.");
  const close = valid.filter((f) => f !== best && best && best.score - f.score <= 1);
  if (best && close.length) warnings.push(`Several possible Staff Updates; using "${best.name}" (also: ${close.map((c) => `"${c.name}"`).join(", ")}).`);
  const strip = ({ ageDays, ...f }: any) => f;
  return { best: best ? strip(best) : null, alternatives: scored.filter((f) => f !== best).slice(0, 4).map(strip), warnings };
}

// ---------------- Sport matrix ----------------

/** "  Copy of  Week 5 " → "week 5" (lower case, single spaces, no "Copy of"). */
export function normaliseSheetName(name: string): string {
  let n = name.replace(/ /g, " ").replace(/\s+/g, " ").trim();
  while (/^copy of /i.test(n)) n = n.replace(/^copy of /i, "");
  return n.replace(/\s*\(\d+\)$/, "").toLowerCase();
}

export interface SheetPick {
  sheet: string | null;
  week?: number;
  warnings: string[];
  duplicates: string[];
}

/** This week's worksheet; never last week's when this week's is missing. */
export function pickSportSheet(names: string[], week: number, term?: number): SheetPick {
  const warnings: string[] = [];
  const candidates = names
    .map((name, index) => ({ name, index, norm: normaliseSheetName(name), w: weekOf(normaliseSheetName(name)), copy: /^\s*copy of/i.test(name) }))
    .filter((c) => c.w && c.w.week === week && (!c.w.term || !term || c.w.term === term));
  if (!candidates.length) {
    const weeks = names.map((n) => weekOf(normaliseSheetName(n))?.week).filter((x): x is number => Boolean(x));
    const latest = weeks.length ? Math.max(...weeks) : null;
    warnings.push(`Week ${week} sport sheet isn't published yet${latest ? ` (latest tab is week ${latest})` : ""}. Not using an older week.`);
    return { sheet: null, week, warnings, duplicates: [] };
  }
  // Prefer the original over "Copy of" tabs, then the first tab with that name.
  candidates.sort((a, b) => Number(a.copy) - Number(b.copy) || a.index - b.index);
  const chosen = candidates[0];
  const duplicates = candidates.slice(1).map((c) => c.name);
  if (duplicates.length) warnings.push(`Duplicate week ${week} tabs found (${[chosen.name, ...duplicates].map((n) => `"${n.trim()}"`).join(", ")}); using "${chosen.name.trim()}".`);
  return { sheet: chosen.name, week, warnings, duplicates };
}

export interface SportRows {
  header: string[];
  rows: string[][];
  column?: string;
  warnings: string[];
}

/**
 * Thursday sport from a worksheet's values: the Thursday column (if the
 * sheet has one) and the rows that mention the person's identifiers.
 */
export function extractThursday(values: string[][], identifiers: string[]): SportRows {
  const warnings: string[] = [];
  const clean = values.map((r) => r.map((c) => String(c ?? "").trim()));
  const headerIdx = clean.findIndex((r) => r.some((c) => /thu(rs(day)?)?\b/i.test(c)));
  const header = headerIdx >= 0 ? clean[headerIdx] : (clean[0] ?? []);
  const thuCol = header.findIndex((c) => /thu(rs(day)?)?\b/i.test(c));
  const ids = identifiers.map((s) => s.trim().toLowerCase()).filter(Boolean);
  let rows = clean.slice(headerIdx >= 0 ? headerIdx + 1 : 1).filter((r) => r.some(Boolean));
  if (ids.length) {
    const mine = rows.filter((r) => r.some((c) => ids.some((id) => c.toLowerCase().includes(id))));
    if (!mine.length) warnings.push(`Your name/code (${identifiers.join(", ")}) isn't on this week's sport sheet.`);
    rows = mine;
  } else {
    warnings.push("Add your name or staff code in Morning Brief settings to pick out your sport allocation.");
    rows = rows.slice(0, 40);
  }
  if (thuCol >= 0) rows = rows.map((r) => [r[0], r[thuCol]].filter((x) => x !== undefined));
  return { header: thuCol >= 0 ? [header[0], header[thuCol]] : header, rows, column: thuCol >= 0 ? header[thuCol] : undefined, warnings };
}
