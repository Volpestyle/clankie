import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { BodyResourceSchema as ResourceSchema, type BodyResource as Resource } from "@clankie/protocol";
const ClaimSchema = z.strictObject({
  resource: ResourceSchema,
  conversationId: z.string().min(1).max(512),
  token: z.uuid(),
  expiresAt: z.number().int().nonnegative(),
  recovery: z.boolean(),
  operations: z.array(z.uuid()),
  recoveryOperation: z.uuid().optional(),
});
type Claim = z.infer<typeof ClaimSchema>;
const RequestSchema = z.strictObject({
  requestId: z.uuid(),
  kind: z.enum(["queue", "ask"]),
  resource: ResourceSchema,
  requester: z.string().min(1).max(512),
  holder: z.string().min(1).max(512),
  incarnation: z.uuid(),
  text: z.string().trim().min(1).max(2000),
  expiresAt: z.number().int().nonnegative(),
  phase: z.enum(["pending", "attempted"]),
});
type BodyRequest = z.infer<typeof RequestSchema>;
const StateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  claims: z.array(ClaimSchema),
  requests: z.array(RequestSchema).default([]),
});
type LeaseRef = Pick<Claim, "resource" | "conversationId" | "token">;
type LeaseView = Pick<Claim, "resource" | "conversationId" | "expiresAt"> & {
  state: "active" | "recovery_required";
};
type Refusal = { outcome: "rejected"; reason: "stale_lease" | "recovery_required" | "store_unavailable" };
type Busy = { outcome: "busy"; lease: LeaseView };
type Admission = { outcome: "acquired"; lease: LeaseRef; expiresAt: number } | Refusal | Busy;
const MAX_TTL_MS = 5 * 60_000;

/** One service owns the registry. A stale process lock requires explicit recovery, never age-based stealing. */
export class BodyLeaseStore {
  private readonly path: string;
  private readonly lock: string;
  private readonly clock: () => number;
  private claims = new Map<Resource, Claim>();
  private requests: BodyRequest[] = [];
  private unavailable = false;
  private closed = false;

  public constructor(directory: string, clock: () => number = Date.now) {
    this.clock = clock;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, "body-leases.json");
    this.lock = join(directory, "body-leases.lock");
    this.acquireProcessLock();
    try {
      if (existsSync(this.path)) {
        const state = StateSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
        this.requests = state.requests;
        for (const claim of state.claims) {
          if (this.claims.has(claim.resource)) throw new Error("Duplicate body resource");
          const { recoveryOperation: _recoveryOperation, ...saved } = claim;
          this.claims.set(claim.resource, { ...saved, token: randomUUID(), recovery: true, operations: [] });
        }
        this.requests = this.requests.map((request) =>
          this.claims.has(request.resource) ? { ...request, phase: "attempted" } : request,
        );
        this.persist(this.claims);
      }
    } catch {
      this.unavailable = true;
    }
  }

  private acquireProcessLock(): void {
    const recovery = `${this.lock}.recovery`;
    if (existsSync(recovery))
      throw new Error("Body lease lock recovery already in progress; inspect its owner before retrying");
    try {
      mkdirSync(this.lock, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const ownerPath = join(this.lock, "owner.json");
      const ownerSchema = z.strictObject({ pid: z.number().int().positive(), nonce: z.uuid() });
      const original = ownerSchema.parse(JSON.parse(readFileSync(ownerPath, "utf8")));
      const originalInode = statSync(this.lock).ino;
      const definitelyDead = (pid: number): boolean => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (cause) {
          return (cause as NodeJS.ErrnoException).code === "ESRCH";
        }
      };
      // A reused PID is alive and is deliberately NOT treated as proof of death.
      if (!definitelyDead(original.pid))
        throw new Error("Body lease store is held by a live or unverifiable process");
      mkdirSync(recovery, { mode: 0o700 });
      try {
        writeFileSync(
          join(recovery, "owner.json"),
          JSON.stringify({ pid: process.pid, nonce: randomUUID() }),
          { mode: 0o600 },
        );
        const current = ownerSchema.parse(JSON.parse(readFileSync(ownerPath, "utf8")));
        if (
          statSync(this.lock).ino !== originalInode ||
          current.nonce !== original.nonce ||
          !definitelyDead(current.pid)
        )
          throw new Error("Body lease process owner changed during recovery");
        rmSync(this.lock, { recursive: true });
        // A competing startup that wins this mkdir owns the new lock; never remove it.
        mkdirSync(this.lock, { mode: 0o700 });
      } finally {
        rmSync(recovery, { recursive: true });
      }
    }
    writeFileSync(join(this.lock, "owner.json"), JSON.stringify({ pid: process.pid, nonce: randomUUID() }), {
      mode: 0o600,
    });
  }

  public request(input: {
    kind: "queue" | "ask";
    resource: Resource;
    requester: string;
    text: string;
    ttlMs: number;
  }):
    | { outcome: "queued"; requestId: string; expiresAt: number }
    | Refusal
    | { outcome: "rejected"; reason: "queue_full" | "unavailable" } {
    if (this.unavailable || this.closed) return this.refused("store_unavailable");
    this.validateTtl(input.ttlMs);
    const held = this.claims.get(input.resource);
    if (held === undefined) return { outcome: "rejected", reason: "unavailable" };
    const kept = this.requests.filter((request) => request.expiresAt > this.clock());
    if (kept.length >= 128) return { outcome: "rejected", reason: "queue_full" };
    const duplicate = kept.find(
      (request) =>
        request.kind === input.kind &&
        request.requester === input.requester &&
        request.incarnation === held.token &&
        request.text === input.text,
    );
    if (duplicate !== undefined)
      return { outcome: "queued", requestId: duplicate.requestId, expiresAt: duplicate.expiresAt };
    const request = RequestSchema.parse({
      requestId: randomUUID(),
      kind: input.kind,
      resource: input.resource,
      requester: input.requester,
      holder: held.conversationId,
      incarnation: held.token,
      text: input.text,
      expiresAt: this.clock() + input.ttlMs,
      phase: "pending",
    });
    try {
      const next = [...kept, request];
      this.persist(this.claims, next);
      this.requests = next;
      return { outcome: "queued", requestId: request.requestId, expiresAt: request.expiresAt };
    } catch {
      this.unavailable = true;
      return this.refused("store_unavailable");
    }
  }

  public requestCurrent(requestId: string): boolean {
    return (
      !this.unavailable &&
      !this.closed &&
      this.requests.some(
        (request) =>
          request.requestId === requestId &&
          request.phase === "attempted" &&
          request.expiresAt > this.clock(),
      )
    );
  }

  public pendingRequests(): readonly BodyRequest[] {
    this.assertReadable();
    return this.requests
      .filter((request) => request.phase === "pending" && request.expiresAt > this.clock())
      .map((request) => ({ ...request }));
  }

  /** Persist attempted before delivery. A lost receipt never becomes automatic restart replay. */
  public attemptRequest(requestId: string): BodyRequest | undefined {
    this.assertReadable();
    const request = this.requests.find(
      (entry) => entry.requestId === requestId && entry.phase === "pending" && entry.expiresAt > this.clock(),
    );
    if (request === undefined) return undefined;
    const next = this.requests.map((entry) =>
      entry.requestId === requestId ? { ...entry, phase: "attempted" as const } : entry,
    );
    try {
      this.persist(this.claims, next);
      this.requests = next;
      return { ...request, phase: "attempted" };
    } catch {
      this.unavailable = true;
      return undefined;
    }
  }

  public status(resource: Resource): LeaseView | undefined {
    this.assertReadable();
    const claim = this.claims.get(resource);
    return claim === undefined ? undefined : this.view(claim);
  }

  public acquire(resource: Resource, conversationId: string, ttlMs: number): Admission {
    if (this.unavailable || this.closed) return this.refused("store_unavailable");
    this.validateTtl(ttlMs);
    if (conversationId.trim().length === 0 || conversationId.length > 512)
      throw new Error("Invalid conversation identity");
    const held = this.claims.get(resource);
    if (held !== undefined) return { outcome: "busy", lease: this.view(held) };
    const claim: Claim = {
      resource,
      conversationId,
      token: randomUUID(),
      expiresAt: this.clock() + ttlMs,
      recovery: false,
      operations: [],
    };
    if (!this.commit(resource, claim)) return this.refused("store_unavailable");
    return { outcome: "acquired", lease: this.ref(claim), expiresAt: claim.expiresAt };
  }

  public renew(ref: LeaseRef, ttlMs: number): { outcome: "renewed"; expiresAt: number } | Refusal {
    this.validateTtl(ttlMs);
    const found = this.match(ref);
    if ("outcome" in found) return found;
    if (this.expired(found)) return this.refused("recovery_required");
    const claim = { ...found, expiresAt: this.clock() + ttlMs };
    return this.commit(ref.resource, claim)
      ? { outcome: "renewed", expiresAt: claim.expiresAt }
      : this.refused("store_unavailable");
  }

  /** Release is allowed only after the caller has confirmed its body session ended. */
  public release(ref: LeaseRef): { outcome: "released" } | Refusal {
    const found = this.match(ref);
    if ("outcome" in found) return found;
    if (this.expired(found) || found.operations.length > 0) return this.refused("recovery_required");
    return this.commit(ref.resource, undefined) ? { outcome: "released" } : this.refused("store_unavailable");
  }

  /** Reserve before any async work. Revalidate at the final effect boundary as well. */
  public begin(ref: LeaseRef): { outcome: "admitted"; operationId: string } | Refusal {
    const found = this.match(ref);
    if ("outcome" in found) return found;
    if (this.expired(found)) return this.refused("recovery_required");
    const operationId = randomUUID();
    return this.commit(ref.resource, { ...found, operations: [...found.operations, operationId] })
      ? { outcome: "admitted", operationId }
      : this.refused("store_unavailable");
  }

  public beginRecovery(ref: LeaseRef): { outcome: "admitted"; operationId: string } | Refusal {
    const found = this.match(ref);
    if ("outcome" in found) return found;
    if (found.recoveryOperation !== undefined) return this.refused("recovery_required");
    const operationId = randomUUID();
    return this.commit(ref.resource, {
      ...found,
      recovery: true,
      recoveryOperation: operationId,
      operations: [...found.operations, operationId],
    })
      ? { outcome: "admitted", operationId }
      : this.refused("store_unavailable");
  }

  public validate(ref: LeaseRef, operationId: string): { outcome: "valid" } | Refusal {
    const found = this.match(ref);
    if ("outcome" in found) return found;
    if (!found.operations.includes(operationId)) return this.refused("stale_lease");
    return this.expired(found) ? this.refused("recovery_required") : { outcome: "valid" };
  }

  /** Completion removes only its own pin; uncertainty blocks all future effects and handoffs. */
  public finish(
    ref: LeaseRef,
    operationId: string,
    outcome: "settled" | "uncertain",
  ): { outcome: "finished" } | Refusal {
    const found = this.match(ref);
    if ("outcome" in found) return found;
    if (!found.operations.includes(operationId)) return this.refused("stale_lease");
    const { recoveryOperation, ...claim } = found;
    const next = {
      ...claim,
      ...(recoveryOperation !== undefined && recoveryOperation !== operationId ? { recoveryOperation } : {}),
      operations: found.operations.filter((id) => id !== operationId),
      recovery: found.recovery || outcome === "uncertain" || this.expired(found),
    };
    return this.commit(ref.resource, next) ? { outcome: "finished" } : this.refused("store_unavailable");
  }

  /** Internal recovery evidence is fenced to this exact incarnation, never exposed in public status. */
  public recoveryReference(resource: Resource): LeaseRef | undefined {
    this.assertReadable();
    const claim = this.claims.get(resource);
    return claim === undefined ? undefined : this.ref(claim);
  }

  /** Host calls only after independently proving termination; a token alone grants no such authority. */
  public reconcileStopped(ref: LeaseRef): { outcome: "released" } | Refusal {
    const found = this.match(ref);
    if ("outcome" in found) return found;
    if (found.operations.length > 0) return this.refused("recovery_required");
    return this.commit(ref.resource, undefined) ? { outcome: "released" } : this.refused("store_unavailable");
  }

  public close(): void {
    if (this.closed) return;
    // No second process can be admitted while this process still has a live operation.
    if ([...this.claims.values()].some((claim) => claim.operations.length > 0))
      throw new Error("Body operations must settle before closing their lease store");
    this.closed = true;
    rmSync(this.lock, { recursive: true });
  }

  private match(ref: LeaseRef): Claim | Refusal {
    if (this.unavailable || this.closed) return this.refused("store_unavailable");
    const found = this.claims.get(ref.resource);
    return found?.conversationId === ref.conversationId && found.token === ref.token
      ? found
      : this.refused("stale_lease");
  }

  private expired(claim: Claim): boolean {
    return claim.recovery || this.clock() >= claim.expiresAt;
  }

  private view(claim: Claim): LeaseView {
    return {
      resource: claim.resource,
      conversationId: claim.conversationId,
      expiresAt: claim.expiresAt,
      state: this.expired(claim) ? "recovery_required" : "active",
    };
  }

  private ref(claim: Claim): LeaseRef {
    return { resource: claim.resource, conversationId: claim.conversationId, token: claim.token };
  }

  private refused(reason: Refusal["reason"]): Refusal {
    return { outcome: "rejected", reason };
  }

  private validateTtl(ttlMs: number): void {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_TTL_MS)
      throw new Error("Invalid lease duration");
  }

  private assertReadable(): void {
    if (this.unavailable || this.closed) throw new Error("Body lease store unavailable");
  }

  private commit(resource: Resource, claim: Claim | undefined): boolean {
    const next = new Map(this.claims);
    if (claim === undefined) next.delete(resource);
    else next.set(resource, claim);
    try {
      const requests =
        claim !== undefined && !this.claims.has(resource)
          ? this.requests.map((request) =>
              request.resource === resource ? { ...request, phase: "attempted" as const } : request,
            )
          : this.requests;
      this.persist(next, requests);
      this.claims = next;
      this.requests = requests;
      return true;
    } catch {
      this.unavailable = true;
      return false;
    }
  }

  private persist(claims: Map<Resource, Claim>, requests = this.requests): void {
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ schemaVersion: 1, claims: [...claims.values()], requests }));
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
      const directory = openSync(dirname(this.path), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    } finally {
      if (fd !== undefined) closeSync(fd);
      rmSync(temporary, { force: true });
    }
  }
}
