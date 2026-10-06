import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import {
  DeliveryStageSchema,
  HireNoLaunchEvidenceSchema,
  type HireNoLaunchEvidence,
} from "@clankie/protocol";

export const ReceiptSchema = z
  .object({
    messageId: z.string().min(1),
    fingerprint: z.string(),
    /** Host reservation begins before any remote hire effect. Legacy records have no window. */
    remoteAdmission: z
      .object({
        target: HireNoLaunchEvidenceSchema.shape.target,
        nonce: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .optional(),
    /** Irreversible service-owned barrier; a remote journal reset cannot erase launch intent. */
    remoteLaunchCommitted: z.literal(true).optional(),
    settlement: HireNoLaunchEvidenceSchema.optional(),
    sessionId: z.string().optional(),
    /** Original native occupant observed by the host, never inferred from pane/name. */
    occupantId: z.string().optional(),
    paneId: z.string().optional(),
    agentName: z.string().optional(),
    beforeIds: z.array(z.string()).optional(),
    seatId: z.string().optional(),
    /** A terminal inbound lookup refusal; this original ID may never dispatch. */
    notSent: z.literal(true).optional(),
    /** Host-owned admission attempt; never accepted from a worker's request. */
    inboundAttempt: z
      .object({ instanceId: z.string().min(1), deadlineAt: z.number().int().nonnegative() })
      .strict()
      .optional(),
    /** Only explicit stable deliveries keep a confirmed receipt after settlement. */
    completed: z
      .object({
        at: z.number().int().nonnegative(),
        messageId: z.string().optional(),
        state: z.enum(["queued", "started", "steered"]).optional(),
        deliveryStage: DeliveryStageSchema.optional(),
      })
      .strict()
      .optional(),
    /** Pi's supported semantic custom-message identity, distinct from this fence's ID. */
    nativeMessageId: z.string().uuid().optional(),
    nativeSessionPath: z
      .string()
      .startsWith("/")
      .max(4096)
      .refine((path) => !path.includes("\0"))
      .optional(),
  })
  .strict();
export type UncertainReceipt = z.infer<typeof ReceiptSchema>;
const COMPLETED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Delivery receipts, never a queue. Ordinary callers expose only unresolved claims. */
export class DeliveryFence {
  private readonly records = new Map<string, UncertainReceipt>();
  private unreadable = false;
  private readonly path: string | undefined;
  public constructor(path?: string) {
    this.path = path;
    if (path === undefined) return;
    try {
      const saved = z.record(z.string(), ReceiptSchema).parse(JSON.parse(readFileSync(path, "utf8")));
      for (const [key, receipt] of Object.entries(saved)) this.records.set(key, receipt);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unreadable = true;
    }
  }

  public pending(key: string): UncertainReceipt | undefined {
    if (this.unreadable) return { messageId: "unreadable-receipts", fingerprint: "" };
    const receipt = this.records.get(key);
    return receipt?.completed || receipt?.settlement ? undefined : receipt;
  }

  public settled(key: string): UncertainReceipt | undefined {
    const receipt = this.records.get(key);
    return !this.unreadable && receipt?.settlement ? receipt : undefined;
  }

  public settlement(messageId: string): HireNoLaunchEvidence | undefined {
    return this.unreadable
      ? undefined
      : [...this.records.values()].find((receipt) => receipt.messageId === messageId)?.settlement;
  }

  public completed(key: string): UncertainReceipt | undefined {
    const receipt = this.records.get(key);
    return !this.unreadable &&
      receipt?.completed &&
      receipt.completed.at > Date.now() - COMPLETED_RETENTION_MS
      ? receipt
      : undefined;
  }

  public entries(): readonly (readonly [string, UncertainReceipt])[] {
    return this.unreadable
      ? [["unreadable-receipts", { messageId: "unreadable-receipts", fingerprint: "" }]]
      : [...this.records.entries()].filter(([, receipt]) => !receipt.completed && !receipt.settlement);
  }

  /** Persist before crossing the uncertain boundary. A persistence failure sends nothing. */
  public begin(
    key: string,
    receipt: Omit<UncertainReceipt, "messageId"> & { messageId?: string },
  ): UncertainReceipt {
    if (this.pending(key) || this.completed(key) || this.settled(key))
      throw new Error("Delivery is uncertain; reconcile its original receipt before any retry");
    for (const [id, value] of this.records)
      if (!value.settlement && value.completed && value.completed.at <= Date.now() - COMPLETED_RETENTION_MS)
        this.records.delete(id);
    const value = { ...receipt, messageId: receipt.messageId ?? randomUUID() };
    const previous = this.records.get(key);
    this.records.set(key, value);
    try {
      this.save();
    } catch (error) {
      if (previous) this.records.set(key, previous);
      else this.records.delete(key);
      throw error;
    }
    return value;
  }

  public complete(
    key: string,
    messageId: string,
    delivery: Omit<NonNullable<UncertainReceipt["completed"]>, "at">,
  ): void {
    const previous = this.records.get(key);
    if (this.unreadable || previous?.messageId !== messageId || previous.completed || previous.settlement)
      throw new Error("Missing original delivery receipt");
    this.records.set(key, { ...previous, completed: { at: Date.now(), ...delivery } });
    try {
      this.save();
    } catch (error) {
      this.records.set(key, previous);
      throw error;
    }
  }

  public update(key: string, messageId: string, fields: Partial<Omit<UncertainReceipt, "messageId">>): void {
    const previous = this.records.get(key);
    if (
      this.unreadable ||
      previous?.messageId !== messageId ||
      previous.settlement ||
      (previous.remoteLaunchCommitted &&
        Object.hasOwn(fields, "remoteLaunchCommitted") &&
        fields.remoteLaunchCommitted !== true)
    )
      throw new Error("Missing original delivery receipt");
    this.records.set(key, { ...previous, ...fields });
    try {
      this.save();
    } catch (error) {
      this.records.set(key, previous);
      throw error;
    }
  }

  /** Retain the original identity, key and authenticated evidence permanently. Never dispatch. */
  public settleNotLaunched(key: string, messageId: string, evidence: HireNoLaunchEvidence): void {
    const previous = this.records.get(key);
    const proof = HireNoLaunchEvidenceSchema.parse(evidence);
    if (
      this.unreadable ||
      previous?.messageId !== messageId ||
      !previous.remoteAdmission ||
      previous.remoteLaunchCommitted ||
      previous.paneId ||
      previous.sessionId ||
      previous.occupantId ||
      previous.completed ||
      previous.settlement ||
      proof.receiptId !== messageId ||
      proof.receiptKey !== key ||
      proof.fingerprint !== previous.fingerprint ||
      JSON.stringify(proof.target) !== JSON.stringify(previous.remoteAdmission.target) ||
      proof.window.sealedAt < proof.window.openedAt ||
      proof.census.observedAt < proof.window.openedAt ||
      proof.census.observedAt > proof.window.sealedAt
    )
      throw new Error("Original hire has no complete authenticated no-launch window");
    this.records.set(key, { ...previous, settlement: proof });
    try {
      this.save();
    } catch (error) {
      this.records.set(key, previous);
      throw error;
    }
  }

  /** Only the mechanism calls this after matching an acknowledgment or proving no dispatch. */
  public reconcile(key: string, messageId: string): boolean {
    if (
      this.unreadable ||
      this.records.get(key)?.messageId !== messageId ||
      this.records.get(key)?.settlement
    )
      return false;
    const previous = this.records.get(key)!;
    this.records.delete(key);
    try {
      this.save();
    } catch (error) {
      this.records.set(key, previous);
      throw error;
    }
    return true;
  }

  /** Seal proven inbound absence and release its exact pane in one durable write. */
  public sealInboundAbsence(
    paneId: string,
    receipt: { messageId: string; paneId: string; sessionId: string; fingerprint: string },
  ): boolean {
    if (this.unreadable || receipt.paneId !== paneId) return false;
    const idKey = `id:${receipt.messageId}`;
    const pane = this.records.get(paneId);
    const id = this.records.get(idKey);
    const matches = (value: UncertainReceipt) =>
      !value.completed &&
      value.messageId === receipt.messageId &&
      value.paneId === receipt.paneId &&
      value.sessionId === receipt.sessionId &&
      value.fingerprint === receipt.fingerprint;
    // An ID without its pending pane can be lost acceptance proof, not absence.
    if ((pane && !matches(pane)) || (id && (!pane || !matches(id)))) return false;
    this.records.set(idKey, { ...receipt, notSent: true });
    this.records.delete(paneId);
    try {
      this.save();
    } catch (error) {
      if (id) this.records.set(idKey, id);
      else this.records.delete(idKey);
      if (pane) this.records.set(paneId, pane);
      throw error;
    }
    return true;
  }

  private save(): void {
    if (this.path === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(Object.fromEntries(this.records))}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.path);
    if (process.platform !== "win32") {
      const parent = openSync(dirname(this.path), "r");
      try {
        fsyncSync(parent);
      } finally {
        closeSync(parent);
      }
    }
  }
}

export function deliveryFingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/gu, "\n").trim()).digest("hex");
}
