import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  collectLinearOutcomes,
  createLocalTracker,
  localDays,
  startedAtDayEnds,
  TRACKER_LEAD,
  TRACKER_OWNER,
  type LinearImportSnapshot,
  type TrackerActor,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const lead: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };

it("reconstructs KH2 Multiplayer's 10-06 → 10-14 outcomes from captured Linear responses", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("./fixtures/outcomes/kh2-multiplayer.json", import.meta.url), "utf8"),
  ) as { calls: { query: string; variables: Record<string, unknown>; data: Record<string, unknown> }[] };
  const sent: string[] = [];
  const outcomes = await collectLinearOutcomes({
    projectId: "b701962e-89aa-4685-a574-ebda25706d64",
    // Strict replay: any query the collector did not send live fails here.
    query: async (query, variables) => {
      const call = fixture.calls.find(
        (entry) => entry.query === query && JSON.stringify(entry.variables) === JSON.stringify(variables),
      );
      if (!call) throw new Error(`Unrecorded Linear query: ${query} ${JSON.stringify(variables)}`);
      sent.push(query);
      return call.data;
    },
    // CDT local days 10-06 through 10-14, read just after the capture.
    window: { since: "2026-10-06T05:00:00.000Z", until: "2026-10-15T05:00:00.000Z" },
    history: true,
    now: () => new Date("2026-10-15T02:50:00.000Z"),
  });
  expect(sent).toHaveLength(fixture.calls.length);

  const days = localDays(outcomes.window, "America/Chicago");
  const table = startedAtDayEnds(outcomes.history!, days, outcomes.readAt).map((row) => {
    const day = days.find((entry) => entry.date === row.date)!;
    return [
      row.date,
      outcomes.closed.filter((issue) => issue.completedAt! >= day.start && issue.completedAt! < day.end)
        .length,
      row.started,
    ];
  });
  // VUH-2255's plan table (10-14 is partial; the plan read 6 started before VUH-2276 started at 02:29Z).
  expect(table).toEqual([
    ["2026-10-06", 1, 21],
    ["2026-10-07", 0, 23],
    ["2026-10-08", 0, 23],
    ["2026-10-09", 2, 22],
    ["2026-10-10", 0, 22],
    ["2026-10-11", 0, 22],
    ["2026-10-12", 2, 24],
    ["2026-10-13", 7, 23],
    ["2026-10-14", 16, 7],
  ]);
  // VUH-2250 is the only parent, and it is still open.
  const parents = [...outcomes.closed, ...outcomes.started.issues].filter((issue) => issue.hasChildren);
  expect(parents.map((issue) => [issue.identifier, issue.state.type])).toEqual([["VUH-2250", "started"]]);
  expect(
    outcomes.closed.filter((issue) => issue.parent !== null).map((issue) => issue.parent!.identifier),
  ).toEqual(["VUH-2250", "VUH-2250", "VUH-2250"]);
  // Closure time is the state transition, not Linear's separately stamped completedAt.
  expect(outcomes.closed.find((issue) => issue.identifier === "VUH-2212")?.completedAt).toBe(
    "2026-10-13T07:13:02.878Z",
  );
  // Duplicate and canceled are not closures.
  expect(outcomes.closed.some((issue) => ["VUH-1789", "VUH-1515"].includes(issue.identifier))).toBe(false);
  expect(outcomes.started).toMatchObject({ total: 7, byState: { "In Progress": 7 } });
  // A tracker milestone finished in the 10-14 cleanup; an empty one is not complete.
  expect(outcomes.milestones.filter((milestone) => milestone.complete)).toEqual([
    {
      id: "f8bef0a3-1897-432b-b94e-28ee08032db2",
      name: "Shared world",
      issues: 4,
      done: 4,
      complete: true,
      completedAt: "2026-10-15T01:44:38.451Z",
    },
  ]);
  expect(outcomes.milestones.find((milestone) => milestone.name === "PvP (after co-op)")).toMatchObject({
    issues: 0,
    complete: false,
  });
  expect(outcomes.statusUpdates.map((update) => update.createdAt)).toEqual([
    "2026-10-06T15:22:57.922Z",
    "2026-10-06T18:18:21.144Z",
    "2026-10-06T21:10:12.554Z",
    "2026-10-06T21:46:12.500Z",
    "2026-10-07T01:51:14.973Z",
    "2026-10-08T00:46:22.790Z",
    "2026-10-11T22:28:35.135Z",
  ]);
  expect(outcomes.caveats.join(" ")).toContain("membership is current");
});

it("rebuilds an imported issue's state history from the built-in tracker's events", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracker-outcomes-"));
  roots.push(root);
  const snapshot = JSON.parse(
    await readFile(new URL("./fixtures/linear-import/clankie-work.json", import.meta.url), "utf8"),
  ) as LinearImportSnapshot;
  const tracker = createLocalTracker({ directory: root });
  const actors = Object.fromEntries(snapshot.actors.map((actor) => [actor.id, lead]));
  await tracker.importLinear(snapshot, actors);
  const outcomes = await tracker.readOutcomes({
    projectId: snapshot.projects[0]!.id,
    window: { since: "2026-10-09T05:00:00.000Z", until: "2026-10-10T05:00:00.000Z" },
    history: true,
  });
  expect(outcomes.tracker).toBe("built-in");
  // The event stream yields exactly the spans Linear recorded.
  for (const source of snapshot.issues)
    expect(outcomes.history!.find((entry) => entry.id === source.id)?.spans).toEqual(
      (
        source.stateHistory as {
          startedAt: string;
          endedAt: string | null;
          state: { name: string; type: string };
        }[]
      ).map((span) => ({
        state: { name: span.state.name, type: span.state.type },
        startedAt: span.startedAt,
        endedAt: span.endedAt,
      })),
    );
  expect(
    outcomes.closed.map((issue) => [issue.identifier, issue.completedAt, issue.parent?.identifier]),
  ).toEqual([
    ["VUH-1933", "2026-10-09T08:09:05.625Z", undefined],
    ["VUH-1919", "2026-10-09T14:07:17.777Z", undefined],
    ["VUH-1962", "2026-10-09T14:48:22.098Z", "VUH-1920"],
  ]);
  expect(outcomes.started).toMatchObject({ total: 1, byState: { "In Progress": 1 } });
  expect(outcomes.milestones).toHaveLength(6);
  expect(
    outcomes.milestones.filter((milestone) => milestone.complete).map((milestone) => milestone.name),
  ).toEqual(["2. Tracker core"]);
});

it("records the status native writes leave, so later rounds can replay them", async () => {
  const root = await mkdtemp(join(tmpdir(), "tracker-outcomes-"));
  roots.push(root);
  let now = new Date("2026-10-12T15:00:00.000Z");
  const tracker = createLocalTracker({ directory: root, clock: () => now });
  const project = (await tracker.call(
    "save_project",
    { name: "Outcomes", addTeams: ["LOCAL"] },
    { actor: lead },
  )) as {
    id: string;
  };
  const parent = (await tracker.call(
    "save_issue",
    { team: "LOCAL", project: project.id, title: "Milestone parent", state: "Todo" },
    { actor: lead },
  )) as { id: string };
  const child = (await tracker.call(
    "save_issue",
    { team: "LOCAL", project: project.id, title: "Child", parentId: parent.id },
    { actor: lead },
  )) as { id: string; identifier: string; createdAt: string };
  now = new Date("2026-10-12T18:00:00.000Z");
  await tracker.call("save_issue", { id: child.id, state: "In Progress" }, { actor: lead });
  now = new Date("2026-10-13T16:00:00.000Z");
  await tracker.call(
    "post_issue_event",
    { issueId: child.id, type: "result", stage: "landed" },
    { actor: lead },
  );
  const events = (await tracker.call("list_issue_events", { issueId: child.id })) as {
    events: { type: string; status?: string }[];
  };
  expect(events.events.filter((event) => event.status !== undefined).map((event) => event.type)).toEqual([
    "created",
    "stage",
    "stage",
  ]);

  const outcomes = await tracker.readOutcomes({
    projectId: project.id,
    window: { since: "2026-10-12T05:00:00.000Z", until: "2026-10-14T05:00:00.000Z" },
    history: true,
  });
  const history = outcomes.history!.find((entry) => entry.id === child.id)!;
  // The landed stage moves the item to its bound status, which replays from the event alone.
  expect(history.spans.map((span) => [span.state.name, span.startedAt, span.endedAt])).toEqual([
    ["Todo", child.createdAt, "2026-10-12T18:00:00.000Z"],
    ["In Progress", "2026-10-12T18:00:00.000Z", "2026-10-13T16:00:00.000Z"],
    ["In Review", "2026-10-13T16:00:00.000Z", null],
  ]);
  const days = localDays(outcomes.window, "America/Chicago");
  expect(startedAtDayEnds(outcomes.history!, days, outcomes.readAt).map((row) => row.started)).toEqual([
    1, 1,
  ]);
  expect(outcomes.started.issues.map((issue) => [issue.identifier, issue.parent?.id])).toEqual([
    [child.identifier, parent.id],
  ]);
  expect(outcomes.caveats).toHaveLength(1);
});

it("keeps local days whole across a daylight-saving change", () => {
  const days = localDays(
    { since: "2026-11-01T05:00:00.000Z", until: "2026-11-03T06:00:00.000Z" },
    "America/Chicago",
  );
  expect(days).toEqual([
    { date: "2026-11-01", start: "2026-11-01T05:00:00.000Z", end: "2026-11-02T06:00:00.000Z" },
    { date: "2026-11-02", start: "2026-11-02T06:00:00.000Z", end: "2026-11-03T06:00:00.000Z" },
  ]);
});
