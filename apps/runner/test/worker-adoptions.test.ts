import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SqliteEventStore } from "@clankie/event-store";
import type { AdoptWorkerRequest, AgentObservation } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { agentDeclarationPath, WorkerAdoptionStore } from "../src/worker-adoptions.ts";

const operator = { kind: "operator", id: "james" } as const;

function observation(overrides: Partial<AgentObservation> = {}): AgentObservation {
  return {
    transport: "herdr",
    terminalId: "term_a",
    label: "Build the census",
    reportedStatus: "working",
    adoptable: true,
    harness: "claude",
    agentSessionId: "session-a",
    ...overrides,
  } as AgentObservation;
}

function request(overrides: Partial<AdoptWorkerRequest> = {}): AdoptWorkerRequest {
  return {
    schemaVersion: 1,
    transport: "herdr",
    terminalId: "term_a",
    grade: "directed",
    writeScope: ["packages/protocol/**"],
    adoptedBy: operator,
    ...overrides,
  };
}

async function makeStore(): Promise<{
  store: WorkerAdoptionStore;
  events: SqliteEventStore;
  rootDir: string;
  now: { value: Date };
}> {
  const rootDir = await mkdtemp(join(tmpdir(), "clankie-adopt-"));
  const events = new SqliteEventStore(":memory:");
  const now = { value: new Date("2026-08-07T00:00:00.000Z") };
  let sequence = 0;
  const store = new WorkerAdoptionStore({
    rootDir,
    events,
    clock: () => now.value,
    idFactory: () => `id-${String(++sequence)}`,
    profileHash: "profile-abc",
  });
  return { store, events, rootDir, now };
}

async function eventTypes(events: SqliteEventStore): Promise<string[]> {
  return (await events.readAll()).map((entry) => entry.event.type);
}

describe("WorkerAdoptionStore", () => {
  it("adopts an identified agent and binds it to the native session, not the pane", async () => {
    const { store, events } = await makeStore();

    const result = await store.adopt(request(), observation());

    expect(result.outcome).toBe("adopted");
    if (result.outcome !== "adopted") return;
    expect(result.adoption.binding).toEqual({
      transport: "herdr",
      terminalId: "term_a",
      harness: "claude",
      agentSessionId: "session-a",
    });
    expect(result.adoption.grade).toBe("directed");
    expect(result.adoption.state).toBe("active");
    expect(await eventTypes(events)).toEqual(["worker.adopted"]);
    const event = (await events.readAll()).at(-1)?.event;
    // An adoption has no mission of its own, so it takes a reserved partition.
    expect(event?.missionId).toBe(`adoption:${result.adoption.adoptionId}`);
    expect(event?.streamKind).toBe("adoption");
  });

  it("refuses a directed adoption with no declared write scope", async () => {
    const { store, events } = await makeStore();

    const result = await store.adopt(request({ writeScope: [] }), observation());

    expect(result).toEqual({ outcome: "refused", reason: "write_scope_required" });
    expect(await eventTypes(events)).toEqual([]);
  });

  it("refuses an observed adoption that tries to declare a write scope", async () => {
    const { store } = await makeStore();

    const result = await store.adopt(request({ grade: "observed", writeScope: ["apps/**"] }), observation());

    expect(result).toEqual({ outcome: "refused", reason: "write_scope_forbidden" });
  });

  it("adopts at observed grade with no scope", async () => {
    const { store } = await makeStore();

    const result = await store.adopt(request({ grade: "observed", writeScope: [] }), observation());

    expect(result.outcome).toBe("adopted");
    if (result.outcome !== "adopted") return;
    expect(result.adoption.writeScope).toEqual([]);
  });

  it("refuses a pane the transport could not identify as an agent", async () => {
    const { store } = await makeStore();

    const result = await store.adopt(
      request(),
      observation({ adoptable: false, harness: undefined, agentSessionId: undefined }),
    );

    expect(result).toEqual({ outcome: "refused", reason: "not_an_agent" });
  });

  it("refuses an agent this runner already owns", async () => {
    const { store } = await makeStore();

    const result = await store.adopt(request(), observation(), new Set(["session-a"]));

    expect(result).toEqual({ outcome: "refused", reason: "already_owned" });
  });

  it("refuses a second adoption of the same live session", async () => {
    const { store } = await makeStore();
    await store.adopt(request(), observation());

    const again = await store.adopt(request({ terminalId: "term_b" }), observation({ terminalId: "term_b" }));

    expect(again).toEqual({ outcome: "refused", reason: "already_adopted" });
  });

  it("refuses when the observation does not match the requested terminal", async () => {
    const { store } = await makeStore();

    const result = await store.adopt(request({ terminalId: "term_z" }), observation());

    expect(result).toEqual({ outcome: "refused", reason: "not_found" });
  });

  it("lapses an adoption whose native session was replaced", async () => {
    const { store, events } = await makeStore();
    await store.adopt(request(), observation());

    const report = await store.reconcile([observation({ agentSessionId: "session-b" })]);

    expect(report.lapsed).toHaveLength(1);
    expect(report.lapsed[0]?.lapseReason).toBe("session_replaced");
    expect(await store.active()).toEqual([]);
    expect(await eventTypes(events)).toEqual(["worker.adopted", "worker.adoption.lapsed"]);
  });

  it("lapses an adoption whose terminal is gone", async () => {
    const { store } = await makeStore();
    await store.adopt(request(), observation());

    const report = await store.reconcile([]);

    expect(report.lapsed[0]?.lapseReason).toBe("terminal_gone");
  });

  it("retains an adoption whose agent is merely idle", async () => {
    const { store } = await makeStore();
    await store.adopt(request(), observation());

    const report = await store.reconcile([observation({ reportedStatus: "idle" })]);

    expect(report.lapsed).toEqual([]);
    expect(report.retained).toHaveLength(1);
  });

  it("lapses nothing when the transport cannot be asked", async () => {
    const { store, events } = await makeStore();
    await store.adopt(request(), observation());

    const report = await store.reconcile(undefined);

    expect(report.lapsed).toEqual([]);
    expect(report.retained).toHaveLength(1);
    expect(await eventTypes(events)).toEqual(["worker.adopted"]);
  });

  it("does not re-check a lapsed record on a later reconcile", async () => {
    const { store, events } = await makeStore();
    await store.adopt(request(), observation());
    await store.reconcile([]);

    const second = await store.reconcile([]);

    expect(second.lapsed).toEqual([]);
    expect(await eventTypes(events)).toEqual(["worker.adopted", "worker.adoption.lapsed"]);
  });

  it("releases idempotently and drops the lapse reason", async () => {
    const { store, events } = await makeStore();
    const adopted = await store.adopt(request(), observation());
    if (adopted.outcome !== "adopted") throw new Error("expected adoption");
    await store.reconcile([]);

    await store.release(adopted.adoption.adoptionId, operator);
    await store.release(adopted.adoption.adoptionId, operator);

    const records = await store.list();
    expect(records[0]?.state).toBe("released");
    expect(records[0]?.lapseReason).toBeUndefined();
    expect(await eventTypes(events)).toEqual([
      "worker.adopted",
      "worker.adoption.lapsed",
      "worker.adoption.released",
    ]);
  });

  it("allows re-adopting a session after release", async () => {
    const { store } = await makeStore();
    const adopted = await store.adopt(request(), observation());
    if (adopted.outcome !== "adopted") throw new Error("expected adoption");
    await store.release(adopted.adoption.adoptionId, operator);

    const again = await store.adopt(request(), observation());

    expect(again.outcome).toBe("adopted");
  });
});

describe("agent self-declarations", () => {
  async function writeDeclaration(rootDir: string, terminalId: string, body: unknown): Promise<void> {
    const path = agentDeclarationPath(rootDir, terminalId);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  }

  it("reads a well-formed declaration", async () => {
    const { store, rootDir } = await makeStore();
    await writeDeclaration(rootDir, "term_a", {
      schemaVersion: 1,
      terminalId: "term_a",
      status: "working",
      objective: "Land the census",
      writeScope: ["apps/runner/**"],
      declaredAt: "2026-08-07T00:00:00.000Z",
    });

    expect(await store.readDeclaration("term_a")).toMatchObject({ objective: "Land the census" });
  });

  it("ignores a declaration claiming a different terminal", async () => {
    const { store, rootDir } = await makeStore();
    await writeDeclaration(rootDir, "term_a", {
      schemaVersion: 1,
      terminalId: "term_other",
      status: "working",
      objective: "Impersonate a neighbour",
      writeScope: [],
      declaredAt: "2026-08-07T00:00:00.000Z",
    });

    expect(await store.readDeclaration("term_a")).toBeUndefined();
  });

  it("ignores stale, malformed, and oversized declarations", async () => {
    const { store, rootDir, now } = await makeStore();
    await writeDeclaration(rootDir, "stale", {
      schemaVersion: 1,
      terminalId: "stale",
      status: "working",
      objective: "Yesterday's news",
      writeScope: [],
      declaredAt: "2026-08-01T00:00:00.000Z",
    });
    await writeDeclaration(rootDir, "malformed", "{not json");
    await writeDeclaration(rootDir, "huge", {
      schemaVersion: 1,
      terminalId: "huge",
      status: "working",
      objective: "x".repeat(9_000),
      writeScope: [],
      declaredAt: now.value.toISOString(),
    });

    expect(await store.readDeclaration("stale")).toBeUndefined();
    expect(await store.readDeclaration("malformed")).toBeUndefined();
    expect(await store.readDeclaration("huge")).toBeUndefined();
  });
});
