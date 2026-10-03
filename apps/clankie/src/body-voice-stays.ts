import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  BodyVoiceReconcileResultSchema,
  BodyVoiceSubjectSchema,
  type BodyVoiceSubject,
  type BodyVoiceReconcileRequest,
  BodyVoiceStaySchema,
  BodyVoiceTargetSchema,
  type BodyLeaseResult,
  type BodyVoiceStay,
  type BodyVoiceTarget,
} from "@clankie/protocol";
import { z } from "zod";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import type { BodyLeaseStore } from "./body-leases.ts";

type Ref = NonNullable<ReturnType<BodyLeaseStore["recoveryReference"]>>;
const RefSchema = z.strictObject({
  resource: z.literal("voice"),
  conversationId: z.string(),
  token: z.uuid(),
});
const TicketSchema = z.strictObject({
  target: BodyVoiceTargetSchema,
  kind: z.enum(["audio", "publish"]).default("audio"),
  conversationId: z.string(),
  expiresAt: z.number(),
  consumed: z.boolean(),
});
const StaySchema = z.strictObject({
  subject: BodyVoiceSubjectSchema.optional(),
  stay: BodyVoiceStaySchema,
  reference: RefSchema,
  operationId: z.uuid(),
  finished: z.boolean(),
});
const StateSchema = z.strictObject({
  tickets: z.record(z.string(), TicketSchema),
  stays: z.record(z.string(), StaySchema),
});
type State = z.infer<typeof StateSchema>;
const refused = (reason: Extract<BodyLeaseResult, { outcome: "rejected" }>["reason"]): BodyLeaseResult => ({
  outcome: "rejected",
  reason,
});
const matches = (left: BodyVoiceTarget, right: BodyVoiceTarget): boolean =>
  left.guildId === right.guildId &&
  left.channelId === right.channelId &&
  left.actorId === right.actorId &&
  left.presenceSessionId === right.presenceSessionId &&
  left.transportKind === right.transportKind;
const sameStay = (left: BodyVoiceStay, right: BodyVoiceStay): boolean =>
  (left.kind ?? "audio") === (right.kind ?? "audio") &&
  left.stayId === right.stayId &&
  left.generation === right.generation &&
  matches(left.target, right.target);

/** Host-only lifecycle. The surrounding BodyLeaseStore owns process exclusion for this directory. */
export class BodyVoiceStays {
  private state: State = { tickets: {}, stays: {} };
  private unavailable = false;
  private readonly reconciliationGuards = new Map<
    string,
    {
      request: BodyVoiceReconcileRequest;
      guard: () => Promise<void>;
      reference: Ref;
      presenceSessionId?: string;
    }
  >();
  private readonly ticketIdentities = new Map<string, BodyConversationIdentity>();
  private readonly restartClaims = new Map<string, Ref>();
  private readonly stayAuthority = new Map<string, BodyConversationIdentity["authorize"]>();
  private readonly store: BodyLeaseStore;
  private readonly path: string;
  private readonly clock: () => number;
  public constructor(store: BodyLeaseStore, path: string, clock = Date.now) {
    this.store = store;
    this.path = path;
    this.clock = clock;
    try {
      this.state = StateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
      // No reconstructed turn grants after restart. Existing stays require trusted observed termination.
      for (const ticket of Object.values(this.state.tickets)) ticket.consumed = true;
      const current = this.store.recoveryReference("voice");
      const unfinished = Object.values(this.state.stays).filter((record) => !record.finished);
      if (
        current !== undefined &&
        this.store.status("voice")?.state === "recovery_required" &&
        unfinished.length > 0 &&
        unfinished.every((record) => record.reference.conversationId === current.conversationId)
      ) {
        for (const previous of unfinished) this.restartClaims.set(previous.stay.stayId, current);
      }
      this.save();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.unavailable = true;
    }
  }

  public async ticket(
    identity: BodyConversationIdentity,
    target: BodyVoiceTarget,
    kind: "audio" | "publish" = "audio",
  ): Promise<{ ticket: string } | BodyLeaseResult> {
    if (this.unavailable) return refused("store_unavailable");
    if (!identity.current() || !(await identity.authorize("voice", "effect")) || !identity.current())
      return refused("not_authorized");
    // Bound and persisted before the control request is dispatched to the body.
    for (const [key, ticket] of Object.entries(this.state.tickets)) {
      if (ticket.expiresAt <= this.clock()) {
        delete this.state.tickets[key];
        this.ticketIdentities.delete(key);
      }
    }
    if (Object.keys(this.state.tickets).length >= 128) return refused("queue_full");
    const id = randomUUID();
    this.state.tickets[id] = {
      target: BodyVoiceTargetSchema.parse(target),
      kind,
      conversationId: identity.conversationId,
      expiresAt: this.clock() + 30_000,
      consumed: false,
    };
    this.save();
    this.ticketIdentities.set(id, identity);
    return { ticket: id };
  }

  /** routeIdentity is resolved only after authenticated physical gateway/session proof. */
  public async claim(
    stay: BodyVoiceStay,
    routeIdentity: BodyConversationIdentity,
    ticketId?: string,
    subject?: BodyVoiceSubject,
  ): Promise<BodyLeaseResult> {
    if (this.unavailable) return refused("store_unavailable");
    if (
      !routeIdentity.current() ||
      !(await routeIdentity.authorize("voice", "effect")) ||
      !routeIdentity.current()
    )
      return refused("not_authorized");
    if (Object.values(this.state.stays).filter((record) => !record.finished).length >= 128)
      return refused("queue_full");
    if (this.state.stays[stay.stayId] !== undefined) return refused("stale_lease");
    if (Object.keys(this.state.stays).length >= 256) {
      for (const [key, record] of Object.entries(this.state.stays)) {
        if (record.finished) {
          delete this.state.stays[key];
          this.restartClaims.delete(key);
        }
        if (Object.keys(this.state.stays).length < 128) break;
      }
    }
    let owner = routeIdentity;
    if (ticketId !== undefined) {
      const ticket = this.state.tickets[ticketId];
      const identity = this.ticketIdentities.get(ticketId);
      if (
        ticket === undefined ||
        ticket.consumed ||
        ticket.expiresAt <= this.clock() ||
        !matches(ticket.target, stay.target) ||
        ticket.kind !== (stay.kind ?? "audio") ||
        identity === undefined
      )
        return refused("stale_lease");
      if (
        !identity.current() ||
        !(await identity.authorize("voice", "effect")) ||
        !identity.current() ||
        !routeIdentity.current()
      )
        return refused("not_authorized");
      // Recheck after the authorization await; concurrent consumers cannot reuse a ticket.
      if (ticket.consumed || ticket.expiresAt <= this.clock()) return refused("stale_lease");
      ticket.consumed = true;
      this.save();
      this.ticketIdentities.delete(ticketId);
      owner = identity;
    }
    const held = this.store.status("voice");
    const existing = this.store.recoveryReference("voice");
    const compatible = Object.values(this.state.stays)
      .filter((record) => !record.finished)
      .every(
        (record) =>
          record.stay.target.guildId === stay.target.guildId &&
          record.stay.target.channelId === stay.target.channelId &&
          record.stay.target.presenceSessionId === stay.target.presenceSessionId &&
          record.stay.target.transportKind === stay.target.transportKind,
      );
    const acquired =
      held?.conversationId === owner.conversationId &&
      held.state === "active" &&
      existing !== undefined &&
      compatible
        ? { outcome: "acquired" as const, lease: existing }
        : this.store.acquire("voice", owner.conversationId, 30_000, owner.route);
    if (acquired.outcome === "busy") return { ...acquired, actions: ["queue", "ask"] };
    if (acquired.outcome !== "acquired") return acquired;
    const renewed = this.store.renew(acquired.lease, 30_000);
    if (renewed.outcome !== "renewed") return renewed;
    const begun = this.store.begin(acquired.lease);
    if (begun.outcome !== "admitted") return begun;
    this.state.stays[stay.stayId] = {
      ...(subject === undefined ? {} : { subject: BodyVoiceSubjectSchema.parse(subject) }),
      stay: BodyVoiceStaySchema.parse(stay),
      reference: acquired.lease as Ref & { resource: "voice" },
      operationId: begun.operationId,
      finished: false,
    };
    this.save();
    // Admission capture can expire on the next turn; ongoing authority keeps the original source grant.
    this.stayAuthority.set(stay.stayId, owner.authorize);
    return { outcome: "acquired", lease: this.store.status("voice")!, incarnation: acquired.lease.token };
  }

  public async heartbeat(
    stay: BodyVoiceStay,
    incarnation: string,
    routeIdentity: BodyConversationIdentity,
  ): Promise<BodyLeaseResult> {
    if (this.unavailable) return refused("store_unavailable");
    const record = this.state.stays[stay.stayId];
    const authority = this.stayAuthority.get(stay.stayId);
    if (
      record === undefined ||
      record.finished ||
      !sameStay(record.stay, stay) ||
      record.reference.token !== incarnation
    )
      return refused("stale_lease");
    if (
      authority === undefined ||
      !routeIdentity.current() ||
      !(await authority("voice", "effect")) ||
      !(await routeIdentity.authorize("voice", "effect")) ||
      !routeIdentity.current()
    )
      return refused("not_authorized");
    const valid = this.store.validate(record.reference, record.operationId);
    if (valid.outcome !== "valid") return valid;
    const renewed = this.store.renew(record.reference, 30_000);
    return renewed.outcome === "renewed"
      ? { outcome: "renewed", lease: this.store.status("voice")! }
      : renewed;
  }

  /** Only the authenticated body's observed gateway-leave callback invokes this, never a caller boolean. */
  public finish(stay: BodyVoiceStay, incarnation: string): BodyLeaseResult {
    if (this.unavailable) return refused("store_unavailable");
    const record = this.state.stays[stay.stayId];
    if (record === undefined || !sameStay(record.stay, stay) || record.reference.token !== incarnation)
      return refused("stale_lease");
    if (record.finished) return { outcome: "released" };
    const current = this.store.recoveryReference("voice");
    const expected = this.restartClaims.get(stay.stayId) ?? record.reference;
    if (
      current === undefined ||
      current.token !== expected.token ||
      current.conversationId !== record.reference.conversationId
    )
      return refused("stale_lease");
    // Persist the observed termination before freeing any registry ownership.
    record.finished = true;
    this.save();
    // On restart only this exact persisted stay's gateway termination can reconcile the rotated claim.
    if (current.token === record.reference.token) this.store.finish(current, record.operationId, "settled");
    // Every persisted stay must terminate, including all pins lost from process memory on restart.
    if (
      Object.values(this.state.stays).some(
        (candidate) => !candidate.finished && candidate.reference.conversationId === current.conversationId,
      )
    ) {
      this.stayAuthority.delete(stay.stayId);
      return { outcome: "released" };
    }
    const result = this.store.reconcileStopped(current);
    if (
      result.outcome !== "released" &&
      !(result.outcome === "rejected" && result.reason === "recovery_required")
    )
      return result;
    this.stayAuthority.delete(stay.stayId);
    return { outcome: "released" }; // Actual termination recorded; an enclosing recovery pin may still hold the registry.
  }

  public compatibleTarget(conversationId: string, target: BodyVoiceTarget): boolean {
    const held = this.store.status("voice");
    if (held !== undefined && held.conversationId !== conversationId) return false;
    return Object.values(this.state.stays)
      .filter((record) => !record.finished)
      .every(
        (record) =>
          record.stay.target.guildId === target.guildId &&
          record.stay.target.channelId === target.channelId &&
          record.stay.target.presenceSessionId === target.presenceSessionId &&
          record.stay.target.transportKind === target.transportKind,
      );
  }

  public publishing(conversationId: string): BodyVoiceStay | undefined {
    if (this.unavailable || this.store.status("voice")?.state !== "active") return undefined;
    const current = this.store.recoveryReference("voice");
    return Object.values(this.state.stays).find(
      (record) =>
        !record.finished &&
        record.stay.kind === "publish" &&
        record.reference.conversationId === conversationId &&
        record.reference.token === current?.token,
    )?.stay;
  }

  /** Called only inside an authorized router recovery, with a trusted body observation port. */
  public async reconcile(
    observe: (request: BodyVoiceReconcileRequest) => Promise<unknown>,
    guard: () => Promise<void>,
  ): Promise<boolean> {
    if (this.unavailable) return false;
    await guard();
    const reference = this.store.recoveryReference("voice");
    if (reference === undefined) return this.stopped();
    const records = Object.values(this.state.stays).filter((record) => !record.finished);
    if (records.length === 0) return this.stopped();
    if (records.some((record) => record.reference.conversationId !== reference.conversationId)) return false;
    const subject = records[0]?.subject;
    if (
      subject === undefined ||
      records.some((record) => JSON.stringify(record.subject) !== JSON.stringify(subject))
    )
      return false;
    const request = { subject, nonce: randomUUID(), stays: records.map((record) => record.stay) };
    const captured: {
      request: BodyVoiceReconcileRequest;
      guard: () => Promise<void>;
      reference: Ref;
      presenceSessionId?: string;
    } = { request, guard, reference };
    this.reconciliationGuards.set(request.nonce, captured);
    let result: unknown;
    try {
      result = await observe(request);
    } finally {
      this.reconciliationGuards.delete(request.nonce);
    }
    const observed = BodyVoiceReconcileResultSchema.safeParse(result);
    await guard();
    const current = this.store.recoveryReference("voice");
    if (
      current?.token !== reference.token ||
      current.conversationId !== reference.conversationId ||
      !observed.success ||
      observed.data.nonce !== request.nonce ||
      observed.data.presenceSessionId !== captured.presenceSessionId ||
      JSON.stringify(observed.data.subject) !== JSON.stringify(subject) ||
      observed.data.confirmedStayIds.length !== records.length ||
      new Set(observed.data.confirmedStayIds).size !== records.length ||
      records.some((record) => !observed.data.confirmedStayIds.includes(record.stay.stayId))
    )
      return false;
    // Persist actual body observations first. A failed write retains the host claim.
    for (const record of records) record.finished = true;
    this.save();
    for (const record of records) {
      if (record.reference.token === reference.token)
        this.store.finish(reference, record.operationId, "settled");
      this.stayAuthority.delete(record.stay.stayId);
    }
    return this.stopped();
  }

  public async authorizeReconciliation(
    request: BodyVoiceReconcileRequest,
    presenceSessionId: string,
  ): Promise<boolean> {
    const captured = this.reconciliationGuards.get(request.nonce);
    if (
      this.unavailable ||
      captured === undefined ||
      JSON.stringify(captured.request) !== JSON.stringify(request)
    )
      return false;
    try {
      await captured.guard();
    } catch {
      return false;
    }
    const current = this.store.recoveryReference("voice");
    const allowed =
      this.reconciliationGuards.get(request.nonce) === captured &&
      current?.token === captured.reference.token &&
      current.conversationId === captured.reference.conversationId &&
      (captured.presenceSessionId === undefined || captured.presenceSessionId === presenceSessionId);
    if (allowed) captured.presenceSessionId = presenceSessionId;
    return allowed;
  }

  public stopped(): boolean {
    return !this.unavailable && Object.values(this.state.stays).every((record) => record.finished);
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      const file = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(file, JSON.stringify(this.state));
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
    } catch (error) {
      this.unavailable = true;
      throw error;
    }
  }
}
