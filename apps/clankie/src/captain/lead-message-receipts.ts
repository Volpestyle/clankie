import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const MAX_ENTRIES = 1000;
const JournalSchema = z.record(
  z.string().min(1),
  z.object({ from: z.string().min(1), to: z.string().min(1) }).strict(),
);

/**
 * Which conversation sent an unconfirmed lead message, and to which lead
 * (VUH-1950). The recipient's head fence holds the original and its ack but
 * only names the recipient; this binding lets the sender alone reconcile it
 * after a restart. An unreadable journal binds nothing, so nothing reconciles.
 */
export class LeadMessageReceipts {
  private entries: Record<string, { from: string; to: string }> = {};
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    try {
      this.entries = JournalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // Absent or unreadable: no sender is bound, so receipts stay as originally reported.
    }
  }

  get(messageId: string): { from: string; to: string } | undefined {
    return Object.hasOwn(this.entries, messageId) ? this.entries[messageId] : undefined;
  }

  /** The first binding for an ID is permanent; a later sender never takes it over. */
  record(messageId: string, from: string, to: string): void {
    if (this.get(messageId) !== undefined) return;
    this.entries[messageId] = { from, to };
    const ids = Object.keys(this.entries);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES))) delete this.entries[id];
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const file = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(file, JSON.stringify(this.entries));
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.path);
  }
}
