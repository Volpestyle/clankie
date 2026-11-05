export const SETTLED_STATUSES = new Set(["idle", "done", "blocked"]);

export const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;

export const HERDR_COMMAND_TIMEOUT_MS = 5_000;

export const SEAT_REPLY_READ_LINES = 240;

// Harness startup includes loading extensions; it is not a short Herdr query.
export const SPAWN_READY_WAIT_MS = 30_000;

export const SPAWN_CHANNEL_DIALOG_WAIT_MS = 30_000;

/** A word the pane's POSIX shell reads back verbatim. */
export function shellWord(word: string): string {
  return /^[\w@%+=:,./-]+$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}
