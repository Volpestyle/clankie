import { mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, ProjectWorkspace } from "@clankie/protocol/projects";
import { afterEach, expect, it } from "vitest";
import { ProjectMirrors } from "../src/captain/project-mirrors.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const remote: ProjectWorkspace = {
  id: "primary",
  machineId: "kh2",
  path: "C:\\Users\\owner\\repos\\game",
  platform: "windows",
};
const project = (id: string, workspaces: ProjectWorkspace[], auto = true) =>
  ({ id, name: id, workspaces, worktreeRoots: [], roles: [], labelRoleMap: [], grants: [], auto }) as Project;

async function mirrors(origins: (string | Error)[]) {
  const root = join(await realpath(await mkdtemp(join(tmpdir(), "project-mirrors-"))), "mirrors");
  roots.push(join(root, ".."));
  const reads: ProjectWorkspace[] = [];
  const store = new ProjectMirrors(root, async (workspace) => {
    reads.push(workspace);
    const next = origins.shift();
    if (next === undefined || next instanceof Error) throw next ?? new Error("no more origins");
    return next;
  });
  return { root, reads, store };
}

it("resolves a remote-only project's origin once, keeps failures unknown and retries each round", async () => {
  // The Windows workspace's origin over its machine channel: unreadable, then a
  // local path that must never be fetched, then a network origin that refuses.
  const { root, reads, store } = await mirrors([
    new Error("fleet kh2: Git observation unavailable"),
    "C:/Users/owner/bare/game.git",
    "https://token:secret@example.invalid/game.git",
    "https://127.0.0.1:9/game.git",
  ]);
  const game = project("game", [remote]);
  expect(await store.history(game)).toEqual({ state: "unknown", reason: "origin not mirrored yet" });

  await store.refresh([game]);
  expect(await store.history(game)).toEqual({
    state: "unknown",
    reason: "origin unreadable on kh2: fleet kh2: Git observation unavailable",
  });
  await store.refresh([game]);
  expect(await store.history(game)).toEqual({
    state: "unknown",
    reason: "origin is not an https, ssh or git URL",
  });
  await store.refresh([game]);
  expect(await store.history(game)).toEqual({ state: "unknown", reason: "origin URL carries a credential" });
  expect(await readdir(root)).toEqual([]);

  await store.refresh([game]);
  const failed = await store.history(game);
  expect(failed).toMatchObject({
    state: "unknown",
    reason: expect.stringMatching(/^origin fetch failed: /u),
  });
  expect(await readdir(root)).toHaveLength(1);
  // The next round retries the fetch from the mirror's own config, without asking the machine again.
  await store.refresh([game]);
  expect(await store.history(game)).toMatchObject({
    reason: expect.stringMatching(/^origin fetch failed: /u),
  });
  expect(reads).toHaveLength(4);
  expect(reads.every((workspace) => workspace === remote)).toBe(true);
});

it("reads local workspaces directly and removes mirrors no project names", async () => {
  const { root, reads, store } = await mirrors([]);
  await mkdir(join(root, "stale.git"), { recursive: true });
  const local = project("garden", [
    { id: "primary", machineId: "local", path: "/repos/garden", platform: "posix" },
  ]);
  // Off Auto: named, so not pruned, but never fetched.
  const parked = project("parked", [remote], false);

  await store.refresh([local, parked]);
  expect(await readdir(root)).toEqual([]);
  expect(reads).toEqual([]);
  expect(await store.history(local)).toEqual({
    state: "readable",
    source: "workspace",
    repositories: ["/repos/garden"],
  });
  expect(await store.history(project("empty", []))).toEqual({
    state: "unknown",
    reason: "project has no workspace",
  });
});
