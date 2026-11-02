import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkpointFixture } from "../../../packages/work-items/test/fixtures/main-checkpoint.ts";
import { createWorkItemsService } from "../src/work-items.ts";
const fixtures: Awaited<ReturnType<typeof checkpointFixture>>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
});
it("the service uses its existing GitHub transport for checkout and issue landing references", async () => {
  const f = await checkpointFixture();
  fixtures.push(f);
  await f.git("remote", "set-url", "origin", "git@github.com:fixture/repo.git");
  const service = createWorkItemsService({
    stateDirectory: f.root,
    githubToken: async () => "fixture-only",
    githubApiBase: f.baseUrl,
    clock: f.clock,
  });
  expect(await service.mainCheckpoint(f.root)).toMatchObject({ reason: "main_red", commit: f.merge });
  const issue = { links: [{ url: `https://github.com/fixture/repo/commit/${f.head}` }] };
  await expect(service.checkIssueCheckpoint(issue)).rejects.toThrow("main_red");
  await expect(service.checkIssueCheckpoint({ links: [] })).rejects.toThrow("main_unknown");
  f.link("url");
  expect(await service.mainCheckpoint(f.root)).toBeUndefined();
  await expect(service.checkIssueCheckpoint(issue)).resolves.toBeUndefined();
  await expect(
    service.checkIssueCheckpoint({ links: [{ url: "https://github.com/fixture/repo/pull/279" }] }),
  ).resolves.toBeUndefined();
});

it("does not charge a research worktree with someone else's red main commit", async () => {
  const f = await checkpointFixture();
  fixtures.push(f);
  const research = join(f.root, "research");
  await f.git("worktree", "add", "--detach", research, f.merge);
  await f.git("remote", "set-url", "origin", "git@github.com:fixture/repo.git");
  const service = createWorkItemsService({
    stateDirectory: f.root,
    githubToken: async () => "fixture-only",
    githubApiBase: f.baseUrl,
    clock: f.clock,
  });
  expect(await service.mainCheckpoint(research)).toBeUndefined();
  expect(f.requests).toEqual([]);
});

it("uses the hire's recorded start before the fork point and keeps connection caches separate", async () => {
  const f = await checkpointFixture();
  fixtures.push(f);
  await f.git("remote", "set-url", "origin", "git@github.com:fixture/repo.git");
  let token = "connection-a";
  const service = createWorkItemsService({
    stateDirectory: f.root,
    githubToken: async () => token,
    githubApiBase: f.baseUrl,
    clock: f.clock,
  });
  expect(await service.mainCheckpoint(f.root, undefined, f.head)).toBeUndefined();
  expect(f.requests).toEqual([]);
  expect(await service.mainCheckpoint(f.root, undefined, f.start)).toMatchObject({ reason: "main_red" });
  const reads = f.requests.length;
  await Promise.all(Array.from({ length: 35 }, () => service.mainCheckpoint(f.root, undefined, f.start)));
  expect(f.requests).toHaveLength(reads);
  f.link("url", false);
  token = "connection-b";
  expect(await service.mainCheckpoint(f.root, undefined, f.start)).toBeUndefined();
  expect(f.requests.length).toBeGreaterThan(reads);
});

it("a worker's own landed commits do not hold a repo without post-merge checkpoints", async () => {
  const f = await checkpointFixture();
  fixtures.push(f);
  f.mode("no-checkpoint");
  await f.git("remote", "set-url", "origin", "git@github.com:fixture/repo.git");
  const service = createWorkItemsService({
    stateDirectory: f.root,
    githubToken: async () => "fixture-only",
    githubApiBase: f.baseUrl,
    clock: f.clock,
  });
  expect(await service.mainCheckpoint(f.root, undefined, f.start)).toBeUndefined();
  expect(f.requests.some((path) => path.startsWith("/repos/fixture/repo/compare/"))).toBe(false);
});

it("non-Git research has no checkpoint, while missing or lost recorded checkouts stay unknown", async () => {
  const root = await mkdtemp(join(tmpdir(), "checkpoint-non-git-"));
  const service = createWorkItemsService({
    stateDirectory: root,
    githubToken: async () => {
      throw new Error("Non-Git work must not read GitHub");
    },
  });
  try {
    expect(await service.mainCheckpoint(root)).toBeUndefined();
    expect(await service.mainCheckpoint(root, undefined, "a".repeat(40))).toMatchObject({
      reason: "main_unknown",
    });
    expect(await service.mainCheckpoint(join(root, "missing"))).toMatchObject({ reason: "main_unknown" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
