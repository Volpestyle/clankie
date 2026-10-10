import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const MAX_RECENT = 1000;
const JournalSchema = z
  .object({
    counters: z.record(z.string().min(1), z.number().int().positive()),
    recent: z.record(z.string().min(1), z.number().int().positive()),
  })
  .strict();

/**
 * Per-(lead conversation, worker) numbering of a lead's messages (VUH-2036).
 * A worker reads numbered decisions, so a late, older one is recognizably older,
 * and a replacing message names the numbers it supersedes. An identical resend
 * keeps its original number, so its text and delivery receipt stay the same.
 */
export class WorkerMessageSequence {
  private journal: z.infer<typeof JournalSchema> = { counters: {}, recent: {} };
  private readonly path: string;
  constructor(path: string) {
    this.path = path;
    try {
      this.journal = JournalSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      // Absent or unreadable: numbering restarts; numbers are context, not authority.
    }
  }

  number(input: {
    conversationId: string;
    seatId: string;
    message: string;
    title?: string;
    replaces?: boolean;
  }): string {
    const key = JSON.stringify([input.conversationId, input.seatId]);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([key, input.message, input.replaces === true]))
      .digest("hex");
    let n = this.journal.recent[fingerprint];
    if (n === undefined) {
      n = (this.journal.counters[key] ?? 0) + 1;
      this.journal.counters[key] = n;
      this.journal.recent[fingerprint] = n;
      const recent = Object.keys(this.journal.recent);
      for (const id of recent.slice(0, Math.max(0, recent.length - MAX_RECENT)))
        delete this.journal.recent[id];
      this.save();
    }
    const from = `conversation ${input.conversationId}${input.title ? ` ("${input.title}")` : ""}`;
    const header =
      input.replaces === true && n > 1
        ? `[Lead message #${n} from ${from}. It replaces this lead's earlier messages #1–#${n - 1}: any of them you have not acted on yet is superseded; follow this one.]`
        : `[Lead message #${n} from ${from}. A message with a lower number that arrives later is older guidance.]`;
    return `${header}\n\n${input.message}`;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.journal));
    const file = openSync(temporary, "r");
    try {
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.path);
  }
}
