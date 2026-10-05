import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { DeliveryStageSchema } from "@clankie/protocol";

export const ReceiptSchema = z
  .object({
    messageId: z.string().min(1),
    fingerprint: z.string(),
    sessionId: z.string().optional(),
    /** Original native occupant observed by the host, never inferred from pane/name. */
    occupantId: z.string().optional(),
    paneId: z.string().optional(),
    agentName: z.string().optional(),
    beforeIds: z.array(z.string()).optional(),
    seatId: z.string().optional(),
    /** A terminal inbound lookup refusal; this original ID may never dispatch. */
    notSent: z.literal(true).optional(),
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
    return receipt?.completed ? undefined : receipt;
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
      : [...this.records.entries()].filter(([, receipt]) => !receipt.completed);
  }

  /** Persist before crossing the uncertain boundary. A persistence failure sends nothing. */
  public begin(
    key: string,
    receipt: Omit<UncertainReceipt, "messageId"> & { messageId?: string },
  ): UncertainReceipt {
    if (this.pending(key) || this.completed(key))
      throw new Error("Delivery is uncertain; reconcile its original receipt before any retry");
    for (const [id, value] of this.records)
      if (value.completed && value.completed.at <= Date.now() - COMPLETED_RETENTION_MS)
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
    if (this.unreadable || previous?.messageId !== messageId || previous.completed)
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
    if (this.unreadable || previous?.messageId !== messageId)
      throw new Error("Missing original delivery receipt");
    this.records.set(key, { ...previous, ...fields });
    this.save();
  }

  /** Only the mechanism calls this after matching an acknowledgment or proving no dispatch. */
  public reconcile(key: string, messageId: string): boolean {
    if (this.unreadable || this.records.get(key)?.messageId !== messageId) return false;
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

  private save(): void {
    if (this.path === undefined) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(Object.fromEntries(this.records))}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export function deliveryFingerprint(text: string): string {
  return createHash("sha256").update(text.replace(/\r\n?/gu, "\n").trim()).digest("hex");
}
