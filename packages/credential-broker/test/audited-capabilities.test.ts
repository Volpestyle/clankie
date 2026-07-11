import { describe, expect, it } from "vitest";
import {
  AuditedCapabilityBroker,
  CapabilityTokenError,
  CapabilityTokenIssuer,
  MAX_CAPABILITY_TTL_SECONDS,
  type CapabilityAuditEnvelope,
  type CapabilityAuditEvent,
  type CapabilityAuditSink,
  type CapabilityGrant,
} from "../src/index.ts";

const grant: CapabilityGrant = {
  version: 1,
  grantId: "grant-1",
  principalId: "worker-run-1",
  missionId: "mission-1",
  profileHash: "profile-1",
  capabilities: ["github.pr.comment"],
  resources: ["acme/repo#12"],
  obligations: ["use_merge_queue"],
  issuedAt: 100,
  expiresAt: 200,
  nonce: "secret-nonce",
};

const context = {
  missionId: grant.missionId,
  workerRunId: grant.principalId,
  correlationId: "correlation-1",
  profileHash: "profile-1",
  taskId: "task-1",
};

class MemoryAuditSink implements CapabilityAuditSink {
  public readonly events: CapabilityAuditEvent[] = [];

  public append(event: CapabilityAuditEvent): Promise<void> {
    const existing = this.events.find((candidate) => candidate.id === event.id);
    if (existing) return Promise.reject(new Error(`duplicate event id ${event.id}`));
    this.events.push(structuredClone(event));
    return Promise.resolve();
  }

  public readAll(): Promise<CapabilityAuditEnvelope[]> {
    return Promise.resolve(this.events.map((event) => ({ event: structuredClone(event) })));
  }
}

describe("CapabilityTokenIssuer", () => {
  it("rejects invalid or overly long windows and tokens used before their issue time", () => {
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    expect(() => issuer.issue({ ...grant, expiresAt: grant.issuedAt })).toThrow(/expiresAt/);
    expect(() =>
      issuer.issue({ ...grant, expiresAt: grant.issuedAt + MAX_CAPABILITY_TTL_SECONDS + 1 }),
    ).toThrow(/lifetime/);
    const token = issuer.issue(grant);
    expect(() => issuer.verify(token, 99)).toThrow(CapabilityTokenError);
    expect(() => issuer.verify(token, 99)).toThrow(/not yet valid/);
  });

  it("rejects noncanonical token encoding", () => {
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    const token = issuer.issue(grant);
    expect(() => issuer.verify(`${token}!`, 150)).toThrow(/encoding/);
  });

  it("requires a matching resource when the grant is resource-scoped", () => {
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    const verified = issuer.verify(issuer.issue(grant), 150);
    expect(verified.allows("github.pr.comment", "acme/repo#12")).toBe(true);
    expect(verified.allows("github.pr.comment")).toBe(false);
    expect(verified.allows("github.pr.comment", "acme/other#12")).toBe(false);
    expect(verified.grant.obligations).toEqual(["use_merge_queue"]);
  });
});

describe("AuditedCapabilityBroker", () => {
  it("audits issuance and every allowed or denied use without logging caller-controlled strings", async () => {
    const events = new MemoryAuditSink();
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    let eventId = 0;
    const broker = new AuditedCapabilityBroker(issuer, events, {
      clock: () => new Date("2026-07-11T04:00:00.000Z"),
      idFactory: () => `event-${String(++eventId)}`,
    });
    const token = await broker.issue(grant, context);
    const rawCredential = "sk-ant-raw-credential-value";

    await expect(
      broker.authorizeUse({ token, capability: "github.pr.merge", resource: rawCredential }, context, 150),
    ).resolves.toEqual({ allowed: false, reason: "capability_not_granted" });
    await expect(
      broker.authorizeUse({ token: "", capability: token, resource: grant.nonce }, context, 150),
    ).resolves.toEqual({ allowed: false, reason: "malformed" });
    await expect(
      broker.authorizeUse({ token, capability: "github.pr.comment", resource: "acme/repo#12" }, context, 150),
    ).resolves.toMatchObject({ allowed: true, reason: "allowed", grant: { grantId: grant.grantId } });
    await expect(
      broker.authorizeUse({ token, capability: "github.pr.comment", resource: "acme/repo#12" }, context, 150),
    ).resolves.toEqual({ allowed: false, reason: "replayed" });

    expect(events.events.map((event) => event.type)).toEqual([
      "capability.issued",
      "capability.use.denied",
      "capability.use.denied",
      "capability.use.allowed",
      "capability.use.denied",
    ]);
    expect(events.events[0]).toMatchObject({
      missionId: grant.missionId,
      workerRunId: grant.principalId,
      correlationId: context.correlationId,
      profileHash: context.profileHash,
      taskId: context.taskId,
      data: { expiresAt: grant.expiresAt },
    });
    const serialized = JSON.stringify(events.events);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(grant.nonce);
    expect(serialized).not.toContain(rawCredential);
    expect(serialized).not.toContain("github.pr.comment");
    expect(serialized).not.toContain("acme/repo#12");
    expect(serialized).not.toContain("use_merge_queue");
  });

  it("binds use to trusted mission/worker context and audits resource/time mismatches", async () => {
    const events = new MemoryAuditSink();
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    const broker = new AuditedCapabilityBroker(issuer, events);
    const token = issuer.issue(grant);
    const request = { token, capability: "github.pr.comment", resource: "acme/repo#12" };

    await expect(broker.authorizeUse(request, { ...context, missionId: "mission-2" }, 150)).resolves.toEqual({
      allowed: false,
      reason: "mission_mismatch",
    });
    await expect(
      broker.authorizeUse(request, { ...context, workerRunId: "worker-run-2" }, 150),
    ).resolves.toEqual({ allowed: false, reason: "principal_mismatch" });
    await expect(
      broker.authorizeUse(request, { ...context, profileHash: "profile-2" }, 150),
    ).resolves.toEqual({ allowed: false, reason: "profile_mismatch" });
    await expect(
      broker.authorizeUse({ ...request, resource: "acme/other#12" }, context, 150),
    ).resolves.toEqual({ allowed: false, reason: "resource_not_granted" });
    await expect(broker.authorizeUse(request, context, 201)).resolves.toEqual({
      allowed: false,
      reason: "expired",
    });
    expect(events.events.filter((event) => event.type === "capability.use.denied")).toHaveLength(5);
  });

  it("rejects issuance whose trusted identity does not match the grant", async () => {
    const broker = new AuditedCapabilityBroker(
      new CapabilityTokenIssuer(Buffer.alloc(32, 7)),
      new MemoryAuditSink(),
    );
    await expect(broker.issue(grant, { ...context, workerRunId: "other-run" })).rejects.toThrow(
      /trusted audit context/,
    );
  });

  it("rehydrates one-use replay protection and resolves cross-broker races fail-closed", async () => {
    const events = new MemoryAuditSink();
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    const token = issuer.issue(grant);
    const request = { token, capability: "github.pr.comment", resource: "acme/repo#12" };
    const first = new AuditedCapabilityBroker(issuer, events);
    const second = new AuditedCapabilityBroker(issuer, events);

    const decisions = await Promise.all([
      first.authorizeUse(request, context, 150),
      second.authorizeUse(request, context, 150),
    ]);
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => decision.reason === "replayed")).toHaveLength(1);

    const restarted = new AuditedCapabilityBroker(issuer, events);
    await expect(restarted.authorizeUse(request, context, 150)).resolves.toEqual({
      allowed: false,
      reason: "replayed",
    });
    expect(events.events.filter((event) => event.type === "capability.use.allowed")).toHaveLength(1);
  });

  it("fails closed when the audit event cannot be appended", async () => {
    const failure = new Error("audit unavailable");
    const events: CapabilityAuditSink = {
      append: () => Promise.reject(failure),
      readAll: () => Promise.resolve([]),
    };
    const issuer = new CapabilityTokenIssuer(Buffer.alloc(32, 7));
    const broker = new AuditedCapabilityBroker(issuer, events);

    await expect(broker.issue(grant, context)).rejects.toThrow("audit unavailable");
    const token = issuer.issue(grant);
    await expect(
      broker.authorizeUse({ token, capability: "github.pr.comment", resource: "acme/repo#12" }, context, 150),
    ).rejects.toThrow("audit unavailable");
  });
});
