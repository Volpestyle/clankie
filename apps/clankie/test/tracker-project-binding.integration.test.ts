import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import { OPERATOR_CONVERSATION_DISPATCH_PATH, ProjectsSettingsSchema } from "@clankie/protocol";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, writeConvention } from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { projectWorkRepoId } from "../src/project-work-items.ts";
import { createWorkItemsService } from "../src/work-items.ts";

it("binds a settings project to a built-in tracker project UUID and returns it through work_repos", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tracker-binding-")));
  const workspace = join(root, "clankie-work");
  await mkdir(workspace);
  await writeConvention(workspace, {
    schemaVersion: 1,
    backend: "default",
    decidedBy: "owner",
    decidedAt: "2026-10-09T00:00:00Z",
  });
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "clankie-work",
          name: "Clankie Work",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: workspace }],
          trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" },
        },
        { id: "other", name: "Other" },
      ],
    }),
  }));
  const tracker = createLocalTracker({ directory: join(root, "tracker") });
  const imported = (await tracker.call("save_project", { name: "Clankie Work", addTeams: ["LOCAL"] })) as {
    id: string;
  };
  const host = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    builtInTracker: tracker,
    workItems: createWorkItemsService({
      stateDirectory: root,
      projects: async () => (await settings.load()).projects,
      localMachineId: "local",
    }),
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
    // The operator dispatch route is the device/captain lane; the owner bearer reaches it as the API lane.
    authenticateCaptain: async (request) =>
      request.headers.get("authorization") === "Bearer owner"
        ? { captainId: "operator", steerSourceLane: "api" }
        : undefined,
  });
  try {
    const fetchImpl = (async (input, init) =>
      host.app.request(new Request(String(input), init))) as typeof fetch;
    const client = new ClankieApiClient({ baseUrl: "http://localhost", operatorToken: "owner", fetchImpl });
    const workRepos = async () => {
      const response = await host.app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
        method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" },
        body: JSON.stringify({ op: "work_repos", schemaVersion: 1 }),
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { repos: Record<string, unknown>[] }).repos.find(
        (repo) => repo.id === projectWorkRepoId("clankie-work"),
      );
    };
    expect(await workRepos()).not.toHaveProperty("trackerProjectId");
    const update = async (trackerProjectId: unknown, projectId = "clankie-work") => {
      const revision = (await client.projects()).revision;
      return host.app.request("/v1/operator/projects/update", {
        method: "POST",
        headers: { authorization: "Bearer owner", "content-type": "application/json" },
        body: JSON.stringify({ projectId, expectedRevision: revision, changes: { trackerProjectId } }),
      });
    };
    // Names never bind, and a UUID the tracker does not hold is refused.
    expect((await update("Clankie Work")).status).toBe(400);
    const unknown = await update("00000000-0000-4000-8000-000000000000");
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual({ error: "tracker_project_not_found" });

    const bound = await client.updateProjectSettings({
      projectId: "clankie-work",
      expectedRevision: (await client.projects()).revision,
      changes: { trackerProjectId: imported.id },
    });
    expect(bound.settings.projects.find((project) => project.id === "clankie-work")).toMatchObject({
      trackerProjectId: imported.id,
    });
    expect(await workRepos()).toMatchObject({
      projectId: "clankie-work",
      trackerProjectId: imported.id,
      backend: "default",
    });
    // One district per tracker project.
    expect((await update(imported.id, "other")).status).toBe(409);

    await client.updateProjectSettings({
      projectId: "clankie-work",
      expectedRevision: (await client.projects()).revision,
      changes: { trackerProjectId: null },
    });
    expect(await workRepos()).not.toHaveProperty("trackerProjectId");
  } finally {
    host.close();
    await rm(root, { recursive: true, force: true });
  }
});
