import { expect, it } from "vitest";
import { ClankieSettingsSchema, projectsRevision } from "@clankie/settings";
import {
  ProjectsSettingsSchema,
  PROJECT_ADD_WORKTREE_ROOT_PATH,
  PROJECT_REMOVE_WORKTREE_ROOT_PATH,
} from "@clankie/protocol/projects";
import { createProjectRoutes } from "../src/project-routes.ts";

function fixture() {
  let current = ClankieSettingsSchema.parse({ schemaVersion: 1 });
  current.projects = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "repo",
        name: "Repo",
        workspaces: [{ id: "main", machineId: "local", platform: "posix", path: "/repo" }],
      },
    ],
  });
  let authority: true | "forbidden" = true;
  let mutation: (() => void) | undefined;
  let root = {
    path: "/worktrees",
    repoPath: "/repo",
    commonDirectory: "/repo/.git",
    homePath: "/home/owner",
  };
  let observations = 0;
  const app = createProjectRoutes(
    async () => authority,
    {
      load: async () => structuredClone(current),
      update: async (mutate, guard) => {
        const next = mutate(structuredClone(current));
        mutation?.();
        await guard?.();
        current = next;
        return next;
      },
    },
    {
      worktreeRoot: async () => {
        observations++;
        return structuredClone(root);
      },
    },
  );
  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    app,
    current: () => current,
    observations: () => observations,
    deny: () => {
      authority = "forbidden";
    },
    race: (kind: "authority" | "settings" | "root") => {
      mutation = () => {
        if (kind === "authority") authority = "forbidden";
        if (kind === "settings") current.projects.projects[0]!.name = "changed";
        if (kind === "root") root = { ...root, commonDirectory: "/other/.git" };
      };
    },
    add: (extra = {}) =>
      post(PROJECT_ADD_WORKTREE_ROOT_PATH, {
        projectId: "repo",
        machineId: "local",
        platform: "posix",
        path: "/worktrees",
        repoPath: "/repo",
        expectedRevision: projectsRevision(current.projects),
        ...extra,
      }),
    remove: () =>
      post(PROJECT_REMOVE_WORKTREE_ROOT_PATH, {
        projectId: "repo",
        rootId: current.projects.projects[0]!.worktreeRoots[0]!.id,
        expectedRevision: projectsRevision(current.projects),
      }),
  };
}
it("owner API enrolls native-observed identity and removes only the chosen root", async () => {
  const f = fixture();
  expect((await f.add()).status).toBe(200);
  expect(f.current().projects.projects[0]!.worktreeRoots[0]).toMatchObject({
    repoPath: "/repo",
    commonDirectory: "/repo/.git",
  });
  expect(f.current().projects.projects[0]!.grants).toEqual([]);
  expect((await f.remove()).status).toBe(200);
  expect(f.current().projects.projects[0]!.worktreeRoots).toEqual([]);
  expect(f.current().projects.projects[0]!.workspaces).toHaveLength(1);
});
it("rejects non-owner requests before filesystem observation and refuses caller-supplied Git facts", async () => {
  const f = fixture();
  expect((await f.add({ commonDirectory: "/forged" })).status).toBe(400);
  f.deny();
  expect((await f.add()).status).toBe(403);
  expect(f.observations()).toBe(0);
});
it.each(["authority", "settings", "root"] as const)(
  "rechecks %s immediately before enrollment persistence",
  async (kind) => {
    const f = fixture();
    f.race(kind);
    expect((await f.add()).status).toBe(409);
    expect(f.current().projects.projects[0]!.worktreeRoots).toEqual([]);
  },
);
it.each(["authority", "settings"] as const)(
  "rechecks %s immediately before removal persistence",
  async (kind) => {
    const f = fixture();
    await f.add();
    f.race(kind);
    expect((await f.remove()).status).toBe(409);
    expect(f.current().projects.projects[0]!.worktreeRoots).toHaveLength(1);
  },
);
it("stale revision and unapproved repo do not enroll a root", async () => {
  const f = fixture();
  expect((await f.add({ expectedRevision: "0".repeat(64) })).status).toBe(409);
  expect((await f.add({ repoPath: "/foreign" })).status).toBe(409);
  expect(f.current().projects.projects[0]!.worktreeRoots).toEqual([]);
});
