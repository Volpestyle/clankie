import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
// @ts-expect-error -- checkout-only eval tooling is plain ESM.
import * as lead from "../../../scripts/evals/lead.mjs";
const sandbox = vi.hoisted(() => vi.fn());
vi.mock("../../../scripts/evals/isolation.mjs", () => ({ executeSandbox: sandbox }));
const {
  gradeCandidate,
  dependencySnapshot,
  loadTasks,
  plan,
  prepareReplay,
  prepareReference,
  prepareCandidate,
  refuseRun,
  summarizeEvidence,
  verifyTask,
  windowGuard,
} = lead;
const completeVerifierReport = (workspace: string, task: { graders: { path: string }[] }) => ({
  success: true,
  numTotalTests: 35,
  numPassedTests: 35,
  numFailedTests: 0,
  numPendingTests: 0,
  numTodoTests: 0,
  numFailedTestSuites: 0,
  numPendingTestSuites: 0,
  testResults: task.graders.map((grader, index) => ({
    name: join(workspace, grader.path),
    status: "passed",
    assertionResults: Array.from({ length: [9, 18, 8][index]! }, (_, i) => ({
      fullName: `fixture assertion ${i}`,
      status: "passed",
      duration: 1,
      failureMessages: [],
    })),
  })),
});
const roots: string[] = [];
const scratch = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "lead-eval-test-")));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.unstubAllEnvs();
  sandbox.mockReset();
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
  expect(lead.nativeReadiness()).toMatchObject({
    status: "refused-engineering-incomplete",
    ownerRunDecision: "separate-hold",
    agentsLaunched: false,
  });
  expect(lead.nativeReadiness().engineeringGaps.map((gap: { code: string }) => gap.code)).toContain(
    "claude-stop-unavailable",
  );
});

it("reports implemented verifier source while refusing the unwired native campaign", () => {
  const readiness = lead.nativeReadiness();
  const bridge = readiness.engineeringGaps.find(
    (gap: { code: string }) => gap.code === "terminal-bench-native-bridge-unavailable",
  );
  expect(bridge).toMatchObject({ source: "scripts/evals/lead-manual-bootstrap.mjs" });
  expect(bridge.detail).toMatch(/artifact-only verifier source is implemented/u);
  expect(bridge.detail).toMatch(/native fleet execution remains unwired/u);
  expect(bridge.detail).toMatch(/descendant, account, isolation and stop acceptance remains unproved/u);
  expect(readiness).toMatchObject({
    status: "refused-engineering-incomplete",
    ownerRunDecision: "separate-hold",
    agentsLaunched: false,
  });
  expect(readiness.engineeringGaps.map((gap: { code: string }) => gap.code)).toEqual([
    "claude-stop-unavailable",
    "descendant-inventory-incomplete",
    "account-window-telemetry-unavailable",
    "isolated-real-hire-unwired",
    "terminal-bench-native-bridge-unavailable",
  ]);
  const prepared = plan();
  expect(prepared.nativeReadiness).toEqual(readiness);
  expect(prepared.blockers).toContain(bridge.detail);
  expect(prepared.results).toEqual([]);
  expect(() => refuseRun()).toThrow("not implemented");
  expect(sandbox).not.toHaveBeenCalled();
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

it("applies a retained candidate diff to the trusted base without executing candidate code", () => {
  const task = loadTasks().historical[2];
  const root = scratch();
  const patchPath = join(root, "candidate.diff");
  writeFileSync(
    patchPath,
    "diff --git a/candidate.txt b/candidate.txt\nnew file mode 100644\n--- /dev/null\n+++ b/candidate.txt\n@@ -0,0 +1 @@\n+candidate implementation\n",
  );
  const output = join(root, "grader");
  vi.stubEnv("GIT_INDEX_FILE", join(root, "poison-index"));
  const receipt = prepareCandidate(task, patchPath, output);
  expect(receipt).toMatchObject({
    revision: "candidate",
    result: "not-run",
    status: "prepared-requires-sandboxed-grader",
    changedPaths: ["candidate.txt"],
  });
  expect(receipt.candidatePatchSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(receipt.candidateTree).toMatch(/^[a-f0-9]{40}$/);
  expect(existsSync(join(output, "source-git/index"))).toBe(true);
  expect(readFileSync(join(output, "worktree/.git"), "utf8")).toContain(join(output, "source-git"));
  expect(readFileSync(join(output, "worktree/candidate.txt"), "utf8")).toBe("candidate implementation\n");
  expect(readFileSync(join(output, "worktree/candidate.patch"))).toEqual(readFileSync(patchPath));
  expect(existsSync(join(root, "poison-index"))).toBe(false);
  for (const grader of task.graders) {
    const expected = spawnSync("git", ["show", `${task.sourceCommit}:${grader.path}`]).stdout;
    expect(readFileSync(join(output, "worktree", grader.path))).toEqual(expected);
  }
}, 30_000);

it.each(["candidate.patch", "../escape", "vitest.config.ts", "apps/clankie/test/setup.ts"])(
  "refuses a candidate patch targeting %s",
  (path) => {
    const task = loadTasks().historical[2];
    const root = scratch();
    const patchPath = join(root, "patch");
    writeFileSync(
      patchPath,
      `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+untrusted\n`,
    );
    expect(() => prepareCandidate(task, patchPath, join(root, "grader"))).toThrow();
    expect(existsSync(join(root, "escape"))).toBe(false);
  },
  30_000,
);

it("refuses an empty candidate patch", () => {
  const task = loadTasks().historical[2];
  const root = scratch();
  const empty = join(root, "empty");
  writeFileSync(empty, "");
  expect(() => prepareCandidate(task, empty, join(root, "empty-grader"))).toThrow("Candidate patch");
});

it("grades through the network-off sandbox with fixed argv and retained provenance", async () => {
  const task = loadTasks().historical[2];
  const root = scratch();
  const patch = join(root, "patch");
  writeFileSync(
    patch,
    "diff --git a/candidate.txt b/candidate.txt\nnew file mode 100644\n--- /dev/null\n+++ b/candidate.txt\n@@ -0,0 +1 @@\n+implementation\n",
  );
  const output = join(root, "grading");
  const receipt = prepareCandidate(task, patch, output);
  const vitestDir = join(output, "worktree/node_modules/vitest");
  mkdirSync(vitestDir, { recursive: true });
  writeFileSync(join(vitestDir, "vitest.mjs"), "// deterministic fake process fixture\n");
  const verifierResult = completeVerifierReport(join(output, "worktree"), task);
  sandbox.mockImplementation(async () => {
    writeFileSync(join(output, "tmp/heldout-results.json"), JSON.stringify(verifierResult));
    return { exitCode: 0, timedOut: false, overflow: false, stdout: "fixture", stderr: "", wallMs: 1 };
  });
  writeFileSync(join(output, "home/owner-secret"), "fixture");
  await expect(gradeCandidate(output)).rejects.toThrow("credential-free home");
  expect(sandbox).not.toHaveBeenCalled();
  rmSync(join(output, "home/owner-secret"));
  writeFileSync(join(output, "worktree/untracked-source.ts"), "fixture");
  await expect(gradeCandidate(output)).rejects.toThrow("Untracked source changed");
  expect(sandbox).not.toHaveBeenCalled();
  rmSync(join(output, "worktree/untracked-source.ts"));
  const result = await gradeCandidate(output);
  expect(result).toMatchObject({
    status: "passed",
    agentsLaunched: false,
    candidatePatchSha256: receipt.candidatePatchSha256,
  });
  expect(result.dependencies.files).toBe(1);
  expect(sandbox).toHaveBeenCalledWith(
    expect.objectContaining({
      root: output,
      network: false,
      timeoutMs: 120000,
      args: [
        join(vitestDir, "vitest.mjs"),
        "run",
        "--config",
        "vitest.config.ts",
        "--reporter=json",
        `--outputFile=${join(output, "tmp/heldout-results.json")}`,
        ...task.graders.map((g: { path: string }) => g.path),
      ],
    }),
  );
  expect(sandbox.mock.calls[0]![0].env).not.toHaveProperty("PATH");
  expect(JSON.parse(readFileSync(join(output, "grading-result.json"), "utf8"))).toMatchObject({
    status: "passed",
  });
  const outsideReport = join(root, "outside-report.json");
  writeFileSync(outsideReport, JSON.stringify(verifierResult));
  sandbox.mockImplementationOnce(async () => {
    symlinkSync(outsideReport, join(output, "tmp/heldout-results.json"));
    return { exitCode: 0, timedOut: false, overflow: false };
  });
  expect(await gradeCandidate(output)).toMatchObject({
    status: "failed-or-infrastructure",
    verifierReportSha256: null,
  });
  sandbox.mockResolvedValueOnce({ exitCode: 0, timedOut: false, overflow: false });
  expect(await gradeCandidate(output)).toMatchObject({
    status: "failed-or-infrastructure",
    coverage: { complete: false },
  });
  sandbox.mockImplementationOnce(async () => {
    writeFileSync(join(output, "tmp/heldout-results.json"), "malformed");
    return { exitCode: 0, timedOut: false, overflow: false };
  });
  expect(await gradeCandidate(output)).toMatchObject({ status: "failed-or-infrastructure" });
  sandbox.mockResolvedValueOnce({
    exitCode: 1,
    timedOut: false,
    overflow: false,
    stderr: "fixture infrastructure failure",
  });
  expect(await gradeCandidate(output)).toMatchObject({ status: "failed-or-infrastructure" });
  sandbox.mockResolvedValueOnce({ exitCode: 0, timedOut: true, overflow: false });
  expect(await gradeCandidate(output)).toMatchObject({ status: "failed-or-infrastructure" });
  const outsideGrader = join(root, "outside-grader.ts");
  const graderPath = join(output, "worktree", task.graders[0].path);
  writeFileSync(outsideGrader, readFileSync(graderPath));
  sandbox.mockImplementationOnce(async () => {
    rmSync(graderPath);
    symlinkSync(outsideGrader, graderPath);
    writeFileSync(join(output, "worktree/.git"), "gitdir: /not-owned\n");
    writeFileSync(join(output, "tmp/heldout-results.json"), JSON.stringify(verifierResult));
    return { exitCode: 0, timedOut: false, overflow: false };
  });
  expect(await gradeCandidate(output)).toMatchObject({ status: "grader-tampered" });
  sandbox.mockClear();
  await expect(gradeCandidate(output)).rejects.toThrow("provenance changed");
  expect(sandbox).not.toHaveBeenCalled();
}, 30_000);

it("refuses dependency links outside the disposable workspace", () => {
  const root = scratch();
  mkdirSync(join(root, "node_modules"));
  symlinkSync("/usr/bin", join(root, "node_modules/external"));
  expect(() => dependencySnapshot(root)).toThrow("External dependency symlink");
});

it("requires every pinned grader file and assertion rather than exit-zero or summary claims", () => {
  const task = loadTasks().historical[2];
  const workspace = "/fixture/worktree";
  const complete = completeVerifierReport(workspace, task);
  expect(lead.validateGraderReport(task, workspace, complete)).toMatchObject({
    complete: true,
    executedTests: 35,
    files: 3,
  });
  const skipped = structuredClone(complete);
  skipped.testResults[0]!.assertionResults[0]!.status = "skipped";
  const missing = structuredClone(complete);
  missing.testResults.pop();
  const zero = { ...complete, numTotalTests: 0, numPassedTests: 0, testResults: [] };
  const truncated = structuredClone(complete);
  truncated.testResults[0]!.assertionResults.pop();
  const duplicate = structuredClone(complete);
  duplicate.testResults[1]!.name = duplicate.testResults[0]!.name;
  for (const report of [undefined, {}, skipped, missing, zero, truncated, duplicate])
    expect(lead.validateGraderReport(task, workspace, report)).toHaveProperty("complete", false);
});

it("rejects dependency ancestor links before following package roots outside the workspace", () => {
  const root = scratch();
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  mkdirSync(join(workspace, "apps"), { recursive: true });
  mkdirSync(join(outside, "node_modules"), { recursive: true });
  writeFileSync(join(outside, "node_modules/private"), "fixture data");
  symlinkSync(outside, join(workspace, "apps/redirect"));
  expect(() => dependencySnapshot(workspace)).toThrow("External dependency");
  rmSync(join(workspace, "apps"), { recursive: true });
  symlinkSync(outside, join(workspace, "apps"));
  expect(() => dependencySnapshot(workspace)).toThrow("External dependency");
});
