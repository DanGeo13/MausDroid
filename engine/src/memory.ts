import fs from "node:fs";
import { dataPath } from "./store.ts";

/** Long-term notes. "about-me" is shared by every bot; each bot also has its own. */
const file = (scope: string) => dataPath("memory", `${scope.replace(/[^a-zA-Z0-9_-]/g, "")}.md`);

export function readMemory(scope: string): string {
  try {
    return fs.readFileSync(file(scope), "utf8");
  } catch {
    return "";
  }
}

export function appendMemory(scope: string, note: string) {
  const line = `- ${new Date().toISOString().slice(0, 10)}: ${note.replace(/\n+/g, " ").trim()}\n`;
  fs.appendFileSync(file(scope), line);
}

export function writeMemory(scope: string, text: string) {
  fs.writeFileSync(file(scope), text);
}
