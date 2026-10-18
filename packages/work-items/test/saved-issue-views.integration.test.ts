import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalTracker } from "../src/tracker-local.ts";
import { refuseBuiltInTrackerFeatures } from "../src/tracker-tools.ts";

it("persists scoped filters, applies current issues after reopen, and preserves guards and isolation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saved-issue-views-"));
  try {
    const tracker = createLocalTracker({ directory });
    const team = (await tracker.call("list_teams", {})) as { teams: { id: string }[] };
    const project = (await tracker.call("save_project", {
      name: "Views",
      addTeams: [team.teams[0]!.id],
    })) as { id: string };
    const other = (await tracker.call("save_project", { name: "Other", addTeams: [team.teams[0]!.id] })) as {
      id: string;
    };
    const storeId = await tracker.storeId();
    const scope = { project: project.id, storeId };
    const definition = { ...scope, schemaVersion: 1, name: "Urgent", filter: { priority: 1 } };
    await expect(
      tracker.call("save_issue_view", { ...definition, ifUpdatedAt: "not-an-existing-record" }),
    ).rejects.toThrow(/ifUpdatedAt/);
    await expect(
      tracker.call("save_issue_view", { ...definition, filter: { createdAt: "not-a-date" } }),
    ).rejects.toThrow(/date/i);
    const view = (await tracker.call("save_issue_view", {
      ...definition,
      idempotencyKey: "view-create-1",
    })) as { id: string; updatedAt: string };
    expect(await tracker.call("save_issue_view", { ...definition, idempotencyKey: "view-create-1" })).toEqual(
      view,
    );
    const first = (await tracker.call("save_issue", {
      team: team.teams[0]!.id,
      project: project.id,
      title: "First",
      priority: 1,
    })) as { id: string };
    await tracker.call("save_issue", {
      team: team.teams[0]!.id,
      project: other.id,
      title: "Hidden",
      priority: 1,
    });
    const apply = () =>
      tracker.call("list_issue_view_issues", { ...scope, id: view.id }) as Promise<{
        issues: { id: string }[];
      }>;
    expect((await apply()).issues.map((issue) => issue.id)).toEqual([first.id]);
    const second = (await tracker.call("save_issue", {
      team: team.teams[0]!.id,
      project: project.id,
      title: "Second",
      priority: 1,
    })) as { id: string };
    await tracker.call("save_issue", { id: first.id, priority: 3 });
    expect((await apply()).issues.map((issue) => issue.id)).toEqual([second.id]);
    const third = (await tracker.call("save_issue", {
      team: team.teams[0]!.id,
      project: project.id,
      title: "Third",
      priority: 1,
    })) as { id: string };
    const page = (await tracker.call("list_issue_view_issues", { ...scope, id: view.id, limit: 1 })) as {
      issues: { id: string }[];
      hasNextPage: boolean;
      cursor: string;
    };
    expect(page.hasNextPage).toBe(true);
    const next = (await tracker.call("list_issue_view_issues", {
      ...scope,
      id: view.id,
      limit: 1,
      cursor: page.cursor,
    })) as { issues: { id: string }[] };
    expect(new Set([...page.issues, ...next.issues].map((issue) => issue.id))).toEqual(
      new Set([second.id, third.id]),
    );
    await tracker.call("save_issue", { id: third.id, priority: 4 });
    const reopened = createLocalTracker({ directory });
    expect(await reopened.call("get_issue_view", { ...scope, id: view.id })).toEqual(view);
    expect(
      (
        (await reopened.call("list_issue_view_issues", { ...scope, id: view.id })) as {
          issues: { id: string }[];
        }
      ).issues.map((issue) => issue.id),
    ).toEqual([second.id]);
    await expect(
      tracker.call("get_issue_view", { ...scope, project: other.id, id: view.id }),
    ).rejects.toThrow();
    await expect(
      tracker.call("post_delete_issue_view", { ...scope, storeId: "another-store", id: view.id }),
    ).rejects.toThrow();
    await expect(
      tracker.call("save_issue_view", { ...definition, id: view.id, filter: { project: other.id } }),
    ).rejects.toThrow();
    await expect(
      tracker.call("save_issue_view", { ...definition, id: view.id, filter: { constructor: "arbitrary" } }),
    ).rejects.toThrow();
    await expect(
      tracker.call("save_issue_view", { ...definition, id: view.id, filter: { assignee: "x".repeat(2049) } }),
    ).rejects.toThrow();
    await expect(
      tracker.call("save_issue_view", { ...definition, id: view.id, name: "x".repeat(121) }),
    ).rejects.toThrow();
    const updated = (await tracker.call("save_issue_view", {
      ...scope,
      schemaVersion: 1,
      id: view.id,
      name: "Renamed",
      ifUpdatedAt: view.updatedAt,
    })) as { updatedAt: string };
    await expect(
      tracker.call("post_delete_issue_view", { ...scope, id: view.id, ifUpdatedAt: view.updatedAt }),
    ).rejects.toThrow(/changed/);
    expect(((await tracker.call("list_issue_views", scope)) as { views: unknown[] }).views).toHaveLength(1);
    await tracker.call("post_delete_issue_view", {
      ...scope,
      id: view.id,
      ifUpdatedAt: updated.updatedAt,
      idempotencyKey: "view-delete-1",
    });
    expect(
      ((await createLocalTracker({ directory }).call("list_issue_views", scope)) as { views: unknown[] })
        .views,
    ).toHaveLength(0);
    expect(() => refuseBuiltInTrackerFeatures("save_issue_view", definition)).toThrow(/built-in tracker/);
    expect(() => refuseBuiltInTrackerFeatures("list_issue_view_issues", scope)).toThrow(/built-in tracker/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
