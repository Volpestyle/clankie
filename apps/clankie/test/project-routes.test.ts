import { expect, it } from "vitest";
import { ClankieSettingsSchema, projectsRevision } from "@clankie/settings";
import {
  ProjectsSettingsSchema,
  PROJECTS_PATH,
  PROJECT_REMOVE_WORKSPACE_PATH,
} from "@clankie/protocol/projects";
import { createProjectRoutes } from "../src/project-routes.ts";

function fixture() {
  let current = ClankieSettingsSchema.parse({ schemaVersion: 1 });
  current.projects = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "test",
        name: "Test",
        workerCap: 4,
        roles: [{ role: "builder" }],
        workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: "/missing" }],
      },
    ],
    assignments: [{ projectId: "test", personaId: "alice", role: "builder" }],
  });
  let authorized: true | "forbidden" = true;
  let race: (() => void) | undefined;
  const settings = {
    load: async () => structuredClone(current),
    update: async (mutate: (value: typeof current) => typeof current, guard?: () => Promise<void>) => {
      const next = mutate(structuredClone(current));
      race?.();
      await guard?.();
      current = next;
      return current;
    },
  };
  const app = createProjectRoutes(async () => authorized, settings);
  return {
    app,
    settings,
    deny: () => {
      authorized = "forbidden";
    },
    race: (value: () => void) => {
      race = value;
    },
    change: () => {
      current.projects.projects[0]!.workerCap = 9;
    },
    tracker: () => {
      current.projects.projects[0]!.trackerRef = { workspaceId: "repo", path: ".clankie/tracking.json" };
    },
    remove: async (patch = {}) =>
      app.request(PROJECT_REMOVE_WORKSPACE_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "test",
          workspaceId: "repo",
          expectedRevision: projectsRevision(current.projects),
          ...patch,
        }),
      }),
  };
}
it("removes only the explicit workspace, without filesystem existence or changing project policy", async () => {
  const f = fixture();
  const before = await f.settings.load();
  expect((await f.app.request(PROJECTS_PATH)).status).toBe(200);
  expect((await f.remove()).status).toBe(200);
  before.projects.projects[0]!.workspaces = [];
  expect(await f.settings.load()).toEqual(before);
});
it.each(["authority", "revision", "unknown", "tracker", "race", "authority-race", "malformed"])(
  "rejects %s removal without losing unrelated changes",
  async (kind) => {
    const f = fixture();
    if (kind === "authority") f.deny();
    if (kind === "tracker") f.tracker();
    if (kind === "race") f.race(f.change);
    if (kind === "authority-race") f.race(f.deny);
    const patch =
      kind === "revision"
        ? { expectedRevision: "0".repeat(64) }
        : kind === "unknown"
          ? { workspaceId: "absent" }
          : kind === "malformed"
            ? { extra: true }
            : {};
    expect((await f.remove(patch)).status).toBeGreaterThanOrEqual(400);
    expect((await f.settings.load()).projects.projects[0]!.workspaces).toHaveLength(1);
    if (kind === "race") expect((await f.settings.load()).projects.projects[0]!.workerCap).toBe(9);
  },
);
