import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error -- checkout-only eval tooling is plain ESM.
import * as lead from "../../../scripts/evals/lead.mjs";
const {
  loadTasks,
  plan,
  prepareReplay,
  prepareReference,
  refuseRun,
  summarizeEvidence,
  verifyTask,
  windowGuard,
} = lead;
const roots: string[] = [];
const scratch = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lead-eval-test-")));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("pins every cross-package pre-fix parent and unchanged landed grader", () => {
  const tasks = loadTasks().historical;
  expect(tasks).toHaveLength(3);
  for (const task of tasks) expect(verifyTask(task)).toBe(task);
  expect(() => verifyTask({ ...tasks[0], prompt: "changed" })).toThrow("text mismatch");
  expect(() => verifyTask({ ...tasks[0], baseCommit: tasks[0].sourceCommit })).toThrow("pre-fix parent");
  expect(() =>
    verifyTask({ ...tasks[0], graders: [{ ...tasks[0].graders[0], sha256: "0".repeat(64) }] }),
  ).toThrow("test mismatch");
});

it("plans equal tasks and budgets, rotates arms and never implies run approval", () => {
  const result = plan();
  expect(result.matrix).toHaveLength(6);
  expect(result.results).toEqual([]);
  expect(result.status).toBe("partial-native-execution-blocked");
  expect(result.matrix[0].arm).toBe("native-subagents");
  expect(result.matrix[2].arm).toBe("clankie-hires");
  for (let index = 0; index < 6; index += 2) {
    expect(result.matrix[index].promptSha256).toBe(result.matrix[index + 1].promptSha256);
    expect(result.matrix[index].timeBudgetSeconds).toBe(result.matrix[index + 1].timeBudgetSeconds);
  }
  expect(() => plan(["--reps", "3"])).toThrow("owner run decision");
  expect(() => plan(["--workers", "0"])).toThrow();
  expect(() => plan(["--tasks", "html-js-filter"])).toThrow("unsupported");
  expect(() => refuseRun()).toThrow("not implemented");
});

it("exports a history-free replay and distinct worker indexes, with no held-out tests", () => {
  const task = loadTasks().historical[2];
  const root = join(scratch(), "replay");
  const poisonedIndex = join(root, "inherited-index");
  vi.stubEnv("GIT_INDEX_FILE", poisonedIndex);
  vi.stubEnv("GIT_DIR", join(root, "nonexistent-git-dir"));
  const result = prepareReplay(task, root, 2);
  vi.unstubAllEnvs();
  expect(existsSync(poisonedIndex)).toBe(false);
  expect(result.status).toBe("prepared-no-agents-launched");
  expect(new Set(result.worktrees.map((w: { index: string }) => w.index)).size).toBe(3);
  for (const worktree of result.worktrees) {
    for (const grader of task.graders) expect(existsSync(join(worktree.path, grader.path))).toBe(false);
    expect(existsSync(join(worktree.path, "scripts/evals"))).toBe(false);
    expect(spawnSync("git", ["remote"], { cwd: worktree.path, encoding: "utf8" }).stdout).toBe("");
    expect(spawnSync("git", ["cat-file", "-e", task.sourceCommit], { cwd: worktree.path }).status).not.toBe(
      0,
    );
  }
  expect(() => prepareReplay(task, root)).toThrow("new directory");
}, 30_000);

it("overlays identical trusted graders on both reference revisions", () => {
  const task = loadTasks().historical[2];
  const root = scratch();
  for (const revision of ["before", "after"]) {
    const destination = join(root, revision);
    const result = prepareReference(task, destination, revision);
    expect(result.result).toBe("not-run");
    for (const grader of task.graders) {
      const expected = spawnSync("git", ["show", `${task.sourceCommit}:${grader.path}`], {
        encoding: "utf8",
      }).stdout;
      expect(readFileSync(join(destination, grader.path), "utf8")).toBe(expected);
    }
  }
}, 30_000);

it("stops on unknown, stale, ambiguous or exhausted windows without a reset timer", () => {
  const now = 100_000;
  const snapshot = { accountId: "a", atMs: now, five_hour: 0.2, seven_day: 0.1 };
  expect(windowGuard(["a"], [snapshot], now)).toEqual({ allowed: true });
  for (const rows of [
    [],
    [snapshot, snapshot],
    [{ ...snapshot, atMs: now - 30_001 }],
    [{ ...snapshot, five_hour: null }],
    [{ ...snapshot, five_hour: 0.8, resetAt: now + 1000 }],
    [{ ...snapshot, seven_day: 0.5 }],
  ]) {
    expect(windowGuard(["a"], rows, now)).toHaveProperty("stop");
    expect(windowGuard(["a"], rows, now)).not.toHaveProperty("wait");
  }
  expect(windowGuard(["a", "b"], [snapshot], now)).toHaveProperty("stop");
});

it("deduplicates all-agent call usage, preserves costs as unknown when coverage is missing", () => {
  const agents = ["lead", "worker"].map((sessionId) => ({
    sessionId,
    accountId: "account",
    transcriptSha256: "a".repeat(64),
    usageComplete: true,
  }));
  const calls = agents.map(({ sessionId }) => ({
    sessionId,
    callId: "call-1",
    input: 10,
    output: 5,
    cacheRead: 3,
    cacheWrite: 2,
  }));
  const evidence = {
    agents,
    calls: [...calls, calls[0]],
    inventoryComplete: true,
    discoveredSessionIds: ["lead", "worker"],
    events: [
      {
        kind: "green",
        atMs: 100,
        passed: true,
        graderSha256: "b".repeat(64),
        detail: "held-out tests passed",
      },
      { kind: "intervention", atMs: 20, detail: "owner resolved approval" },
      { kind: "shared-index-sweep", atMs: 30, detail: "worker included another worker's staged file" },
    ],
  };
  expect(summarizeEvidence(evidence)).toMatchObject({
    status: "imported-unverified",
    totalTokens: 40,
    wallToGreenMs: 100,
  });
  expect(summarizeEvidence({ ...evidence, discoveredSessionIds: ["unknown"] }).totalTokens).toBeNull();
  expect(summarizeEvidence({ ...evidence, inventoryComplete: false }).totalTokens).toBeNull();
  expect(summarizeEvidence({ ...evidence, calls: [calls[0]] }).totalTokens).toBeNull();
  expect(
    summarizeEvidence({ ...evidence, calls: [...calls, { ...calls[0], output: 99 }] }).totalTokens,
  ).toBeNull();
  expect(
    summarizeEvidence({
      ...evidence,
      calls: [
        ...calls,
        {
          output: 5,
          input: 10,
          cacheWrite: 2,
          cacheRead: 3,
          callId: "call-1",
          sessionId: "lead",
          observedAt: 99,
        },
      ],
    }).totalTokens,
  ).toBe(40);
  expect(
    summarizeEvidence({
      ...evidence,
      events: [{ kind: "green", passed: true, atMs: -1, graderSha256: "bad", detail: "invalid" }],
    }).wallToGreenMs,
  ).toBeNull();
  expect(summarizeEvidence({})).toMatchObject({
    totalTokens: null,
    wallToGreenMs: null,
    recommendation: null,
  });
});
