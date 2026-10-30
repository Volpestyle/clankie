import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createLocalTracker,
  refuseBuiltInTrackerFeatures,
  TRACKER_LEAD,
  TRACKER_OWNER,
  TRACKER_TOOLS,
  trackerCatalogForRole,
  trackerRoleRefusal,
  type TrackerActor,
  type TrackerItemEvent,
} from "../src/index.ts";

// LOCAL-VUH-64: only items the lead or owner marks with an owner check reach the
// owner's Proof deck; workers neither see nor set the mark.
const lead: TrackerActor = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
const owner: TrackerActor = { ...TRACKER_OWNER, onBehalfOf: [] };
const worker: TrackerActor = {
  type: "agent-worker",
  id: "owner-check-worker",
  name: "Builder",
  onBehalfOf: [TRACKER_OWNER, TRACKER_LEAD],
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tracker-owner-check-"));
  roots.push(root);
  const tracker = createLocalTracker({ directory: join(root, "tracker") });
  const save = async (args: Record<string, unknown>, actor: TrackerActor = lead) =>
    (await tracker.call("save_issue", args, { actor })) as Record<string, unknown> & {
      id: string;
      ownerCheck?: string;
    };
  const issue = await save({ team: "LOCAL", title: "Taps on a house" });
  const events = async () =>
    (
      (await tracker.call("list_issue_events", { issueId: issue.id }, { actor: lead })) as {
        events: TrackerItemEvent[];
      }
    ).events.filter((event) => event.type === "owner_check");
  const read = async () =>
    (await tracker.call("get_issue", { id: issue.id }, { actor: lead })) as Record<string, unknown>;
  return { tracker, save, issue, events, read };
}

const check = "Open Work, tap a house, tap back, open Work: taps work";

it("the lead and the owner set, change and clear an item's owner check, each change in its event stream", async () => {
  const f = await fixture();
  const set = await f.save({ id: f.issue.id, ownerCheck: `  ${check}  ` });
  expect(set.ownerCheck).toBe(check);
  expect((await f.read()).ownerCheck).toBe(check);

  // Saving the same check again records nothing new.
  await f.save({ id: f.issue.id, ownerCheck: check });
  expect((await f.events()).map(({ body, actor }) => ({ body, actor: actor.id }))).toEqual([
    { body: check, actor: TRACKER_LEAD.id },
  ]);

  const byOwner = await f.save({ id: f.issue.id, ownerCheck: "Does the garden feel calm?" }, owner);
  expect(byOwner.ownerCheck).toBe("Does the garden feel calm?");

  const cleared = await f.save({ id: f.issue.id, ownerCheck: null });
  expect(cleared).not.toHaveProperty("ownerCheck");
  expect(await f.read()).not.toHaveProperty("ownerCheck");
  await f.save({ id: f.issue.id, ownerCheck: "Again" });
  expect((await f.save({ id: f.issue.id, ownerCheck: "   " })).ownerCheck).toBeUndefined();

  // Other saves leave it alone.
  await f.save({ id: f.issue.id, ownerCheck: check });
  expect((await f.save({ id: f.issue.id, title: "Taps on a house work" })).ownerCheck).toBe(check);

  const history = await f.events();
  expect(history.map(({ body, actor }) => ({ body, actor: actor.id }))).toEqual([
    { body: check, actor: TRACKER_LEAD.id },
    { body: "Does the garden feel calm?", actor: TRACKER_OWNER.id },
    { body: undefined, actor: TRACKER_LEAD.id },
    { body: "Again", actor: TRACKER_LEAD.id },
    { body: undefined, actor: TRACKER_LEAD.id },
    { body: check, actor: TRACKER_LEAD.id },
  ]);
});

it("a worker is refused, on create and on update, and nothing is written", async () => {
  const f = await fixture();
  await expect(f.save({ id: f.issue.id, ownerCheck: check }, worker)).rejects.toThrow(
    /owner_check_reserved.*only the owner or the lead asks the owner to check an item/u,
  );
  await expect(f.save({ id: f.issue.id, ownerCheck: null }, worker)).rejects.toThrow(/owner_check_reserved/u);
  await expect(f.save({ team: "LOCAL", title: "Sneaky", ownerCheck: check }, worker)).rejects.toThrow(
    /owner_check_reserved/u,
  );
  expect(await f.read()).not.toHaveProperty("ownerCheck");
  expect(await f.events()).toEqual([]);
  const listed = (await f.tracker.call("list_issues", { query: "Sneaky" }, { actor: lead })) as {
    issues: unknown[];
  };
  expect(listed.issues).toEqual([]);
  // A worker's ordinary save still works.
  expect((await f.save({ id: f.issue.id, title: "Renamed" }, worker)).title).toBe("Renamed");
});

it("an owner check is one line of at most 140 characters", async () => {
  const f = await fixture();
  await expect(f.save({ id: f.issue.id, ownerCheck: "Open Work\ntap a house" })).rejects.toThrow(/one line/u);
  await expect(f.save({ id: f.issue.id, ownerCheck: "Open Work\rtap a house" })).rejects.toThrow(/one line/u);
  await expect(f.save({ id: f.issue.id, ownerCheck: "x".repeat(141) })).rejects.toThrow(
    /at most 140 characters/u,
  );
  expect((await f.read()).ownerCheck).toBeUndefined();
  expect((await f.save({ id: f.issue.id, ownerCheck: "x".repeat(140) })).ownerCheck).toBe("x".repeat(140));
});

it("workers and reviewers neither see nor call the owner check; other backends refuse it", () => {
  for (const role of ["worker", "reviewer"] as const) {
    expect(trackerRoleRefusal(role, "save_issue", { id: "LOCAL-1", ownerCheck: check })).toBe(
      "asking the owner to check an item belongs to the lead",
    );
    expect(trackerRoleRefusal(role, "save_issue", { id: "LOCAL-1", ownerCheck: null })).toBeDefined();
    const saveIssue = trackerCatalogForRole(role, TRACKER_TOOLS).find((tool) => tool.name === "save_issue")!;
    expect((saveIssue.inputSchema as { properties: object }).properties).not.toHaveProperty("ownerCheck");
  }
  expect(trackerRoleRefusal("lead", "save_issue", { id: "LOCAL-1", ownerCheck: check })).toBeUndefined();
  expect(trackerRoleRefusal("worker", "save_issue", { id: "LOCAL-1", title: "Fine" })).toBeUndefined();
  const full = TRACKER_TOOLS.find((tool) => tool.name === "save_issue")!;
  expect((full.inputSchema as { properties: object }).properties).toHaveProperty("ownerCheck");

  expect(() => refuseBuiltInTrackerFeatures("save_issue", { id: "VUH-1", ownerCheck: check })).toThrow(
    "ownerCheck is supported only by Clankie's built-in tracker",
  );
  expect(() => refuseBuiltInTrackerFeatures("save_issue", { id: "VUH-1", ownerCheck: null })).toThrow(
    /ownerCheck/u,
  );
});
