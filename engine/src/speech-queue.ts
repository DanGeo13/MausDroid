import { bridge } from "./bridge.ts";

/**
 * Everything sent to the phone's phrase player goes through one ordered line.
 * Phrases are produced a few milliseconds apart (speech starts after the first
 * few words); sent as separate requests at once, they could reach the phone
 * out of order and come out garbled. Each waits for the one before it.
 */
let last: Promise<unknown> = Promise.resolve();
export function enqueueSpeech<T = any>(body: Record<string, unknown>, timeoutMs = 10_000): Promise<T> {
  const run = last.catch(() => {}).then(() => bridge<T>("/speech/enqueue", body, timeoutMs));
  last = run;
  return run;
}
