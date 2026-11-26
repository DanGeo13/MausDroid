/**
 * When MausDroid's access rules change, existing chats must not keep acting on
 * what happened earlier in the conversation (e.g. "Gmail is blocked"). Each
 * change gets a short note; a bot sees the notes it hasn't seen yet once, at
 * the start of its next turn. Nothing is cleared — chats and bots carry on.
 * Add a new entry here whenever access or permissions change.
 */
export const ACCESS_UPDATES: { id: string; note: string }[] = [
  {
    id: "2026-11-26-smart-access",
    note: "Reading no longer needs approval: emails, calendars, files, notifications and web pages can be opened straight away, and the old double approval for Claude is gone. Anything earlier in this chat saying an app or email was blocked, or waiting for approval, is out of date — try the tools again now instead of asking the person to paste things. Only sending, creating, changing, deleting, archiving, buying or posting asks first.",
  },
];
export const LATEST_ACCESS_UPDATE = ACCESS_UPDATES[ACCESS_UPDATES.length - 1].id;

/** Notes a bot hasn't seen (all of them for a bot that has never seen any). */
export function unseenUpdates(seen: string | undefined) {
  if (seen === LATEST_ACCESS_UPDATE) return [];
  const i = seen ? ACCESS_UPDATES.findIndex((u) => u.id === seen) : -1;
  return ACCESS_UPDATES.slice(i + 1);
}

export function accessNote(seen: string | undefined): string | null {
  const notes = unseenUpdates(seen);
  return notes.length ? `[MausDroid update since earlier in this chat: ${notes.map((n) => n.note).join(" ")}]` : null;
}
