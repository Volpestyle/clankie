import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore } from "@clankie/event-store";
import { MemoryStore, type MemoryFact } from "@clankie/memory-store";
import type { DomainEvent } from "@clankie/protocol";
import { beforeAll, describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";

let doctrine: ReturnType<typeof compileDoctrine>;

beforeAll(async () => {
  doctrine = compileDoctrine([
    await loadDoctrineFile(resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml")),
  ]);
});

function memoryFact(
  id: string,
  body: string,
  sourceKind: "semantic-event" | "raw-transcript" = "semantic-event",
): MemoryFact {
  return {
    schemaVersion: 1,
    factId: id,
    category: "repo-knowledge",
    body,
    provenance: {
      missionId: "mission-memory",
      correlationId: "correlation-memory",
      sourceEventId: `source-${id}`,
      sourceKind,
      publicSource: false,
    },
    confidence: 0.9,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

function proposalBody(id: string, body: string): string {
  return JSON.stringify({ schemaVersion: 1, proposalId: id, fact: memoryFact(`fact-${id}`, body) });
}

function worker() {
  return Promise.resolve({
    missionId: "mission-memory",
    workerRunId: "worker-memory",
    correlationId: "correlation-memory",
    profileHash: doctrine.profileHash,
  });
}

const operator = (request: Request) =>
  Promise.resolve(
    request.headers.get("authorization") === "Bearer operator" ? { operatorId: "operator-james" } : undefined,
  );

describe("memory-store control-plane wiring", () => {
  it("never mutates memory before the authenticated approval is recorded", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-memory-unapproved-"));
    const eventStore = new SqliteEventStore(join(root, "events.db"));
    const memoryStore = new MemoryStore(join(root, "memory.db"), { doctrine: doctrine.profile.memory });
    const app = await createControlPlane({
      doctrine,
      eventStore,
      memoryStore,
      authenticateWorker: worker,
      authenticateOperator: operator,
      clock: () => new Date("2026-07-12T00:00:00.000Z"),
    });
    const response = await app.request("/v1/memory/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: proposalBody("pending", "SQLite persists bounded mission memory"),
    });
    expect(response.status).toBe(202);
    expect(memoryStore.list()).toEqual([]);
    expect((await eventStore.readAll()).map(({ event }) => event.type)).toEqual(
      expect.arrayContaining(["memory.proposal.submitted", "approval.requested"]),
    );
    expect((await eventStore.readAll()).some(({ event }) => event.type === "memory.proposal.committed")).toBe(
      false,
    );
    memoryStore.close();
    eventStore.close();
  });

  it("denies proposals under high assurance without creating approval or memory", async () => {
    const highAssurance = compileDoctrine([
      doctrine.profile,
      await loadDoctrineFile(
        resolve(import.meta.dirname, "../../../doctrine/profiles/high-assurance-overlay.yaml"),
      ),
    ]);
    const root = await mkdtemp(join(tmpdir(), "clankie-memory-denied-"));
    const eventStore = new SqliteEventStore(join(root, "events.db"));
    const memoryStore = new MemoryStore(join(root, "memory.db"), { doctrine: highAssurance.profile.memory });
    const app = await createControlPlane({
      doctrine: highAssurance,
      eventStore,
      memoryStore,
      authenticateWorker: () =>
        Promise.resolve({
          missionId: "mission-memory",
          workerRunId: "worker-memory",
          correlationId: "correlation-memory",
          profileHash: highAssurance.profileHash,
        }),
    });
    const response = await app.request("/v1/memory/proposals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: proposalBody("denied", "This proposal must remain denied"),
    });
    expect(response.status).toBe(403);
    expect(memoryStore.list()).toEqual([]);
    const types = (await eventStore.readAll()).map(({ event }) => event.type);
    expect(types).toContain("memory.proposal.denied");
    expect(types).not.toContain("approval.requested");
    memoryStore.close();
    eventStore.close();
  });

  it("commits an approved proposal exactly once and remains idempotent after replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-memory-approved-"));
    const eventPath = join(root, "events.db");
    const memoryPath = join(root, "memory.db");
    let eventStore = new SqliteEventStore(eventPath);
    let memoryStore = new MemoryStore(memoryPath, { doctrine: doctrine.profile.memory });
    let app = await createControlPlane({
      doctrine,
      eventStore,
      memoryStore,
      authenticateWorker: worker,
      authenticateOperator: operator,
    });
    expect(
      (
        await app.request("/v1/memory/proposals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: proposalBody("approved", "Mission memory survives restart"),
        })
      ).status,
    ).toBe(202);
    const decision = await app.request("/v1/approvals/memory:approved/decision", {
      method: "POST",
      headers: { authorization: "Bearer operator", "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve", reason: "Reviewed the exact bounded fact." }),
    });
    expect(decision.status).toBe(200);
    expect(memoryStore.list()).toHaveLength(1);
    expect(
      (await eventStore.readAll()).filter(({ event }) => event.type === "memory.proposal.committed"),
    ).toHaveLength(1);
    memoryStore.close();
    eventStore.close();

    eventStore = new SqliteEventStore(eventPath);
    memoryStore = new MemoryStore(memoryPath, { doctrine: doctrine.profile.memory });
    app = await createControlPlane({
      doctrine,
      eventStore,
      memoryStore,
      authenticateWorker: worker,
      authenticateOperator: operator,
    });
    expect(memoryStore.list()).toHaveLength(1);
    expect(
      (await eventStore.readAll()).filter(({ event }) => event.type === "memory.proposal.committed"),
    ).toHaveLength(1);
    memoryStore.close();
    eventStore.close();
  });

  it("injects bounded recall into captain mission context at plan time", async () => {
    const root = await mkdtemp(join(tmpdir(), "clankie-memory-recall-"));
    const eventStore = new SqliteEventStore(join(root, "events.db"));
    const memoryStore = new MemoryStore(join(root, "memory.db"), { doctrine: doctrine.profile.memory });
    memoryStore.applyApprovedProposal({
      schemaVersion: 1,
      proposalId: "fixture-recall",
      approval: {
        approvalId: "fixture-approval",
        status: "approved",
        approvedAt: "2026-07-11T00:00:00.000Z",
        approvedBy: "fixture",
      },
      fact: memoryFact("recall", "SQLite memory uses deterministic retention pruning"),
    });
    const app = await createControlPlane({ doctrine, eventStore, memoryStore });
    const created = await app.request("/v1/missions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "Review SQLite retention" }),
    });
    const { missionId } = (await created.json()) as { missionId: string };
    const plan = {
      missionId,
      goal: "Review SQLite retention",
      rationale: "Use recalled repository knowledge.",
      tasks: [
        {
          id: "implement",
          title: "Review",
          objective: "Review SQLite retention",
          kind: "implementation",
          role: "implementer",
          writeScope: ["src/**"],
          successCriteria: ["Reviewed"],
          evidenceRequirements: ["Report"],
        },
        {
          id: "verify",
          title: "Verify",
          objective: "Verify review",
          kind: "verification",
          role: "verifier",
          dependsOn: ["implement"],
          successCriteria: ["Verified"],
          evidenceRequirements: ["Report"],
        },
      ],
      successCriteria: ["Done"],
      profileHash: doctrine.profileHash,
    };
    expect(
      (
        await app.request(`/v1/missions/${missionId}/plan`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(plan),
        })
      ).status,
    ).toBe(200);
    const mission = (await (await app.request(`/v1/missions/${missionId}`)).json()) as {
      context: { captainMissionContext: string };
    };
    expect(mission.context.captainMissionContext).toContain(doctrine.plannerCard);
    expect(mission.context.captainMissionContext).toContain(
      "SQLite memory uses deterministic retention pruning",
    );
    memoryStore.close();
    eventStore.close();
  });

  it("prunes immediately when the loaded doctrine retention differs from the prior run", async () => {
    const zeroRetention = compileDoctrine([
      {
        ...doctrine.profile,
        id: "zero-memory-retention",
        memory: { ...doctrine.profile.memory, rawTranscriptRetentionDays: 0 },
      },
    ]);
    const root = await mkdtemp(join(tmpdir(), "clankie-memory-prune-"));
    const eventStore = new SqliteEventStore(join(root, "events.db"));
    const prior: DomainEvent = {
      id: "prior-retention",
      occurredAt: "2026-07-10T00:00:00.000Z",
      missionId: "memory:retention",
      correlationId: "memory:retention",
      profileHash: doctrine.profileHash,
      type: "memory.retention.pruned",
      data: { reason: "maintenance", rawTranscriptRetentionDays: 7, prunedFactIds: [] },
    };
    await eventStore.append(prior);
    const memoryStore = new MemoryStore(join(root, "memory.db"), { doctrine: zeroRetention.profile.memory });
    memoryStore.applyApprovedProposal({
      schemaVersion: 1,
      proposalId: "old-raw",
      approval: {
        approvalId: "old-raw-approval",
        status: "approved",
        approvedAt: "2026-07-01T00:00:00.000Z",
        approvedBy: "fixture",
      },
      fact: memoryFact("old-raw", "Expired transcript-derived fact", "raw-transcript"),
    });
    await createControlPlane({
      doctrine: zeroRetention,
      eventStore,
      memoryStore,
      clock: () => new Date("2026-07-12T00:00:00.000Z"),
    });
    expect(memoryStore.list()).toEqual([]);
    expect((await eventStore.readAll()).at(-1)?.event).toMatchObject({
      type: "memory.retention.pruned",
      data: { reason: "doctrine_loaded", rawTranscriptRetentionDays: 0, prunedFactIds: ["old-raw"] },
    });
    memoryStore.close();
    eventStore.close();
  });
});
