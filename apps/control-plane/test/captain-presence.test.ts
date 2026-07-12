import { resolve } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { seal, verifyChain, type EventStore, type StoredEvent } from "@clankie/event-store";
import type { CaptainPresenceEvent, DomainEvent } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createControlPlane } from "../src/app.ts";
import { CaptainPresenceManager } from "../src/captain-presence.ts";

function report(eventId: string, type: "captain.heartbeat" | "captain.turn.started" = "captain.heartbeat") {
  return {
    schemaVersion: 1 as const,
    eventId,
    leaseId: "lease-1",
    generationId: "generation-1",
    occurredAt: "2026-07-11T12:00:00.000Z",
    type,
    ...(type === "captain.turn.started" ? { sessionId: "session-1", turnId: "turn-1" } : {}),
  };
}

function harness(replayEvents: readonly CaptainPresenceEvent[] = []) {
  let now = new Date("2026-07-11T12:00:00.000Z");
  const events = [...replayEvents];
  const manager = new CaptainPresenceManager({
    profileHash: "profile-1",
    replayEvents,
    clock: () => now,
    leaseDurationMs: 30_000,
    recordedHeartbeatIntervalMs: 10_000,
    scheduleExpiry: false,
    emit: ({ event }) => {
      if (!events.some((candidate) => candidate.id === event.id)) events.push(event);
      return Promise.resolve();
    },
  });
  return {
    events,
    manager,
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

class MemoryEventStore implements EventStore {
  public readonly entries: StoredEvent[] = [];

  public append(event: DomainEvent): Promise<StoredEvent> {
    const previousHash = this.entries.at(-1)?.hash ?? "GENESIS";
    const stored = seal(event, this.entries.length + 1, previousHash);
    this.entries.push(stored);
    return Promise.resolve(stored);
  }

  public readAll(): Promise<StoredEvent[]> {
    return Promise.resolve([...this.entries]);
  }

  public verify() {
    return Promise.resolve(verifyChain(this.entries));
  }
}

describe("CaptainPresenceManager", () => {
  it("registers and renews idempotently while recording heartbeats sparsely", async () => {
    const test = harness();
    const started = await test.manager.receive("captain-eve", report("turn-1", "captain.turn.started"));
    expect(started.emitted.map((event) => event.type)).toEqual([
      "captain.presence.online",
      "captain.turn.started",
    ]);
    expect(started.lease).toMatchObject({
      state: "live",
      heartbeatAt: "2026-07-11T12:00:00.000Z",
      expiresAt: "2026-07-11T12:00:30.000Z",
    });

    test.advance(1_000);
    const duplicate = await test.manager.receive("captain-eve", report("turn-1", "captain.turn.started"));
    expect(duplicate.emitted).toEqual([]);
    expect(duplicate.lease.expiresAt).toBe("2026-07-11T12:00:31.000Z");

    test.advance(4_000);
    expect((await test.manager.receive("captain-eve", report("beat-1"))).emitted).toEqual([]);
    test.advance(5_000);
    expect((await test.manager.receive("captain-eve", report("beat-2"))).emitted).toEqual([
      expect.objectContaining({ type: "captain.heartbeat" }),
    ]);
    expect(test.events.map((event) => event.type)).toEqual([
      "captain.presence.online",
      "captain.turn.started",
      "captain.heartbeat",
    ]);
  });

  it("ingests reports through captain auth and reaps the durable lease outside Eve", async () => {
    const profilePath = resolve(import.meta.dirname, "../../../doctrine/profiles/self-build-lab.yaml");
    const doctrine = compileDoctrine([await loadDoctrineFile(profilePath)]);
    const eventStore = new MemoryEventStore();
    const authenticateCaptain = (request: Request) =>
      Promise.resolve(
        request.headers.get("authorization") === "Bearer captain-secret"
          ? { captainId: "captain-eve" }
          : undefined,
      );
    const unavailable = await createControlPlane({ doctrine, authenticateCaptain });
    expect(
      (
        await unavailable.request("/v1/captain/presence", {
          method: "POST",
          headers: { authorization: "Bearer captain-secret", "content-type": "application/json" },
          body: JSON.stringify(report("no-store")),
        })
      ).status,
    ).toBe(503);
    const app = await createControlPlane({
      doctrine,
      eventStore,
      captainLeaseDurationMs: 100,
      captainHeartbeatRecordIntervalMs: 20,
      authenticateCaptain,
    });
    const body = JSON.stringify(report("route-heartbeat"));

    expect(
      (
        await app.request("/v1/captain/presence", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/v1/captain/presence", {
          method: "POST",
          headers: { authorization: "Bearer captain-secret", "content-type": "application/json" },
          body: JSON.stringify({ ...report("invalid-offline"), type: "captain.presence.offline" }),
        })
      ).status,
    ).toBe(400);

    const accepted = await app.request("/v1/captain/presence", {
      method: "POST",
      headers: { authorization: "Bearer captain-secret", "content-type": "application/json" },
      body,
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      accepted: true,
      lease: { captainId: "captain-eve", state: "live" },
      events: [{ type: "captain.presence.online" }, { type: "captain.heartbeat" }],
    });

    const duplicate = await app.request("/v1/captain/presence", {
      method: "POST",
      headers: { authorization: "Bearer captain-secret", "content-type": "application/json" },
      body,
    });
    expect(duplicate.status).toBe(202);
    expect(await duplicate.json()).toMatchObject({ accepted: true, events: [] });

    await expect
      .poll(() => eventStore.entries.map(({ event }) => event.type))
      .toEqual(["captain.presence.online", "captain.heartbeat", "captain.presence.offline"]);
    expect(await eventStore.verify()).toEqual({ valid: true, count: 3 });
  });

  it("emits one offline event at expiry and restores the lease from replay", async () => {
    const first = harness();
    await first.manager.receive("captain-eve", report("initial-beat"));
    expect(first.events.map((event) => event.type)).toEqual(["captain.presence.online", "captain.heartbeat"]);

    const restarted = harness(first.events);
    restarted.advance(30_000);
    expect(await restarted.manager.expireStale()).toMatchObject({
      type: "captain.presence.offline",
      data: { state: "offline", reason: "lease_expired" },
    });
    expect(await restarted.manager.expireStale()).toBeUndefined();
    expect(restarted.manager.snapshot()).toMatchObject({ state: "offline" });
    expect(restarted.events.filter((event) => event.type === "captain.presence.offline")).toHaveLength(1);
  });

  it("rejects a second lease masquerading as the live generation", async () => {
    const test = harness();
    await test.manager.receive("captain-eve", report("initial-beat"));
    await expect(
      test.manager.receive("captain-eve", { ...report("stolen"), leaseId: "lease-stolen" }),
    ).rejects.toThrow(/different captain identity/);
    expect(test.manager.snapshot()).toMatchObject({ leaseId: "lease-1", state: "live" });
  });

  it("supersedes an old generation with explicit offline then online events", async () => {
    const test = harness();
    await test.manager.receive("captain-eve", report("initial-beat"));
    test.advance(1_000);
    const replacement = await test.manager.receive("captain-eve", {
      ...report("replacement"),
      leaseId: "lease-2",
      generationId: "generation-2",
    });
    expect(
      replacement.emitted.map((event) => [
        event.type,
        "reason" in event.data ? event.data.reason : undefined,
      ]),
    ).toEqual([
      ["captain.presence.offline", "superseded"],
      ["captain.presence.online", undefined],
      ["captain.heartbeat", undefined],
    ]);
    expect(replacement.lease).toMatchObject({
      leaseId: "lease-2",
      generationId: "generation-2",
      state: "live",
    });
  });
});
