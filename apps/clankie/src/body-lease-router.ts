import type { BodyLeaseResult, BodyResource } from "@clankie/protocol";
import { BodyLeaseStore } from "./body-leases.ts";

type LeaseRef = NonNullable<ReturnType<BodyLeaseStore["recoveryReference"]>>;
/** Host creates this binding after resolving an authenticated route; tool arguments cannot create it. */
export interface BodyConversationIdentity {
  readonly conversationId: string;
  /** Exact seat/session/turn binding remains current, including through awaited discovery. */
  readonly current: () => boolean;
  /** Existing permission checks, independent of ownership. */
  readonly authorize: (resource: BodyResource, action: "effect" | "recover") => Promise<boolean>;
}

interface RequestDeliveryPorts {
  identity(conversationId: string): Promise<BodyConversationIdentity | undefined>;
  /** Verifies the source may deliver to this exact destination under existing route grants. */
  authorizeDelivery(requester: string, destination: string): Promise<boolean>;
  designatedHead(owner: string): string | undefined;
  deliver(
    destination: string,
    request: { requester: string; resource: BodyResource; text: string; kind: "queue" | "ask" },
    guard: () => Promise<void>,
  ): Promise<Extract<BodyLeaseResult, { outcome: "asked" }>["deliveryStage"]>;
}

type Refusal = Extract<BodyLeaseResult, { outcome: "rejected" | "busy" }>;

/** Resource ownership supplements existing grants; every effect receives a final-boundary guard. */
export class BodyLeaseRouter {
  private readonly store: BodyLeaseStore;
  public constructor(store: BodyLeaseStore) {
    this.store = store;
  }

  public async request(
    identity: BodyConversationIdentity,
    input: { kind: "queue" | "ask"; resource: BodyResource; text: string; ttlMs: number },
  ): Promise<BodyLeaseResult> {
    const requester = identity.conversationId;
    const denied = await this.authorize(identity, requester, input.resource, "effect");
    if (denied !== undefined) return denied;
    return this.store.request({ ...input, requester });
  }

  /** Explicit pump: fresh identities/grants, exact holder incarnation, and no automatic body action. */
  public async deliverRequests(ports: RequestDeliveryPorts): Promise<BodyLeaseResult[]> {
    const results: BodyLeaseResult[] = [];
    for (const request of this.store.pendingRequests()) {
      const held = this.store.recoveryReference(request.resource);
      if (request.kind === "queue" && held !== undefined) continue;
      if (
        request.kind === "ask" &&
        (held?.token !== request.incarnation || held.conversationId !== request.holder)
      )
        continue;
      const source = await ports.identity(request.requester);
      if (
        source === undefined ||
        (await this.authorize(source, request.requester, request.resource, "effect")) !== undefined
      )
        continue;
      let destination = request.kind === "queue" ? request.requester : request.holder;
      let target = await ports.identity(destination);
      if (target === undefined && request.kind === "ask") {
        const head = ports.designatedHead(request.holder);
        if (head === undefined) continue;
        destination = head;
        target = await ports.identity(head);
      }
      if (
        target === undefined ||
        !target.current() ||
        !(await ports.authorizeDelivery(request.requester, destination))
      )
        continue;
      // Recheck after awaited route discovery. Nothing from another room's context is copied.
      if (!source.current() || !target.current()) continue;
      const current = this.store.recoveryReference(request.resource);
      if (request.kind === "queue" ? current !== undefined : current?.token !== request.incarnation) continue;
      const attempted = this.store.attemptRequest(request.requestId);
      if (attempted === undefined) continue;
      const guard = async () => {
        if (
          (await this.authorize(source, request.requester, request.resource, "effect")) !== undefined ||
          !(await ports.authorizeDelivery(request.requester, destination)) ||
          !source.current() ||
          !target.current() ||
          !this.store.requestCurrent(request.requestId)
        )
          throw new Error("Lease request authority or deadline changed");
        const latest = this.store.recoveryReference(request.resource);
        if (request.kind === "queue" ? latest !== undefined : latest?.token !== request.incarnation)
          throw new Error("Lease request holder changed");
      };
      let deliveryStage: Extract<BodyLeaseResult, { outcome: "asked" }>["deliveryStage"];
      try {
        await guard();
        deliveryStage = await ports.deliver(
          destination,
          {
            requester: request.requester,
            resource: request.resource,
            text: request.text,
            kind: request.kind,
          },
          guard,
        );
      } catch {
        deliveryStage = "uncertain";
      }
      results.push({ outcome: "asked", requestId: request.requestId, deliveryStage });
    }
    return results;
  }

  public async run<T>(
    identity: BodyConversationIdentity,
    resource: BodyResource,
    effect: (guard: () => Promise<void>) => Promise<T>,
    options: { lifetime: "operation" | "session"; uncertain?: (result: T) => boolean },
  ): Promise<{ outcome: "completed"; value: T; leaseIssue?: string } | Refusal> {
    const conversationId = identity.conversationId;
    const authorized = await this.authorize(identity, conversationId, resource, "effect");
    if (authorized !== undefined) return authorized;
    let lease: LeaseRef;
    try {
      const held = this.store.status(resource);
      if (held?.conversationId === conversationId && held.state === "active") {
        const reference = this.store.recoveryReference(resource);
        if (reference === undefined) return { outcome: "rejected", reason: "stale_lease" };
        lease = reference;
        const renewed = this.store.renew(lease, 300_000);
        if (renewed.outcome !== "renewed") return renewed;
      } else {
        const result = this.store.acquire(resource, conversationId, 300_000);
        if (result.outcome === "busy") return { ...result, actions: ["queue", "ask"] };
        if (result.outcome !== "acquired") return result;
        lease = result.lease;
      }
    } catch {
      return { outcome: "rejected", reason: "store_unavailable" };
    }
    const begun = this.store.begin(lease);
    if (begun.outcome !== "admitted") return begun;
    const guard = async () => {
      const denied = await this.authorize(identity, conversationId, resource, "effect");
      if (denied !== undefined) throw new BodyLeaseDenied(denied);
      const valid = this.store.validate(lease, begun.operationId);
      if (valid.outcome !== "valid") throw new BodyLeaseDenied(valid);
    };
    let started = false;
    try {
      await guard();
      started = true;
      const value = await effect(guard);
      const uncertain = options.uncertain?.(value) === true;
      const finished = this.store.finish(lease, begun.operationId, uncertain ? "uncertain" : "settled");
      if (finished.outcome !== "finished")
        return { outcome: "completed", value, leaseIssue: finished.reason };
      if (!uncertain && options.lifetime === "operation") {
        const released = this.store.release(lease);
        if (released.outcome !== "released")
          return { outcome: "completed", value, leaseIssue: released.reason };
      }
      return { outcome: "completed", value };
    } catch (error) {
      // A thrown transport error may follow an effect. Only pre-effect refusal proves nothing ran.
      this.store.finish(lease, begun.operationId, started ? "uncertain" : "settled");
      if (error instanceof BodyLeaseDenied) return error.result;
      throw error;
    }
  }

  /** Termination proof belongs to the body host, never a caller-supplied boolean or timeout. */
  public async recover(
    identity: BodyConversationIdentity,
    resource: BodyResource,
    confirmStopped: (guard: () => Promise<void>) => Promise<boolean>,
  ): Promise<BodyLeaseResult> {
    const conversationId = identity.conversationId;
    const denied = await this.authorize(identity, conversationId, resource, "recover");
    if (denied !== undefined) return denied;
    let reference: LeaseRef | undefined;
    try {
      reference = this.store.recoveryReference(resource);
    } catch {
      return { outcome: "rejected", reason: "store_unavailable" };
    }
    if (reference === undefined) return { outcome: "released" };
    const expected = reference;
    const begun = this.store.beginRecovery(expected);
    if (begun.outcome !== "admitted") return begun;
    const guard = async () => {
      const refused = await this.authorize(identity, conversationId, resource, "recover");
      if (refused !== undefined) throw new BodyLeaseDenied(refused);
      const current = this.store.recoveryReference(resource);
      if (current?.token !== expected.token || current.conversationId !== expected.conversationId)
        throw new BodyLeaseDenied({ outcome: "rejected", reason: "stale_lease" });
    };
    try {
      await guard();
      if (!(await confirmStopped(guard))) return { outcome: "rejected", reason: "recovery_required" };
      await guard();
      const finished = this.store.finish(expected, begun.operationId, "settled");
      if (finished.outcome !== "finished") return finished;
      return this.store.reconcileStopped(expected);
    } catch (error) {
      if (error instanceof BodyLeaseDenied) return error.result;
      return { outcome: "rejected", reason: "recovery_required" };
    } finally {
      this.store.finish(expected, begun.operationId, "uncertain");
    }
  }

  private async authorize(
    identity: BodyConversationIdentity,
    conversationId: string,
    resource: BodyResource,
    action: "effect" | "recover",
  ): Promise<Extract<BodyLeaseResult, { outcome: "rejected" }> | undefined> {
    if (!conversationId || !identity.current() || identity.conversationId !== conversationId)
      return { outcome: "rejected", reason: "identity_required" };
    let authorized = false;
    try {
      authorized = await identity.authorize(resource, action);
    } catch {
      /* Failed grants deny. */
    }
    if (!identity.current() || identity.conversationId !== conversationId)
      return { outcome: "rejected", reason: "identity_required" };
    return authorized ? undefined : { outcome: "rejected", reason: "not_authorized" };
  }
}

class BodyLeaseDenied extends Error {
  public readonly result: Refusal;
  public constructor(result: Refusal) {
    super(`Body lease ${result.outcome}`);
    this.result = result;
  }
}
