import { createHash, randomUUID } from "node:crypto";
import type { SeatEvent } from "@clankie/agent-hosts";
import { z } from "zod";
import { DurableReceiptStore } from "./durable-receipt-store.ts";

const Identity = z.string().min(1).max(512);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Host-resolved native occupant, not a pane name or an app-supplied target. */
const Binding = z.strictObject({ machineId: Identity, seatId: Identity, instanceId: Identity });
export type AgentMessageBinding = z.infer<typeof Binding>;

const Stage = z.enum(["queued", "delivered", "read", "acted_on", "answered"]);
const Progress = z.strictObject({
  stage: Stage,
  observedAt: z.number().finite().nonnegative(),
  /** Native timestamp, when the adapter actually supplies one. */
  occurredAt: z.string().datetime({ offset: true }).optional(),
  evidence: z.enum([
    "native_queue",
    "native_handoff",
    "native_turn_started",
    "native_turn_completed",
    "native_answer",
  ]),
});
export const AgentMessageReceiptSchema = z.strictObject({
  receiptId: z.string().uuid(),
  agent: Identity,
  revision: z.number().int().positive(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative(),
  delivery: z.enum(["pending", "queued", "delivered", "uncertain", "refused", "unavailable"]),
  /** Only facts observed for this exact input; missing stages remain unknown. */
  progress: z.array(Progress).max(5),
});
export type AgentMessageReceipt = z.infer<typeof AgentMessageReceiptSchema>;
export type AgentMessageReceiptLookup =
  | { outcome: "found"; receipt: AgentMessageReceipt }
  | { outcome: "unknown" | "expired" | "unavailable" };

const RecordSchema = z
  .strictObject({
    id: z.string().uuid(),
    createdAt: z.number().finite().nonnegative(),
    state: z.enum(["uncertain", "settled"]),
    senderDeviceId: Identity,
    requestKey: Identity,
    fingerprint: Digest,
    binding: Binding,
    /** Filled once by the native controller; an operator runId is not a messageId. */
    messageId: Identity.optional(),
    result: AgentMessageReceiptSchema.optional(),
  })
  .refine((record) => record.result === undefined || record.result.receiptId === record.id);
type ReceiptRecord = z.infer<typeof RecordSchema>;
const sameBinding = (a: AgentMessageBinding, b: AgentMessageBinding) =>
  a.machineId === b.machineId && a.seatId === b.seatId && a.instanceId === b.instanceId;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** A host-owned journal. None of these methods dispatches, retries or reads a session. */
export class AgentMessageReceipts {
  private readonly store: DurableReceiptStore<ReceiptRecord>;
  private readonly now: () => number;

  public constructor(path: string, now: () => number = Date.now) {
    this.now = now;
    this.store = new DurableReceiptStore({
      path,
      sharded: true,
      schema: RecordSchema,
      unreadableMessage: "Agent message receipts are unreadable; no message was dispatched",
    });
  }

  /** Persist before handoff. A repeated key can only recover its original receipt. */
  public begin(input: {
    senderDeviceId: string;
    requestKey: string;
    agent: string;
    binding: AgentMessageBinding;
    message: string;
    attachments?: readonly { filename: string; mediaType: string; sha256: string }[];
  }): { outcome: "new" | "existing"; receiptId: string } | { outcome: "conflict" } {
    const senderDeviceId = Identity.parse(input.senderDeviceId);
    const requestKey = Identity.parse(input.requestKey);
    const binding = Binding.parse(input.binding);
    const agent = Identity.parse(input.agent);
    const attachments = (input.attachments ?? []).map(({ filename, mediaType, sha256 }) => ({
      filename,
      mediaType,
      sha256: Digest.parse(sha256),
    }));
    const fingerprint = digest(JSON.stringify({ agent, binding, message: input.message, attachments }));
    const records = this.store.load();
    const original = [...records.values()].find(
      (record) => record.senderDeviceId === senderDeviceId && record.requestKey === requestKey,
    );
    if (original !== undefined)
      return original.fingerprint === fingerprint
        ? { outcome: "existing", receiptId: original.id }
        : { outcome: "conflict" };
    const id = randomUUID();
    const createdAt = this.now();
    records.set(id, {
      id,
      createdAt,
      senderDeviceId,
      requestKey,
      fingerprint,
      binding,
      state: "uncertain",
      result: {
        receiptId: id,
        agent,
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        delivery: "pending",
        progress: [],
      },
    });
    this.store.save();
    return { outcome: "new", receiptId: id };
  }

  /** Bind only the original occupant's actual native input, never its service run ID. */
  public bindNativeMessage(id: string, binding: AgentMessageBinding, messageId: string): boolean {
    const record = this.store.load().get(id);
    if (record === undefined || record.state === "settled" || !sameBinding(record.binding, binding))
      return false;
    Identity.parse(messageId);
    if (record.messageId !== undefined) return record.messageId === messageId;
    record.messageId = messageId;
    this.store.save();
    return true;
  }

  public delivery(
    id: string,
    binding: AgentMessageBinding,
    delivery: AgentMessageReceipt["delivery"],
  ): boolean {
    const record = this.store.load().get(id);
    if (record?.result === undefined || record.state === "settled" || !sameBinding(record.binding, binding))
      return false;
    // A late uncertain response cannot erase a confirmed handoff or native progress.
    if (
      (delivery === "pending" ||
        delivery === "uncertain" ||
        delivery === "refused" ||
        delivery === "unavailable") &&
      record.result.progress.length > 0
    )
      return false;
    if (record.result.delivery === delivery) return true;
    if (delivery === "queued" && record.result.delivery === "delivered") return false;
    record.result.delivery = delivery;
    if (delivery === "queued" || delivery === "delivered")
      this.progress(record, delivery, delivery === "queued" ? "native_queue" : "native_handoff");
    if (delivery === "refused" || delivery === "unavailable") record.state = "settled";
    this.changed(record);
    return true;
  }

  /** Trusted controller events only. Uncorrelated stops and activity never advance progress. */
  public observe(id: string, binding: AgentMessageBinding, event: SeatEvent): boolean {
    const record = this.store.load().get(id);
    if (record?.result === undefined || record.state === "settled" || !sameBinding(record.binding, binding))
      return false;
    if (event.type !== "turn_started" && event.type !== "turn_completed") return false;
    if (record.messageId === undefined || event.messageId !== record.messageId) return false;
    // Invalid native time is not grounds for inventing a timestamp.
    const at = z.string().datetime({ offset: true }).safeParse(event.at);
    if (!at.success) return false;
    if (event.type === "turn_started") {
      if (record.result.progress.some((entry) => entry.stage === "read")) return true;
      this.progress(record, "read", "native_turn_started", at.data);
    } else {
      if (!event.ok) return false;
      this.progress(record, "acted_on", "native_turn_completed", at.data);
      if (event.text?.trim()) this.progress(record, "answered", "native_answer", at.data);
      record.state = "settled";
    }
    this.changed(record);
    return true;
  }

  /** The service must supply the authenticated device, never a request's sender field. */
  public lookup(id: string, senderDeviceId: string): AgentMessageReceiptLookup {
    const record = this.store.read(id);
    if (record === undefined || record.senderDeviceId !== senderDeviceId) return { outcome: "unknown" };
    return record.result === undefined
      ? { outcome: "expired" }
      : { outcome: "found", receipt: record.result };
  }

  private progress(
    record: ReceiptRecord,
    stage: z.infer<typeof Stage>,
    evidence: z.infer<typeof Progress>["evidence"],
    occurredAt?: string,
  ): void {
    if (record.result === undefined || record.result.progress.some((entry) => entry.stage === stage)) return;
    record.result.progress.push({
      stage,
      evidence,
      observedAt: this.now(),
      ...(occurredAt === undefined ? {} : { occurredAt }),
    });
  }

  private changed(record: ReceiptRecord): void {
    if (record.result === undefined) return;
    record.result.revision += 1;
    record.result.updatedAt = this.now();
    this.store.save();
  }
}
