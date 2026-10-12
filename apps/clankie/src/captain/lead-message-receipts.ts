import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const MAX_ENTRIES = 1000;
const JournalSchema = z.record(
  z.string().min(1),
  z.object({ from: z.string().min(1), to: z.string().min(1), service: z.literal(true).optional() }).strict(),
);

/**
 * Sender/recipient attribution for native and service-queued lead messages.
 * The receiving channel or inbox owns progress; this binding protects sender-only
 * reconciliation after restart. An unreadable journal binds nothing.
 */
export class LeadMessageReceipts {
  private entries: Record<string, { from: string; to: string; service?: true | undefined }> = {};
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    try {
      this.entries = JournalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // Absent or unreadable: no sender is bound, so receipts stay as originally reported.
    }
  }

  get(messageId: string): { from: string; to: string; service?: true | undefined } | undefined {
    return Object.hasOwn(this.entries, messageId) ? this.entries[messageId] : undefined;
  }

  /** The first binding for an ID is permanent; a later sender never takes it over. */
  record(messageId: string, from: string, to: string, service?: true): void {
    if (this.get(messageId) !== undefined) return;
    this.entries[messageId] = { from, to, ...(service ? { service } : {}) };
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
