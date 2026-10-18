import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SUPERVISE_GRANTS, TrackerSyncResultSchema } from "@clankie/protocol";
import { syncFixture } from "./helpers/tracker-sync.ts";

it("reads and applies current saved views through the enrolled chat device relay with canonical paging and isolation", async () => {
  const f = await syncFixture();
  try {
    const project = (await f.tracker.call("save_project", { name: "Views", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const other = (await f.tracker.call("save_project", { name: "Other", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const storeId = await f.tracker.storeId();
    const scope = { project: project.id, storeId };
    const urgent = (await f.tracker.call("save_issue_view", {
      ...scope,
      schemaVersion: 1,
      name: "Urgent",
      filter: { priority: 1 },
    })) as { id: string };
    const all = (await f.tracker.call("save_issue_view", {
      ...scope,
      schemaVersion: 1,
      name: "All",
      filter: {},
    })) as { id: string };
    const foreign = (await f.tracker.call("save_issue_view", {
      project: other.id,
      storeId,
      schemaVersion: 1,
      name: "Foreign",
      filter: {},
    })) as { id: string };
    const first = (await f.tracker.call("save_issue", {
      team: "LOCAL",
      project: project.id,
      title: "First",
      priority: 1,
    })) as { id: string };
    await f.tracker.call("save_issue", { team: "LOCAL", project: other.id, title: "Hidden", priority: 1 });
    const second = (await f.tracker.call("save_issue", {
      team: "LOCAL",
      project: project.id,
      title: "Second",
      priority: 1,
    })) as { id: string };
    const device = await f.pair("View reader", SUPERVISE_GRANTS);
    const noChat = await f.pair("No chat", { ...SUPERVISE_GRANTS, chat: false });
    const list = { action: "list_issue_views" as const, ...scope, limit: 1 };
    const before = await readFile(join(f.root, "tracker.json"), "utf8");
    const page = await f.sync(device.deviceToken, list);
    expect(page).toMatchObject({
      status: 200,
      outcome: "issue_views",
      storeId,
      projectId: project.id,
      hasNextPage: true,
    });
    expect(page.views).toHaveLength(1);
    const next = await f.sync(device.deviceToken, { ...list, cursor: page.cursor });
    expect(next.hasNextPage).toBe(false);
    expect(new Set([...page.views, ...next.views].map((view: { id: string }) => view.id))).toEqual(
      new Set([urgent.id, all.id]),
    );
    // Successful reads preserve canonical result records and never create write receipts.
    const { status: _status, error: _error, ...wirePage } = page;
    expect(TrackerSyncResultSchema.parse(wirePage)).toMatchObject({ outcome: "issue_views" });
    const apply = { action: "list_issue_view_issues" as const, ...scope, id: urgent.id, limit: 1 };
    expect((await f.sync(noChat.deviceToken, list)).status).toBe(403);
    expect((await f.sync(noChat.deviceToken, apply)).status).toBe(403);
    const applied = await f.sync(device.deviceToken, apply);
    const appliedNext = await f.sync(device.deviceToken, { ...apply, cursor: applied.cursor });
    expect(
      new Set([...applied.issues, ...appliedNext.issues].map((issue: { id: string }) => issue.id)),
    ).toEqual(new Set([first.id, second.id]));
    const canonical = await f.tracker.call("list_issue_view_issues", { ...scope, id: urgent.id, limit: 1 });
    expect(applied).toMatchObject(canonical as Record<string, unknown>);
    expect(await readFile(join(f.root, "tracker.json"), "utf8")).toBe(before);
    await expect(f.sync(device.deviceToken, { ...apply, id: foreign.id })).resolves.toMatchObject({
      outcome: "refused",
    });
    await expect(f.sync(device.deviceToken, { ...apply, project: other.id })).resolves.toMatchObject({
      outcome: "refused",
    });
    await expect(f.sync(device.deviceToken, { ...list, storeId: "replaced-store" })).resolves.toMatchObject({
      outcome: "refused",
    });
    await expect(
      f.sync(device.deviceToken, { ...list, project: other.id, cursor: page.cursor }),
    ).resolves.toMatchObject({ outcome: "refused" });

    const boot = await f.sync(device.deviceToken, {
      action: "bootstrap",
      type: "partial",
      projects: [project.id],
      lazy: true,
    });
    const metadata = JSON.parse(boot.ndjson.trim().split("\n").at(-1));
    await f.tracker.call("save_issue", { id: first.id, priority: 4 });
    const commits = await f.sync(device.deviceToken, {
      action: "subscribe",
      projects: [project.id],
      storeId,
      lastSyncId: metadata.lastSyncId,
      waitMs: 0,
      limit: 100,
    });
    expect(commits.commits.some((commit: { tool: string }) => commit.tool === "save_issue")).toBe(true);
    expect(
      (await f.sync(device.deviceToken, { ...apply, limit: 50 })).issues.map(
        (issue: { id: string }) => issue.id,
      ),
    ).toEqual([second.id]);
    await f.tracker.call("save_issue_view", {
      ...scope,
      id: urgent.id,
      schemaVersion: 1,
      filter: { priority: 4 },
    });
    const definitionCommit = await f.sync(device.deviceToken, {
      action: "subscribe",
      projects: [project.id],
      storeId,
      lastSyncId: commits.lastSyncId,
      waitMs: 0,
      limit: 100,
    });
    expect(definitionCommit.commits).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: "save_issue_view", deltas: [] })]),
    );
    expect((await f.sync(device.deviceToken, apply)).issues.map((issue: { id: string }) => issue.id)).toEqual(
      [first.id],
    );
    await f.revoke(device.deviceId);
    expect(await f.sync(device.deviceToken, list)).toMatchObject({ status: 401, error: "revoked" });
    expect(await f.sync(device.deviceToken, apply)).toMatchObject({ status: 401, error: "revoked" });
  } finally {
    await f.close();
  }
});
