import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createProjectMembershipResolver } from "../src/project-membership.ts";

function fixture() {
  const settings = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "repo",
        name: "Repo",
        workspaces: [{ id: "main", machineId: "local", platform: "posix", path: "/repo" }],
        worktreeRoots: [
          {
            id: "root",
            machineId: "local",
            platform: "posix",
            path: "/worktrees",
            repoPath: "/repo",
            commonDirectory: "/repo/.git",
          },
        ],
      },
    ],
  });
  const state = { valid: true, cwd: "/worktrees/branch/src", startTime: "original", mutate: () => {} };
  const identity = {
    pane: "w1:p1",
    validate: async () => state.valid,
    projectProof: async () => ({
      fleet: "default",
      pane: "w1:p1",
      nativeOccupantId: "native",
      binding: { socketPath: "/socket" },
      shell: { pid: 10, startTime: "shell" },
      processes: [{ pid: 11, startTime: state.startTime }],
    }),
  };
  const resolve = createProjectMembershipResolver({
    settings: async () => settings,
    hire: async () => ({ state: "none" }),
    canonical: async (path) => path,
    cwd: async () => state.cwd,
    worktreeRoot: async () => ({
      path: "/worktrees",
      repoPath: "/repo",
      commonDirectory: "/repo/.git",
      homePath: "/home/owner",
    }),
    gitWorktree: async () => {
      state.mutate();
      return {
        cwd: "/worktrees/branch/src",
        worktreePath: "/worktrees/branch",
        gitDirectory: "/repo/.git/worktrees/branch",
        commonDirectory: "/repo/.git",
        repoPath: "/repo",
        repoCommonDirectory: "/repo/.git",
        registeredWorktrees: ["/repo", "/worktrees/branch"],
        gitFilePath: "/worktrees/branch/.git",
        gitDirectoryBacklink: "/worktrees/branch/.git",
      };
    },
  });
  return { state, settings, resolve: () => resolve(identity) };
}
it("admits a native linked-worktree cwd with no hire assignment", async () => {
  expect(await fixture().resolve()).toMatchObject({ projectId: "repo" });
});
it.each(["cwd", "process", "authority", "settings"])(
  "denies %s races after Git observation",
  async (kind) => {
    const f = fixture();
    f.state.mutate = () => {
      if (kind === "cwd") f.state.cwd = "/outside";
      if (kind === "process") f.state.startTime = "reused";
      if (kind === "authority") f.state.valid = false;
      if (kind === "settings") f.settings.projects[0]!.name = "changed";
    };
    expect(await f.resolve()).toBeUndefined();
  },
);
