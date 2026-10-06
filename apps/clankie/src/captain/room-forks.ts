import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

/** What an owner-directed room turn reports back to the seat that started it (ADR 0218). */
export const RoomForkResultSchema = z
  .object({
    state: z.enum(["posted", "silent", "failed", "uncertain"]),
    room: z.string().min(1),
    channelId: z.string().min(1).optional(),
    replyTo: z.string().min(1).optional(),
    messageId: z.string().min(1).optional(),
    /** The words that posted (or would have), bounded for the seat's context. */
    text: z.string().max(1_600).optional(),
    file: z.string().min(1).max(256).optional(),
    code: z.string().min(1).max(256).optional(),
  })
  .strict();
export type RoomForkResult = z.infer<typeof RoomForkResultSchema>;

const RecordSchema = z.union([
  z.strictObject({ state: z.literal("running"), fingerprint: z.string().min(1) }),
  z.strictObject({
    state: z.literal("settled"),
    fingerprint: z.string().min(1),
    result: RoomForkResultSchema,
  }),
]);
type Record_ = z.infer<typeof RecordSchema>;

/**
 * One owner-directed room turn per request ID. A retry returns the settled
 * result; a run interrupted by a restart is reported uncertain and never rerun,
 * because its model turn or post may already have happened.
 */
export class RoomForkReceipts {
  private readonly records = new Map<string, Record_>();
  private readonly path: string | undefined;

  public constructor(path?: string) {
    this.path = path;
    if (path === undefined) return;
    try {
      const saved = z.record(z.string(), RecordSchema).parse(JSON.parse(readFileSync(path, "utf8")));
      for (const [id, record] of Object.entries(saved)) this.records.set(id, record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** `undefined` means this call owns the run; otherwise what to answer instead. */
  public begin(id: string, fingerprint: string, room: string, live: boolean): RoomForkResult | undefined {
    const existing = this.records.get(id);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint)
        return { state: "failed", room, code: "room_fork_request_conflict" };
      if (existing.state === "settled") return existing.result;
      return { state: "uncertain", room, code: live ? "room_fork_running" : "room_fork_interrupted" };
    }
    this.records.set(id, { state: "running", fingerprint });
    this.save();
    return undefined;
  }

  public settle(id: string, fingerprint: string, result: RoomForkResult): RoomForkResult {
    const parsed = RoomForkResultSchema.parse(result);
    this.records.set(id, { state: "settled", fingerprint, result: parsed });
    this.save();
    return parsed;
  }

  private save(): void {
    if (this.path === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const file = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(file, `${JSON.stringify(Object.fromEntries(this.records))}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.path);
  }
}
