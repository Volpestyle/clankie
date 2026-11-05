import { readFileSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import type { SeatEvent } from "@clankie/agent-hosts";
import { z } from "zod";
import { DurableReceiptStore } from "./durable-receipt-store.ts";

const Identity = z.string().min(1).max(512);
const Digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Host-resolved native occupant, not a pane name or an app-supplied target. */
const Binding = z.strictObject({ machineId: Identity, seatId: Identity, instanceId: Identity });
export type AgentMessageBinding = z.infer<typeof Binding>;

import {
  AgentMessageReceiptSchema,
  type AgentMessageReceipt,
  type AgentMessageReceiptLookup,
  type AgentMessageStageSchema,
  type AgentMessageProgressSchema,
  SubmitOperatorConversationTurnResultSchema,
  type SubmitOperatorConversationTurnResult,
} from "@clankie/protocol";

const RecordSchema = z
  .strictObject({
    id: z.string().uuid(),
    createdAt: z.number().finite().nonnegative(),
    state: z.enum(["uncertain", "settled"]),
    senderDeviceId: Identity,
    senderSessionId: Identity.optional(),
    storageVersion: z.literal(2).optional(),
    requestKey: Identity,
    fingerprint: Digest,
    commandFingerprint: Digest,
    binding: Binding,
    /** Filled once by the native controller; an operator runId is not a messageId. */
    messageId: Identity.optional(),
    result: AgentMessageReceiptSchema.optional(),
    sendResult: SubmitOperatorConversationTurnResultSchema.optional(),
  })
  .refine((record) => record.result === undefined || record.result.receiptId === record.id);
type ReceiptRecord = z.infer<typeof RecordSchema>;
const sameBinding = (a: AgentMessageBinding, b: AgentMessageBinding) =>
  a.machineId === b.machineId && a.seatId === b.seatId && a.instanceId === b.instanceId;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
/** Persist handoff metadata only; native free text is not part of idempotent recovery. */
function replayResult(value: SubmitOperatorConversationTurnResult): SubmitOperatorConversationTurnResult {
  const result = SubmitOperatorConversationTurnResultSchema.parse(value);
  if (result.status === "accepted" && result.seatDelivery?.detail !== undefined)
    result.seatDelivery.detail = "Native queue handoff recorded; inspect the receipt for progress.";
  if (result.status === "seat_undelivered" || result.status === "seat_delivery_unconfirmed") {
    result.detail = "Native delivery result recorded; inspect the original receipt. Nothing was resent.";
    delete result.messageId;
  }
  return result;
}

/** A host-owned journal. None of these methods dispatches, retries or reads a session. */
export class AgentMessageReceipts {
  private readonly store: DurableReceiptStore<ReceiptRecord>;
  private readonly now: () => number;
  private readonly nativeEvidencePath: string | undefined;

  public constructor(path: string, now: () => number = Date.now, nativeEvidencePath?: string) {
    this.nativeEvidencePath = nativeEvidencePath;
    this.now = now;
    this.store = new DurableReceiptStore({
      path,
      sharded: true,
      schema: RecordSchema,
      trimSettled: (record) => {
        delete record.sendResult;
      },
      unreadableMessage: "Agent message receipts are unreadable; no message was dispatched",
    });
    // Upgrade before serving any request. Keep old admission tombstones, but an
    // unbound legacy record never acquires the session of its next reader.
    const records = this.store.load();
    let migrated = false;
    for (const record of records.values()) {
      if (record.storageVersion === 2) continue;
      if (record.sendResult) record.sendResult = replayResult(record.sendResult);
      record.storageVersion = 2;
      migrated = true;
    }
    if (migrated) this.store.checkpoint();
    this.store.pruneObsolete();
  }

  /** Persist before handoff. A repeated key can only recover its original receipt. */
  public begin(input: {
    senderDeviceId: string;
    senderSessionId: string;
    requestKey: string;
    agent: string;
    binding: AgentMessageBinding;
    message: string;
    targetKey?: string;
    attachments?: readonly { filename: string; mediaType: string; sha256: string }[];
  }): { outcome: "new" | "existing"; receiptId: string } | { outcome: "conflict" } {
    const senderDeviceId = Identity.parse(input.senderDeviceId);
    const senderSessionId = Identity.parse(input.senderSessionId);
    const requestKey = Identity.parse(input.requestKey);
    const binding = Binding.parse(input.binding);
    const agent = Identity.parse(input.agent);
    const attachments = (input.attachments ?? []).map(({ filename, mediaType, sha256 }) => ({
      filename,
      mediaType,
      sha256: Digest.parse(sha256),
    }));
    const fingerprint = digest(JSON.stringify({ agent, binding, message: input.message, attachments }));
    const commandFingerprint = digest(
      JSON.stringify({ targetKey: input.targetKey ?? agent, message: input.message, attachments }),
    );
    const records = this.store.load();
    const original = [...records.values()].find(
      (record) => record.senderDeviceId === senderDeviceId && record.requestKey === requestKey,
    );
    if (original !== undefined)
      return original.senderSessionId === senderSessionId && original.fingerprint === fingerprint
        ? { outcome: "existing", receiptId: original.id }
        : { outcome: "conflict" };
    const id = randomUUID();
    const createdAt = this.now();
    records.set(id, {
      id,
      createdAt,
      senderDeviceId,
      senderSessionId,
      storageVersion: 2,
      requestKey,
      fingerprint,
      commandFingerprint,
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

  /** Reconcile the immutable original command before doing any new recipient discovery. */
  public recover(input: {
    senderDeviceId: string;
    senderSessionId: string;
    requestKey: string;
    targetKey: string;
    message: string;
  }): { outcome: "absent" | "conflict" } | { outcome: "existing"; receiptId: string } {
    const record = [...this.store.load().values()].find(
      (entry) => entry.senderDeviceId === input.senderDeviceId && entry.requestKey === input.requestKey,
    );
    if (!record) return { outcome: "absent" };
    const fingerprint = digest(
      JSON.stringify({ targetKey: input.targetKey, message: input.message, attachments: [] }),
    );
    return record.senderSessionId === input.senderSessionId && record.commandFingerprint === fingerprint
      ? { outcome: "existing", receiptId: record.id }
      : { outcome: "conflict" };
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
  public lookup(
    id: string,
    senderDeviceId: string,
    senderSessionId: string | undefined,
  ): AgentMessageReceiptLookup {
    const record = this.store.read(id);
    if (
      record === undefined ||
      !senderSessionId ||
      record.senderSessionId !== senderSessionId ||
      record.senderDeviceId !== senderDeviceId
    )
      return { outcome: "unknown" };
    return record.result === undefined
      ? { outcome: "expired" }
      : { outcome: "found", receipt: this.projectNative(record) };
  }

  /** Only the host's separately authenticated owner inspection path may call this. */
  public inspectAsOwner(id: string): AgentMessageReceiptLookup {
    const record = this.store.read(id);
    return !record
      ? { outcome: "unknown" }
      : record.result === undefined
        ? { outcome: "expired" }
        : { outcome: "found", receipt: this.projectNative(record) };
  }

  /** Pure projection of the native watcher's durable exact-input completion; no session I/O or writes. */
  private projectNative(record: ReceiptRecord): AgentMessageReceipt {
    const result = structuredClone(record.result!);
    if (!this.nativeEvidencePath || !record.messageId) return result;
    try {
      if (!statSync(this.nativeEvidencePath, { throwIfNoEntry: false })?.isFile()) return result;
      const journal = z
        .object({
          schemaVersion: z.literal(1),
          harvestedTurns: z.array(
            z.object({
              terminalId: z.string(),
              occupantId: z.string(),
              messageId: z.string(),
              completion: z
                .object({
                  type: z.literal("turn_completed"),
                  at: z.string().datetime({ offset: true }),
                  messageId: z.string().optional(),
                  ok: z.boolean(),
                  text: z.string().optional(),
                })
                .optional(),
            }),
          ),
        })
        .parse(JSON.parse(readFileSync(this.nativeEvidencePath, "utf8")));
      const proof = journal.harvestedTurns.find(
        (entry) =>
          entry.terminalId === record.binding.seatId &&
          entry.occupantId === record.binding.instanceId &&
          entry.messageId === record.messageId &&
          entry.completion?.messageId === record.messageId,
      )?.completion;
      if (!proof?.ok || Date.parse(proof.at) < record.createdAt) return result;
      result.updatedAt = Math.max(result.updatedAt, Date.parse(proof.at));
      const stages = proof.text?.trim() ? (["acted_on", "answered"] as const) : (["acted_on"] as const);
      for (const stage of stages) {
        if (result.progress.some((entry) => entry.stage === stage)) continue;
        result.progress.push({
          stage,
          occurredAt: proof.at,
          evidence: stage === "answered" ? "native_answer" : "native_turn_completed",
        });
        result.revision += 1;
      }
    } catch {
      /* Missing or unverified native evidence never advances the original receipt. */
    }
    return result;
  }

  public sendResult(
    id: string,
    senderDeviceId: string,
    senderSessionId: string,
  ): SubmitOperatorConversationTurnResult | undefined {
    const record = this.store.read(id);
    return record?.senderDeviceId === senderDeviceId && record.senderSessionId === senderSessionId
      ? record.sendResult
      : undefined;
  }

  public settleSend(
    id: string,
    binding: AgentMessageBinding,
    result: SubmitOperatorConversationTurnResult,
  ): void {
    const record = this.store.load().get(id);
    if (!record || !sameBinding(record.binding, binding) || record.sendResult !== undefined) return;
    record.sendResult = replayResult(result);
    this.store.save();
  }

  private progress(
    record: ReceiptRecord,
    stage: z.infer<typeof AgentMessageStageSchema>,
    evidence: z.infer<typeof AgentMessageProgressSchema>["evidence"],
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
