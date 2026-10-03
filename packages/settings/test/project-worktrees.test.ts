import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { projectsRevision, resolveProjectMembership, removeProjectWorkspace } from "../src/projects.ts";
import {
  addProjectWorktreeRoot,
  removeProjectWorktreeRoot,
  matchesProjectWorktree,
  projectWorktreeMatches,
  validateProjectWorktreeRoot,
} from "../src/project-worktrees.ts";
import {
  observeLocalProjectWorktreeRoot,
  observeLocalProjectGitWorktree,
} from "../src/project-worktree-observer.ts";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "project-worktrees-")));
  roots.push(temporary);
  const repo = join(temporary, "repo");
  const root = join(temporary, "worktrees");
  await mkdir(root);
  const git = async (...args: string[]) =>
    exec("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
      timeout: 5_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
  await git("init", "--initial-branch=main", repo);
  await git(
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const worktree = join(root, "branch");
  await git("-C", repo, "worktree", "add", "--detach", worktree, "HEAD");
  const before = ProjectsSettingsSchema.parse({
    projects: [
      {
        id: "repo",
        name: "Repo",
        workspaces: [{ id: "main", machineId: "local", platform: "posix", path: repo }],
      },
    ],
  });
  const request = {
    projectId: "repo",
    machineId: "local",
    platform: "posix" as const,
    path: root,
    repoPath: repo,
    expectedRevision: projectsRevision(before),
  };
  const observation = (await observeLocalProjectWorktreeRoot(request))!;
  const settings = addProjectWorktreeRoot(before, request, observation);
  const enrolled = settings.projects[0]!.worktreeRoots[0]!;
  const matches = (cwd: string) =>
    projectWorktreeMatches(
      settings,
      { machineId: "local", platform: "posix", cwd },
      observeLocalProjectWorktreeRoot,
      observeLocalProjectGitWorktree,
    );
  return { temporary, repo, root, worktree, before, request, observation, settings, enrolled, matches, git };
}

it("admits only a registered linked worktree and its real subdirectories, never ordinary root containment", async () => {
  const f = await fixture();
  const nested = join(f.worktree, "src");
  await mkdir(nested);
  expect(await f.matches(f.worktree)).toEqual(["repo"]);
  expect(await f.matches(nested)).toEqual(["repo"]);
  const plain = join(f.root, "plain");
  await mkdir(plain);
  expect(await f.matches(plain)).toEqual([]);
  expect(await f.matches(f.root)).toEqual([]);
  expect(
    resolveProjectMembership(f.settings, {
      occupantId: "native",
      workspace: { machineId: "local", platform: "posix", canonicalPath: f.worktree },
    }).outcome,
  ).toBe("unassigned");
});
it("rejects a copied .git pointer, foreign repo/worktree, symlink and prefix sibling", async () => {
  const f = await fixture();
  const forged = join(f.root, "forged");
  await mkdir(forged);
  await copyFile(join(f.worktree, ".git"), join(forged, ".git"));
  expect(await f.matches(forged)).toEqual([]);
  const foreign = join(f.root, "foreign");
  await f.git("init", foreign);
  expect(await f.matches(foreign)).toEqual([]);
  const alias = join(f.root, "alias");
  await symlink(f.worktree, alias);
  expect(await f.matches(alias)).toEqual([]);
  const sibling = f.root + "-other";
  await mkdir(sibling);
  expect(await f.matches(sibling)).toEqual([]);
  const foreignRepo = join(f.temporary, "foreign-repo");
  await f.git("clone", f.repo, foreignRepo);
  const foreignLinked = join(f.root, "foreign-linked");
  await f.git("-C", foreignRepo, "worktree", "add", "--detach", foreignLinked, "HEAD");
  expect(await f.matches(foreignLinked)).toEqual([]);
});
it("requires ledger membership and the exact linked admin directory and backlink", async () => {
  const f = await fixture();
  const observed = (await observeLocalProjectGitWorktree(f.enrolled, f.worktree))!;
  expect(matchesProjectWorktree(f.enrolled, f.worktree, observed)).toBe(true);
  for (const patch of [
    { registeredWorktrees: [] },
    { gitDirectory: f.enrolled.commonDirectory },
    { gitDirectory: join(f.root, "fake-admin") },
    { gitDirectoryBacklink: join(f.root, "fake", ".git") },
    { commonDirectory: join(f.root, "foreign-common") },
    { repoCommonDirectory: join(f.root, "foreign-common") },
  ])
    expect(matchesProjectWorktree(f.enrolled, f.worktree, { ...observed, ...patch })).toBe(false);
});
it("rejects unsafe root enrollment and cross-project overlaps without granting tools", async () => {
  const f = await fixture();
  for (const path of ["/", f.repo, f.temporary, f.observation.homePath])
    expect(() =>
      addProjectWorktreeRoot(f.before, { ...f.request, path }, { ...f.observation, path }),
    ).toThrow();
  expect(() =>
    addProjectWorktreeRoot(
      f.before,
      { ...f.request, repoPath: f.worktree },
      { ...f.observation, repoPath: f.worktree },
    ),
  ).toThrow("approved workspace");
  const conflict = ProjectsSettingsSchema.parse({
    projects: [
      ...f.before.projects,
      {
        id: "other",
        name: "Other",
        workspaces: [{ id: "other", machineId: "local", platform: "posix", path: join(f.root, "other") }],
      },
    ],
  });
  expect(() =>
    addProjectWorktreeRoot(
      conflict,
      { ...f.request, expectedRevision: projectsRevision(conflict) },
      f.observation,
    ),
  ).toThrow("overlaps");
  expect(f.settings.projects[0]!.grants).toEqual([]);
  expect(() =>
    removeProjectWorkspace(f.settings, {
      projectId: "repo",
      workspaceId: "main",
      expectedRevision: projectsRevision(f.settings),
    }),
  ).toThrow("worktree root");
  const removed = removeProjectWorktreeRoot(f.settings, {
    projectId: "repo",
    rootId: f.enrolled.id,
    expectedRevision: projectsRevision(f.settings),
  });
  expect(removed.projects[0]!.worktreeRoots).toEqual([]);
  expect(removed.projects[0]!.workspaces).toEqual(f.before.projects[0]!.workspaces);
});
it("denies replaced repo identity, stale enrollment and changed Git facts", async () => {
  const f = await fixture();
  expect(() =>
    addProjectWorktreeRoot(f.before, { ...f.request, expectedRevision: "0".repeat(64) }, f.observation),
  ).toThrow("changed");
  const fact = (await observeLocalProjectGitWorktree(f.enrolled, f.worktree))!;
  let reads = 0;
  expect(
    await projectWorktreeMatches(
      f.settings,
      { machineId: "local", platform: "posix", cwd: f.worktree },
      observeLocalProjectWorktreeRoot,
      async () => (++reads === 1 ? fact : { ...fact, registeredWorktrees: [] }),
    ),
  ).toEqual([]);
  await rename(f.repo, f.repo + "-old");
  await f.git("init", f.repo);
  expect(await f.matches(f.worktree)).toEqual([]);
});
it("a missing or aliased registration does not disable a distinct valid root", async () => {
  const f = await fixture();
  const settings = ProjectsSettingsSchema.parse({
    projects: [
      ...f.settings.projects,
      {
        id: "missing",
        name: "Missing",
        workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: "/missing-repo" }],
        worktreeRoots: [{ ...f.enrolled, path: "/missing-root", repoPath: "/missing-repo" }],
      },
    ],
  });
  expect(
    await projectWorktreeMatches(
      settings,
      { machineId: "local", platform: "posix", cwd: f.worktree },
      observeLocalProjectWorktreeRoot,
      observeLocalProjectGitWorktree,
    ),
  ).toEqual(["repo"]);
  const alias = f.root + "-alias";
  await symlink(f.root, alias);
  expect(await observeLocalProjectWorktreeRoot({ ...f.request, path: alias })).toBeUndefined();
  await writeFile(join(f.root, "file"), "not a directory");
  expect(await observeLocalProjectWorktreeRoot({ ...f.request, path: join(f.root, "file") })).toBeUndefined();
});
it("Windows policy rejects prefix/device/alias spellings and drive roots", () => {
  const request = {
    machineId: "pc",
    platform: "windows" as const,
    path: "D:\\worktrees",
    repoPath: "D:\\repo",
  };
  const observed = {
    path: request.path,
    repoPath: request.repoPath,
    commonDirectory: "D:\\repo\\.git",
    homePath: "C:\\Users\\Owner",
  };
  expect(validateProjectWorktreeRoot(request, observed)).toBe(true);
  for (const path of ["D:\\", "\\\\?\\D:\\worktrees", "d:\\worktrees", "D:\\worktrees\\..\\worktrees"])
    expect(validateProjectWorktreeRoot({ ...request, path }, { ...observed, path })).toBe(false);
});
