import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ConversationOwnerSchema, type ConversationOwner } from "./conversation-owner.ts";

/** Who asked for a hire (ADR 0321). Absent on a hire Clankie chose himself, and on older records. */
const HireStarterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }).strict(),
  z.object({ kind: z.literal("app"), deviceId: z.string().min(1).max(256) }).strict(),
]);
export type HireStarter = z.infer<typeof HireStarterSchema>;
const RecordSchema = z
  .object({
    id: z.string().min(1),
    paneId: z.string().min(1).optional(),
    seatId: z.string().min(1).optional(),
    occupantId: z.string().min(1).optional(),
    sessionKey: z.string().min(1).optional(),
    hired: z.boolean().optional(),
    startupFailure: z.string().min(1).max(4000).optional(),
    hireConversationId: z.string().min(1).optional(),
    hireProjectId: z.string().min(1).optional(),
    startedBy: HireStarterSchema.optional(),
    owner: ConversationOwnerSchema,
  })
  .strict();
export const HireOwnersStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    hires: z.array(RecordSchema),
    restartSuccessors: z
      .array(z.object({ receiptId: z.string().min(1), previous: RecordSchema, next: RecordSchema }).strict())
      .optional(),
  })
  .strict();
type HireOwnerRecord = z.infer<typeof RecordSchema>;

/** Ownership survives watch consumption and service replacement; it is never inferred from persona. */
export class HireOwners {
  private state: z.infer<typeof HireOwnersStateSchema>;
  private readonly path: string;
  public constructor(path: string) {
    this.path = path;
    // Corrupt ownership cannot be replaced with a fresh empty journal.
    this.state = existsSync(path)
      ? HireOwnersStateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : { schemaVersion: 1, hires: [] };
  }
  /** Retain a failed first turn on the original allocation, including before native binding. */
  public failStartup(intentId: string, detail: string): string | undefined {
    const held = this.state.hires.find((entry) => entry.id === intentId);
    if (!held?.paneId) return;
    this.save({
      ...this.state,
      hires: this.state.hires.map((entry) => (entry === held ? { ...entry, startupFailure: detail } : entry)),
    });
    return held.paneId;
  }
  /** A display flag, never native authority; it remains visible across service replacement. */
  public startupFailure(paneId: string, seatId: string, occupantId?: string): string | undefined {
    return this.state.hires.find(
      (entry) =>
        entry.paneId === paneId &&
        (entry.seatId === undefined || (entry.seatId === seatId && entry.occupantId === occupantId)),
    )?.startupFailure;
  }
  public hasClaim(paneId: string, seatId: string): boolean {
    return this.state.hires.some((entry) => entry.paneId === paneId || entry.seatId === seatId);
  }
  public owner(paneId: string, seatId: string, occupantId: string): ConversationOwner | undefined {
    const held = this.state.hires.find(
      (entry) => entry.paneId === paneId && entry.seatId === seatId && entry.occupantId === occupantId,
    );
    return held === undefined ? undefined : ConversationOwnerSchema.parse(held.owner);
  }
  /**
   * The persisted lead of this exact native occupant, and whether Clankie hired
   * it (`hired: false` is a hand-started seat a conversation adopted by messaging).
   */
  public claim(
    paneId: string,
    seatId: string,
    occupantId: string,
  ): { owner: ConversationOwner; hired: boolean } | undefined {
    const held = this.state.hires.find(
      (entry) => entry.paneId === paneId && entry.seatId === seatId && entry.occupantId === occupantId,
    );
    return held === undefined
      ? undefined
      : { owner: ConversationOwnerSchema.parse(held.owner), hired: held.hired !== false };
  }
  /** Display attribution requires an explicitly recorded hire, never adoption alone. */
  public hiredProjectContext(
    paneId: string,
    seatId: string,
    occupantId: string,
  ): { conversationId: string; projectId?: string } | null | undefined {
    const records = this.state.hires.filter((entry) => entry.paneId === paneId || entry.seatId === seatId);
    const held = records.length === 1 ? records[0] : undefined;
    return held?.hired === true &&
      held.paneId === paneId &&
      held.seatId === seatId &&
      held.occupantId === occupantId
      ? {
          conversationId: held.hireConversationId ?? held.owner.conversationId,
          ...(held.hireProjectId === undefined ? {} : { projectId: held.hireProjectId }),
        }
      : records.some((record) => record.hired === true)
        ? null
        : undefined;
  }
  public seatOwner(seatId: string, occupantId: string): ConversationOwner | undefined {
    const held = this.state.hires.find((entry) => entry.seatId === seatId && entry.occupantId === occupantId);
    return held === undefined ? undefined : ConversationOwnerSchema.parse(held.owner);
  }
  /** Uncertain startup has only the pane allocated by this exact persisted intent. */
  public pendingOwner(paneId: string): ConversationOwner | undefined {
    const held = this.state.hires.find(
      (entry) => entry.paneId === paneId && entry.seatId === undefined && entry.occupantId === undefined,
    );
    return held === undefined ? undefined : ConversationOwnerSchema.parse(held.owner);
  }
  public sessionOwner(sessionKey: string): ConversationOwner | undefined {
    const entries = this.state.hires.filter((item) => item.sessionKey === sessionKey);
    const entry = entries[0];
    if (entries.some((item) => item.owner.conversationId !== entry?.owner.conversationId))
      throw new Error("Saved session has conflicting persisted conversation owners");
    return entry === undefined ? undefined : ConversationOwnerSchema.parse(entry.owner);
  }
  /** Historical hire provenance is distinct from fresh native delivery admission. */
  public tidyRecord(paneId: string, seatId: string, occupantId: string, sessionKey: string) {
    const held = this.state.hires.find(
      (entry) => entry.sessionKey === sessionKey && entry.occupantId === occupantId,
    );
    if (held) return { ...held, owner: ConversationOwnerSchema.parse(held.owner) };
    return this.hasClaim(paneId, seatId) ? ("unknown" as const) : undefined;
  }
  /** Restored retirement needs one explicit original hire, with no competing pane/thread claim. */
  public restoredRetirementRecord(paneId: string, seatId: string, occupantId: string, sessionKey: string) {
    const records = this.state.hires.filter(
      (entry) => entry.paneId === paneId || entry.seatId === seatId || entry.sessionKey === sessionKey,
    );
    const held = records[0];
    return records.length === 1 &&
      held?.hired === true &&
      held.paneId === paneId &&
      held.occupantId === occupantId &&
      held.sessionKey === sessionKey &&
      held.seatId
      ? { ...held, owner: ConversationOwnerSchema.parse(held.owner) }
      : undefined;
  }
  /** A matching thread may retain its report, without adopting or granting native control. */
  public retainedReportOwner(
    paneId: string,
    seatId: string,
    sessionKey: string,
  ): ConversationOwner | undefined {
    const held = this.sessionOwner(sessionKey);
    if (held === undefined || this.hasThreadConflict(paneId, seatId, sessionKey, held)) return undefined;
    return held;
  }
  private hasThreadConflict(
    paneId: string,
    seatId: string,
    sessionKey: string,
    held: ConversationOwner,
  ): boolean {
    return this.state.hires.some(
      (entry) =>
        (entry.paneId === paneId || entry.seatId === seatId) &&
        (entry.owner.conversationId !== held.conversationId ||
          (entry.sessionKey !== sessionKey &&
            (entry.sessionKey !== undefined ||
              entry.seatId !== undefined ||
              entry.occupantId !== undefined))),
    );
  }
  /** Only the persisted owning conversation may repair the exact same native thread. */
  public readopt(
    paneId: string,
    seatId: string,
    occupantId: string,
    owner: ConversationOwner,
    sessionKey: string,
    intentId?: string,
  ): { owner: ConversationOwner; replaced: readonly HireOwnerRecord[] } {
    const held = this.sessionOwner(sessionKey);
    if (held === undefined || held.conversationId !== owner.conversationId)
      throw new Error("Saved session has no matching persisted hiring conversation");
    if (this.hasThreadConflict(paneId, seatId, sessionKey, held))
      throw new Error("This pane belongs to a different persisted native thread");
    const replaced = this.state.hires.filter(
      (entry) => entry.sessionKey === sessionKey || entry.paneId === paneId || entry.seatId === seatId,
    );
    const prior = replaced.find((entry) => entry.sessionKey === sessionKey)!;
    this.save({
      schemaVersion: 1,
      hires: [
        ...this.state.hires.filter((entry) => entry.id !== intentId && !replaced.includes(entry)),
        {
          id: intentId ?? prior.id,
          paneId,
          seatId,
          occupantId,
          owner: held,
          sessionKey,
          // Reattachment changes native admission, not how the thread was started.
          // Keep false and unknown too: re-adoption must never manufacture a hire.
          ...(prior.hired === undefined ? {} : { hired: prior.hired }),
          ...(prior.hireConversationId === undefined ? {} : { hireConversationId: prior.hireConversationId }),
          ...(prior.hireProjectId === undefined ? {} : { hireProjectId: prior.hireProjectId }),
          ...(prior.startedBy === undefined ? {} : { startedBy: prior.startedBy }),
        },
      ],
    });
    return { owner: held, replaced: replaced.map((entry) => RecordSchema.parse(entry)) };
  }
  /** An admitted message adopts the exact native worker, before it can report back. */
  public adopt(
    paneId: string,
    seatId: string,
    occupantId: string,
    owner: ConversationOwner,
    sessionKey?: string,
  ): void {
    const prior = this.state.hires.find((entry) => entry.paneId === paneId || entry.seatId === seatId);
    if (
      prior !== undefined &&
      (prior.paneId !== paneId || prior.seatId !== seatId || prior.occupantId !== occupantId)
    )
      throw new Error("The adopted worker no longer matches its persisted native occupant");
    const nativeSession = prior?.sessionKey ?? sessionKey;
    this.save({
      schemaVersion: 1,
      hires: [
        ...this.state.hires.filter(
          (entry) =>
            entry.paneId !== paneId &&
            entry.seatId !== seatId &&
            (nativeSession === undefined || entry.sessionKey !== nativeSession),
        ),
        {
          id: prior?.id ?? randomUUID(),
          paneId,
          seatId,
          occupantId,
          owner,
          ...(prior?.hireConversationId === undefined
            ? {}
            : { hireConversationId: prior.hireConversationId }),
          ...(prior?.hireProjectId === undefined ? {} : { hireProjectId: prior.hireProjectId }),
          ...(prior === undefined
            ? { hired: false }
            : prior.hired === undefined
              ? {}
              : { hired: prior.hired }),
          ...(nativeSession === undefined ? {} : { sessionKey: nativeSession }),
        },
      ],
    });
  }
  public intent(owner: ConversationOwner, startedBy?: HireStarter): string {
    const id = randomUUID();
    this.save({
      schemaVersion: 1,
      hires: [...this.state.hires, { id, owner, ...(startedBy === undefined ? {} : { startedBy }) }],
    });
    return id;
  }
  /** Who asked for this exact occupant's hire; display only, never authority (ADR 0321). */
  public starter(seatId: string, occupantId: string): HireStarter | undefined {
    const held = this.state.hires.find((entry) => entry.seatId === seatId && entry.occupantId === occupantId);
    return held?.hired === true ? held.startedBy : undefined;
  }
  /** An original runtime's journaled fresh restart, never ordinary re-adoption. */
  public restartSuccessor(input: {
    receiptId: string;
    paneId: string;
    previousSeatId: string;
    previousOccupantId: string;
    previousSessionKey: string;
    seatId: string;
    occupantId: string;
    sessionKey: string;
    owner: ConversationOwner;
  }): void {
    const prior = this.state.hires.find((entry) => entry.paneId === input.paneId);
    if (
      !input.receiptId ||
      !prior ||
      prior.hired !== true ||
      prior.seatId !== input.previousSeatId ||
      prior.occupantId !== input.previousOccupantId ||
      prior.sessionKey !== input.previousSessionKey ||
      prior.owner.conversationId !== input.owner.conversationId ||
      input.sessionKey === prior.sessionKey ||
      this.state.hires.some(
        (entry) =>
          entry !== prior && (entry.seatId === input.seatId || entry.sessionKey === input.sessionKey),
      )
    )
      throw new Error("Restart successor does not match the original hire owner");
    const next = {
      ...prior,
      seatId: input.seatId,
      occupantId: input.occupantId,
      sessionKey: input.sessionKey,
    };
    this.save({
      schemaVersion: 1,
      hires: this.state.hires.map((entry) => (entry !== prior ? entry : next)),
      restartSuccessors: [
        ...(this.state.restartSuccessors ?? []),
        { receiptId: input.receiptId, previous: prior, next },
      ],
    });
  }

  public bind(
    paneId: string,
    owner: ConversationOwner,
    seatId?: string,
    intentId?: string,
    occupantId?: string,
    sessionKey?: string,
    projectId?: string,
  ): void {
    const prior = this.state.hires.find(
      (entry) => entry.paneId === paneId || (seatId !== undefined && entry.seatId === seatId),
    );
    const sessionOwner = sessionKey === undefined ? undefined : this.sessionOwner(sessionKey);
    const held = sessionOwner ?? prior?.owner;
    // A new hire's own intent says who asked; a re-bind keeps what its record already says.
    const startedBy =
      intentId === undefined
        ? prior?.startedBy
        : this.state.hires.find((entry) => entry.id === intentId)?.startedBy;
    const sessionClaim =
      sessionKey === undefined
        ? undefined
        : this.state.hires.find((entry) => entry.sessionKey === sessionKey);
    if (
      (held !== undefined && held.conversationId !== owner.conversationId) ||
      (prior?.occupantId !== undefined && (prior.occupantId !== occupantId || prior.seatId !== seatId)) ||
      (sessionClaim !== undefined &&
        (sessionClaim.paneId !== paneId ||
          sessionClaim.seatId !== seatId ||
          sessionClaim.occupantId !== occupantId))
    )
      throw new Error("This worker has a different persisted conversation or native occupant");
    const next = HireOwnersStateSchema.parse({
      schemaVersion: 1,
      hires: [
        ...this.state.hires.filter(
          (entry) =>
            entry.id !== intentId &&
            entry.paneId !== paneId &&
            (seatId === undefined || entry.seatId !== seatId) &&
            (sessionKey === undefined || entry.sessionKey !== sessionKey),
        ),
        {
          id: intentId ?? randomUUID(),
          paneId,
          owner: held ?? owner,
          hired: true,
          hireConversationId: prior?.hireConversationId ?? owner.conversationId,
          ...((prior?.hireProjectId ?? projectId) === undefined
            ? {}
            : { hireProjectId: prior?.hireProjectId ?? projectId }),
          ...(seatId === undefined ? {} : { seatId }),
          ...(occupantId === undefined ? {} : { occupantId }),
          ...(sessionKey === undefined ? {} : { sessionKey }),
          ...(startedBy === undefined ? {} : { startedBy }),
        },
      ],
    });
    this.save(next);
  }
  private save(input: z.infer<typeof HireOwnersStateSchema>): void {
    const next = HireOwnersStateSchema.parse({
      ...input,
      ...((input.restartSuccessors ?? this.state.restartSuccessors) === undefined
        ? {}
        : {
            restartSuccessors: input.restartSuccessors ?? this.state.restartSuccessors,
          }),
    });
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    const file = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, this.path);
    const directory = openSync(dirname(this.path), "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
    this.state = next;
  }
}
