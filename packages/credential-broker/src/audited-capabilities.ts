import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CapabilityGrantSchema,
  CapabilityTokenError,
  type CapabilityGrant,
  type CapabilityTokenErrorCode,
  type CapabilityTokenIssuer,
} from "./capability-token.ts";

export interface CapabilityAuditEvent {
  id: string;
  occurredAt: string;
  missionId: string;
  taskId?: string;
  workerRunId: string;
  correlationId: string;
  profileHash: string;
  type: "capability.issued" | "capability.use.allowed" | "capability.use.denied";
  data: Record<string, unknown>;
}

export interface CapabilityAuditEnvelope {
  event: {
    type: string;
    data: Record<string, unknown>;
  };
}

/** Structurally compatible with @clankie/event-store's append/readAll surface. */
export interface CapabilityAuditSink {
  append(event: CapabilityAuditEvent): Promise<unknown>;
  readAll(): Promise<CapabilityAuditEnvelope[]>;
}

/** Mission and worker attribution supplied by the trusted runner/control plane. */
export interface CapabilityAuditContext {
  missionId: string;
  workerRunId: string;
  correlationId: string;
  profileHash: string;
  taskId?: string;
}

export const CapabilityUseRequestSchema = z.object({
  token: z.string(),
  capability: z.string(),
  resource: z.string().optional(),
});
export type CapabilityUseRequest = z.infer<typeof CapabilityUseRequestSchema>;

export type CapabilityUseReason =
  | "allowed"
  | CapabilityTokenErrorCode
  | "mission_mismatch"
  | "principal_mismatch"
  | "profile_mismatch"
  | "capability_not_granted"
  | "resource_not_granted"
  | "replayed";

export interface CapabilityUseDecision {
  allowed: boolean;
  reason: CapabilityUseReason;
  grant?: CapabilityGrant;
}

export interface AuditedCapabilityBrokerOptions {
  clock?: () => Date;
  idFactory?: () => string;
}

const capabilityUseQueues = new Map<string, Promise<unknown>>();

function enqueueCapabilityUse<T>(grantFingerprint: string, operation: () => Promise<T>): Promise<T> {
  const previous = capabilityUseQueues.get(grantFingerprint) ?? Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  capabilityUseQueues.set(grantFingerprint, settled);
  void settled.finally(() => {
    if (capabilityUseQueues.get(grantFingerprint) === settled) {
      capabilityUseQueues.delete(grantFingerprint);
    }
  });
  return result;
}

/**
 * Fail-closed runtime boundary for capability issuance and one-time use. A
 * token or allowed decision is never returned until its redacted semantic
 * event has been durably appended by the configured event sink.
 */
export class AuditedCapabilityBroker {
  private readonly issuer: CapabilityTokenIssuer;
  private readonly events: CapabilityAuditSink;
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly consumedGrants = new Set<string>();

  public constructor(
    issuer: CapabilityTokenIssuer,
    events: CapabilityAuditSink,
    options: AuditedCapabilityBrokerOptions = {},
  ) {
    this.issuer = issuer;
    this.events = events;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public async issue(grant: CapabilityGrant, context: CapabilityAuditContext): Promise<string> {
    const parsed = CapabilityGrantSchema.parse(grant);
    if (
      parsed.missionId !== context.missionId ||
      parsed.principalId !== context.workerRunId ||
      parsed.profileHash !== context.profileHash
    ) {
      throw new Error("Capability grant identity does not match its trusted audit context");
    }
    const token = this.issuer.issue(parsed);
    await this.record("capability.issued", context, {
      grantFingerprint: fingerprint(parsed.grantId),
      capabilityFingerprints: parsed.capabilities.map(fingerprint),
      resourceFingerprints: parsed.resources.map(fingerprint),
      obligationFingerprints: parsed.obligations.map(fingerprint),
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    });
    return token;
  }

  public async authorizeUse(
    request: CapabilityUseRequest,
    context: CapabilityAuditContext,
    nowEpochSeconds = Math.floor(this.clock().getTime() / 1000),
  ): Promise<CapabilityUseDecision> {
    const parsed = CapabilityUseRequestSchema.parse(request);
    let grant: CapabilityGrant;
    try {
      grant = this.issuer.verify(parsed.token, nowEpochSeconds).grant;
    } catch (error) {
      const reason = error instanceof CapabilityTokenError ? error.code : "malformed";
      return this.decide(false, reason, parsed, context);
    }

    if (grant.missionId !== context.missionId) {
      return this.decide(false, "mission_mismatch", parsed, context, grant);
    }
    if (grant.principalId !== context.workerRunId) {
      return this.decide(false, "principal_mismatch", parsed, context, grant);
    }
    if (grant.profileHash !== context.profileHash) {
      return this.decide(false, "profile_mismatch", parsed, context, grant);
    }

    const grantFingerprint = fingerprint(grant.grantId);
    return enqueueCapabilityUse(grantFingerprint, async () => {
      await this.refreshConsumed();
      if (this.consumedGrants.has(grantFingerprint)) {
        return this.decide(false, "replayed", parsed, context, grant);
      }
      if (!grant.capabilities.includes(parsed.capability)) {
        return this.decide(false, "capability_not_granted", parsed, context, grant);
      }
      if (
        grant.resources.length > 0 &&
        (parsed.resource === undefined || !grant.resources.includes(parsed.resource))
      ) {
        return this.decide(false, "resource_not_granted", parsed, context, grant);
      }

      this.consumedGrants.add(grantFingerprint);
      try {
        return await this.decide(
          true,
          "allowed",
          parsed,
          context,
          grant,
          `capability-use-${grantFingerprint}`,
          randomUUID(),
        );
      } catch (error) {
        if (await this.isDurablyConsumed(grantFingerprint)) {
          return this.decide(false, "replayed", parsed, context, grant);
        }
        this.consumedGrants.delete(grantFingerprint);
        throw error;
      }
    });
  }

  private async decide(
    allowed: boolean,
    reason: CapabilityUseReason,
    request: CapabilityUseRequest,
    context: CapabilityAuditContext,
    grant?: CapabilityGrant,
    eventId?: string,
    attemptId?: string,
  ): Promise<CapabilityUseDecision> {
    await this.record(
      allowed ? "capability.use.allowed" : "capability.use.denied",
      context,
      {
        ...(grant ? { grantFingerprint: fingerprint(grant.grantId) } : {}),
        capabilityFingerprint: fingerprint(request.capability),
        ...(request.resource === undefined ? {} : { resourceFingerprint: fingerprint(request.resource) }),
        ...(attemptId ? { attemptId } : {}),
        reason,
      },
      eventId,
    );
    return allowed && grant ? { allowed, reason, grant } : { allowed, reason };
  }

  private async isDurablyConsumed(grantFingerprint: string): Promise<boolean> {
    await this.refreshConsumed();
    return this.consumedGrants.has(grantFingerprint);
  }

  private async refreshConsumed(): Promise<void> {
    for (const entry of await this.events.readAll()) {
      if (entry.event.type !== "capability.use.allowed") continue;
      const value = entry.event.data.grantFingerprint;
      if (typeof value === "string") this.consumedGrants.add(value);
    }
  }

  private async record(
    type: CapabilityAuditEvent["type"],
    context: CapabilityAuditContext,
    data: Record<string, unknown>,
    eventId = this.idFactory(),
  ): Promise<void> {
    await this.events.append({
      id: eventId,
      occurredAt: this.clock().toISOString(),
      missionId: context.missionId,
      ...(context.taskId ? { taskId: context.taskId } : {}),
      workerRunId: context.workerRunId,
      correlationId: context.correlationId,
      profileHash: context.profileHash,
      type,
      data,
    });
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
