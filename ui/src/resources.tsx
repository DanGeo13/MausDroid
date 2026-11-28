import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import { IconBack, IconSearch } from "./icons.tsx";
import { copyText, toast } from "./actions.tsx";

/**
 * Resources: links bots gave you and documents MausDroid made, grouped by
 * keyword. Old ones move to Archived but stay searchable (and any bot can
 * find them). Delete one, or select several and delete them together.
 */
export function Resources({ onBack }: { onBack: () => void }) {
  const [q, setQ] = useState("");
  const [kw, setKw] = useState("");
  const [archived, setArchived] = useState(false);
  const [data, setData] = useState<{ items: any[]; keywords: { keyword: string; count: number }[] } | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const load = () => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (kw) p.set("keyword", kw);
    // Searching looks in the archive too, so nothing is ever lost.
    if (archived) p.set("archived", "1");
    else if (q.trim()) p.set("archived", "all");
    void api(`resources?${p}`).then(setData).catch(() => setData({ items: [], keywords: [] }));
  };
  useEffect(load, [q, kw, archived]);
  const open = async (r: any) => {
    const x = await api(`resources/${r.id}/open`, { body: {} }).catch(() => null);
    const url = r.url ?? (r.fileId ? `api/files/${r.fileId}` : x?.url);
    if (url) window.open(url, "_blank");
  };
  const del = async (ids: string[]) => {
    if (!ids.length || !confirm(ids.length === 1 ? "Delete this?" : `Delete these ${ids.length}?`)) return;
    const r = await api("resources/delete", { body: { ids } });
    toast(`Deleted ${r.deleted?.length ?? 0}`);
    setSel(new Set());
    load();
  };
  const pick = (id: string) => {
    const s = new Set(sel);
    s.has(id) ? s.delete(id) : s.add(id);
    setSel(s);
  };
  return (
    <>
      <div class="topbar">
        <button class="icon-btn" onClick={onBack} aria-label="Back">
          <IconBack />
        </button>
        <h1>Resources</h1>
        {sel.size ? (
          <button class="btn small danger" onClick={() => del([...sel])}>
            Delete {sel.size}
          </button>
        ) : null}
      </div>
      <div class="page">
        <div class="search">
          <IconSearch />
          <input value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} placeholder="Search links and documents" aria-label="Search resources" />
        </div>
        <div class="chips">
          <button class={`chip ${!kw ? "on" : ""}`} onClick={() => setKw("")}>
            All
          </button>
          {data?.keywords.slice(0, 30).map((k) => (
            <button class={`chip ${kw === k.keyword ? "on" : ""}`} onClick={() => setKw(kw === k.keyword ? "" : k.keyword)}>
              {k.keyword} <span class="muted">{k.count}</span>
            </button>
          ))}
          <button class={`chip ${archived ? "on" : ""}`} onClick={() => setArchived(!archived)}>
            🗄️ Archived
          </button>
        </div>
        {!data ? (
          <p class="muted">Loading…</p>
        ) : !data.items.length ? (
          <p class="muted">{archived ? "Nothing archived." : "No links or documents yet. Links bots give you, and documents MausDroid makes, appear here."}</p>
        ) : (
          data.items.map((r) => (
            <div class={`res-row ${sel.has(r.id) ? "picked" : ""}`} key={r.id}>
              <input type="checkbox" checked={sel.has(r.id)} onChange={() => pick(r.id)} aria-label={`Select ${r.title}`} />
              <button class="res-main" onClick={() => void open(r)}>
                <div class="res-title">
                  {r.kind === "doc" ? "📄" : "🔗"} {r.title}
                  {r.archived ? <span class="pill">Archived</span> : null}
                </div>
                {r.url ? <div class="muted res-url">{r.url}</div> : null}
                <div class="muted" style={{ fontSize: ".75rem" }}>
                  {r.keywords.join(" · ")}
                  {r.keywords.length ? " · " : ""}
                  {new Date(r.addedAt).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}
                </div>
              </button>
              <div class="res-acts">
                {r.url ? (
                  <button class="btn secondary small" onClick={() => void copyText(r.url).then(() => toast("Link copied"))} aria-label="Copy link">
                    Copy
                  </button>
                ) : null}
                <button
                  class="btn secondary small"
                  onClick={() => {
                    const k = prompt("Keywords (comma separated)", r.keywords.join(", "));
                    if (k != null) void api(`resources/${r.id}/tag`, { body: { keywords: k.split(",").map((x) => x.trim()).filter(Boolean), replace: true } }).then(load);
                  }}
                >
                  Tag
                </button>
                <button class="btn secondary small" onClick={() => void api(`resources/${r.id}/archive`, { body: { archived: !r.archived } }).then(load)}>
                  {r.archived ? "Unarchive" : "Archive"}
                </button>
                <button class="btn secondary small" onClick={() => void del([r.id])} aria-label={`Delete ${r.title}`}>
                  Delete
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
