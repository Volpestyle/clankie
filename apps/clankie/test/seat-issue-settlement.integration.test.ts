import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createLocalTracker, writeConvention } from "@clankie/work-items";
import { createWorkItemsService } from "../src/work-items.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";
import {
  SeatIssueKeeper,
  prepareSeatIssueAttribution,
  type LiveSeatIssue,
  type SeatIssueAttribution,
  type SeatIssueTrackerScope,
} from "../src/captain/seat-issue-status.ts";

/**
 * VUH-2872 through the production keeper, hire ledger, attribution capture and
 * project tracker routes over disposable built-in stores. Native process proof
 * is a synthetic fixture: no pane closes and no real tracker is reconciled.
 */
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Row = Record<string, unknown>;

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "seat-issue-settlement-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const ledger = new ProjectHires(join(root, "hires.json"));
  let now = Date.parse("2026-10-26T22:45:00Z");
  const keeper = new SeatIssueKeeper(
    {
      call: async () => {
        throw new Error("No default tracker in this fixture");
      },
    },
    join(root, "keeper.json"),
    { requireAttribution: true, now: () => now, exitGraceMs: 60_000 },
  );
  let panes = 0;
  async function project(id: string) {
    const path = join(root, id);
    await mkdir(path);
    await writeConvention(path, {
      schemaVersion: 1,
      backend: "builtin",
      decidedBy: "owner",
      decidedAt: "2026-10-26T00:00:00Z",
    });
    const directory = join(root, `${id}-store`);
    const store = createLocalTracker({ directory, team: "VUH", project: id });
    const projects = (await store.call("list_projects", {})) as { projects: { id: string }[] };
    const projectId = projects.projects[0]!.id;
    const issues: Row[] = [];
    for (let index = 1; index <= 4; index++) {
      const issue = (await store.call("save_issue", {
        team: "VUH",
        project: projectId,
        title: `${id} item ${index}`,
      })) as Row;
      await store.call("post_issue_event", { issueId: issue.id, type: "ack" });
      issues.push(issue);
    }
    const settings = ProjectsSettingsSchema.parse({
      projects: [
        {
          id,
          name: id,
          workerCap: 20,
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path }],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
          trackerProjectId: projectId,
        },
      ],
    });
    const service = createWorkItemsService({
      stateDirectory: join(root, `${id}-service`),
      globalTrackerDirectory: directory,
      builtInTracker: (assertIssueWrite) =>
        createLocalTracker({ directory, ...(assertIssueWrite ? { assertIssueWrite } : {}) }),
      projects: async () => settings,
      projectsFence: async () => ({ projects: settings, assertCurrent: () => {} }),
      localMachineId: "local",
    });
    /** A confirmed hire, plus the captain's refusal for a roster that saw another occupant. */
    async function hire(title: string, key: string) {
      const pane = `${id}-pane-${++panes}`;
      const occupant = `fixture-${pane}`;
      const allocation = ledger.reserve(settings, id, {
        schemaVersion: 1,
        title,
        workingDirectory: join(path, pane),
        harness: "codex",
        deliverable: key,
      });
      ledger.launch(allocation.id, settings);
      ledger.pane(allocation.id, pane);
      const proof = {
        nativeOccupantId: occupant,
        fleet: "default",
        pane,
        binding: { socketPath: join(root, "fixture-only.sock") },
        processes: [{ pid: 22, startTime: "fixture" }],
        shell: { pid: 11, startTime: "fixture" },
      };
      ledger.observe(allocation.id, pane, occupant, proof);
      ledger.confirmed(allocation.id);
      const routes = {
        proof: async () => proof,
        watches: {
          projectHireAssignment: (fleet: string, paneId: string, current = proof) =>
            ledger.assignment(fleet, paneId, current),
          projectHireBookkeepingAttribution: (fleet: string, paneId: string, occupantId: string) =>
            ledger.bookkeepingAttribution(fleet, paneId, occupantId),
        },
        workItems: service,
        projects: async () => settings,
      };
      const native = { fleet: "default", pane, nativeOccupantId: occupant };
      let resolutions = 0;
      const confirmed = await prepareSeatIssueAttribution(native, routes);
      const live: LiveSeatIssue = {
        seatId: pane,
        occupantId: occupant,
        title,
        keys: [key],
        attribution: {
          resolve: () => {
            resolutions++;
            return confirmed.resolve();
          },
        },
      };
      // The captain keeps a refused capture as an attribution that rethrows it.
      const error = await prepareSeatIssueAttribution({ ...native, nativeOccupantId: "stale" }, routes).then(
        () => undefined,
        (refusal: unknown) => refusal,
      );
      expect(String(error)).toContain("Native hire attribution is unavailable or changed occupant.");
      const refused: LiveSeatIssue = {
        ...live,
        occupantId: "stale",
        attribution: {
          resolve: async () => {
            resolutions++;
            throw error;
          },
        },
      };
      return { live, refused, resolutions: () => resolutions };
    }
    const bytes = () => readFile(join(directory, "tracker.json"), "utf8");
    const issue = (index: number) => store.call("get_issue", { id: issues[index - 1]!.id }) as Promise<Row>;
    const comments = async (index: number) =>
      (
        (await store.call("list_comments", { issueId: issues[index - 1]!.id })) as {
          comments: { body: string }[];
        }
      ).comments.map((comment) => comment.body);
    return { hire, bytes, issue, comments };
  }
  return {
    keeper,
    project,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it("settles past an unknown owner whose assignment provably names other work", async () => {
  const { keeper, project } = await setup();
  const a = await project("a");
  const closing = await a.hire("Soren", "LOCAL-VUH-4");
  const unrelated = await a.hire("Unattributed peer", "LOCAL-VUH-2");
  await keeper.observe([closing.live, unrelated.live]);
  // The peer's next roster capture sees a changed occupant (the live refusal).
  expect(await keeper.observe([closing.live, unrelated.refused])).toMatchObject([
    { outcome: "failed", issue: "LOCAL-VUH-2", detail: expect.stringContaining("changed occupant") },
  ]);
  const before = unrelated.resolutions();
  const result = await keeper.closed({
    seatId: closing.live.seatId,
    reason: "core change landed",
    outcome: "verifying",
    evidence: "fixture commit",
  });
  expect(result).toMatchObject({ outcome: "updated", issue: "LOCAL-VUH-4", intended: "Verifying" });
  expect(result).not.toHaveProperty("retryUntil");
  // Canonical identity in the closing scope proved it; the peer's refusal was never consulted.
  expect(unrelated.resolutions()).toBe(before);
  expect(await a.comments(4)).toEqual([expect.stringContaining("Soren left: core change landed.")]);
  expect(await a.comments(2)).toEqual([]);
  expect(await a.issue(2)).toMatchObject({ status: "In Progress" });
});

it("defers for a relevant or unprovable unknown owner, then hands off once it recovers", async () => {
  const { keeper, project, advance } = await setup();
  const a = await project("a");
  const closing = await a.hire("Soren", "LOCAL-VUH-4");
  const peer = await a.hire("Peer on the same issue", "LOCAL-VUH-4");
  const unprovable = { seatId: "head", title: "Clankie", keys: [], ownedKeys: ["LOCAL-VUH-4"] };
  await keeper.observe([closing.live, peer.live]);
  // Unprovable: no attribution, and its key names the closing item in this scope.
  await keeper.observe([closing.live, unprovable]);
  const untouched = await a.bytes();
  const deferred = await keeper.closed({
    seatId: closing.live.seatId,
    reason: "handing over",
    outcome: "done",
    evidence: "fixture proof",
  });
  expect(deferred).toMatchObject({
    outcome: "failed",
    intended: "Done",
    detail: expect.stringContaining("attribution is unavailable"),
    retryUntil: "2026-10-27T04:45:00.000Z",
  });
  // The changed-occupant refusal on the same issue defers the same way.
  expect(await keeper.observe([peer.refused])).toMatchObject([
    { outcome: "failed", detail: expect.stringContaining("changed occupant") },
  ]);
  for (let tick = 0; tick < 5; tick++) {
    advance(5_000);
    expect(await keeper.observe([peer.refused])).toEqual([]);
  }
  expect(await a.bytes()).toBe(untouched);
  advance(10_000);
  const refusedAgain = await keeper.observe([peer.refused]);
  expect(refusedAgain).toMatchObject([
    { outcome: "failed", detail: expect.stringContaining("changed occupant") },
    {
      outcome: "failed",
      issue: "LOCAL-VUH-4",
      intended: "Done",
      detail: expect.stringContaining("changed occupant"),
      retryUntil: "2026-10-27T04:45:00.000Z",
    },
  ]);
  expect(await a.bytes()).toBe(untouched);
  // The roster catches up with the real occupant; the retry keeps the original
  // close and finds the live successor without closing any pane again.
  advance(120_000);
  expect(await keeper.observe([peer.live])).toMatchObject([
    { outcome: "updated", issue: "LOCAL-VUH-4", intended: "In Progress", status: "In Progress" },
  ]);
  expect(await a.comments(4)).toEqual([
    expect.stringContaining(
      "Handed from Soren to Peer on the same issue: handing over. Evidence: fixture proof.",
    ),
  ]);
  for (let tick = 0; tick < 3; tick++) {
    advance(600_000);
    expect(await keeper.observe([peer.live])).toEqual([]);
  }
  expect(await a.comments(4)).toHaveLength(1);
});

it("keeps identical keys in distinct tracker scopes apart, retrying exactly once after an uncertain comment", async () => {
  const { keeper, project, advance } = await setup();
  const a = await project("a");
  const b = await project("b");
  const closing = await a.hire("Soren", "LOCAL-VUH-4");
  const sameKey = await b.hire("Other scope, same display key", "LOCAL-VUH-4");
  const otherKey = await b.hire("Other scope, other key", "LOCAL-VUH-2");
  // The closing scope's later comment applies but its reply is lost once.
  let lose = true;
  const scopes = { calls: [] as string[] };
  const original = closing.live.attribution!;
  const flaky: SeatIssueAttribution = {
    resolve: async () => {
      const scope = await original.resolve();
      return {
        ...scope,
        call: async (tool, args, priority) => {
          scopes.calls.push(tool);
          const result = await scope.call(tool, args, priority);
          if (tool === "save_comment" && lose) {
            lose = false;
            throw new Error("save_comment: timed out after applying");
          }
          return result;
        },
      } satisfies SeatIssueTrackerScope;
    },
  };
  const closingSeat = { ...closing.live, attribution: flaky };
  await keeper.observe([closingSeat, otherKey.live, sameKey.live]);
  await keeper.observe([closingSeat, otherKey.refused, sameKey.refused]);
  const bBefore = await b.bytes();
  // LOCAL-VUH-4 also names A's target, so B's unattributed seat cannot be ruled out.
  expect(
    await keeper.closed({
      seatId: closing.live.seatId,
      reason: "remaining proof pending",
      outcome: "verifying",
    }),
  ).toMatchObject({ outcome: "failed", detail: expect.stringContaining("changed occupant") });
  expect(otherKey.resolutions()).toBe(2); // LOCAL-VUH-2 named other work in A's scope.
  // B's seat recovers in its own scope: not a successor for A's item.
  advance(30_000);
  expect(await keeper.observe([sameKey.live, otherKey.live])).toMatchObject([
    {
      outcome: "failed",
      issue: "LOCAL-VUH-4",
      intended: "Verifying",
      detail: "save_comment: timed out after applying",
    },
  ]);
  expect(await a.comments(4)).toHaveLength(1);
  const statusWrites = scopes.calls.filter((tool) => tool === "save_issue").length;
  advance(60_000);
  expect(await keeper.observe([sameKey.live, otherKey.live])).toMatchObject([
    { outcome: "updated", issue: "LOCAL-VUH-4", intended: "Verifying" },
  ]);
  // The retry read the comment back instead of posting or deciding again.
  expect(await a.comments(4)).toEqual([expect.stringContaining("Soren left: remaining proof pending.")]);
  expect(scopes.calls.filter((tool) => tool === "save_issue").length).toBe(statusWrites);
  expect(scopes.calls.at(-1)).toBe("list_comments");
  expect(scopes.calls.filter((tool) => tool === "save_comment")).toHaveLength(1);
  expect(await b.bytes()).toBe(bBefore);
  expect(await b.issue(4)).toMatchObject({ status: "In Progress" });
  advance(600_000);
  expect(await keeper.observe([sameKey.live, otherKey.live])).toEqual([]);
});

it("ends retries at the bound and never settles an issue its seat came back to", async () => {
  const { keeper, project, advance } = await setup();
  const a = await project("a");
  const closing = await a.hire("Soren", "LOCAL-VUH-4");
  const returning = await a.hire("Undo returns", "LOCAL-VUH-3");
  const unprovable = {
    seatId: "head",
    title: "Clankie",
    keys: [],
    ownedKeys: ["LOCAL-VUH-4", "LOCAL-VUH-3"],
  };
  await keeper.observe([closing.live, returning.live, unprovable]);
  const untouched = await a.bytes();
  expect(await keeper.closed({ seatId: closing.live.seatId, reason: "stuck" })).toMatchObject({
    outcome: "failed",
    retryUntil: "2026-10-27T04:45:00.000Z",
  });
  expect(await keeper.closed({ seatId: returning.live.seatId, reason: "closed, then undone" })).toMatchObject(
    {
      outcome: "failed",
    },
  );
  // The undone seat is confirmed again with its issue: its retirement is dropped.
  advance(30_000);
  const round = await keeper.observe([returning.live, unprovable]);
  expect(round).toMatchObject([{ outcome: "failed", issue: "LOCAL-VUH-4" }]);
  let ended: { outcome: string; detail?: string }[] = [];
  let rounds = 0;
  while (!ended.length && rounds++ < 100) {
    advance(300_000);
    ended = (await keeper.observe([returning.live, unprovable])).filter(
      (result) => result.issue === "LOCAL-VUH-4" && result.retryUntil === undefined,
    );
  }
  expect(rounds).toBeGreaterThan(60);
  expect(ended).toMatchObject([
    {
      outcome: "failed",
      detail: expect.stringContaining("Issue settlement retries ended; settle it by hand."),
    },
  ]);
  advance(300_000);
  expect(await keeper.observe([returning.live, unprovable])).toEqual([]);
  expect(await a.bytes()).toBe(untouched);
});

it("settles past an unattributed seat on another tracker's key, and keeps status when no outcome is stated", async () => {
  const { keeper, project } = await setup();
  const a = await project("a");
  const stated = await a.hire("Odile", "LOCAL-VUH-4");
  const tidied = await a.hire("Tidied", "LOCAL-VUH-3");
  // VUH-2920: the head seat and a seat on a Linear item never resolve hire attribution here.
  const head = { seatId: "head", title: "Clankie", keys: [], ownedKeys: ["VUH-2868", "VUH-2920"] };
  const linear = await a.hire("Linear worker", "VUH-2868");
  await keeper.observe([stated.live, tidied.live, head, linear.refused]);
  expect(
    await keeper.closed({ seatId: stated.live.seatId, reason: "paused at a handoff", outcome: "paused" }),
  ).toMatchObject({ outcome: "updated", issue: "LOCAL-VUH-4", intended: "Paused", status: "Todo" });
  expect(await a.issue(4)).toMatchObject({ status: "Todo" });
  // Auto-tidy and owner closes state no outcome: the status stays and the reason is recorded.
  const kept = await keeper.closed({ seatId: tidied.live.seatId, reason: "auto-tidy: idle and landed" });
  expect(kept).toMatchObject({ outcome: "updated", issue: "LOCAL-VUH-3", status: "In Progress" });
  expect(kept).not.toHaveProperty("intended");
  expect(kept).not.toHaveProperty("retryUntil");
  expect(await a.issue(3)).toMatchObject({ status: "In Progress" });
  expect(await a.comments(3)).toEqual([
    expect.stringContaining(
      "Tidied left: auto-tidy: idle and landed. Status kept: In Progress (no outcome stated).",
    ),
  ]);
});

it("a seat closed while a roster round runs is neither its own successor nor retired again", async () => {
  // VUH-2924: close_worker_pane failed issue settlement with "changed occupant" on ordinary local seats.
  const { keeper, project, advance } = await setup();
  const a = await project("a");
  const closing = await a.hire("Piers", "LOCAL-VUH-4");
  let hold: Promise<void> | undefined;
  const tracked: LiveSeatIssue = {
    ...closing.live,
    attribution: {
      resolve: async () => {
        await hold;
        return closing.live.attribution!.resolve();
      },
    },
  };
  await keeper.observe([tracked]);
  // The next round reads the roster, and the lead closes the seat while that round still runs.
  advance(5_000);
  const censusAt = Date.parse("2026-10-26T22:45:05Z");
  advance(1_000);
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  const close = keeper.closed({ seatId: closing.live.seatId, reason: "work landed" });
  // That round still lists the exiting seat; with its process gone, the capture can't prove the occupant.
  const stale = await keeper.observe([closing.refused], censusAt);
  release();
  expect(await close).toMatchObject({ outcome: "updated", issue: "LOCAL-VUH-4", status: "In Progress" });
  expect(await close).not.toHaveProperty("retryUntil");
  expect(stale).toEqual([]);
  // A capture taken before the close still confirms the seat; it is not tracked again.
  expect(await keeper.observe([closing.live], censusAt)).toEqual([]);
  expect(await keeper.observe([])).toEqual([]);
  advance(120_000);
  expect(await keeper.observe([])).toEqual([]);
  expect(await a.comments(4)).toEqual([
    expect.stringContaining("Piers left: work landed. Status kept: In Progress (no outcome stated)."),
  ]);
  expect(await a.issue(4)).toMatchObject({ status: "In Progress" });
});

// From Corvin's review: the close lands while the round waits on the seat's tracker, as a Linear read can.
for (const capture of ["live", "refused"] as const)
  it(`a close that lands while a round awaits the seat's ${capture} capture settles once`, async () => {
    const { keeper, project, advance } = await setup();
    const a = await project("a");
    const closing = await a.hire("Piers", "LOCAL-VUH-4");
    await keeper.observe([closing.live]);
    advance(5_000);
    const censusAt = Date.parse("2026-10-26T22:45:05Z");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const waiting: LiveSeatIssue = {
      ...closing[capture],
      attribution: {
        resolve: async () => {
          entered();
          await gate;
          return closing[capture].attribution!.resolve();
        },
      },
    };
    const round = keeper.observe([waiting], censusAt);
    await inside;
    advance(1_000);
    const close = await keeper.closed({ seatId: closing.live.seatId, reason: "work landed" });
    release();
    expect(close).toMatchObject({ outcome: "updated", issue: "LOCAL-VUH-4", status: "In Progress" });
    // A refused capture is the exit, not a failure; a live one does not track the seat again.
    expect(await round).toEqual([]);
    expect(await keeper.observe([])).toEqual([]);
    advance(120_000);
    expect(await keeper.observe([])).toEqual([]);
    expect(await a.comments(4)).toEqual([
      expect.stringContaining("Piers left: work landed. Status kept: In Progress (no outcome stated)."),
    ]);
    expect(await a.issue(4)).toMatchObject({ status: "In Progress" });
  });
