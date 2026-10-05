import { randomUUID, createHmac } from "node:crypto";
import {
  SupportGrantCreateRequestSchema,
  SupportGrantSchema,
  SUPPORT_GRANT_WINDOW_CAPACITY,
  type SupportGrant,
  type SupportGrantCreateRequest,
  type SupportGrantMetadata,
  type SupportRouteClass,
} from "@clankie/protocol/support-access";
import type { DomainEvent } from "@clankie/protocol";
import type { BodyTelemetry } from "@clankie/observability/body-telemetry";

export class SupportGrantCapacityError extends Error {}

/** Durable body authority. Fleet snapshots contain metadata only and never create authority here. */
export class SupportGrantStore {
  private readonly grants = new Map<string, SupportGrant>();
  private revision = 0;
  private readonly pendingAudit: {
    sourceEventId: string;
    audit: {
      event: "body.support";
      grantId: string;
      scope: "read-state" | "shell";
      action: "granted" | "revoked" | "expired";
    };
  }[] = [];
  private readonly options: {
    events?: readonly DomainEvent[];
    clock: () => Date;
    idFactory?: () => string;
    recordEvent: (type: string, streamId: string, at: string, data: Record<string, unknown>) => DomainEvent;
    telemetry?: BodyTelemetry;
    /** This tenant's telemetry key, or the body's dedicated persistent local telemetry key. */
    deviceRefKey?: Uint8Array;
    requireAudit?: boolean;
    changed?: () => void;
  };
  constructor(options: SupportGrantStore["options"]) {
    this.options = options;
    for (const event of options.events ?? []) {
      if (event.type === "support.audit.recorded") {
        const index = this.pendingAudit.findIndex((item) => item.sourceEventId === event.data.sourceEventId);
        if (index >= 0) this.pendingAudit.splice(index, 1);
        continue;
      }
      if (!event.type.startsWith("support.grant.")) continue;
      if (!["support.grant.granted", "support.grant.revoked", "support.grant.expired"].includes(event.type))
        throw new Error("Unknown support grant lifecycle event");
      const grant = SupportGrantSchema.parse(event.data.grant);
      const previous = this.grants.get(grant.grantId);
      if (previous !== undefined && (previous.status !== "active" || grant.status === "active"))
        throw new Error("Invalid support grant lifecycle replay");
      if (previous === undefined && grant.status !== "active")
        throw new Error("Support grant terminal event without creation");
      this.grants.set(grant.grantId, grant);
      this.revision += 1;
      this.pendingAudit.push({
        sourceEventId: event.id,
        audit: {
          event: "body.support",
          grantId: grant.grantId,
          scope: grant.scope,
          action: grant.status === "active" ? "granted" : grant.status,
        },
      });
    }
  }
  private persist(grant: SupportGrant, action: "granted" | "revoked" | "expired"): void {
    const audit = { event: "body.support" as const, grantId: grant.grantId, scope: grant.scope, action };
    // Admission cannot succeed while mandatory audit persistence is unavailable.
    if (action === "granted") this.audit(audit);
    const event = this.options.recordEvent(
      `support.grant.${action}`,
      `support:${grant.grantId}`,
      this.options.clock().toISOString(),
      {
        schemaVersion: 1,
        grant,
      },
    );
    this.grants.set(grant.grantId, grant);
    this.revision += 1;
    this.pendingAudit.push({ sourceEventId: event.id, audit });
    // Terminal authority is durable first and stays closed while audit retries.
    this.retryAudit(action === "granted" ? event.id : undefined);
    this.options.changed?.();
  }
  expire(): void {
    this.retryAudit();
    const now = this.options.clock().getTime();
    for (const grant of this.grants.values()) {
      if (grant.status === "active" && Date.parse(grant.expiresAt) <= now)
        this.persist({ ...grant, status: "expired" }, "expired");
    }
  }
  list(): SupportGrant[] {
    this.expire();
    return [...this.grants.values()].map((grant) => ({ ...grant }));
  }
  active(id: string): SupportGrant | undefined {
    this.expire();
    const grant = this.grants.get(id);
    return grant?.status === "active" ? { ...grant } : undefined;
  }
  create(input: SupportGrantCreateRequest): SupportGrant {
    const parsed = SupportGrantCreateRequestSchema.parse(input);
    const now = this.options.clock();
    this.expire();
    if (
      [...this.grants.values()].filter((grant) => Date.parse(grant.expiresAt) > now.getTime()).length >=
      SUPPORT_GRANT_WINDOW_CAPACITY
    )
      throw new SupportGrantCapacityError("Support grant window capacity reached");
    const grant = SupportGrantSchema.parse({
      grantId: (this.options.idFactory ?? randomUUID)(),
      scope: parsed.scope,
      supportRef: parsed.supportRef,
      status: "active",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + parsed.durationSeconds * 1000).toISOString(),
    });
    this.persist(grant, "granted");
    return { ...grant };
  }
  revoke(id: string): SupportGrant | undefined {
    this.expire();
    const grant = this.grants.get(id);
    if (grant === undefined) return undefined;
    if (grant.status !== "active") return { ...grant };
    const revoked: SupportGrant = {
      ...grant,
      status: "revoked",
      revokedAt: this.options.clock().toISOString(),
    };
    this.persist(revoked, "revoked");
    return { ...revoked };
  }
  accessed(id: string, deviceId: string, routeClass: SupportRouteClass): boolean {
    const grant = this.active(id);
    if (grant === undefined) return false;
    if (this.options.telemetry === undefined && !this.options.requireAudit) return true;
    const key = this.options.deviceRefKey;
    if (key === undefined || key.byteLength !== 32)
      throw new Error("Support device reference key unavailable");
    this.audit({
      event: "body.support",
      action: "accessed",
      grantId: id,
      scope: grant.scope,
      deviceRef: `dv1_${createHmac("sha256", key)
        .update(`clankie-device-v1\0${deviceId}`)
        .digest("base64url")
        .slice(0, 22)}`,
      routeClass,
    });
    return true;
  }
  private audit(event: Parameters<BodyTelemetry["emit"]>[0]): void {
    if (this.options.telemetry === undefined && !this.options.requireAudit) return;
    if (this.options.telemetry?.audit === undefined || event.event !== "body.support")
      throw new Error("Mandatory support audit unavailable");
    this.options.telemetry.audit(event);
  }
  private retryAudit(alreadyAudited?: string): void {
    while (this.pendingAudit[0] !== undefined) {
      const pending = this.pendingAudit[0];
      try {
        if (pending.sourceEventId !== alreadyAudited) this.audit(pending.audit);
        this.options.recordEvent(
          "support.audit.recorded",
          `support:${pending.audit.grantId}`,
          this.options.clock().toISOString(),
          { schemaVersion: 1, sourceEventId: pending.sourceEventId },
        );
      } catch {
        return;
      }
      this.pendingAudit.shift();
    }
  }
  snapshot(): { revision: number; grants: SupportGrantMetadata[] } {
    this.expire();
    return {
      revision: this.revision,
      grants: [...this.grants.values()]
        .filter((grant) => Date.parse(grant.expiresAt) > this.options.clock().getTime())
        .map(({ supportRef: _ref, ...grant }) => grant),
    };
  }
}
