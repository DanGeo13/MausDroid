import { collection } from "./store.ts";
import { emit } from "./events.ts";
import { clip, id as newId, now } from "./util.ts";

/**
 * Resources: the links bots give you and the documents MausDroid makes, in one
 * list, grouped by keywords (Christmas, a name, a project, a destination…).
 * Things you haven't opened for 30 days are archived — still searchable and
 * retrievable by any bot when you need reminding. "Don't worry about that, you
 * can delete it" deletes one or many.
 */
export interface Resource {
  id: string;
  kind: "link" | "doc";
  url?: string;
  /** A MausDroid file (documents it made or saved). */
  fileId?: string;
  title: string;
  keywords: string[];
  note?: string;
  botId?: string;
  addedAt: string;
  lastUsedAt: string;
  archived: boolean;
}

const store = collection<{ items: Resource[] }>("resources", { items: [] });
store.update((s) => void (s.items ??= []));
const ARCHIVE_DAYS = 30;
const changed = () => emit("resources", {});

const tidyKeywords = (k: string[]) => [...new Set(k.map((x) => String(x).trim().toLowerCase().replace(/\s+/g, " ")).filter((x) => x && x.length <= 40))].slice(0, 12);

/** Archives what hasn't been opened for 30 days (still searchable). */
function archiveOld() {
  const cutoff = Date.now() - ARCHIVE_DAYS * 86400_000;
  let n = 0;
  store.update((s) => {
    for (const r of s.items) if (!r.archived && new Date(r.lastUsedAt).getTime() < cutoff) (r.archived = true), n++;
  });
  if (n) changed();
}

/** Adds a link or document (or adds keywords to one already saved). */
export function saveResource(input: { kind?: "link" | "doc"; url?: string; fileId?: string; title?: string; keywords?: string[]; note?: string; botId?: string }): Resource {
  const url = input.url ? String(input.url).trim() : undefined;
  if (!url && !input.fileId) throw new Error("Give a link (url) or a document (fileId).");
  if (url && !/^https?:\/\//i.test(url)) throw new Error("Links start with http:// or https://");
  let out: Resource | undefined;
  store.update((s) => {
    const cur = s.items.find((r) => (url && r.url === url) || (input.fileId && r.fileId === input.fileId));
    if (cur) {
      cur.keywords = tidyKeywords([...cur.keywords, ...(input.keywords ?? [])]);
      if (input.title && (!cur.title || cur.title === cur.url)) cur.title = clip(input.title, 200);
      if (input.note) cur.note = clip(input.note, 500);
      cur.lastUsedAt = now();
      cur.archived = false;
      out = { ...cur };
      return;
    }
    const r: Resource = {
      id: newId("res"),
      kind: input.kind ?? (input.fileId ? "doc" : "link"),
      url,
      fileId: input.fileId,
      title: clip(String(input.title || url || "Document").trim(), 200),
      keywords: tidyKeywords(input.keywords ?? []),
      note: input.note ? clip(input.note, 500) : undefined,
      botId: input.botId,
      addedAt: now(),
      lastUsedAt: now(),
      archived: false,
    };
    s.items.push(r);
    if (s.items.length > 5000) s.items.splice(0, s.items.length - 5000);
    out = r;
  });
  changed();
  return out!;
}

const STOP = new Set("about after again also because before being below between both could does doing down during each few from further have having here hers herself himself into itself just more most myself once only other ought ours ourselves over same should some such than that their theirs them themselves then there these they this those through under until very were what when where which while whom with would your yours yourself yourselves please thanks find send give show link links need want looking look some good best".split(" "));
const TOPICS = /\b(christmas|xmas|birthday|holiday|holidays|trip|travel|wedding|anniversary|gift|gifts|present|presents|school|work|project|recipe|recipes|house|home|garden|car|health|finance|money|tax|insurance|music|book|books|movie|movies|course|camp|party|easter|halloween)\b/gi;

/** Keywords from what you asked: topics (Christmas, holiday…) and names/places (capitalised words). */
export function keywordsFrom(text: string): string[] {
  const topics = (text.match(TOPICS) ?? []).map((t) => t.toLowerCase().replace(/^xmas$/, "christmas"));
  const names = (text.match(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?\b/g) ?? []).filter((w, i) => i > 0 || !/^(Can|Could|Please|Find|Send|Give|Show|What|Where|When|How|Why|Who|Hey|Hi|Hello|Get|Look|Search|Book|The|And|For)$/.test(w));
  return tidyKeywords([...topics, ...names.filter((w) => !STOP.has(w.toLowerCase()))]).slice(0, 5);
}

/** Links in a reply (Markdown links with their titles, and bare links). MausDroid's own local links are skipped. */
export function linksIn(text: string): { url: string; title?: string }[] {
  const out: { url: string; title?: string }[] = [];
  for (const m of text.matchAll(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]+)\)/g)) out.push({ url: m[2], title: m[1] });
  for (const m of text.matchAll(/(?<!\]\()https?:\/\/[^\s<>()\]"']+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    if (!out.some((x) => x.url === url)) out.push({ url });
  }
  return out.filter((x) => !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(x.url)).slice(0, 20);
}

/** Saves the links a bot gave, with keywords from what you'd asked. */
export function captureLinks(reply: string, asked: string, botId?: string): Resource[] {
  const links = linksIn(reply);
  if (!links.length) return [];
  const keywords = keywordsFrom(asked);
  return links.map((l) => saveResource({ kind: "link", url: l.url, title: l.title ?? l.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80), keywords, botId }));
}

export function listResources(opts: { query?: string; keyword?: string; archived?: boolean | "all" } = {}): Resource[] {
  archiveOld();
  const q = (opts.query ?? "").trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const kw = opts.keyword?.trim().toLowerCase();
  return store
    .get()
    .items.filter((r) => opts.archived === "all" || (opts.archived ? r.archived : !r.archived))
    .filter((r) => !kw || r.keywords.includes(kw))
    .map((r) => {
      const hay = `${r.title} ${r.url ?? ""} ${r.keywords.join(" ")} ${r.note ?? ""}`.toLowerCase();
      const score = words.length ? words.reduce((n, w) => n + (r.keywords.includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0) : 1;
      return { r, score };
    })
    .filter((x) => x.score > 0 && (!words.length || words.every((w) => `${x.r.title} ${x.r.url ?? ""} ${x.r.keywords.join(" ")} ${x.r.note ?? ""}`.toLowerCase().includes(w))))
    .sort((a, b) => b.score - a.score || b.r.addedAt.localeCompare(a.r.addedAt))
    .map((x) => x.r);
}

/** Keywords with how many items each has (for grouping). */
export function keywordGroups(includeArchived = false) {
  const m = new Map<string, number>();
  for (const r of store.get().items) if (includeArchived || !r.archived) for (const k of r.keywords) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([keyword, count]) => ({ keyword, count }));
}

export function touchResource(id: string) {
  store.update((s) => {
    const r = s.items.find((x) => x.id === id);
    if (r) (r.lastUsedAt = now()), (r.archived = false);
  });
  changed();
}

export function tagResource(id: string, keywords: string[], replace = false): Resource {
  let out: Resource | undefined;
  store.update((s) => {
    const r = s.items.find((x) => x.id === id);
    if (!r) throw new Error("No such resource.");
    r.keywords = tidyKeywords(replace ? keywords : [...r.keywords, ...keywords]);
    out = { ...r };
  });
  changed();
  return out!;
}

export function archiveResource(id: string, archived = true) {
  store.update((s) => {
    const r = s.items.find((x) => x.id === id);
    if (r) r.archived = archived;
  });
  changed();
}

/** Deletes one or many (by ids, or everything matching a keyword or search). Documents' files go too. */
export async function deleteResources(sel: { ids?: string[]; keyword?: string; query?: string }): Promise<{ deleted: Resource[] }> {
  const targets = sel.ids?.length ? store.get().items.filter((r) => sel.ids!.includes(r.id)) : sel.keyword || sel.query ? listResources({ keyword: sel.keyword, query: sel.query, archived: "all" }) : [];
  if (!targets.length) return { deleted: [] };
  const ids = new Set(targets.map((r) => r.id));
  store.update((s) => {
    s.items = s.items.filter((r) => !ids.has(r.id));
  });
  const { deleteFile } = await import("./files.ts");
  for (const r of targets) if (r.fileId) deleteFile(r.fileId);
  changed();
  return { deleted: targets };
}

export const getResource = (id: string) => store.get().items.find((r) => r.id === id);
