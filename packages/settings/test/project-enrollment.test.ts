import { expect, it } from "vitest";
import {
  CreateProjectSettingsSchema,
  ProjectRoleSchema,
  ProjectsSettingsSchema,
} from "@clankie/protocol/projects";
import {
  assertProjectWorkspaceAvailable,
  assertProjectWorkspacePath,
  createProjectSettings,
} from "../src/project-enrollment.ts";
import { projectsRevision } from "../src/projects.ts";

it("nullable creation caps do not widen the existing persisted role schema", () => {
  const settings = ProjectsSettingsSchema.parse({});
  const input = CreateProjectSettingsSchema.parse({
    projectId: "new",
    name: "New",
    workspacePath: "/fixture/new",
    expectedRevision: projectsRevision(settings),
    workerCap: null,
    roles: [{ role: "  Sound   Designer ", concurrencyCap: null }],
  });
  expect(ProjectRoleSchema.safeParse(input.roles![0]).success).toBe(false);
  const created = createProjectSettings(settings, input).projects[0]!;
  expect(created.roles).toEqual([{ role: "Sound Designer" }]);
  expect(created).not.toHaveProperty("workerCap");
  expect(created.fleet).toBeUndefined();
  expect(settings.projects).toEqual([]);
});
it("namespace checks include linked roots and preserve path segment boundaries", () => {
  const settings = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "existing",
        name: "Existing",
        worktreeRoots: [
          {
            id: "trees",
            machineId: "local",
            platform: "posix",
            path: "/fixture/trees",
            repoPath: "/fixture/repo",
            commonDirectory: "/fixture/repo/.git",
          },
        ],
      },
    ],
  });
  const workspace = {
    id: "primary",
    machineId: "local",
    platform: "posix" as const,
    path: "/fixture/trees/new",
  };
  expect(() => assertProjectWorkspaceAvailable(settings, workspace)).toThrow("overlaps");
  expect(() =>
    assertProjectWorkspaceAvailable(settings, { ...workspace, path: "/fixture/trees-sibling" }),
  ).not.toThrow();
  expect(() =>
    assertProjectWorkspaceAvailable(settings, { ...workspace, machineId: "owner-remote" }),
  ).not.toThrow();
});
it("remote-owner CLI path validation stays lexical and Windows-aware, without local filesystem access", () => {
  const workspace = { id: "primary", machineId: "pc", platform: "windows" as const, path: "C:\\Repo" };
  expect(() => assertProjectWorkspacePath(workspace)).not.toThrow();
  expect(() => assertProjectWorkspacePath({ ...workspace, path: "C:\\Repo\\..\\Other" })).toThrow(
    "canonical",
  );
  const settings = ProjectsSettingsSchema.parse({
    projects: [{ id: "pc", name: "PC", workspaces: [workspace] }],
  });
  expect(() => assertProjectWorkspaceAvailable(settings, { ...workspace, path: "c:\\repo\\child" })).toThrow(
    "overlaps",
  );
});
