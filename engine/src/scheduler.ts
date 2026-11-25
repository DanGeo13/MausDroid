import { dueRoutines, listRoutines } from "./routines.ts";
import { sendToBot } from "./agent.ts";
import { getBot } from "./bots.ts";

function fire(r: { botId: string; title: string; prompt: string }) {
  if (!getBot(r.botId)) return;
  sendToBot(
    r.botId,
    `${r.prompt}\n\n(This is your scheduled routine "${r.title}". The person is probably not watching: if there's something they should know, use notify_user; otherwise just reply briefly with what you found.)`,
    `routine: ${r.title}`,
  );
}

export function runRoutineNow(id: string) {
  const r = listRoutines().find((x) => x.id === id);
  if (!r) throw new Error("No such routine");
  fire(r);
}

export function tick() {
  for (const r of dueRoutines()) fire(r);
}

export function startScheduler() {
  setInterval(tick, 30_000);
  tick();
}
