import {
  WorkItemWriteCommandSchema,
  WorkItemWriteReceiptRequestSchema,
  WorkItemWriteReceiptSchema,
  uncertainWorkItemWrite,
  type WorkItemWriteCommand,
  type WorkItemWriteReceipt,
} from "@clankie/protocol";
import { z } from "zod";
import { DeliveryFence, deliveryFingerprint } from "./captain/delivery-fence.ts";
import { DurableReceiptStore } from "./durable-receipt-store.ts";

const WorkWriteScopeSchema = z
  .object({
    owner: z.object({ kind: z.enum(["operator", "device"]), id: z.string().min(1).max(256) }).strict(),
    repoId: WorkItemWriteReceiptRequestSchema.shape.repoId,
    itemId: WorkItemWriteReceiptRequestSchema.shape.itemId,
    /** Exact server-prepared project/tracker binding, never supplied by the device. */
    binding: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type WorkWriteScope = z.infer<typeof WorkWriteScopeSchema>;

const RecordSchema = z
  .object({
    id: WorkItemWriteReceiptRequestSchema.shape.requestId,
    scope: WorkWriteScopeSchema,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    createdAt: z.number(),
    state: z.enum(["uncertain", "settled"]),
    result: WorkItemWriteReceiptSchema.optional(),
  })
  .strict()
  .refine(
    (record) =>
      record.result === undefined ||
      (record.result.requestId === record.id &&
        (record.state === "uncertain") === (record.result.outcome === "uncertain")),
    "Receipt must match its original ID and settlement state",
  );
type ReceiptRecord = z.infer<typeof RecordSchema>;

const refused = (requestId: string, message: string): WorkItemWriteReceipt => ({
  requestId,
  outcome: "refused",
  message,
});

/** Durable intent admission, scoped reconciliation, and no mutation replay. */
export class WorkWriteReceipts {
  private readonly store: DurableReceiptStore<ReceiptRecord>;
  // The flat store owns durable admission; this fence retains unresolved in-process claims.
  private readonly fence = new DeliveryFence();

  public constructor(path?: string) {
    this.store = new DurableReceiptStore({
      ...(path === undefined ? {} : { path }),
      schema: RecordSchema,
      unreadableMessage: "Work-item write receipts are unreadable; no action was dispatched",
    });
  }

  private matches(record: ReceiptRecord, scope: WorkWriteScope): boolean {
    return (
      record.scope.owner.kind === scope.owner.kind &&
      record.scope.owner.id === scope.owner.id &&
      record.scope.repoId === scope.repoId &&
      record.scope.itemId === scope.itemId &&
      record.scope.binding === scope.binding
    );
  }

  private result(record: ReceiptRecord): WorkItemWriteReceipt {
    return (
      (record.result === undefined ? undefined : structuredClone(record.result)) ??
      uncertainWorkItemWrite(
        record.id,
        record.state === "settled"
          ? "The original result body has expired. This ID is settled and cannot dispatch again; inspect the item and native history."
          : "The original write has no settled result. It may have happened; inspect this receipt and the item, never resend it.",
      )
    );
  }

  public begin(
    id: string,
    scope: WorkWriteScope,
    command: WorkItemWriteCommand,
    freeAgent?: import("@clankie/protocol").FreeAgentIntent,
    workHandoff?: import("@clankie/protocol").WorkHandoffIntent,
  ): WorkItemWriteReceipt | undefined {
    WorkItemWriteReceiptRequestSchema.shape.requestId.parse(id);
    const originalScope = WorkWriteScopeSchema.parse(scope);
    const originalCommand = WorkItemWriteCommandSchema.parse(command);
    const records = this.store.load();
    const fingerprint = deliveryFingerprint(
      JSON.stringify(
        workHandoff !== undefined
          ? { command: originalCommand, workHandoff }
          : freeAgent === undefined
            ? originalCommand
            : { command: originalCommand, freeAgent },
      ),
    );
    const previous = records.get(id);
    if (previous !== undefined) {
      if (!this.matches(previous, originalScope) || previous.fingerprint !== fingerprint)
        return refused(
          id,
          "Request ID does not match this owner, item, binding, and original command. Nothing dispatched.",
        );
      return this.result(previous);
    }
    const claimFingerprint = deliveryFingerprint(JSON.stringify([originalScope, fingerprint]));
    const pending = this.fence.pending(id);
    if (pending !== undefined && pending.fingerprint !== claimFingerprint)
      return refused(
        id,
        "Request ID does not match this owner, item, binding, and original command. Nothing dispatched.",
      );
    if (pending !== undefined)
      return uncertainWorkItemWrite(
        id,
        "The original write remains unresolved. Nothing was resent; inspect the item and native history.",
      );
    records.set(id, {
      id,
      scope: originalScope,
      fingerprint,
      createdAt: Date.now(),
      state: "uncertain",
      result: uncertainWorkItemWrite(
        id,
        "The original write may be in progress or may have happened. Read this receipt; never resend it.",
      ),
    });
    // Admission must be durable before the caller can enter any backend mutation.
    this.store.save();
    this.fence.begin(id, { messageId: id, fingerprint: claimFingerprint });
    return undefined;
  }

  public settle(id: string, receipt: WorkItemWriteReceipt): WorkItemWriteReceipt {
    const result = WorkItemWriteReceiptSchema.parse(receipt);
    if (result.requestId !== id)
      throw new Error("Work-item write receipt ID does not match its original request");
    const record = this.store.load().get(id);
    if (record === undefined) throw new Error("Missing original work-item write receipt");
    if (record.state === "settled") return this.result(record);
    record.state = result.outcome === "uncertain" ? "uncertain" : "settled";
    record.result = result;
    this.store.save();
    if (record.state === "settled") this.fence.reconcile(id, id);
    return this.result(record);
  }

  public read(id: string, scope: WorkWriteScope): WorkItemWriteReceipt {
    WorkItemWriteReceiptRequestSchema.shape.requestId.parse(id);
    const originalScope = WorkWriteScopeSchema.parse(scope);
    const record = this.store.load().get(id);
    if (record === undefined || !this.matches(record, originalScope))
      return refused(
        id,
        "No matching work-item write receipt for this owner, item, and binding. Nothing dispatched.",
      );
    return this.result(record);
  }
}
