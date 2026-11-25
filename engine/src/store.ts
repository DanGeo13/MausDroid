import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

/**
 * Small durable JSON store. Each collection is one file, written atomically
 * (write temp file, then rename) so a killed process never leaves half a file.
 */
export class JsonFile<T> {
  private value: T;
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string, initial: T) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      this.value = JSON.parse(fs.readFileSync(file, "utf8")) as T;
    } catch {
      this.value = initial;
    }
  }
  get(): T {
    return this.value;
  }
  set(next: T): void {
    this.value = next;
    this.schedule();
  }
  update(fn: (v: T) => void): T {
    fn(this.value);
    this.schedule();
    return this.value;
  }
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.value));
    fs.renameSync(tmp, this.file);
  }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 150);
  }
}

const files = new Map<string, JsonFile<unknown>>();
export function collection<T>(name: string, initial: T): JsonFile<T> {
  let f = files.get(name);
  if (!f) {
    f = new JsonFile<T>(path.join(config.dataDir, `${name}.json`), initial);
    files.set(name, f);
  }
  return f as JsonFile<T>;
}

export function flushAll() {
  for (const f of files.values()) {
    try {
      f.flush();
    } catch {
      /* best effort during shutdown */
    }
  }
}

export function dataPath(...parts: string[]) {
  const p = path.join(config.dataDir, ...parts);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}
