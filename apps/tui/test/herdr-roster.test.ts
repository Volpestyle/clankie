import { expect, it, vi } from "vitest";
import {
  OperatorFleetSeatSchema,
  OperatorFleetSnapshotSchema,
  OperatorConversationSchema,
  type OperatorFleetSnapshot,
} from "@clankie/protocol";
import { HerdrRoster } from "../src/observation/herdr-roster.ts";

it("shows the service fleet in every console and reports a failed read", async () => {
  let failed = false;
  const seat = OperatorFleetSeatSchema.parse({
    seatId: "terminal-1",
    occupantId: "agent-1",
    personaId: "persona-1",
    harness: "codex",
    status: "working",
    title: "fixing tests",
  });
  const client = {
    roster: async () => {
      if (failed) throw new Error("service unavailable");
      return [seat];
    },
    terminalCatalog: async () => [
      {
        terminalId: "terminal-1",
        label: "tests",
        workspace: { id: "w1", number: 1, label: "work" },
        tab: { id: "w1:t1", number: 1, label: "work" },
        pane: { id: "w1:p1" },
      },
    ],
  };
  // No caller environment or local CLI enters this path.
  const consoles = [new HerdrRoster(client), new HerdrRoster(client)];
  for (const console of consoles) {
    expect(await console.poll()).toBe(true);
    expect(console.snapshot()).toMatchObject({
      agents: [{ paneId: "w1:p1", agent: "codex", status: "working", title: "fixing tests" }],
    });
    expect(await console.poll()).toBe(false);
  }
  failed = true;
  await consoles[0]!.poll();
  expect(consoles[0]!.snapshot()).toMatchObject({ agents: [], error: "service unavailable" });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function fleetSnapshot(cursor: string, status: "working" | "idle"): OperatorFleetSnapshot {
  return OperatorFleetSnapshotSchema.parse({
    schemaVersion: 1,
    cursor,
    seats: [
      {
        seatId: "terminal-1",
        occupantId: "agent-1",
        personaId: "persona-1",
        harness: "claude",
        status,
        title: "short turn",
      },
    ],
    personas: [],
    channels: [],
  });
}

it("follows handoff status and results without manufacturing seats or panes", async () => {
  const child = OperatorConversationSchema.parse({
    schemaVersion: 1,
    conversationId: "voice-job",
    scope: { kind: "global" },
    title: "Bakery hours",
    isDefault: false,
    sessionState: "waiting",
    revision: 1,
    createdAt: "2026-10-05T12:00:00.000Z",
    updatedAt: "2026-10-05T12:00:00.000Z",
    roomHandoff: {
      roomConversationId: "voice-room",
      deliveryId: "voice-delivery",
      actorId: "James",
      source: "voice",
      request: "Check the bakery hours",
      state: "running",
      host: "pi",
    },
  });
  const resources = {
    schemaVersion: 1,
    policy: {},
    capacity: { heavySlots: 2, simulatorSlots: 1, used: 1 },
    pressure: { sampledAtMs: 1, loadRatio: 0.1, availableMemoryMb: 10000, healthy: true },
    leases: [
      {
        id: "owned-lease",
        kind: "heavy",
        state: "running",
        seatId: "builder",
        pid: 123,
        executable: "node",
        createdAtMs: 1,
        lastUsedAtMs: 1,
      },
    ],
    queue: [],
  };
  const waits: ReturnType<typeof deferred<OperatorFleetSnapshot>>[] = [];
  const roster = new HerdrRoster({
    roster: async () => [],
    fleet: async () => {
      const wait = deferred<OperatorFleetSnapshot>();
      waits.push(wait);
      return wait.promise;
    },
  });
  const change = vi.fn();
  roster.start(change);
  await vi.waitFor(() => expect(waits).toHaveLength(1));
  waits[0]!.resolve(
    OperatorFleetSnapshotSchema.parse({
      schemaVersion: 1,
      cursor: "running",
      resources,
      seats: [],
      personas: [],
      channels: [],
      roomHandoffs: [child],
    }),
  );
  await vi.waitFor(() => expect(waits).toHaveLength(2));
  expect(roster.snapshot()).toMatchObject({ agents: [], liveAgents: [], roomHandoffs: [child] });
  expect(roster.snapshot().resources?.leases[0]).toMatchObject({
    seatId: "builder",
    pid: 123,
    executable: "node",
  });
  const finished = {
    ...child,
    roomHandoff: { ...child.roomHandoff!, state: "completed", result: "Open until six" },
  };
  waits[1]!.resolve(
    OperatorFleetSnapshotSchema.parse({
      schemaVersion: 1,
      cursor: "completed",
      resources: { ...resources, capacity: { ...resources.capacity, used: 0 }, leases: [] },
      seats: [],
      personas: [],
      channels: [],
      roomHandoffs: [finished],
    }),
  );
  await vi.waitFor(() => expect(waits).toHaveLength(3));
  expect(change).toHaveBeenCalledTimes(2);
  expect(roster.snapshot().resources?.leases).toEqual([]);
  expect(roster.snapshot().roomHandoffs?.[0]?.roomHandoff).toMatchObject({
    state: "completed",
    result: "Open until six",
  });
  roster.stop();
});

it("repaints on the fleet cursor the moment Herdr changes, with no roster poll (ADR 0150)", async () => {
  const waits: { cursor: string | undefined; reply: ReturnType<typeof deferred<OperatorFleetSnapshot>> }[] =
    [];
  let rosterReads = 0;
  let aborted = false;
  const client = {
    roster: async () => {
      rosterReads += 1;
      return [];
    },
    fleet: (cursor?: string, signal?: AbortSignal) => {
      const reply = deferred<OperatorFleetSnapshot>();
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      waits.push({ cursor, reply });
      return reply.promise;
    },
  };
  const roster = new HerdrRoster(client);
  let changes = 0;
  roster.start(() => {
    changes += 1;
  });
  await vi.waitFor(() => expect(waits).toHaveLength(1));
  expect(waits[0]!.cursor).toBeUndefined();
  waits[0]!.reply.resolve(fleetSnapshot("c1", "working"));
  await vi.waitFor(() => expect(waits).toHaveLength(2));
  expect(waits[1]!.cursor).toBe("c1");
  expect(changes).toBe(1);
  expect(roster.snapshot().agents).toEqual([
    { paneId: "terminal-1", agent: "claude", status: "working", title: "short turn" },
  ]);

  // A turn shorter than any poll interval still lands: the parked wait answers.
  waits[1]!.reply.resolve(fleetSnapshot("c2", "idle"));
  await vi.waitFor(() => expect(waits).toHaveLength(3));
  expect(waits[2]!.cursor).toBe("c2");
  expect(changes).toBe(2);
  expect(roster.snapshot().agents[0]?.status).toBe("idle");
  expect(rosterReads).toBe(0);

  roster.stop();
  expect(aborted).toBe(true);
});

it("falls back to a roster read while the fleet cursor is unavailable", async () => {
  const seat = OperatorFleetSeatSchema.parse({
    seatId: "terminal-1",
    occupantId: "agent-1",
    personaId: "persona-1",
    harness: "codex",
    status: "working",
    title: "older host",
  });
  let rosterReads = 0;
  const client = {
    roster: async () => {
      rosterReads += 1;
      return [seat];
    },
    fleet: async () => {
      throw new Error("Unknown op fleet");
    },
  };
  const roster = new HerdrRoster(client);
  let changes = 0;
  roster.start(() => {
    changes += 1;
  });
  await vi.waitFor(() => expect(changes).toBe(1));
  roster.stop();
  expect(rosterReads).toBe(1);
  expect(roster.snapshot().agents).toEqual([
    { paneId: "terminal-1", agent: "codex", status: "working", title: "older host" },
  ]);
});

it("keeps names, qualified seats, remote machines and steps when terminal observation is unavailable", async () => {
  const snapshot = fleetSnapshot("qualified", "working");
  const local = snapshot.seats[0]!;
  const remote = {
    ...local,
    seatId: "pc/terminal-1",
    personaId: "remote-worker",
    machine: "Office PC",
    fleet: "pc",
    title: "Checking PC delivery",
  };
  const roster = new HerdrRoster({
    roster: async () => [{ ...remote, status: "done" }],
    terminalCatalog: async () => {
      throw new Error("No remote terminal observation");
    },
    fleet: async (_cursor, signal) => {
      if (_cursor) await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
      return {
        ...snapshot,
        seats: [local, remote],
        personas: [
          {
            schemaVersion: 1,
            personaId: "remote-worker",
            name: "Morgan",
            harness: "claude",
            createdAt: "2026-10-03T00:00:00.000Z",
            updatedAt: "2026-10-03T00:00:00.000Z",
            appearance: { variant: "green", accessory: "none", shape: "circle" },
          },
        ],
      } as OperatorFleetSnapshot;
    },
  });
  roster.start(() => {});
  await vi.waitFor(() => expect(roster.snapshot().liveAgents).toHaveLength(2));
  roster.stop();
  expect(roster.snapshot().liveAgents).toContainEqual({ name: "Morgan", seat: remote });
  expect(roster.snapshot().error).toBeUndefined();
  await roster.poll();
  expect(roster.snapshot().liveAgents).toEqual([{ name: "Morgan", seat: { ...remote, status: "done" } }]);
});
