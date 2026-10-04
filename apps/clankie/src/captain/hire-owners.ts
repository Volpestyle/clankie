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

const RecordSchema = z
  .object({
    id: z.string().min(1),
    paneId: z.string().min(1).optional(),
    seatId: z.string().min(1).optional(),
    occupantId: z.string().min(1).optional(),
    sessionKey: z.string().min(1).optional(),
    owner: ConversationOwnerSchema,
  })
  .strict();
const StateSchema = z.object({ schemaVersion: z.literal(1), hires: z.array(RecordSchema) }).strict();

/** Ownership survives watch consumption and service replacement; it is never inferred from persona. */
export class HireOwners {
  private state: z.infer<typeof StateSchema>;
  private readonly path: string;
  public constructor(path: string) {
    this.path = path;
    // Corrupt ownership cannot be replaced with a fresh empty journal.
    this.state = existsSync(path)
      ? StateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : { schemaVersion: 1, hires: [] };
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
    const entry = this.state.hires.find((item) => item.sessionKey === sessionKey);
    return entry === undefined ? undefined : ConversationOwnerSchema.parse(entry.owner);
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
          ...(nativeSession === undefined ? {} : { sessionKey: nativeSession }),
        },
      ],
    });
  }
  public intent(owner: ConversationOwner): string {
    const id = randomUUID();
    this.save({ schemaVersion: 1, hires: [...this.state.hires, { id, owner }] });
    return id;
  }
  public bind(
    paneId: string,
    owner: ConversationOwner,
    seatId?: string,
    intentId?: string,
    occupantId?: string,
    sessionKey?: string,
  ): void {
    const prior = this.state.hires.find(
      (entry) => entry.paneId === paneId || (seatId !== undefined && entry.seatId === seatId),
    );
    const sessionOwner = sessionKey === undefined ? undefined : this.sessionOwner(sessionKey);
    const held = sessionOwner ?? prior?.owner;
    if (
      (held !== undefined && held.conversationId !== owner.conversationId) ||
      (prior?.occupantId !== undefined && (prior.occupantId !== occupantId || prior.seatId !== seatId))
    )
      throw new Error("This worker has a different persisted conversation or native occupant");
    const next = StateSchema.parse({
      schemaVersion: 1,
      hires: [
        ...this.state.hires.filter(
          (entry) =>
            entry.id !== intentId &&
            entry.paneId !== paneId &&
            (seatId === undefined || entry.seatId !== seatId),
        ),
        {
          id: intentId ?? randomUUID(),
          paneId,
          owner: held ?? owner,
          ...(seatId === undefined ? {} : { seatId }),
          ...(occupantId === undefined ? {} : { occupantId }),
          ...(sessionKey === undefined ? {} : { sessionKey }),
        },
      ],
    });
    this.save(next);
  }
  private save(input: z.infer<typeof StateSchema>): void {
    const next = StateSchema.parse(input);
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
