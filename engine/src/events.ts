/**
 * Event hub. Every change the UI needs (new message text, tool activity,
 * approval cards, alerts) is an event with an increasing sequence number.
 * Local UIs use Server-Sent Events; the remote website polls with `since`.
 */
export interface EngineEvent {
  seq: number;
  type: string;
  at: string;
  [k: string]: unknown;
}

type Listener = (e: EngineEvent) => void;
const listeners = new Set<Listener>();
const backlog: EngineEvent[] = [];
let seq = 0;

export function emit(type: string, data: Record<string, unknown> = {}): EngineEvent {
  const e: EngineEvent = { ...data, seq: ++seq, type, at: new Date().toISOString() };
  backlog.push(e);
  if (backlog.length > 2000) backlog.splice(0, backlog.length - 2000);
  for (const l of listeners) {
    try {
      l(e);
    } catch {
      /* a broken listener must not stop others */
    }
  }
  return e;
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function eventsSince(since: number): EngineEvent[] {
  return backlog.filter((e) => e.seq > since);
}

export const currentSeq = () => seq;

/** Waits up to `ms` for any event after `since` (long polling for the website relay). */
export function waitForEvents(since: number, ms: number): Promise<EngineEvent[]> {
  const ready = eventsSince(since);
  if (ready.length) return Promise.resolve(ready);
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      off();
      resolve([]);
    }, ms);
    const off = subscribe(() => {
      clearTimeout(t);
      off();
      resolve(eventsSince(since));
    });
  });
}
