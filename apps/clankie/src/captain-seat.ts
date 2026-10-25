import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CaptainSeatStartResultSchema,
  type CaptainSeat,
  type CaptainSeatSnapshot,
  type CaptainSeatStartResult,
} from "@clankie/protocol/captain-seat";
import type { ClankieSettings } from "@clankie/settings";

export function captainSeatSnapshot(settings: ClankieSettings, supported: boolean): CaptainSeatSnapshot {
  const seat = settings.captain.seat ?? "app";
  return {
    schemaVersion: 1,
    revision: createHash("sha256").update(JSON.stringify({ seat })).digest("hex"),
    seat,
    supported,
  };
}

const RecordSchema = z
  .object({
    result: CaptainSeatStartResultSchema,
    expectedRevision: z.string(),
    startedAt: z.number(),
  })
  .strict();
type StartRecord = z.infer<typeof RecordSchema>;

type CaptainSeatDependencies = {
  directory: string;
  supported: boolean;
  snapshot(): Promise<CaptainSeatSnapshot>;
  cwd(): Promise<string>;
  createConversation(cwd: string, seat: CaptainSeat): Promise<string>;
  appReady(): Promise<boolean>;
  nativeReady(conversationId: string, seat: "claude" | "codex"): Promise<boolean>;
  launch(
    input: { cwd: string; seat: "claude" | "codex"; conversationId: string },
    guard: () => Promise<boolean>,
  ): Promise<string>;
};

/** A launcher preflight proved no native creation request was sent. */
export class CaptainSeatLaunchRefused extends Error {
  readonly reason: "unavailable" | "authority_revoked";
  constructor(reason: "unavailable" | "authority_revoked") {
    super(reason);
    this.reason = reason;
  }
}

/** One durable request per explicit launch; a lost reply never authorizes another pane. */
export class CaptainSeats {
  private readonly pending = new Set<string>();
  private readonly deps: CaptainSeatDependencies;
  constructor(deps: CaptainSeatDependencies) {
    this.deps = deps;
  }

  get supported(): boolean {
    return this.deps.supported;
  }

  private read(requestId: string): StartRecord | undefined {
    // Only schema-validated UUIDs can select files, including internal callers.
    z.uuid().parse(requestId);
    try {
      return RecordSchema.parse(
        JSON.parse(readFileSync(join(this.deps.directory, `${requestId}.json`), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  private save(record: StartRecord): void {
    mkdirSync(this.deps.directory, { recursive: true, mode: 0o700 });
    const path = join(this.deps.directory, `${record.result.requestId}.json`);
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(RecordSchema.parse(record))}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }

  async status(requestId: string): Promise<CaptainSeatStartResult | undefined> {
    const record = this.read(requestId);
    if (!record) return undefined;
    const { result } = record;
    if (result.outcome !== "starting" && result.outcome !== "uncertain") return result;
    if (
      result.conversationId &&
      result.seat !== "app" &&
      (await this.deps.nativeReady(result.conversationId, result.seat))
    ) {
      record.result = { ...result, outcome: "ready" };
      delete record.result.error;
      this.save(record);
    } else if (
      result.outcome === "starting" &&
      !this.pending.has(requestId) &&
      (!result.paneId || Date.now() - record.startedAt > 120_000)
    ) {
      record.result = { ...result, outcome: "uncertain", error: "launch_unconfirmed" };
      this.save(record);
    }
    return record.result;
  }

  async start(input: { requestId: string; expectedRevision: string }, guard: () => Promise<boolean>) {
    const previous = this.read(input.requestId);
    if (previous) {
      if (previous.expectedRevision !== input.expectedRevision) throw Error("seat_conflict");
      return (await this.status(input.requestId))!;
    }
    const current = await this.deps.snapshot();
    if (current.revision !== input.expectedRevision) throw Error("seat_conflict");
    if (!this.supported || !(await guard())) throw Error("forbidden");
    // There is no await between deduplication and the durable write. Competing
    // HTTP requests after the authority check must inspect the record again.
    if (this.read(input.requestId)) return (await this.status(input.requestId))!;
    const record: StartRecord = {
      expectedRevision: input.expectedRevision,
      startedAt: Date.now(),
      result: { requestId: input.requestId, seat: current.seat, outcome: "starting" },
    };
    this.save(record);
    this.pending.add(input.requestId);
    void this.perform(record, guard)
      .catch(() => console.error("Captain seat start journal unavailable", input.requestId))
      .finally(() => this.pending.delete(input.requestId));
    return record.result;
  }

  private async perform(record: StartRecord, guard: () => Promise<boolean>): Promise<void> {
    let launchAttempted = false;
    const fail = (error: NonNullable<CaptainSeatStartResult["error"]>) => {
      record.result = { ...record.result, outcome: "failed", error };
      this.save(record);
    };
    try {
      if (!(await guard())) return fail("authority_revoked");
      if ((await this.deps.snapshot()).revision !== record.expectedRevision) return fail("selection_changed");
      if (record.result.seat === "app" && !(await this.deps.appReady())) return fail("not_ready");
      const cwd = await this.deps.cwd();
      if (!(await guard())) return fail("authority_revoked");
      const conversationId = await this.deps.createConversation(cwd, record.result.seat);
      record.result = { ...record.result, conversationId };
      this.save(record);
      if (!(await guard())) return fail("authority_revoked");
      if ((await this.deps.snapshot()).revision !== record.expectedRevision) return fail("selection_changed");
      if (record.result.seat === "app") {
        record.result = { ...record.result, outcome: "ready" };
      } else {
        launchAttempted = true;
        const paneId = await this.deps.launch({ cwd, seat: record.result.seat, conversationId }, guard);
        record.result = { ...record.result, paneId };
      }
      this.save(record);
    } catch (error) {
      if (error instanceof CaptainSeatLaunchRefused) return fail(error.reason);
      record.result = {
        ...record.result,
        outcome: launchAttempted ? "uncertain" : "failed",
        error: launchAttempted ? "launch_unconfirmed" : "unavailable",
      };
      this.save(record);
    }
  }
}
