// Talks to the engine. Paths are relative so the same UI works inside the
// app, over Tailscale, and through the always-on website (/d/<id>/...).
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`api/${path}`, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: opts.body === undefined ? {} : { "content-type": "application/json" },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    credentials: "same-origin",
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return data as T;
}

export type EngineEvent = { seq: number; type: string; [k: string]: any };

/** Live updates: Server-Sent Events in the app, long polling through the website. */
export function listen(onEvent: (e: EngineEvent) => void, startSeq: number, poll: boolean): () => void {
  let stopped = false;
  if (!poll && typeof EventSource !== "undefined") {
    const es = new EventSource("api/events");
    es.onmessage = (m) => onEvent(JSON.parse(m.data));
    es.onerror = () => {
      /* EventSource reconnects by itself */
    };
    return () => es.close();
  }
  let since = startSeq;
  (async () => {
    while (!stopped) {
      try {
        const r = await api<{ events: EngineEvent[]; seq: number }>(`events/poll?since=${since}`);
        for (const e of r.events) onEvent(e);
        // After an engine restart its numbering starts again from zero.
        since = r.events.length ? r.events[r.events.length - 1].seq : r.seq < since ? r.seq : since;
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
  return () => {
    stopped = true;
  };
}
