import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  computerPoint,
  ComputerCommandSchema,
  ComputerFrameSchema,
  ComputerInventorySchema,
  ComputerLeaseSchema,
  ComputerReceiptSchema,
  ComputerScreenshotSchema,
  COMPUTER_FRAME_QUEUE_MAX,
  type ComputerCommand,
  type ComputerCoordinates,
  type ComputerInput,
  type ComputerInventory,
  type ComputerLease,
  type ComputerReceipt,
  type ComputerScreenshot,
  type ComputerTarget,
} from "@clankie/interactive-environment";
import { BodyLeaseStore } from "./body-leases.ts";
import type { BodyConversationIdentity } from "./body-lease-router.ts";

export interface ComputerObservation {
  readonly target: ComputerTarget;
  readonly png: Buffer;
  readonly coordinates: ComputerCoordinates;
  readonly inputReady: boolean;
  readonly elements: ComputerScreenshot["elements"];
  readonly accessibility?: ComputerScreenshot["accessibility"];
  /** Provider-owned snapshot/reference stays inside the body host. */
  readonly reference: unknown;
}
export interface ComputerAdapter {
  readonly bodyId: string;
  readonly allowInput?: boolean;
  readonly inputReady?: boolean;
  inventory(
    guard: () => Promise<void>,
  ): Promise<Omit<ComputerInventory, "schemaVersion" | "bodyId" | "observedAt">>;
  capture(
    target: ComputerTarget,
    mode: "normal" | "classic_read_only",
    guard: () => Promise<void>,
  ): Promise<ComputerObservation>;
  input(
    input: ComputerInput,
    observation: ComputerObservation,
    screenshot: ComputerScreenshot,
    guard: () => Promise<void>,
  ): Promise<{ outcome: ComputerReceipt["outcome"]; detail: string }>;
  /** True only after the host proves no queued/running input remains. Never a caller assertion. */
  stop(guard: () => Promise<void>): Promise<boolean>;
}
const RecordSchema = z.strictObject({ fingerprint: z.string(), receipt: ComputerReceiptSchema.optional() });
const JournalSchema = z.strictObject({
  bodyId: z.string(),
  leaseId: z.string(),
  allowInput: z.boolean().optional(),
  requests: z.record(z.string(), RecordSchema),
});
const RecoveryAuditSchema = z.strictObject({
  schemaVersion: z.literal(1),
  auditId: z.uuid(),
  at: z.string().datetime(),
  bodyId: z.union([z.literal("macos:console"), z.string().regex(/^lent:[0-9a-f-]{36}$/u)]),
  decision: z.literal("owner_override_authorized"),
  operatorId: z.string().min(1),
  requestedFrom: z.string().min(1),
  originalHolder: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  incarnationSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  reason: z.string().trim().min(1).max(2000),
});
type Ref = NonNullable<ReturnType<BodyLeaseStore["recoveryReference"]>>;

/**
 * Host-created, never from a command or native tool identity: the authenticated operator request
 * for the local Mac, or the lent host's own parent-owned control channel for a lent screen.
 */
export interface OwnerComputerRecovery {
  readonly operatorId: string;
  readonly authorize: () => Promise<boolean>;
  readonly holderIdle: (conversationId: string) => boolean;
}
const recoveryRefusal = (reason: string, detail: string, next: string) => ({
  outcome: "rejected" as const,
  reason,
  detail,
  next,
});

/** One service-owned adapter per real desktop. No model, worker or provider routing lives here. */
export class ComputerBody {
  private readonly adapter: ComputerAdapter;
  private readonly store: BodyLeaseStore;
  private readonly requireScreen: (() => Promise<void>) | undefined;
  private readonly journalPath: string;
  private readonly recoveryAuditPath: string;
  private journal: z.infer<typeof JournalSchema>;
  private active = false;
  private unavailable = false;
  private sequence = 0;
  private lease: ComputerLease | undefined;
  private readonly frames = new Map<
    string,
    { screenshot: ComputerScreenshot; observation: ComputerObservation }
  >();

  constructor(
    adapter: ComputerAdapter,
    store: BodyLeaseStore,
    directory: string,
    requireScreen?: () => Promise<void>,
  ) {
    this.adapter = adapter;
    this.store = store;
    this.requireScreen = requireScreen;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.journalPath = join(directory, "computer-inputs.json");
    this.recoveryAuditPath = join(directory, "computer-recoveries.jsonl");
    this.journal = { bodyId: adapter.bodyId, leaseId: "", requests: {} };
    try {
      if (existsSync(this.journalPath))
        this.journal = JournalSchema.parse(JSON.parse(readFileSync(this.journalPath, "utf8")));
      if (this.journal.bodyId !== adapter.bodyId) throw new Error("Computer body identity changed");
    } catch {
      this.unavailable = true;
    }
  }

  private save(): void {
    const path = `${this.journalPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(path, JSON.stringify(this.journal), { mode: 0o600, flag: "wx", flush: true });
      renameSync(path, this.journalPath);
    } catch (error) {
      this.unavailable = true;
      throw error;
    }
  }

  private async authorized(identity: BodyConversationIdentity): Promise<void> {
    if (
      this.unavailable ||
      identity.route?.mode !== "machine" ||
      !identity.current() ||
      !(await identity.authorize("computer", "effect")) ||
      !identity.current()
    )
      throw new Error("Computer authority or storage unavailable");
  }

  private reference(identity: BodyConversationIdentity, leaseId: string): Ref {
    const ref = this.store.recoveryReference("computer");
    if (
      this.journal.leaseId !== leaseId ||
      ref?.token !== leaseId ||
      ref.conversationId !== identity.conversationId
    )
      throw new Error("Stale computer lease");
    return ref;
  }

  async dispatch(
    identity: BodyConversationIdentity,
    raw: unknown,
    ownerRecovery?: OwnerComputerRecovery,
  ): Promise<unknown> {
    const command = ComputerCommandSchema.parse(raw);
    await this.authorized(identity);
    if (!["status", "release", "revoke", "recover"].includes(command.action)) await this.requireScreen?.();
    if (command.action === "status") {
      const lease = this.store.status("computer");
      return {
        bodyId: this.adapter.bodyId,
        lease:
          lease === undefined
            ? null
            : {
                ...lease,
                ...(this.adapter.allowInput === undefined
                  ? {}
                  : { allowInput: this.journal.allowInput === true }),
              },
        busy: this.active,
        ...(this.adapter.allowInput === undefined
          ? {}
          : { allowInput: this.adapter.allowInput, inputReady: this.adapter.inputReady === true }),
      };
    }
    if (command.action === "revoke") {
      const ref = this.reference(identity, command.leaseId);
      const begun = this.store.beginRecovery(ref);
      if (begun.outcome !== "admitted") return begun;
      const finished = this.store.finish(ref, begun.operationId, "settled");
      this.frames.clear();
      return finished.outcome === "finished" ? { outcome: "revoked" } : finished;
    }
    if (this.active) {
      if (command.action === "recover")
        return recoveryRefusal(
          "operation_in_progress",
          "A computer operation is still running.",
          "Wait for the operation to settle; inspect status before recovering.",
        );
      throw new Error("Computer operation in progress");
    }
    if (command.action === "acquire") {
      const result = this.store.acquire("computer", identity.conversationId, command.ttlMs, identity.route);
      if (result.outcome !== "acquired") return result;
      const now = new Date().toISOString();
      this.lease = ComputerLeaseSchema.parse({
        bodyId: this.adapter.bodyId,
        conversationId: identity.conversationId,
        leaseId: result.lease.token,
        ...(this.adapter.allowInput === undefined ? {} : { allowInput: this.adapter.allowInput }),
        issuedAt: now,
        heartbeatAt: now,
        expiresAt: new Date(result.expiresAt).toISOString(),
      });
      this.journal = {
        bodyId: this.adapter.bodyId,
        leaseId: result.lease.token,
        requests: {},
        ...(this.adapter.allowInput === undefined ? {} : { allowInput: this.adapter.allowInput }),
      };
      this.frames.clear();
      this.save();
      return { outcome: "acquired", lease: structuredClone(this.lease) };
    }
    if (command.action === "recover") {
      if (command.ownerRecovery) return this.recoverByOwner(identity, command.ownerRecovery, ownerRecovery);
      this.active = true;
      try {
        const held = this.store.recoveryReference("computer");
        if (held === undefined) return { outcome: "released" };
        if (!(await identity.authorize("computer", "recover")) || !identity.current())
          throw new Error("Recovery not authorized");
        const begun = this.store.beginRecovery(held);
        if (begun.outcome !== "admitted") return begun;
        const guard = async () => {
          await this.authorized(identity);
          if (!(await identity.authorize("computer", "recover")) || !identity.current())
            throw new Error("Recovery not authorized");
          const current = this.store.recoveryReference("computer");
          if (current?.token !== held.token || current.conversationId !== held.conversationId)
            throw new Error("Recovery lease changed");
        };
        try {
          await guard();
          if (!(await this.adapter.stop(guard)))
            return this.adapter.bodyId === "macos:console"
              ? recoveryRefusal(
                  "recovery_required",
                  "The computer host cannot prove that queued or running native input has stopped.",
                  "Read status. After confirming the old driver has stopped, use recover with ownerRecovery.reason, expectedHolder and expectedExpiresAt under operator authority.",
                )
              : this.adapter.bodyId.startsWith("lent:")
                ? recoveryRefusal(
                    "recovery_required",
                    "The lent host cannot prove that queued or running native input has stopped.",
                    "The owner at that machine can take over, then release the expired lease with screen_recover through its clankie join control.",
                  )
                : { outcome: "rejected", reason: "recovery_required" };
          await guard();
          const finished = this.store.finish(held, begun.operationId, "settled");
          if (finished.outcome !== "finished") return finished;
          this.frames.clear();
          this.lease = undefined;
          return this.store.reconcileStopped(held);
        } finally {
          this.store.finish(held, begun.operationId, "uncertain");
        }
      } finally {
        this.active = false;
      }
    }
    const ref = this.reference(identity, command.leaseId);
    if (command.action === "renew") {
      const result = this.store.renew(ref, command.ttlMs);
      if (result.outcome === "renewed" && this.lease !== undefined)
        this.lease = ComputerLeaseSchema.parse({
          ...this.lease,
          heartbeatAt: new Date().toISOString(),
          expiresAt: new Date(result.expiresAt).toISOString(),
        });
      return result.outcome === "renewed" ? { outcome: "renewed", lease: this.lease } : result;
    }
    if (command.action === "release") {
      const result = this.store.release(ref);
      if (result.outcome === "released") {
        this.frames.clear();
        this.lease = undefined;
      }
      return result;
    }
    if (command.action === "input") {
      const old = this.journal.requests[command.requestId];
      const fingerprint = createHash("sha256").update(JSON.stringify(command)).digest("hex");
      if (old !== undefined) {
        if (old.fingerprint !== fingerprint) throw new Error("Request ID reused with different input");
        return (
          old.receipt ?? { outcome: "uncertain", reason: "Original input receipt unavailable; never replay" }
        );
      }
    }
    const begun = this.store.begin(ref);
    if (begun.outcome !== "admitted") return begun;
    this.active = true;
    let uncertain = false;
    const guard = async () => {
      await this.authorized(identity);
      await this.requireScreen?.();
      if (this.store.validate(ref, begun.operationId).outcome !== "valid")
        throw new Error("Computer lease expired or revoked");
    };
    try {
      await guard();
      if (command.action === "inventory") {
        const inventory = await this.adapter.inventory(guard);
        await guard();
        return ComputerInventorySchema.parse({
          ...inventory,
          bodyId: this.adapter.bodyId,
          observedAt: new Date().toISOString(),
        });
      }
      if (command.action === "capture") {
        const capturedAt = Date.now();
        const sequence = this.sequence++; // A failed new capture cannot leave an old action token current.
        const captured = await this.adapter.capture(command.target, command.capture, guard);
        const observation = { ...captured, png: Buffer.from(captured.png) };
        await guard();
        const png = observation.png;
        if (
          png.length < 24 ||
          !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
          png.toString("ascii", 12, 16) !== "IHDR"
        )
          throw new Error("Provider did not return a PNG");
        if (
          observation.target.appId !== command.target.appId ||
          observation.target.windowId !== command.target.windowId
        )
          throw new Error("Capture target drift");
        if (Date.now() - capturedAt >= 30000) throw new Error("Capture exceeded its freshness budget");
        const screenshot = ComputerScreenshotSchema.parse({
          screenshotId: randomUUID(),
          bodyId: this.adapter.bodyId,
          conversationId: identity.conversationId,
          leaseId: ref.token,
          sequence,
          capturedAt: new Date(capturedAt).toISOString(),
          expiresAt: new Date(capturedAt + 30000).toISOString(),
          target: observation.target,
          width: png.readUInt32BE(16),
          height: png.readUInt32BE(20),
          coordinates: observation.coordinates,
          inputReady: observation.inputReady && command.capture !== "classic_read_only",
          ...(observation.accessibility === undefined ? {} : { accessibility: observation.accessibility }),
          elements: observation.elements,
          sha256: createHash("sha256").update(png).digest("hex"),
        });
        ComputerFrameSchema.parse({
          screenshotId: screenshot.screenshotId,
          encoding: "png",
          data: png.toString("base64"),
          byteLength: png.length,
          sha256: screenshot.sha256,
        });
        this.frames.set(screenshot.screenshotId, { screenshot, observation });
        while (this.frames.size > COMPUTER_FRAME_QUEUE_MAX)
          this.frames.delete(this.frames.keys().next().value!);
        return structuredClone(screenshot);
      }
      const frame = this.frames.get(command.screenshotId);
      if (
        frame === undefined ||
        frame.screenshot.leaseId !== ref.token ||
        Date.parse(frame.screenshot.expiresAt) <= Date.now()
      )
        throw new Error("Screenshot missing or stale");
      if (command.action === "frame")
        return ComputerFrameSchema.parse({
          screenshotId: command.screenshotId,
          encoding: "png",
          data: frame.observation.png.toString("base64"),
          byteLength: frame.observation.png.length,
          sha256: frame.screenshot.sha256,
        });
      if (!frame.screenshot.inputReady || frame.screenshot.sequence !== this.sequence - 1)
        throw new Error("Screenshot is not the latest action-ready capture");
      if (
        this.adapter.allowInput !== undefined &&
        (!this.adapter.allowInput || this.journal.allowInput !== true)
      )
        throw new Error("Computer lease is observation-only; input requires explicit owner opt-in");
      if (Object.keys(this.journal.requests).length >= 256)
        throw new Error("Lease input budget exhausted; release and acquire a new lease");
      this.journal.requests[command.requestId] = {
        fingerprint: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
      };
      this.save(); // Pending survives transport loss and restart before any effect.
      const inputs: ComputerReceipt["inputs"] = [];
      for (const [index, input] of command.inputs.entries()) {
        try {
          await guard();
        } catch {
          inputs.push({ index, outcome: "failed", detail: "Authority or lease changed before input" });
          break;
        }
        try {
          if (input.kind === "click") computerPoint(frame.screenshot, input.at);
          if (input.kind === "scroll" && input.at !== undefined) computerPoint(frame.screenshot, input.at);
          if (input.kind === "drag") {
            computerPoint(frame.screenshot, input.from);
            computerPoint(frame.screenshot, input.to);
          }
          if (
            input.kind === "element" &&
            !frame.screenshot.elements.some((element) => element.id === input.elementId && element.actionable)
          )
            throw new Error("Element absent from capture");
        } catch {
          inputs.push({ index, outcome: "failed", detail: "Input target absent or outside this screenshot" });
          break;
        }
        try {
          const result = await this.adapter.input(input, frame.observation, frame.screenshot, guard);
          inputs.push({ index, ...result });
        } catch {
          inputs.push({
            index,
            outcome: "uncertain",
            detail: "Input transport failed; observe before recovery, never replay",
          });
        }
        if (inputs.at(-1)?.outcome !== "confirmed") break;
      }
      uncertain = inputs.some((input) => input.outcome === "uncertain");
      const receipt = ComputerReceiptSchema.parse({
        requestId: command.requestId,
        bodyId: this.adapter.bodyId,
        conversationId: identity.conversationId,
        leaseId: ref.token,
        screenshotId: command.screenshotId,
        completedAt: new Date().toISOString(),
        outcome: uncertain
          ? "uncertain"
          : inputs.length !== command.inputs.length || inputs.some((i) => i.outcome === "failed")
            ? "failed"
            : "confirmed",
        inputs,
      });
      // Even refused inputs require another capture; the old frame is never an action token again.
      this.frames.clear();
      this.journal.requests[command.requestId]!.receipt = receipt;
      this.save();
      return receipt;
    } catch (error) {
      if (command.action === "input" && this.journal.requests[command.requestId] !== undefined)
        uncertain = true;
      throw error;
    } finally {
      this.store.finish(ref, begun.operationId, uncertain ? "uncertain" : "settled");
      this.active = false;
    }
  }

  private async recoverByOwner(
    identity: BodyConversationIdentity,
    decision: NonNullable<Extract<ComputerCommand, { action: "recover" }>["ownerRecovery"]>,
    authority: OwnerComputerRecovery | undefined,
  ): Promise<unknown> {
    const lent = this.adapter.bodyId.startsWith("lent:");
    if (this.adapter.bodyId !== "macos:console" && !lent)
      return recoveryRefusal(
        "owner_recovery_unsupported",
        "Owner recovery is only available for the local macOS computer and lent screens.",
        "Use this host's native stop-proof recovery.",
      );
    if (!authority && lent)
      return recoveryRefusal(
        "owner_recovery_unsupported",
        "A lent screen accepts owner recovery only from its own host.",
        "The owner at that machine sends screen_recover through its clankie join control.",
      );
    if (!authority)
      return recoveryRefusal(
        "owner_authorization_required",
        "Explicit owner recovery requires a separately authenticated operator request.",
        "Use clankie computer request through the owner operator connection.",
      );
    this.active = true;
    let held: Ref | undefined;
    let operationId: string | undefined;
    try {
      held = this.store.recoveryReference("computer");
      if (!held) return { outcome: "released" };
      const expected = held;
      const eligible = () => {
        const lease = this.store.status("computer");
        return (
          lease?.state === "recovery_required" &&
          lease.expiresAt <= Date.now() &&
          lease.conversationId === decision.expectedHolder &&
          lease.expiresAt === decision.expectedExpiresAt &&
          this.store.recoveryReference("computer")?.token === expected.token &&
          this.store.recoveryReady(expected, operationId) &&
          authority.holderIdle(expected.conversationId)
        );
      };
      const guard = async () => {
        await this.authorized(identity);
        if (
          !(await identity.authorize("computer", "recover")) ||
          !(await authority.authorize()) ||
          !identity.current()
        )
          throw new Error("Owner recovery authority changed");
        return eligible();
      };
      const current = this.store.status("computer");
      if (
        current?.conversationId === decision.expectedHolder &&
        current.expiresAt === decision.expectedExpiresAt &&
        current.expiresAt > Date.now()
      )
        return recoveryRefusal(
          "recovery_not_expired",
          "The lease has not expired yet; Stop has already fenced its input.",
          "Wait until its expiresAt, read status, then retry with that holder and expiry.",
        );
      if (!(await guard()))
        return recoveryRefusal(
          "recovery_not_idle",
          "The expected expired lease is no longer current, or its holder has service-tracked work or a body operation.",
          "Wait for the holder and driver to settle, read status, then use its current holder and expiry.",
        );
      const begun = this.store.beginRecovery(expected);
      if (begun.outcome !== "admitted")
        return recoveryRefusal(
          begun.reason,
          "Another recovery or lease operation blocks this decision.",
          "Wait for it to settle and read status.",
        );
      operationId = begun.operationId;
      if (!(await guard()))
        return recoveryRefusal(
          "recovery_not_idle",
          "The holder or lease changed during owner recovery.",
          "Read status and wait for the holder and driver to settle.",
        );
      const auditId = randomUUID();
      if (existsSync(this.recoveryAuditPath)) {
        const previous = readFileSync(this.recoveryAuditPath, "utf8");
        if (previous.length && !previous.endsWith("\n")) throw new Error("Incomplete recovery audit");
        for (const line of previous.split("\n").slice(0, -1)) RecoveryAuditSchema.parse(JSON.parse(line));
      }
      // Durable decision BEFORE release. This records accepted uncertainty, not a claim of native drain or completed release.
      appendFileSync(
        this.recoveryAuditPath,
        JSON.stringify(
          RecoveryAuditSchema.parse({
            schemaVersion: 1,
            auditId,
            at: new Date().toISOString(),
            bodyId: this.adapter.bodyId,
            decision: "owner_override_authorized",
            operatorId: authority.operatorId,
            requestedFrom: identity.conversationId,
            originalHolder: expected.conversationId,
            expiresAt: decision.expectedExpiresAt,
            incarnationSha256: createHash("sha256").update(expected.token).digest("hex"),
            reason: decision.reason,
          }),
        ) + "\n",
        { mode: 0o600, flush: true },
      );
      const auditDirectory = openSync(dirname(this.recoveryAuditPath), "r");
      try {
        fsyncSync(auditDirectory);
      } finally {
        closeSync(auditDirectory);
      }
      // No await between the final guards, audit and exact-incarnation release.
      const finished = this.store.finish(expected, operationId, "settled");
      if (finished.outcome !== "finished") return finished;
      const result = this.store.overrideComputerRecovery(expected);
      if (result.outcome !== "released") return result;
      this.frames.clear();
      this.lease = undefined;
      return { outcome: "released", recovery: { kind: "owner_override", auditId, reason: decision.reason } };
    } catch {
      return recoveryRefusal(
        "owner_recovery_refused",
        "Owner authorization, lease state or durable recovery audit is unavailable; the lease remains held.",
        "Read status, restore operator authorization or audit storage, then reconcile before another recovery.",
      );
    } finally {
      if (held && operationId) this.store.finish(held, operationId, "uncertain");
      this.active = false;
    }
  }
}
