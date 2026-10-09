import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLocalTracker, TRACKER_LEAD, TRACKER_OWNER, type LinearImportSnapshot } from "../src/index.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "linear-import-"));
  directories.push(directory);
  const snapshot = JSON.parse(
    await readFile(new URL("./fixtures/linear-import/clankie-work.json", import.meta.url), "utf8"),
  ) as LinearImportSnapshot;
  const actors = Object.fromEntries(
    snapshot.actors.map((actor) => [
      actor.id,
      actor.id === "634ad2c8-4992-48b5-b14d-af650cd30030"
        ? { ...TRACKER_OWNER, onBehalfOf: [] }
        : { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] },
    ]),
  );
  return { directory, snapshot, actors, tracker: createLocalTracker({ directory }) };
}

it("imports a real captured Linear graph into native records and survives reopen without duplicate writes", async () => {
  const { directory, snapshot, actors, tracker } = await setup();
  const first = await tracker.importLinear(snapshot, actors);
  expect(first.counts.issues).toBe(5);
  expect(await tracker.call("get_user", { query: "634ad2c8-4992-48b5-b14d-af650cd30030" })).toMatchObject({
    actor: { type: "human", id: "owner" },
  });
  for (const source of snapshot.issues) {
    const issue = (await tracker.call("get_issue", {
      id: source.identifier,
      includeRelations: true,
    })) as Record<string, unknown>;
    expect(issue).toMatchObject({
      id: source.id,
      uuid: source.id,
      identifier: source.identifier,
      description: source.description,
      priority: source.priority,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      stateHistory: source.stateHistory,
    });
    const comments = (await tracker.call("list_comments", { issueId: source.id, limit: 250 })) as {
      comments: Record<string, unknown>[];
    };
    expect(comments.comments.map((comment) => comment.id).sort()).toEqual(
      snapshot.comments
        .filter((comment) => comment.issueId === source.id)
        .map((comment) => comment.id)
        .sort(),
    );
  }
  expect(
    await tracker.call("list_milestones", { project: snapshot.projects[0]!.id, limit: 250 }),
  ).toMatchObject({
    milestones: snapshot.milestones.map((m) => ({
      id: m.id,
      projectId: snapshot.projects[0]!.id,
      name: m.name,
      sortOrder: m.sortOrder,
    })),
  });
  expect(await tracker.call("get_document", { id: snapshot.documents[0]!.id })).toMatchObject(
    snapshot.documents[0]!,
  );
  const sync = await tracker.sync({
    action: "bootstrap",
    type: "full",
    projects: [snapshot.projects[0]!.id],
    lazy: false,
  });
  if (sync.outcome !== "bootstrap") throw new Error("Expected bootstrap");
  const models = sync.ndjson
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { modelName?: string });
  expect(models.map((model) => model.modelName)).toContain("milestone");
  expect(models.map((model) => model.modelName)).toContain("document");
  const before = await readFile(join(directory, "tracker.json"), "utf8");
  const reopened = createLocalTracker({ directory });
  const rerun = await reopened.importLinear(snapshot, actors);
  expect(rerun).toMatchObject({ created: 0, updated: 0 });
  expect(await readFile(join(directory, "tracker.json"), "utf8")).toBe(before);
});

it("preserves archived records, reply parents, team cycles and actor provenance without local workflow effects", async () => {
  const { snapshot, actors, tracker, directory } = await setup();
  const issue = snapshot.issues[0]!;
  issue.archivedAt = issue.updatedAt;
  const parent = snapshot.comments.find((comment) => comment.issueId === issue.id)!;
  snapshot.comments.push({ ...parent, id: "acceptance-reply", parentId: parent.id, body: "Reply preserved" });
  snapshot.cycles.push({
    id: "acceptance-cycle",
    team: { id: snapshot.team.id },
    number: 1,
    name: "Previous Linear cycle",
    startsAt: "2020-01-01T00:00:00.000Z",
    endsAt: "2020-01-08T00:00:00.000Z",
    createdAt: "2020-01-01T00:00:00.000Z",
  });
  issue.cycle = { id: "acceptance-cycle" };
  await tracker.importLinear(snapshot, actors);
  const before = await readFile(join(directory, "tracker.json"), "utf8");
  expect(await tracker.call("get_issue", { id: issue.id })).toMatchObject({
    archivedAt: issue.archivedAt,
    cycleId: "acceptance-cycle",
    createdByActor: actors[(issue.creator as { id: string }).id],
  });
  expect(await tracker.call("list_comments", { issueId: issue.id, limit: 250 })).toMatchObject({
    comments: expect.arrayContaining([
      expect.objectContaining({ id: "acceptance-reply", parentId: parent.id }),
    ]),
  });
  expect(await tracker.call("list_cycles", {})).toMatchObject({
    cycles: [expect.objectContaining({ id: "acceptance-cycle" })],
  });
  const raw = JSON.parse(await readFile(join(directory, "tracker.json"), "utf8"));
  expect(raw.ownerAsks ?? []).toEqual([]);
  expect(await readFile(join(directory, "tracker.json"), "utf8")).toBe(before);
});

it("updates by provider id once and publishes the imported milestone through the existing sync journal", async () => {
  const { snapshot, actors, tracker, directory } = await setup();
  await tracker.importLinear(snapshot, actors);
  const before = JSON.parse(await readFile(join(directory, "tracker.json"), "utf8"));
  snapshot.issues[0]!.title = "Changed upstream title";
  snapshot.milestones[0]!.name = "Changed upstream milestone";
  expect(await tracker.importLinear(snapshot, actors)).toMatchObject({ created: 0, updated: 2 });
  const after = JSON.parse(await readFile(join(directory, "tracker.json"), "utf8"));
  expect(after.issues.length).toBe(before.issues.length);
  expect(after.syncLog.length).toBeGreaterThan(before.syncLog.length);
  expect(await tracker.call("get_milestone", { id: snapshot.milestones[0]!.id })).toMatchObject({
    name: "Changed upstream milestone",
  });
});
