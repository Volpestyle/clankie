import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { OperatorFleetSnapshotSchema, type OperatorFleetSeat } from "@clankie/protocol";
import { FleetRosterSnapshotSchema } from "@clankie/protocol/fleet-roster";
import { FleetRoster } from "../src/captain/fleet-roster.ts";
import { leadChatFixture } from "./fixtures/lead-chats.ts";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

it.each([false, true])(
  "counts the captain's actual local/remote native roster (remote=%s)",
  async (remote) => {
    const f = await leadChatFixture(remote, cleanups);
    const native = await f.captain.serveOperatorConversation({ op: "roster", schemaVersion: 1 });
    if (native.op !== "roster") throw new Error("Missing roster");
    const result = FleetRosterSnapshotSchema.parse(await f.captain.fleetRoster!());
    expect(result.complete).toBe(true);
    expect(result.counts.total).toBe(native.seats.length);
    expect(result.counts.idle).toBe(native.seats.filter((seat) => seat.status === "idle").length);
    expect(result.agents.map((agent) => agent.seatId).sort()).toEqual(
      native.seats.map((seat) => seat.seatId).sort(),
    );
    expect(result.machines[0]?.id).toBe(remote ? "pc" : "local");
    // A host row alone confers no control over an owner-started lead.
    const row = result.agents[0]!;
    expect(
      await f.captain.fleetRosterAction!(
        { seatId: row.seatId, occupantId: row.occupantId },
        { current: () => true, authorize: async () => true },
      ),
    ).toMatchObject({ outcome: "refused", reason: "agent_not_retirable" });
  },
);

it.each([false, true])(
  "refreshes native counts after a catalog read before authorizing retirement (remote=%s)",
  async (remote) => {
    let status = "idle";
    const f = await leadChatFixture(remote, cleanups, { nativeStatus: () => status });
    const before = await f.captain.fleetRoster!();
    expect(before.counts).toMatchObject({ total: 1, idle: 1, working: 0 });
    await f.captain.workerCatalogSeats!();
    status = "working";
    const row = before.agents[0]!;
    expect(
      await f.captain.fleetRosterAction!(
        { seatId: row.seatId, occupantId: row.occupantId },
        { current: () => true, authorize: async () => true },
      ),
    ).toMatchObject({ outcome: "refused", reason: "agent_not_retirable" });
    expect((await f.captain.fleetRoster!()).counts).toMatchObject({ total: 1, idle: 0, working: 1 });
  },
);

it.each(["waiting", "blocked"])(
  "serves grouped statuses (%s) and persisted one-hour inactivity without inheriting another occupant's age or hiding pending mail",
  (waitingStatus) => {
    const root = mkdtempSync(join(tmpdir(), "fleet-roster-"));
    cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
    const path = join(root, "roster.json");
    const seat = (id: string, status: string, extra: Partial<OperatorFleetSeat> = {}): OperatorFleetSeat => ({
      seatId: id,
      occupantId: `${id}-native`,
      personaId: id,
      harness: "codex",
      status,
      title: id,
      owner: { conversationId: "lead", hired: true },
      ...extra,
    });
    const seats = [
      seat("active", "working"),
      seat("blocked", waitingStatus),
      seat("quiet", "idle"),
      seat("complete", "done", { fleet: "pc", machine: "PC" }),
    ];
    const snapshot = () =>
      OperatorFleetSnapshotSchema.parse({
        schemaVersion: 1,
        cursor: "fleet:1",
        seats,
        personas: [],
        channels: [],
      });
    const time = Date.parse("2026-10-18T00:00:00Z");
    const initial = new FleetRoster(path).project(snapshot(), new Set(), time);
    expect(initial.counts).toMatchObject({
      total: 4,
      working: 1,
      waiting: 1,
      idle: 1,
      finished: 1,
      stale: 0,
    });
    const restarted = new FleetRoster(path);
    expect(restarted.project(snapshot(), new Set(), time + 3_600_000).counts.stale).toBe(0);
    const later = restarted.project(snapshot(), new Set(), time + 3_600_001);
    expect(later.counts.stale).toBe(2);
    expect(later.leads[0]?.counts.total).toBe(4);
    expect(later.machines.find((machine) => machine.id === "pc")?.counts.finished).toBe(1);
    seats[2] = seat("quiet", "idle", { occupantId: "replacement" });
    seats[3] = seat("complete", "done", {
      fleet: "pc",
      waitingMessages: {
        stored: 1,
        unconfirmed: 0,
        oldestAt: new Date(time).toISOString(),
        expiresAt: new Date(time + 86_400_000).toISOString(),
        detail: "A message is waiting",
      },
    });
    const pending = restarted.project(snapshot(), new Set(), time + 3_600_002);
    expect(pending.counts.stale).toBe(0);
    expect(pending.agents.find((agent) => agent.seatId === "complete")).toMatchObject({
      pending: true,
      retireEligible: false,
    });
    const partial = restarted.project(
      { ...snapshot(), readWarnings: [{ source: "pc", reason: "unavailable", message: "PC unavailable" }] },
      new Set(),
      time + 7_200_002,
    );
    expect(partial.complete).toBe(false);
  },
);

it("counts a pending owner question as waiting even when the native pane is idle", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-roster-question-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const model = new FleetRoster(join(root, "roster.json"));
  const snapshot = OperatorFleetSnapshotSchema.parse({
    schemaVersion: 1,
    cursor: "fleet:1",
    personas: [],
    channels: [],
    seats: [
      {
        seatId: "worker",
        occupantId: "native",
        personaId: "worker",
        harness: "codex",
        status: "idle",
        title: "Worker",
        owner: { conversationId: "lead", hired: true },
      },
    ],
  });
  const now = Date.now();
  model.project(snapshot, new Set(), now - 3_600_001);
  const result = model.project(snapshot, new Set(["worker"]), now);
  expect(result.counts).toMatchObject({ total: 1, waiting: 1, idle: 0, stale: 0 });
  expect(result.agents[0]).toMatchObject({
    status: "waiting",
    pending: true,
    stale: false,
    retireEligible: false,
  });
});

it("marks a missing remote source incomplete and refuses retirement", async () => {
  const f = await leadChatFixture(false, cleanups, { slowFleetMs: 1 });
  const roster = await f.captain.fleetRoster!();
  expect(roster.complete).toBe(false);
  expect(roster.readWarnings?.some((warning) => warning.source.includes("pc"))).toBe(true);
  expect(
    await f.captain.fleetRosterAction!(
      { seatId: f.head.terminalId, occupantId: "unknown" },
      { current: () => true, authorize: async () => true },
    ),
  ).toMatchObject({ outcome: "refused", reason: "roster_unavailable" });
});

it("reuses the host's existing observed inactivity instead of guessing from progress text", () => {
  const root = mkdtempSync(join(tmpdir(), "fleet-roster-age-"));
  cleanups.push(async () => rmSync(root, { recursive: true, force: true }));
  const time = Date.parse("2026-10-18T02:00:00Z");
  const snapshot = OperatorFleetSnapshotSchema.parse({
    schemaVersion: 1,
    cursor: "fleet:1",
    personas: [],
    channels: [],
    seats: [
      {
        seatId: "worker",
        occupantId: "native",
        personaId: "worker",
        harness: "codex",
        title: "Worker",
        status: "done",
        efficiency: {
          checkedAt: new Date(time).toISOString(),
          ownerConversationId: "lead",
          flags: [],
          inactiveSince: "2026-10-18T00:00:00Z",
        },
      },
    ],
  });
  expect(
    new FleetRoster(join(root, "roster.json")).project(snapshot, new Set(), time).agents[0],
  ).toMatchObject({ stale: true, inactiveSince: "2026-10-18T00:00:00Z" });
});

it("does not turn a failed local native census into a confirmed empty count", async () => {
  let failed = false;
  const f = await leadChatFixture(false, cleanups, { localUnavailable: () => failed });
  failed = true;
  expect(
    await f.captain.fleetRosterAction!(
      { seatId: f.head.terminalId, occupantId: "previous" },
      { current: () => true, authorize: async () => true },
    ),
  ).toMatchObject({ outcome: "refused", reason: "roster_unavailable" });
  const roster = await f.captain.fleetRoster!();
  expect(roster.complete).toBe(false);
  expect(roster.readWarnings?.some((warning) => warning.source === "herdr:default")).toBe(true);
});
