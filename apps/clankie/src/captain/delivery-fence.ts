import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  DeliveryStageSchema,
  HireNoLaunchEvidenceSchema,
  HireRecoveryEvidenceSchema,
  LocalHireSettlementEvidenceSchema,
  RetainedHireEvidenceSchema,
  SeatDeliveryAbandonmentSchema,
  SpawnOperatorSeatSchema,
  type HireRecoveryEvidence,
  type LocalHireSettlementEvidence,
  type RetainedHireEvidence,
  type HireNoLaunchEvidence,
} from "@clankie/protocol";
import { ConversationOwnerSchema, type ConversationOwner } from "./conversation-owner.ts";

const FreshHireReceiptSchema = SpawnOperatorSeatSchema.shape.freshIntent
  .unwrap()
  .extend({
    baseKey: z.string().min(1),
    owner: ConversationOwnerSchema,
    launch: SpawnOperatorSeatSchema.omit({ freshIntent: true }),
  })
  .strict();

export const ReceiptSchema = z
  .object({
    messageId: z.string().min(1),
    fingerprint: z.string(),
    /** Explicit fresh admission keeps its UUID, original location and host-authored owner forever. */
    freshHire: FreshHireReceiptSchema.optional(),
    /** Original location of a completed ordinary hire archived outside its reusable recipient key. */
    hireBaseKey: z.string().optional(),
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
    /** Native hire may exist; its first brief provably never crossed the turn RPC. Retain launch guard. */
    briefNotSent: z.literal(true).optional(),
    /** Operator recovery permanently excludes ordinary launch/adoption/reconciliation. */
    recoveryRequested: z.literal(true).optional(),
    settlement: RetainedHireEvidenceSchema.optional(),
    /** Complete native inventory proved a completed hire's original pane absent. No launch history erased. */
    retired: z
      .object({ at: z.number().int().nonnegative(), censusSha256: z.string().regex(/^[a-f0-9]{64}$/u) })
      .strict()
      .optional(),
    /** When a seat mailbox began this delivery; absent before VUH-1779. */
    beganAt: z.number().int().nonnegative().optional(),
    /** Owner settled a seat delivery without receipt (VUH-1779). Never resent, never claimed. */
    abandoned: SeatDeliveryAbandonmentSchema.optional(),
    sessionId: z.string().optional(),
    /** Original native occupant observed by the host, never inferred from pane/name. */
    occupantId: z.string().optional(),
    /**
     * This receipt is the one rediscovery of an operator message whose first
     * send was not confirmed (ADR 0312). A later send of the same text is not
     * dispatched again until the receipt is settled.
     */
    rediscovered: z.literal(true).optional(),
    paneId: z.string().optional(),
    agentName: z.string().optional(),
    /** Exact native channel event returned to the caller, distinct from the control fence key. */
    nativeDeliveryId: z.string().min(1).max(256).optional(),
    conversationId: z.string().min(1).max(256).optional(),
    recipientBinding: z.string().optional(),
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
    return receipt?.completed || receipt?.settlement || receipt?.abandoned ? undefined : receipt;
  }

  public settled(key: string): UncertainReceipt | undefined {
    const receipt = this.records.get(key);
    return !this.unreadable && receipt?.settlement ? receipt : undefined;
  }

  public settlement(messageId: string): RetainedHireEvidence | undefined {
    return this.unreadable
      ? undefined
      : [...this.records.values()].find((receipt) => receipt.messageId === messageId)?.settlement;
  }

  public all(): readonly (readonly [string, UncertainReceipt])[] {
    if (this.unreadable) throw new Error("Original receipt journal is unreadable");
    return [...this.records.entries()];
  }

  /**
   * The fresh intent new work at this location needs: after its latest retained
   * receipt, once that location was settled or holds fresh history (#100).
   * Undefined when an ordinary hire still fits. Admission still decides.
   */
  public nextFreshIntent(baseKey: string): { id: string; afterReceiptId: string } | undefined {
    const siblings = this.all().filter(
      ([key, receipt]) => (receipt.freshHire?.baseKey ?? receipt.hireBaseKey ?? key) === baseKey,
    );
    if (!this.settled(baseKey) && !siblings.some(([, receipt]) => receipt.freshHire)) return undefined;
    const latest = siblings.at(-1)?.[1];
    return latest === undefined ? undefined : { id: randomUUID(), afterReceiptId: latest.messageId };
  }

  /** Read-only validation; repeat synchronously immediately before begin, after any awaits. */
  public freshHireAdmission(
    baseKey: string,
    input: z.infer<typeof SpawnOperatorSeatSchema>,
    owner: ConversationOwner,
    fingerprint: string,
  ) {
    const { freshIntent, ...launch } = input;
    const entries = this.all();
    const key =
      freshIntent && JSON.stringify([...(JSON.parse(baseKey) as string[]), "fresh", freshIntent.id]);
    const siblings = entries.filter(
      ([id, record]) => id !== key && (record.freshHire?.baseKey ?? record.hireBaseKey ?? id) === baseKey,
    );
    const expected = siblings.at(-1)?.[1];
    // Every refusal names the latest retained receipt at this location (VUH-2180).
    const refuse = (reason: string) =>
      new Error(
        `${reason}; expected ${expected?.messageId ?? "no retained receipt"}${expected?.freshHire ? ` (fresh intent ${expected.freshHire.id})` : ""}`,
      );
    if (!freshIntent || !key || !input.fleet || input.resume)
      throw refuse("freshIntent requires a new remote hire, never a saved-session resume");
    // Canonical persisted shape: optional undefined properties cannot become aliases on restart.
    const metadata = FreshHireReceiptSchema.parse(
      JSON.parse(JSON.stringify({ ...freshIntent, baseKey, owner, launch })),
    );
    if (entries.some(([, record]) => record.messageId === metadata.id))
      throw refuse("Fresh intent UUID already names a native receipt");
    const originals = entries.filter(
      ([, record]) =>
        record.messageId === metadata.afterReceiptId || record.freshHire?.id === metadata.afterReceiptId,
    );
    if (siblings.some(([, record]) => !record.settlement && !record.completed))
      throw refuse("Another original hire at this location is unresolved; no fresh dispatch may begin");
    const original = originals[0];
    const settled = original?.[1].settlement;
    const target =
      (settled && "target" in settled ? settled.target : undefined) ?? original?.[1].remoteAdmission?.target;
    if (
      originals.length !== 1 ||
      !original ||
      original[1] !== expected ||
      !(original[1].settlement || (original[1].completed && original[1].retired)) ||
      !target ||
      (original[1].freshHire?.baseKey ?? original[1].hireBaseKey ?? original[0]) !== baseKey
    )
      throw refuse(
        "freshIntent requires the exact settled native hire receipt at this location. Completed hires require complete pane-absent inventory",
      );
    const known = entries.filter(([, record]) => record.freshHire?.id === metadata.id);
    const identity = (value: z.infer<typeof FreshHireReceiptSchema>) => {
      const { discord, ...route } = value.owner;
      if (!discord) return { ...value, owner: route };
      const { messageId: _message, deliveryId: _delivery, ...origin } = discord;
      return { ...value, owner: { ...route, discord: origin } };
    };
    if (
      known.length > 1 ||
      (known[0] &&
        (known[0][0] !== key ||
          known[0][1].fingerprint !== fingerprint ||
          !isDeepStrictEqual(identity(known[0][1].freshHire!), identity(metadata))))
    )
      throw refuse("Fresh intent UUID already names a different owner, launch or brief");
    if (siblings.some(([, record]) => record.fingerprint === fingerprint))
      throw refuse("A fresh intent cannot replay any retained original brief at this location");
    return { key, metadata, target };
  }

  /** A complete successful inventory may retire only already completed exact remote hires. */
  public retireCompleted(
    target: HireNoLaunchEvidence["target"],
    panes: ReadonlySet<string>,
    active: ReadonlySet<string>,
  ): void {
    const previous = new Map(this.records);
    const censusSha256 = createHash("sha256")
      .update(JSON.stringify([...panes].sort()))
      .digest("hex");
    let changed = false;
    for (const [key, receipt] of this.all()) {
      if (
        receipt.completed &&
        !receipt.retired &&
        isDeepStrictEqual(receipt.remoteAdmission?.target, target) &&
        receipt.paneId &&
        !panes.has(receipt.paneId) &&
        !active.has(key)
      ) {
        this.records.set(key, { ...receipt, retired: { at: Date.now(), censusSha256 } });
        changed = true;
      }
    }
    if (!changed) return;
    try {
      this.save();
    } catch (error) {
      this.records.clear();
      for (const [key, receipt] of previous) this.records.set(key, receipt);
      throw error;
    }
  }

  public settleRecovery(key: string, messageId: string, evidence: HireRecoveryEvidence): void {
    const previous = this.records.get(key);
    const proof = HireRecoveryEvidenceSchema.parse(evidence);
    const channel = proof.disposition === "delivered" && proof.delivery?.receiptId === messageId;
    const unknown = proof.disposition === "abandoned-unknown";
    if (
      this.unreadable ||
      previous?.messageId !== messageId ||
      previous.settlement ||
      previous.abandoned ||
      proof.fingerprint !== previous.fingerprint ||
      (unknown &&
        (!previous.remoteAdmission ||
          ("outcome" in proof.allocation &&
            (proof.allocation.launchHistory === "launching") !== !!previous.remoteLaunchCommitted) ||
          !previous.recoveryRequested ||
          previous.paneId ||
          previous.sessionId ||
          previous.occupantId ||
          previous.completed ||
          !isDeepStrictEqual(proof.target, previous.remoteAdmission.target))) ||
      (!channel && (proof.receiptId !== messageId || proof.receiptKey !== key))
    )
      throw new Error("Recovery does not match the retained original receipt");
    this.records.set(key, { ...previous, settlement: proof });
    try {
      this.save();
    } catch (error) {
      this.records.set(key, previous);
      throw error;
    }
  }

  public completed(key: string): UncertainReceipt | undefined {
    const receipt = this.records.get(key);
    return !this.unreadable &&
      receipt?.completed &&
      (receipt.freshHire !== undefined ||
        receipt.remoteAdmission !== undefined ||
        receipt.completed.at > Date.now() - COMPLETED_RETENTION_MS)
      ? receipt
      : undefined;
  }

  public entries(): readonly (readonly [string, UncertainReceipt])[] {
    return this.unreadable
      ? [["unreadable-receipts", { messageId: "unreadable-receipts", fingerprint: "" }]]
      : [...this.records.entries()].filter(
          ([, receipt]) => !receipt.completed && !receipt.settlement && !receipt.abandoned,
        );
  }

  /** Free an ordinary recipient key while retaining the abandoned original forever. */
  public archiveAbandoned(key: string, messageId: string): void {
    const original = this.records.get(key);
    if (this.unreadable || !original?.abandoned || original.messageId !== messageId)
      throw new Error("Only a retained abandoned original can free its recipient key");
    const archive = `abandoned:${messageId}`;
    if (this.records.has(archive)) throw new Error("Abandoned original archive already exists");
    this.records.set(archive, original);
    this.records.delete(key);
    try {
      this.save();
    } catch (error) {
      this.records.set(key, original);
      this.records.delete(archive);
      throw error;
    }
  }

  /** Persist before crossing the uncertain boundary. A persistence failure sends nothing. */
  public begin(
    key: string,
    receipt: Omit<UncertainReceipt, "messageId"> & { messageId?: string },
  ): UncertainReceipt {
    if (this.pending(key) || this.completed(key) || this.settled(key) || this.records.get(key)?.abandoned)
      throw new Error("Delivery is uncertain; reconcile its original receipt before any retry");
    const baseKey = receipt.freshHire?.baseKey ?? key;
    if (
      this.all().some(
        ([id, record]) =>
          id !== key &&
          (record.freshHire?.baseKey ?? record.hireBaseKey ?? id) === baseKey &&
          !record.completed &&
          !record.settlement &&
          !record.abandoned,
      )
    )
      throw new Error("Another hire at this location remains uncertain; no dispatch may begin");
    if (!receipt.freshHire && this.all().some(([, record]) => record.freshHire?.baseKey === baseKey))
      throw new Error("This location retains fresh hire history; use a distinct freshIntent and new brief");
    for (const [id, value] of this.records)
      if (
        !value.freshHire &&
        !value.remoteAdmission &&
        !value.settlement &&
        !value.abandoned &&
        value.completed &&
        value.completed.at <= Date.now() - COMPLETED_RETENTION_MS
      )
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
    if (
      this.unreadable ||
      previous?.messageId !== messageId ||
      previous.completed ||
      previous.settlement ||
      previous.abandoned ||
      previous.recoveryRequested
    )
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
      previous.abandoned ||
      (previous.freshHire &&
        ((Object.hasOwn(fields, "freshHire") && !isDeepStrictEqual(fields.freshHire, previous.freshHire)) ||
          (Object.hasOwn(fields, "fingerprint") && fields.fingerprint !== previous.fingerprint))) ||
      (previous.recoveryRequested &&
        Object.hasOwn(fields, "recoveryRequested") &&
        fields.recoveryRequested !== true) ||
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
      previous.recoveryRequested ||
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

  /**
   * Settle a local hire from host inventory and free its location in one durable
   * write (VUH-2243). The original keeps its identity, brief fingerprint and
   * evidence under an archive key; nothing here claims launch or delivery.
   */
  public settleLocal(key: string, messageId: string, evidence: LocalHireSettlementEvidence): void {
    const previous = this.records.get(key);
    const proof = LocalHireSettlementEvidenceSchema.parse(evidence);
    const archive = `local-settled:${messageId}`;
    if (
      this.unreadable ||
      previous?.messageId !== messageId ||
      JSON.parse(key)[0] !== "local" ||
      previous.freshHire ||
      previous.remoteAdmission ||
      previous.recoveryRequested ||
      previous.completed ||
      previous.settlement ||
      previous.abandoned ||
      proof.receiptId !== messageId ||
      proof.receiptKey !== key ||
      proof.fingerprint !== previous.fingerprint ||
      proof.pane?.paneId !== previous.paneId ||
      (proof.pane !== undefined &&
        "occupantId" in proof.pane &&
        ((previous.occupantId !== undefined && previous.occupantId !== proof.pane.occupantId) ||
          (previous.sessionId !== undefined && previous.sessionId !== proof.pane.sessionId))) ||
      this.records.has(archive)
    )
      throw new Error("Local settlement does not match the retained original receipt");
    this.records.set(archive, { ...previous, hireBaseKey: key, settlement: proof });
    this.records.delete(key);
    try {
      this.save();
    } catch (error) {
      this.records.delete(archive);
      this.records.set(key, previous);
      throw error;
    }
  }

  /**
   * Owner settlement of an unresolved seat delivery (VUH-1779). The original
   * stays retained under its key and identity, so it can never be begun,
   * reconciled or resent; nothing here claims it was received.
   */
  public abandonUnknown(key: string, messageId: string, abandonedAt: number) {
    const previous = this.records.get(key);
    if (
      this.unreadable ||
      previous?.messageId !== messageId ||
      previous.completed ||
      previous.settlement ||
      previous.abandoned ||
      previous.freshHire ||
      previous.remoteAdmission
    )
      throw new Error("Only an unresolved seat delivery can be settled as abandoned-unknown");
    const evidence = SeatDeliveryAbandonmentSchema.parse({
      disposition: "abandoned-unknown",
      journal: "owner-settled-unknown",
      receiptId: messageId,
      fingerprint: previous.fingerprint,
      ...(previous.beganAt === undefined ? {} : { beganAt: previous.beganAt }),
      abandonedAt,
    });
    this.records.set(key, { ...previous, abandoned: evidence });
    try {
      this.save();
    } catch (error) {
      this.records.set(key, previous);
      throw error;
    }
    return evidence;
  }

  /** Only the mechanism calls this after matching an acknowledgment or proving no dispatch. */
  public reconcile(key: string, messageId: string, retainNativeHire = false): boolean {
    if (
      this.unreadable ||
      this.records.get(key)?.messageId !== messageId ||
      this.records.get(key)?.settlement ||
      this.records.get(key)?.abandoned ||
      this.records.get(key)?.recoveryRequested
    )
      return false;
    const previous = this.records.get(key)!;
    const archiveKey =
      retainNativeHire && previous.remoteAdmission && !previous.freshHire
        ? `completed-hire:${messageId}`
        : key;
    if (archiveKey !== key && this.records.has(archiveKey)) return false;
    if (previous.freshHire || (retainNativeHire && previous.remoteAdmission)) {
      this.records.set(archiveKey, {
        ...previous,
        completed: previous.completed ?? { at: Date.now() },
        ...(archiveKey === key ? {} : { hireBaseKey: key }),
      });
      if (archiveKey !== key) this.records.delete(key);
    } else this.records.delete(key);
    try {
      this.save();
    } catch (error) {
      if (archiveKey !== key) this.records.delete(archiveKey);
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
