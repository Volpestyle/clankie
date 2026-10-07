import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  OwnerUpdateDraftSchema,
  OwnerUpdateSchema,
  OWNER_UPDATE_LIST_MAX,
  OWNER_UPDATE_CONVERSATION_MAX,
  OWNER_UPDATE_STATE_BYTES_MAX,
  type OwnerUpdateListFilter,
  type OwnerUpdate,
  type OwnerUpdateDraft,
} from "@clankie/protocol";

const RecordSchema = z
  .object({ publicationId: z.string().min(1).max(1024), update: OwnerUpdateSchema })
  .strict();
type UpdateRecord = z.infer<typeof RecordSchema>;
const StateSchema = z
  .object({ schemaVersion: z.literal(1), records: z.array(RecordSchema) })
  .strict()
  .superRefine((state, ctx) => {
    const conversations = new Map<string, UpdateRecord[]>();
    for (const record of state.records) {
      const records = conversations.get(record.update.conversationId) ?? [];
      records.push(record);
      conversations.set(record.update.conversationId, records);
    }
    if (new Set(state.records.map((r) => r.update.id)).size !== state.records.length)
      ctx.addIssue({ code: "custom", message: "Duplicate owner update ID" });
    for (const records of conversations.values()) {
      if (
        records.length > OWNER_UPDATE_CONVERSATION_MAX ||
        Buffer.byteLength(JSON.stringify(records)) > OWNER_UPDATE_STATE_BYTES_MAX ||
        new Set(records.map((r) => r.publicationId)).size !== records.length
      )
        ctx.addIssue({ code: "custom", message: "Invalid bounded owner updates" });
    }
  });

/** Deliberate informational mail only. Reading/dismissing never schedules a run. */
export class OwnerUpdates {
  private state: z.infer<typeof StateSchema>;
  private readonly path: string;
  public constructor(path: string) {
    this.path = path;
    this.state = existsSync(path)
      ? StateSchema.parse(JSON.parse(readFileSync(path, "utf8")))
      : { schemaVersion: 1, records: [] };
  }
  public publish(conversationId: string, draft: OwnerUpdateDraft, publicationId: string): OwnerUpdate {
    const input = OwnerUpdateDraftSchema.parse(draft);
    z.string().min(1).max(1024).parse(publicationId);
    const existing = this.state.records.find(
      (r) => r.update.conversationId === conversationId && r.publicationId === publicationId,
    );
    if (existing) {
      const u = existing.update;
      const original = {
        title: u.title,
        ...(u.body === undefined ? {} : { body: u.body }),
        ...(u.source.seatId === undefined ? {} : { seatId: u.source.seatId }),
        ...(u.issue === undefined ? {} : { issue: u.issue }),
        ...(u.links === undefined ? {} : { links: u.links }),
        ...(u.media === undefined ? {} : { media: u.media }),
      };
      if (!isDeepStrictEqual(original, input)) throw new Error("owner_update_publication_conflict");
      return structuredClone(u);
    }
    const { seatId, ...content } = input;
    const update = OwnerUpdateSchema.parse({
      ...content,
      id: randomUUID(),
      conversationId,
      at: new Date().toISOString(),
      source: { conversationId, ...(seatId === undefined ? {} : { seatId }) },
      state: "unread",
    });
    const own = this.state.records.filter((r) => r.update.conversationId === conversationId);
    const dismissed = own.filter((r) => r.update.state === "dismissed").slice(-32);
    const records = [
      ...this.state.records.filter(
        (r) =>
          r.update.conversationId !== conversationId ||
          r.update.state !== "dismissed" ||
          dismissed.includes(r),
      ),
      { publicationId, update },
    ];
    // Reserve timestamps for later read/dismiss transitions at the size bound.
    const ownNext = records.filter((r) => r.update.conversationId === conversationId);
    if (Buffer.byteLength(JSON.stringify(ownNext)) + ownNext.length * 100 > OWNER_UPDATE_STATE_BYTES_MAX)
      throw new Error("owner_updates_capacity");
    this.commit({ schemaVersion: 1, records });
    return structuredClone(update);
  }
  public list(filter: OwnerUpdateListFilter = {}): OwnerUpdate[] {
    return this.state.records
      .toReversed()
      .filter(
        (r) =>
          (!filter.conversationId || r.update.conversationId === filter.conversationId) &&
          (filter.state === "all" ||
            (filter.state ? r.update.state === filter.state : r.update.state !== "dismissed")),
      )
      .map((r) => structuredClone(r.update))
      .sort((a, b) => b.at.localeCompare(a.at) || a.conversationId.localeCompare(b.conversationId))
      .slice(0, OWNER_UPDATE_LIST_MAX);
  }
  public resolve(id: string, operation: "read" | "dismiss") {
    const record = this.state.records.find((r) => r.update.id === id);
    if (!record) return { status: "refused" as const, reason: "unknown_update" };
    if (
      record.update.state !== "dismissed" &&
      (operation === "dismiss" || record.update.state === "unread")
    ) {
      const next = structuredClone(this.state);
      const update = next.records.find((r) => r.update.id === id)!.update;
      update.readAt ??= new Date().toISOString();
      update.state = operation === "read" ? "read" : "dismissed";
      if (operation === "dismiss") update.dismissedAt = new Date().toISOString();
      this.commit(next);
    }
    return {
      status: "resolved" as const,
      update: structuredClone(this.state.records.find((r) => r.update.id === id)!.update),
    };
  }
  private commit(next: z.infer<typeof StateSchema>): void {
    StateSchema.parse(next);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let committed = false;
    try {
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(file, JSON.stringify(next));
        fsyncSync(file);
      } finally {
        closeSync(file);
      }
      renameSync(temporary, this.path);
      committed = true;
      this.state = next;
      const directory = openSync(dirname(this.path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } catch (error) {
      if (committed) throw new Error("owner_update_commit_uncertain", { cause: error });
      throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
