import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { checkpointFixture } from "../../../packages/work-items/test/fixtures/main-checkpoint.ts";
import type { HerdrAgentSnapshot } from "../src/captain/herdr-watch.ts";
import { PaneTidy } from "../src/captain/pane-tidy.ts";
import { readSeatCommitBaseline } from "../src/captain/seat-telemetry.ts";
import { workerWorktreeHold } from "../src/captain/worktree-decisions.ts";
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

it("closes a long-landed worker on a busy main in time, and still refuses an unknown checkpoint (#746)", async () => {
  const f = await checkpointFixture();
  fixtures.push(f);
  await f.git("remote", "set-url", "origin", "git@github.com:fixture/repo.git");
  // Main moved on: 250 green pushes since this merge, each comparison taking 40 ms.
  // Walking them to reach the merge's own run outlasted every close (#746).
  f.mode("green");
  f.busy(250, 40);
  const service = createWorkItemsService({
    stateDirectory: f.root,
    githubToken: async () => "fixture-only",
    githubApiBase: f.baseUrl,
    clock: f.clock,
  });
  const agent: HerdrAgentSnapshot = {
    paneId: "herdr-core/t6s",
    terminalId: "herdr-core/t6s",
    agent: "claude",
    status: "done",
    title: "landed hire",
  };
  const tidy = new PaneTidy(join(f.root, "pane-tidy.json"), {
    mainCheckpoint: () => service.mainCheckpoint(f.root, undefined, f.start),
    checkpointMs: 3_000,
  } as never);

  // The first close and a retry after the cached answer expires both clear in time.
  expect(await tidy.mainCheckpointHold(agent)).toBeUndefined();
  f.advance();
  expect(await tidy.mainCheckpointHold(agent)).toBeUndefined();
  expect(f.requests.filter((path) => path.includes("/compare/")).length).toBeLessThan(30);

  // A merge with no checkpoint run of its own, or GitHub unreachable, still holds.
  for (const mode of ["missing-own", "unreachable"]) {
    f.advance();
    f.mode(mode);
    expect(await tidy.mainCheckpointHold(agent), mode).toMatchObject({ reason: "main_unknown" });
  }
}, 60_000);

it("a worker that removed its own worktree closes once its branch landed, and still names unlanded commits (#769)", async () => {
  const f = await checkpointFixture();
  fixtures.push(f);
  await f.git("remote", "set-url", "origin", "git@github.com:fixture/repo.git");
  const service = createWorkItemsService({
    stateDirectory: f.root,
    githubToken: async () => "fixture-only",
    githubApiBase: f.baseUrl,
    clock: f.clock,
  });
  const root = await realpath(f.root);
  // Each hire gets a linked worktree from main; the host records it before launch.
  const hire = async (name: string) => {
    const path = join(root, ".local", name);
    await f.git("worktree", "add", "-q", "-b", `clankie/${name}`, path, f.start);
    const recorded = await readSeatCommitBaseline(path);
    expect(recorded).toMatchObject({ branchRef: `refs/heads/clankie/${name}`, head: f.start });
    return { path, recorded: recorded!, agent: { paneId: `herdr-core/${name}`, workingDirectory: path } };
  };
  // t6y's case: its work landed (the worker commit merged into main), then it removed its worktree.
  const landed = await hire("landed");
  await f.git("-C", landed.path, "reset", "-q", "--hard", f.head);
  await f.git("worktree", "remove", landed.path);
  // Another worker committed work main never got, then removed its worktree too.
  const unlanded = await hire("unlanded");
  await writeFile(join(unlanded.path, "unlanded"), "unlanded");
  await f.git("-C", unlanded.path, "add", "unlanded");
  await f.git("-C", unlanded.path, "commit", "-qm", "work main never got");
  const kept = await f.git("-C", unlanded.path, "rev-parse", "HEAD");
  await f.git("worktree", "remove", unlanded.path);

  // Before #769, the landed worker's missing folder left its checkpoint unknown forever.
  expect(await service.mainCheckpoint(landed.path, undefined, f.start)).toMatchObject({
    reason: "main_unknown",
    detail: "Worker repository or GitHub checkpoint unavailable",
  });
  // Its recorded branch is read instead: nothing held, and main's checkpoint still applies.
  expect(await workerWorktreeHold(landed.agent, { recorded: landed.recorded })).toEqual([]);
  expect(await service.mainCheckpoint(landed.path, undefined, f.start, landed.recorded)).toMatchObject({
    reason: "main_red",
    commit: f.merge,
  });
  f.mode("green");
  f.advance();
  expect(await service.mainCheckpoint(landed.path, undefined, f.start, landed.recorded)).toBeUndefined();

  // Unlanded commits on a removed worktree's branch still refuse, and are named.
  const [held] = await workerWorktreeHold(unlanded.agent, { recorded: unlanded.recorded });
  expect(held).toMatchObject({
    path: unlanded.path,
    state: "unknown",
    branch: "clankie/unlanded",
    head: kept,
    unlandedCommits: 1,
  });
  expect(held!.reason).toContain(`${kept.slice(0, 12)} work main never got`);

  // A branch deleted with its worktree leaves the work unreadable: both reads refuse.
  await f.git("branch", "-D", "clankie/landed");
  expect(await workerWorktreeHold(landed.agent, { recorded: landed.recorded })).toMatchObject([
    { path: landed.path, state: "unknown", reason: expect.stringContaining("clankie/landed is gone") },
  ]);
  f.advance();
  expect(await service.mainCheckpoint(landed.path, undefined, f.start, landed.recorded)).toMatchObject({
    reason: "main_unknown",
  });
});
