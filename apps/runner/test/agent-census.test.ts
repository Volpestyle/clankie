import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SqliteEventStore } from "@clankie/event-store";
import type { AgentObservation } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { AgentCensusService, takeAgentCensus } from "../src/agent-census.ts";
import { herdrPaneToAgentObservation } from "../src/herdr-provider.ts";
import type { ProcessLease } from "../src/process-leases.ts";
import { agentDeclarationPath, WorkerAdoptionStore } from "../src/worker-adoptions.ts";

const now = new Date("2026-08-07T00:00:00.000Z");

function observation(overrides: Partial<AgentObservation> = {}): AgentObservation {
  return {
    transport: "herdr",
    terminalId: "term_a",
    label: "A working agent",
    reportedStatus: "working",
    adoptable: true,
    harness: "claude",
    agentSessionId: "session-a",
    ...overrides,
  } as AgentObservation;
}

function lease(overrides: Partial<ProcessLease> = {}): ProcessLease {
  return {
    id: "lease-1",
    missionId: "m-1",
    taskId: "t-1",
    workerRunId: "run-1",
    profileHash: "profile-abc",
    pid: 4242,
    processStartedAt: "identity",
    runnerPid: 1,
    state: "live",
    registeredAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    expiresAt: now.toISOString(),
    ...overrides,
  };
}

async function makeStore(): Promise<{
  store: WorkerAdoptionStore;
  rootDir: string;
  events: SqliteEventStore;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "clankie-census-"));
  const events = new SqliteEventStore(":memory:");
  let sequence = 0;
  const store = new WorkerAdoptionStore({
    rootDir,
    events,
    clock: () => now,
    idFactory: () => `id-${String(++sequence)}`,
  });
  return { store, rootDir, events };
}

describe("takeAgentCensus", () => {
  it("distinguishes an unreachable transport from a quiet machine", async () => {
    const { store } = await makeStore();

    const census = await takeAgentCensus({
      runnerId: "local",
      observations: undefined,
      leases: [],
      adoptions: store,
      clock: () => now,
    });

    expect(census.transportAvailable).toBe(false);
    expect(census.entries).toEqual([]);
    expect(census.counts).toEqual({ owned: 0, adopted: 0, lapsed: 0, unclaimed: 0 });
  });

  it("reports a live agent nobody has claimed, and does not adopt it", async () => {
    const { store } = await makeStore();

    const census = await takeAgentCensus({
      runnerId: "local",
      observations: [observation()],
      leases: [],
      adoptions: store,
      clock: () => now,
    });

    expect(census.transportAvailable).toBe(true);
    expect(census.entries).toHaveLength(1);
    expect(census.entries[0]?.classification).toBe("unclaimed");
    expect(census.entries[0]?.adoptionId).toBeUndefined();
    expect(census.counts.unclaimed).toBe(1);
    expect(await store.list()).toEqual([]);
  });

  it("recognizes a worker this runner spawned by its own workerRunId", async () => {
    const { store } = await makeStore();

    const census = await takeAgentCensus({
      runnerId: "local",
      observations: [observation({ agentSessionId: "run-1" })],
      leases: [lease()],
      adoptions: store,
      clock: () => now,
    });

    expect(census.entries[0]).toMatchObject({
      classification: "owned",
      workerRunId: "run-1",
      missionId: "m-1",
      taskId: "t-1",
    });
  });

  it("does not treat a settled lease as ownership of a live pane", async () => {
    const { store } = await makeStore();

    const census = await takeAgentCensus({
      runnerId: "local",
      observations: [observation({ agentSessionId: "run-1" })],
      leases: [lease({ state: "completed" })],
      adoptions: store,
      clock: () => now,
    });

    expect(census.entries[0]?.classification).toBe("unclaimed");
  });

  it("reports an adopted agent with its grade and a lapsed one with its cause", async () => {
    const { store } = await makeStore();
    await store.adopt(
      {
        schemaVersion: 1,
        transport: "herdr",
        terminalId: "term_a",
        grade: "directed",
        writeScope: ["apps/**"],
        adoptedBy: { kind: "operator", id: "james" },
      },
      observation(),
    );
    await store.adopt(
      {
        schemaVersion: 1,
        transport: "herdr",
        terminalId: "term_b",
        grade: "observed",
        writeScope: [],
        adoptedBy: { kind: "captain", id: "eve" },
      },
      observation({ terminalId: "term_b", agentSessionId: "session-b" }),
    );
    // term_b's agent restarted; term_a's did not.
    await store.reconcile([observation(), observation({ terminalId: "term_b", agentSessionId: "new" })]);

    const census = await takeAgentCensus({
      runnerId: "local",
      observations: [observation(), observation({ terminalId: "term_b", agentSessionId: "new" })],
      leases: [],
      adoptions: store,
      clock: () => now,
    });

    expect(census.entries[0]).toMatchObject({ classification: "adopted", grade: "directed" });
    expect(census.entries[1]).toMatchObject({
      classification: "lapsed",
      grade: "observed",
      lapseReason: "session_replaced",
    });
    expect(census.counts).toEqual({ owned: 0, adopted: 1, lapsed: 1, unclaimed: 0 });
  });

  it("keeps the agent's own words separate from what the runner observed", async () => {
    const { store, rootDir } = await makeStore();
    const path = agentDeclarationPath(rootDir, "term_a");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        terminalId: "term_a",
        status: "blocked",
        objective: "Waiting on a review",
        writeScope: ["docs/**"],
        declaredAt: now.toISOString(),
      }),
      "utf8",
    );

    const census = await takeAgentCensus({
      runnerId: "local",
      observations: [observation()],
      leases: [],
      adoptions: store,
      clock: () => now,
    });

    const digest = census.entries[0]?.digest;
    expect(digest?.runnerObserved.reportedStatus).toBe("working");
    expect(digest?.selfDeclared?.status).toBe("blocked");
    expect(digest?.selfDeclared?.objective).toBe("Waiting on a review");
  });

  it("is byte-identical across repeated runs regardless of transport order", async () => {
    const { store } = await makeStore();
    const agents = [
      observation({ terminalId: "term_c", agentSessionId: "c" }),
      observation({ terminalId: "term_a", agentSessionId: "a" }),
      observation({ terminalId: "term_b", agentSessionId: "b" }),
    ];

    const first = await takeAgentCensus({
      runnerId: "local",
      observations: agents,
      leases: [],
      adoptions: store,
      clock: () => now,
    });
    const second = await takeAgentCensus({
      runnerId: "local",
      observations: [...agents].reverse(),
      leases: [],
      adoptions: store,
      clock: () => now,
    });

    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    expect(first.entries.map((entry) => entry.digest.runnerObserved.terminalId)).toEqual([
      "term_a",
      "term_b",
      "term_c",
    ]);
  });

  it("reports how many agents it could not fit rather than truncating silently", async () => {
    const { store } = await makeStore();
    const agents = Array.from({ length: 260 }, (_unused, index) =>
      observation({
        terminalId: `term_${String(index).padStart(4, "0")}`,
        agentSessionId: `session-${String(index)}`,
      }),
    );

    const census = await takeAgentCensus({
      runnerId: "local",
      observations: agents,
      leases: [],
      adoptions: store,
      clock: () => now,
    });

    expect(census.entries).toHaveLength(256);
    expect(census.truncated).toBe(4);
  });
});

describe("AgentCensusService.direct", () => {
  const adoptRequest = {
    schemaVersion: 1 as const,
    transport: "herdr" as const,
    terminalId: "term_a",
    grade: "directed" as const,
    writeScope: ["apps/**"],
    adoptedBy: { kind: "operator" as const, id: "james" },
  };
  const directedBy = { kind: "captain" as const, id: "eve" };

  async function makeService(
    overrides: {
      observations?: readonly AgentObservation[] | undefined;
      deliver?: (terminalId: string, text: string) => Promise<"delivered" | "terminal_gone">;
      grade?: "observed" | "directed";
    } = {},
  ) {
    const { store, events } = await makeStore();
    const delivered: Array<{ terminalId: string; text: string }> = [];
    const adopted = await store.adopt(
      overrides.grade === "observed" ? { ...adoptRequest, grade: "observed", writeScope: [] } : adoptRequest,
      observation(),
    );
    if (adopted.outcome !== "adopted") throw new Error("expected adoption");
    const service = new AgentCensusService({
      runnerId: "local",
      adoptions: store,
      observe: () => Promise.resolve("observations" in overrides ? overrides.observations : [observation()]),
      leases: () => Promise.resolve([]),
      deliver:
        overrides.deliver ??
        ((terminalId, text) => {
          delivered.push({ terminalId, text });
          return Promise.resolve("delivered");
        }),
      clock: () => now,
    });
    return { service, store, events, delivered, adoptionId: adopted.adoption.adoptionId };
  }

  it("delivers bounded direction to the adopted agent's terminal", async () => {
    const { service, delivered, adoptionId } = await makeService();

    const result = await service.direct({
      schemaVersion: 1,
      adoptionId,
      text: "focus on the failing test",
      directedBy,
    });

    expect(result.outcome).toBe("delivered");
    expect(delivered).toEqual([{ terminalId: "term_a", text: "focus on the failing test" }]);
  });

  it("records that direction happened without recording what was said", async () => {
    const { service, events, adoptionId } = await makeService();
    await service.direct({ schemaVersion: 1, adoptionId, text: "secret plan", directedBy });

    const stored = await events.readAll();
    const directed = stored.find((entry) => entry.event.type === "worker.adoption.directed");
    expect(directed?.event.data).toMatchObject({ directedByKind: "captain", textLength: 11 });
    expect(JSON.stringify(directed?.event.data)).not.toContain("secret plan");
  });

  it("refuses to talk to an observed adoption", async () => {
    const { service, delivered, adoptionId } = await makeService({ grade: "observed" });

    const result = await service.direct({ schemaVersion: 1, adoptionId, text: "hello", directedBy });

    expect(result).toEqual({ outcome: "refused", reason: "not_directed" });
    expect(delivered).toEqual([]);
  });

  it("re-verifies the binding immediately before delivering", async () => {
    const { service, delivered, adoptionId } = await makeService({
      observations: [observation({ agentSessionId: "someone-else" })],
    });

    const result = await service.direct({ schemaVersion: 1, adoptionId, text: "hello", directedBy });

    expect(result).toEqual({ outcome: "refused", reason: "binding_lapsed" });
    expect(delivered).toEqual([]);
  });

  it("refuses when the transport cannot be asked", async () => {
    const { service, adoptionId } = await makeService({ observations: undefined });

    const result = await service.direct({ schemaVersion: 1, adoptionId, text: "hello", directedBy });

    expect(result).toEqual({ outcome: "refused", reason: "transport_unavailable" });
  });

  it("reports a terminal that vanished between check and send", async () => {
    const { service, adoptionId } = await makeService({
      deliver: () => Promise.resolve("terminal_gone"),
    });

    const result = await service.direct({ schemaVersion: 1, adoptionId, text: "hello", directedBy });

    expect(result).toEqual({ outcome: "refused", reason: "binding_lapsed" });
  });

  it("refuses an unknown adoption", async () => {
    const { service } = await makeService();

    const result = await service.direct({
      schemaVersion: 1,
      adoptionId: "nope",
      text: "hello",
      directedBy,
    });

    expect(result).toEqual({ outcome: "refused", reason: "unknown_adoption" });
  });
});

describe("herdrPaneToAgentObservation", () => {
  it("maps an agent pane to an adoptable observation", () => {
    const observed = herdrPaneToAgentObservation({
      agent: "claude",
      agent_session: { agent: "claude", kind: "id", source: "herdr:claude", value: "sess-1" },
      agent_status: "working",
      cwd: "/Users/james/dev/clankie",
      pane_id: "w12:p1Z",
      terminal_id: "term_6581afd5edc966c",
      terminal_title_stripped: "Evaluate Clankie as agent router",
    });

    expect(observed).toEqual({
      transport: "herdr",
      terminalId: "term_6581afd5edc966c",
      label: "Evaluate Clankie as agent router",
      reportedStatus: "working",
      adoptable: true,
      harness: "claude",
      agentSessionId: "sess-1",
      cwd: "/Users/james/dev/clankie",
    });
  });

  it("reports a plain shell pane but never marks it adoptable", () => {
    const observed = herdrPaneToAgentObservation({
      agent_status: "unknown",
      cwd: "/Users/james/dev/clankie",
      pane_id: "w12:p10",
      terminal_id: "term_6581b016e7f3f6d",
      terminal_title_stripped: "james@Jamess-MacBook-Pro:~/dev/clankie",
    });

    expect(observed).toMatchObject({ adoptable: false, reportedStatus: "unknown" });
    expect(observed?.harness).toBeUndefined();
    expect(observed?.agentSessionId).toBeUndefined();
    expect(observed?.cwd).toBe("/Users/james/dev/clankie");
  });

  it("replaces a label the terminal-plane sanitizer rejects", () => {
    const observed = herdrPaneToAgentObservation({
      agent_status: "unknown",
      pane_id: "w12:p10",
      terminal_id: "term_leaky",
      terminal_title_stripped: "editing ~/dev/secret-project",
    });

    expect(observed?.label).toBe("Herdr pane");
  });

  it("refuses to bind to a session the transport only inferred", () => {
    const observed = herdrPaneToAgentObservation({
      agent: "codex",
      agent_session: { agent: "codex", kind: "inferred", value: "guess" },
      agent_status: "idle",
      terminal_id: "term_x",
      terminal_title_stripped: "clankie",
    });

    expect(observed?.adoptable).toBe(false);
    expect(observed?.harness).toBe("codex");
  });

  it("degrades an unrecognized status to unknown instead of dropping the pane", () => {
    const observed = herdrPaneToAgentObservation({
      agent: "claude",
      agent_session: { agent: "claude", kind: "id", value: "sess-2" },
      agent_status: "spelunking",
      terminal_id: "term_y",
      terminal_title_stripped: "Something new",
    });

    expect(observed).toMatchObject({ reportedStatus: "unknown", adoptable: true });
  });

  it("omits a pane with no terminal identity", () => {
    expect(herdrPaneToAgentObservation({ agent: "claude", pane_id: "w1:p1" })).toBeUndefined();
    expect(herdrPaneToAgentObservation("not a pane")).toBeUndefined();
  });
});
