import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalTracker, trackerToolsFor } from "@clankie/work-items";
import { createWorkItemsService } from "../src/work-items.ts";
import { authorizeProjectTrackerCall } from "../src/captain/project-tracker-access.ts";

it("keeps saved views inside the repo binding and remote lead project fence with real storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saved-view-project-access-"));
  try {
    const tracker = createLocalTracker({ directory });
    const teams = (await tracker.call("list_teams", {})) as { teams: { id: string }[] };
    const teamId = teams.teams[0]!.id;
    const first = (await tracker.call("save_project", { name: "First", addTeams: [teamId] })) as {
      id: string;
    };
    const other = (await tracker.call("save_project", { name: "Other", addTeams: [teamId] })) as {
      id: string;
    };
    const storeId = await tracker.storeId();
    const scope = { project: first.id, storeId };
    const view = (await tracker.call("save_issue_view", {
      ...scope,
      schemaVersion: 1,
      name: "All",
      filter: {},
    })) as { id: string };
    const foreign = (await tracker.call("save_issue_view", {
      project: other.id,
      storeId,
      schemaVersion: 1,
      name: "Other",
      filter: {},
    })) as { id: string };
    const read = (name: string, args: Record<string, unknown>) => tracker.call(name, args);
    for (const name of [
      "get_issue_view",
      "list_issue_view_issues",
      "post_delete_issue_view",
      "save_issue_view",
    ]) {
      const args = { ...scope, id: view.id, ...(name === "save_issue_view" ? { schemaVersion: 1 } : {}) };
      await expect(authorizeProjectTrackerCall(name, args, other.id, read)).rejects.toThrow();
      await expect(
        authorizeProjectTrackerCall(name, { ...args, storeId: "foreign-store" }, first.id, read),
      ).rejects.toThrow();
      await expect(
        authorizeProjectTrackerCall(name, { ...args, id: foreign.id }, first.id, read),
      ).rejects.toThrow();
      expect(await authorizeProjectTrackerCall(name, args, first.id, read)).toEqual(args);
    }
    await expect(authorizeProjectTrackerCall("list_issue_views", scope, other.id, read)).rejects.toThrow();
    const scoped = trackerToolsFor(
      directory,
      { schemaVersion: 1, backend: "builtin", decidedBy: "owner", decidedAt: new Date().toISOString() },
      { builtIn: { projectId: first.id, teamId, open: () => tracker } },
    );
    await expect(
      scoped.call("get_issue_view", { ...scope, project: other.id, id: foreign.id }),
    ).rejects.toThrow();
    await expect(
      scoped.call("get_issue_view", { ...scope, storeId: "foreign-store", id: view.id }),
    ).rejects.toThrow();
    expect(await scoped.call("get_issue_view", { ...scope, id: view.id })).toEqual(view);
    // The real filesystem repo adapter refuses this capability; it never falls back to ancillary storage.
    const unsupported = trackerToolsFor(
      directory,
      {
        schemaVersion: 1,
        backend: "markdown",
        directory: "tasks",
        decidedAt: new Date().toISOString(),
        decidedBy: "owner",
      },
      {},
    );
    const disconnectedLinear = trackerToolsFor(
      directory,
      {
        schemaVersion: 1,
        backend: "linear",
        decidedBy: "owner",
        linear: { team: "LOCAL" },
        decidedAt: new Date().toISOString(),
      },
      {},
    );
    await expect(
      disconnectedLinear.call("save_issue_view", {
        ...scope,
        schemaVersion: 1,
        name: "No disconnected fallback",
        filter: {},
      }),
    ).rejects.toThrow(/built-in tracker/);
    await expect(
      unsupported.call("save_issue_view", { ...scope, schemaVersion: 1, name: "No fallback", filter: {} }),
    ).rejects.toThrow(/built-in tracker/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses saved-view service routing when current project authority is unavailable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "saved-view-no-authority-"));
  try {
    const service = createWorkItemsService({ stateDirectory: directory });
    await expect(
      service.callTracker(
        "list_issue_views",
        { project: "00000000-0000-0000-0000-000000000001", storeId: "store" },
        { repo: "unknown", local: true },
      ),
    ).rejects.toThrow("Current project authority is unavailable");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
