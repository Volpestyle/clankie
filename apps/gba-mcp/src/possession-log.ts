/**
 * Possession transitions, durably.
 *
 * "Every transition is logged; possession is never silent" only held while
 * someone was watching the right stderr at the right moment: a stdio server's
 * stderr belongs to whichever harness launched it, and is gone with the
 * process. Who held the body, when, and who was refused is exactly the record
 * an operator asks for after the fact, so it lands next to `body.lock` in the
 * shared body root — one file, append-only, across every server that ever
 * serves this body.
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { PossessionEvent } from "./possession.ts";

export const POSSESSION_EVENT_LOG_FILENAME = "possession-events.jsonl";

export const PossessionEventRecordSchema = z
  .object({
    schemaVersion: z.literal(1),
    at: z.string().datetime(),
    type: z.enum(["acquired", "released", "expired", "stolen", "refused"]),
    holderId: z.string().min(1).max(200),
    previousHolderId: z.string().min(1).max(200).optional(),
    reason: z.string().min(1).max(200).optional(),
  })
  .strict();
export type PossessionEventRecord = z.infer<typeof PossessionEventRecordSchema>;

export interface PossessionEventLog {
  readonly path: string;
  append(event: PossessionEvent): void;
}

export function createPossessionEventLog(input: {
  /** The shared body root — the same directory `body.lock` lives in. */
  rootDir: string;
  clock?: () => Date;
  /**
   * Where a failed append lands. A possession that cannot be recorded must
   * still be granted or refused on its own merits — the log observes the
   * lease, it does not gate it. Absent, append errors propagate.
   */
  onError?: (error: unknown) => void;
}): PossessionEventLog {
  const clock = input.clock ?? (() => new Date());
  const logPath = path.join(input.rootDir, POSSESSION_EVENT_LOG_FILENAME);
  return {
    path: logPath,
    append: (event) => {
      try {
        const record = PossessionEventRecordSchema.parse({
          schemaVersion: 1,
          at: clock().toISOString(),
          type: event.type,
          holderId: event.holderId,
          ...(event.previousHolderId === undefined ? {} : { previousHolderId: event.previousHolderId }),
          ...(event.reason === undefined ? {} : { reason: event.reason }),
        });
        appendFileSync(logPath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      } catch (error) {
        if (input.onError === undefined) throw error;
        input.onError(error);
      }
    },
  };
}

/** Parse the log's lines. Corrupt lines throw: a lying record is worse than none. */
export function parsePossessionEventLog(contents: string): PossessionEventRecord[] {
  return contents
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => PossessionEventRecordSchema.parse(JSON.parse(line)));
}
