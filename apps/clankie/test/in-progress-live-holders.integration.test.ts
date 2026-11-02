// #318: "in progress" means a live agent holds the issue now. The real captain (its Herdr
// census stood in, as in agent-work.test.ts), its real `state_work`, and the real work-item
// service over a real file tracker: the reads behind list_issues, the app's views and
// `clankie work list`, and `clankie metrics --issues`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsStore } from "@clankie/settings";
import type { WorkItem } from "@clankie/protocol";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import * as census from "../src/captain/herdr-census.ts";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { createWorkItemsService } from "../src/work-items.ts";

const roots: string[] = [];
const scratch = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), name));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("counts an issue in progress only while a live agent holds it, and drops it when that agent closes", async () => {
  const root = scratch("clankie-in-progress-");
  const checkout = scratch("clankie-in-progress-repo-");
  const occupant = "019a0000-0000-7000-8000-000000000318";
  vi.spyOn(HerdrWatchStore.prototype, "start").mockImplementation(() => {});
  vi.spyOn(HerdrWatchStore.prototype, "trackSeat").mockImplementation(() => {});
  vi.spyOn(census, "readSeatIdForHerdrPane").mockResolvedValue("seat");
  const worker = {
    seatId: "seat",
    paneId: "w1:p1",
    occupantId: occupant,
    subject: "seat",
    harness: "codex",
    status: "working",
    title: "Juniper",
    session: { kind: "id" as const, source: "herdr:codex", value: occupant },
  };
  const observed = vi.spyOn(census, "readFleet").mockResolvedValue({ seats: [worker] });
  const captain = createCaptain({} as CaptainDeps, {
    repoRoot: root,
    stateDir: root,
    settings: new SettingsStore(join(root, "settings.json")),
  });
  const refresh = async () => {
    const result = await captain.serveOperatorConversation({
      op: "fleet",
      schemaVersion: 1,
      includeWork: true,
    });
    if (result.op !== "fleet") throw new Error("Expected a fleet");
    return result.snapshot;
  };
  const work = createWorkItemsService({
    stateDirectory: join(root, "work"),
    workspace: () => root,
    run: async () => {
      throw new Error("no git here");
    },
    liveHolders: () => captain.issueHolders!(),
  });
  const list = async (status?: WorkItem["status"][]) => {
    const result = await work.handle(
      { action: "list", repo: checkout, ...(status === undefined ? {} : { status }) },
      true,
    );
    if (!("items" in result)) throw new Error("Expected a list");
    return Object.fromEntries(result.items.map((item) => [item.title, item]));
  };
  const create = async (title: string, status: WorkItem["status"]) => {
    const result = await work.handle({ action: "create", repo: checkout, title, status }, true);
    if (!("item" in result)) throw new Error("Expected an item");
    return { repoId: result.repo.id, item: result.item };
  };
  const inProgress = async () => (await captain.readIssueMetrics({})).summary?.current.inProgressCount;
  try {
    await refresh();
    // The tracker says one issue is in progress, but nobody is working on it.
    const stale = await create("Claimed long ago", "in_progress");
    const { repoId, item: held } = await create("Being worked now", "todo");
    expect(await list()).toMatchObject({
      "Claimed long ago": { status: "todo", trackerStatus: "in_progress" },
      "Being worked now": { status: "todo" },
    });
    expect(await list()).not.toHaveProperty(["Claimed long ago", "heldBy"]);
    expect(await list(["in_progress"])).toEqual({});
    expect(await inProgress()).toBe(0);

    // A live worker states it is working on one issue.
    await captain.serveOperatorConversation({
      op: "state_work",
      schemaVersion: 1,
      work: {
        herdrPaneId: "w1:p1",
        assignment: { objective: "Ship it", issue: { repoId, itemId: held.id } },
      },
    });
    await refresh();
    expect(await list()).toMatchObject({
      "Claimed long ago": { status: "todo", trackerStatus: "in_progress" },
      "Being worked now": { status: "in_progress", trackerStatus: "todo", heldBy: ["seat"] },
    });
    expect(Object.keys(await list(["in_progress"]))).toEqual(["Being worked now"]);
    expect(Object.keys(await list(["todo"])).sort()).toEqual(["Claimed long ago"]);
    const shown = await work.handle({ action: "show", repo: checkout, id: held.id }, true);
    expect(shown).toMatchObject({ item: { status: "in_progress", heldBy: ["seat"] } });
    expect(await inProgress()).toBe(1);

    // The worker closes without a merge: its pane is gone from the fleet.
    observed.mockResolvedValue({ seats: [] });
    // Fleet reads are fresh for about a second; read again once that window has passed.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await refresh()).seats).toEqual([]);
    expect(await list()).toMatchObject({ "Being worked now": { status: "todo" } });
    expect(await list()).not.toHaveProperty(["Being worked now", "heldBy"]);
    expect(await list(["in_progress"])).toEqual({});
    expect(await inProgress()).toBe(0);
    expect(stale.item.status).toBe("in_progress");
  } finally {
    await captain.close();
  }
}, 30_000);
