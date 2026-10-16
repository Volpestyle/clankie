import { randomUUID, createHmac } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
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

/**
 * The hosted host's shell watcher reads this beside the fleet's instance tags
 * and closes Systems Manager unless the tagged grant is listed active here, so a
 * revoke holds even while fleet sync is down. It can only narrow access: the
 * shell still needs the provisioner-only tag. Metadata only, no support ref.
 * Called every tick, it also restores a copy that diverged on disk.
 */
export function writeSupportGrantProjection(
  path: string,
  snapshot: { revision: number; grants: SupportGrantMetadata[] },
): void {
  const content = `${JSON.stringify({ schemaVersion: 1, ...snapshot })}\n`;
  // The volume is writable from inside the container: never follow a planted
  // link or block on a FIFO, and read a plain file only under the watcher's cap.
  const withRecord = <T>(flags: number, use: (fd: number) => T): T | undefined => {
    let fd: number;
    try {
      fd = openSync(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch {
      return undefined;
    }
    try {
      const stat = fstatSync(fd);
      return stat.isFile() && stat.size <= 1 << 20 ? use(fd) : undefined;
    } finally {
      closeSync(fd);
    }
  };
  const current = withRecord(constants.O_RDONLY, (fd) => readFileSync(fd, "utf8"));
  if (current === content) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { mode: 0o644 });
    renameSync(temporary, path);
  } catch (error) {
    // Truncation needs no free space, and an empty record closes the shell, so
    // a failed write never leaves a revoked or ended shell window listed active.
    const shell = (text: string | undefined) => {
      try {
        const grants = (JSON.parse(text ?? "") as { grants?: SupportGrantMetadata[] }).grants ?? [];
        return grants
          .filter((grant) => grant.scope === "shell" && grant.status === "active")
          .map((grant) => grant.grantId);
      } catch {
        return [];
      }
    };
    const allowed = new Set(shell(content));
    if (shell(current).some((grantId) => !allowed.has(grantId)))
      withRecord(constants.O_WRONLY, (fd) => ftruncateSync(fd, 0));
    throw error;
  }
}

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
