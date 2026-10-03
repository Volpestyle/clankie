#!/usr/bin/env node
/** Manual lead-eval preparation and evidence tools. No model/provider calls. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executeSandbox } from "./isolation.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = join(repo, "scripts/evals/lead-tasks.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const arms = ["native-subagents", "clankie-hires"];
const failures = [
  "conflicting-edits",
  "shared-index-sweep",
  "lost-work",
  "duplicate-work",
  "idle-worker",
  "unsupported-control",
  "uncertain-delivery",
  "usage-unknown",
  "budget-stop",
  "test-failure",
  "infrastructure",
];
function command(binary, args, cwd = repo, input) {
  const result = spawnSync(
    binary,
    binary === "/usr/bin/git"
      ? [
          "-c",
          "gc.auto=0",
          "-c",
          "maintenance.auto=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "core.fsmonitor=false",
          ...args,
        ]
      : args,
    {
      cwd,
      input,
      maxBuffer: 128 * 1024 * 1024,
      env: {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (result.status !== 0)
    throw Error(`${binary} ${args[0]} failed: ${result.stderr?.toString().slice(-1000)}`);
  return result.stdout;
}
const git = (...args) => command("/usr/bin/git", args);
const gitText = (...args) =>
  git(...args)
    .toString()
    .trim();

export function loadTasks() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

/** Verify local objects and test blobs before any preparation. Never fetch implicitly. */
export function verifyTask(task) {
  if (!/^[a-z0-9-]+$/.test(task.id) || task.kind !== "historical") throw Error("Unsupported task");
  for (const key of ["sourceCommit", "baseCommit", "baseTree", "sourceTree"])
    if (!/^[a-f0-9]{40}$/.test(task[key])) throw Error(`Unpinned ${key}`);
  if (gitText("rev-parse", `${task.sourceCommit}^`) !== task.baseCommit)
    throw Error("Base is not pre-fix parent");
  for (const [commit, tree] of [
    [task.baseCommit, task.baseTree],
    [task.sourceCommit, task.sourceTree],
  ])
    if (gitText("rev-parse", `${commit}^{tree}`) !== tree) throw Error("Source tree mismatch");
  if (sha(task.prompt) !== task.promptSha256) throw Error("Task text mismatch");
  const changed = gitText("diff", "--name-only", task.baseCommit, task.sourceCommit).split("\n");
  if (task.parallelWork.length < 2 || !task.graders.length)
    throw Error("Task lacks cross-package work or graders");
  for (const grader of task.graders) {
    if (
      !/^(apps|packages)\/[^/]+\/test\/[a-zA-Z0-9/-]+\.test\.ts$/.test(grader.path) ||
      !changed.includes(grader.path)
    )
      throw Error("Invalid held-out test path");
    const spec = `${task.sourceCommit}:${grader.path}`;
    if (gitText("rev-parse", spec) !== grader.blob || sha(git("show", spec)) !== grader.sha256)
      throw Error("Held-out test mismatch");
  }
  return task;
}

export function plan(args = []) {
  const options = { tasks: "historical", arms: arms.join(","), reps: 1, workers: 3 };
  const flags = { "--tasks": "tasks", "--arms": "arms", "--reps": "reps", "--workers": "workers" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dry-run") continue;
    const key = flags[args[i]];
    if (!key || !args[i + 1] || args[i + 1].startsWith("--"))
      throw Error(`Unknown/incomplete argument ${args[i]}`);
    options[key] = ["reps", "workers"].includes(key) ? Number(args[++i]) : args[++i];
  }
  if (options.reps !== 1)
    throw Error("Only one-repetition plans are enabled; a full round needs a separate owner run decision");
  if (!Number.isSafeInteger(options.workers) || options.workers < 1 || options.workers > 6)
    throw Error("workers must be 1..6");
  const selectedArms = options.arms.split(",");
  if (
    new Set(selectedArms).size !== selectedArms.length ||
    selectedArms.some((a) => ![...arms, "single-agent"].includes(a))
  )
    throw Error("Invalid arms");
  const manifest = loadTasks();
  const ids =
    options.tasks === "historical" ? manifest.historical.map((t) => t.id) : options.tasks.split(",");
  if (new Set(ids).size !== ids.length) throw Error("Duplicate tasks");
  const tasks = ids.map((id) => {
    const task = manifest.historical.find((t) => t.id === id);
    if (!task) throw Error(`Unknown/unsupported replay ${id}; neutral sources are pinned separately`);
    return verifyTask(task);
  });
  return {
    schemaVersion: 1,
    status: "partial-native-execution-blocked",
    manifestSha256: sha(readFileSync(manifestPath)),
    runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    options,
    matrix: tasks.flatMap((task, index) =>
      selectedArms.map((_, slot) => ({
        task: task.id,
        arm: selectedArms[(index + slot) % selectedArms.length],
        rep: 0,
        promptSha256: task.promptSha256,
        timeBudgetSeconds: task.timeBudgetSeconds,
      })),
    ),
    nativeRequirements: {
      service:
        "Throwaway current Clankie service, isolated state/config/credential roots; fake external bodies; real hire_agent/native harness connections only",
      herdr:
        "Dedicated owned session/socket; native interactive Claude lead; exact-session delivery receipts, no terminal typing or automatic approval",
      workers:
        "Every concurrent writer gets a distinct worktree and git index; no inherited live fleet/socket or tracker access",
      accounting:
        "Complete lead and descendant session inventory, untruncated transcripts, deduplicated per-call tokens and account-bound fresh five_hour/seven_day snapshots",
      guard:
        "Before launch and continuously during a turn; unknown/stale account or windows stop the run; never wait or dispatch after reset",
      authorization:
        "Explicit James run decision for concrete task/arms/time/account budget; preparation is not authorization",
    },
    nativeReadiness: nativeReadiness(),
    blockers: nativeReadiness().engineeringGaps.map((gap) => gap.detail),
    results: [],
  };
}

function freshDirectory(path) {
  const absolute = resolve(path);
  if (existsSync(absolute)) throw Error("Output must be a new directory");
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  return realpathSync(absolute);
}

/** Export no future history/remote. All worker indexes live in a new repository. */
export function prepareReplay(task, output, workers = 3) {
  verifyTask(task);
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 6) throw Error("workers must be 1..6");
  const root = freshDirectory(output);
  const workspace = join(root, "worktree");
  mkdirSync(workspace);
  const tar = join(root, "source.tar");
  writeFileSync(tar, git("archive", "--format=tar", task.baseCommit));
  command("/usr/bin/tar", ["-xf", tar, "-C", workspace]);
  rmSync(tar);
  for (const grader of task.graders) rmSync(join(workspace, grader.path), { force: true });
  // An exported replay must not reveal newer solution/grader sources through eval tooling.
  rmSync(join(workspace, "scripts/evals"), { recursive: true, force: true });
  rmSync(join(workspace, "docs/testing"), { recursive: true, force: true });
  writeFileSync(
    join(workspace, "TASK.md"),
    `${task.prompt}\n\nTime budget: ${task.timeBudgetSeconds} seconds. Give concurrent writers separate worktrees and indexes. Do not seek the original fix or held-out tests.\n`,
  );
  const local = (...args) => command("/usr/bin/git", args, workspace).toString().trim();
  local("init", "-q");
  local("add", ".");
  local(
    "-c",
    "user.name=Lead eval fixture",
    "-c",
    "user.email=eval@invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Pinned pre-fix replay",
  );
  const worktrees = [{ role: "lead", path: workspace }];
  for (let i = 0; i < workers; i++) {
    const path = join(root, `worker-${i + 1}`);
    local("worktree", "add", "-q", "-b", `worker-${i + 1}`, path);
    worktrees.push({ role: `worker-${i + 1}`, path });
  }
  const result = {
    schemaVersion: 1,
    task: task.id,
    baseCommit: task.baseCommit,
    sourceTree: task.baseTree,
    promptSha256: task.promptSha256,
    status: "prepared-no-agents-launched",
    worktrees: worktrees.map((w) => ({
      ...w,
      index: command("/usr/bin/git", ["rev-parse", "--path-format=absolute", "--git-path", "index"], w.path)
        .toString()
        .trim(),
    })),
  };
  json(join(root, "preparation.json"), result);
  return result;
}

/** Export trusted reference grading trees; tests never enter agent worktrees. */
export function prepareReference(task, output, revision) {
  verifyTask(task);
  if (!["before", "after"].includes(revision)) throw Error("Reference must be before or after");
  const root = freshDirectory(output);
  const tar = join(root, "source.tar");
  writeFileSync(
    tar,
    git("archive", "--format=tar", revision === "before" ? task.baseCommit : task.sourceCommit),
  );
  command("/usr/bin/tar", ["-xf", tar, "-C", root]);
  rmSync(tar);
  for (const grader of task.graders)
    writeFileSync(join(root, grader.path), git("show", `${task.sourceCommit}:${grader.path}`));
  const result = {
    task: task.id,
    revision,
    command: [
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      ...task.graders.map((g) => g.path),
    ],
    testHashes: task.graders,
    result: "not-run",
  };
  for (const directory of ["fixture-home", "fixture-tmp", "fixture-state"]) mkdirSync(join(root, directory));
  result.env = {
    PATH: process.env.PATH,
    HOME: join(root, "fixture-home"),
    TMPDIR: join(root, "fixture-tmp"),
    CLANKIE_SETTINGS_FILE: join(root, "fixture-home/settings.json"),
    CLANKIE_STATE: join(root, "fixture-state"),
    XDG_CONFIG_HOME: join(root, "fixture-home/config"),
    XDG_STATE_HOME: join(root, "fixture-state"),
  };
  writeFileSync(result.env.CLANKIE_SETTINGS_FILE, '{"schemaVersion":1}\n');
  json(join(root, "lead-grader.json"), result);
  return result;
}

/** Apply a retained candidate diff in a fresh trusted grading tree, never execute it.
 * The patch is untrusted code. This is preparation, not sandboxed grading.
 */
export function prepareCandidate(task, patchPath, output) {
  verifyTask(task);
  const patch = readFileSync(patchPath);
  if (!patch.length || patch.length > 32 * 1024 * 1024)
    throw Error("Candidate patch must be 1..33554432 bytes");
  const sandbox = freshDirectory(output);
  const root = join(sandbox, "worktree");
  const result = prepareReference(task, root, "before");
  for (const name of ["home", "tmp", "seed"]) mkdirSync(join(sandbox, name));
  const local = (...args) => command("/usr/bin/git", args, root);
  // An owned index is essential: inherited GIT_INDEX_FILE/GIT_DIR never reach git.
  local("init", "-q");
  local("add", "--force", ".");
  local(
    "-c",
    "user.name=Lead eval grader",
    "-c",
    "user.email=eval@invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "Trusted pre-fix grading tree",
  );
  command("/usr/bin/git", ["apply", "--check", "--binary", "-"], root, patch);
  command("/usr/bin/git", ["apply", "--binary", "-"], root, patch);
  // Include newly created files, without trusting the candidate's ignore rules.
  local("add", "--all", "--force", ".");
  const changed = local("diff", "--cached", "--name-only", "-z").toString().split("\0").filter(Boolean);
  const protectedPaths = new Set([
    ...task.graders.map((g) => g.path),
    "lead-grader.json",
    "candidate.patch",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "vitest.config.ts",
  ]);
  if (
    changed.some(
      (path) =>
        protectedPaths.has(path) ||
        /(^|\/)(test|tests|__tests__)(\/|$)/.test(path) ||
        /(^|\/)(vitest|vite)\.[^/]+$/.test(path) ||
        /(^|\/)(package\.json|tsconfig[^/]*\.json)$/.test(path) ||
        /^(fixture-(home|tmp|state)|scripts\/evals)(\/|$)/.test(path),
    )
  )
    throw Error(
      "Candidate changes trusted grader/tooling paths; separate reviewed grading support is required",
    );
  // Retain the exact submitted diff separately; neither imported green events nor
  // successful application are a test pass.
  writeFileSync(join(root, "candidate.patch"), patch, { mode: 0o600 });
  const receipt = {
    ...result,
    env: undefined,
    revision: "candidate",
    result: "not-run",
    status: "prepared-requires-sandboxed-grader",
    candidatePatchSha256: sha(patch),
    changedPaths: changed,
    candidateTree: local("write-tree").toString().trim(),
    baseCommit: task.baseCommit,
    sourceTree: task.baseTree,
    warning:
      "Candidate code has not run. A sandboxed verifier is required; do not execute on the owner host.",
  };
  json(join(sandbox, "lead-grader.json"), receipt);
  return receipt;
}

/** Content-address staged dependencies; symlinks may only resolve within this sandbox. */
export function dependencySnapshot(directory) {
  const root = realpathSync(directory);
  const entries = [];
  const visit = (path) => {
    const stat = lstatSync(path);
    const name = path.slice(root.length + 1);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(path);
      if (!target.startsWith(`${root}/`)) throw Error(`External dependency symlink: ${name}`);
      entries.push([name, "link", readlinkSync(path)]);
    } else if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(join(path, child));
    } else if (stat.isFile()) entries.push([name, stat.mode & 0o777, sha(readFileSync(path))]);
    else throw Error(`Unsupported dependency file: ${name}`);
  };
  // Root and per-package node_modules are independent snapshots, not live links.
  for (const relative of [
    "node_modules",
    ...["apps", "packages", "integrations"].flatMap((category) =>
      existsSync(join(root, category))
        ? readdirSync(join(root, category)).map((name) => `${category}/${name}/node_modules`)
        : [],
    ),
  ]) {
    const path = join(root, relative);
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink()) throw Error("Dependency directories must be owned copies");
      visit(path);
    }
  }
  return { sha256: sha(JSON.stringify(entries)), files: entries.length };
}

const referencePath = join(repo, "docs/testing/2026-10-03-lead-eval/reference-checks.json");
// Per-file declarations from the pinned test blobs, reconciled with retained after-pass totals.
// text-inbox has 10 ordinary tests plus it.each tables of 2, 3 and 3 cases.
const referenceFileCounts = {
  "roles-subagents-labels": [13, 1, 10, 4, 5, 5, 1, 22, 13],
  "owner-attachments": [9, 2],
  "async-discord-text": [9, 18, 8],
};
const referenceSha256 = "e33d17ee80de218202f66b46c73a851f4fc869e3463cab7eb159d7327084ecfd";

/** A process exit alone is never a green result: require every pinned file and test. */
export function validateGraderReport(task, workspace, report) {
  const bytes = readFileSync(referencePath);
  if (sha(bytes) !== referenceSha256) throw Error("Reference coverage pin changed");
  const reference = JSON.parse(bytes).results.find((r) => r.task === task.id);
  const after = reference?.checks.find((r) => r.reference === "after" && r.outcome === "pass");
  const expectedTests = Number(after?.summary.join("\n").match(/Tests\s+(\d+) passed/)?.[1]);
  if (
    !expectedTests ||
    reference.sourceCommit !== task.sourceCommit ||
    reference.baseCommit !== task.baseCommit ||
    JSON.stringify(reference.graders) !== JSON.stringify(task.graders)
  )
    throw Error("Reference coverage does not match task");
  const failure = (detail) => ({ complete: false, detail, expectedTests, referenceSha256 });
  if (
    !report ||
    report.success !== true ||
    report.numTotalTests !== expectedTests ||
    report.numPassedTests !== expectedTests ||
    !Array.isArray(report.testResults) ||
    report.testResults.length !== task.graders.length ||
    ["numFailedTests", "numPendingTests", "numTodoTests", "numFailedTestSuites", "numPendingTestSuites"].some(
      (key) => report[key] !== 0,
    )
  )
    return failure("Missing, skipped, failed or incomplete held-out test coverage");
  const expectedFiles = new Map(
    task.graders.map((g, i) => [join(workspace, g.path), referenceFileCounts[task.id][i]]),
  );
  let count = 0;
  for (const file of report.testResults) {
    const expectedCount = expectedFiles.get(file.name);
    if (
      !expectedFiles.delete(file.name) ||
      file.status !== "passed" ||
      !Array.isArray(file.assertionResults) ||
      file.assertionResults.length !== expectedCount
    )
      return failure("Missing, duplicate or unexpected grader file");
    const names = new Set();
    for (const assertion of file.assertionResults) {
      if (
        assertion.status !== "passed" ||
        typeof assertion.fullName !== "string" ||
        !assertion.fullName ||
        names.has(assertion.fullName) ||
        !Array.isArray(assertion.failureMessages) ||
        assertion.failureMessages.length ||
        !Number.isFinite(assertion.duration) ||
        assertion.duration < 0
      )
        return failure("Unexecuted, duplicate or failed grader assertion");
      names.add(assertion.fullName);
      count++;
    }
  }
  return count === expectedTests && expectedFiles.size === 0
    ? {
        complete: true,
        expectedTests,
        executedTests: count,
        files: report.testResults.length,
        referenceSha256,
      }
    : failure("Assertion count does not match pinned reference");
}

/** Grade only an explicitly prepared candidate with separately staged dependencies.
 * This command never starts agents. It uses the existing network-off OS sandbox.
 */
export async function gradeCandidate(directory) {
  const root = realpathSync(resolve(directory));
  const workspace = join(root, "worktree");
  if (realpathSync(workspace) !== workspace || readdirSync(join(root, "home")).length)
    throw Error("Grading requires an owned worktree and fresh empty credential-free home");
  const receipt = JSON.parse(readFileSync(join(root, "lead-grader.json"), "utf8"));
  const task = loadTasks().historical.find((t) => t.id === receipt.task);
  if (!task || receipt.status !== "prepared-requires-sandboxed-grader")
    throw Error("Not a prepared candidate");
  verifyTask(task);
  const local = (...args) => command("/usr/bin/git", args, workspace);
  const untracked = local("ls-files", "--others", "--directory", "--no-empty-directory", "-z")
    .toString()
    .split("\0")
    .filter(Boolean);
  if (untracked.some((path) => path !== "candidate.patch" && !/(^|\/)node_modules\/$/.test(path)))
    throw Error("Untracked source changed after preparation");
  if (
    receipt.baseCommit !== task.baseCommit ||
    receipt.sourceTree !== task.baseTree ||
    sha(readFileSync(join(workspace, "candidate.patch"))) !== receipt.candidatePatchSha256 ||
    local("write-tree").toString().trim() !== receipt.candidateTree ||
    local("diff", "--no-ext-diff", "--no-textconv", "--name-only").length
  )
    throw Error("Candidate provenance changed after preparation");
  for (const grader of task.graders)
    if (sha(readFileSync(join(workspace, grader.path))) !== grader.sha256)
      throw Error("Held-out grader changed after preparation");
  // No install, credential import, account discovery or arbitrary command flags.
  const vitest = join(workspace, "node_modules/vitest/vitest.mjs");
  if (!existsSync(vitest) || !realpathSync(vitest).startsWith(`${root}/`))
    throw Error("Stage independent owned dependencies inside the grading sandbox before grading");
  const dependencies = dependencySnapshot(workspace);
  const reportPath = join(root, "tmp/heldout-results.json");
  rmSync(reportPath, { force: true });
  const started = Date.now();
  const result = await executeSandbox({
    root,
    binary: process.execPath,
    args: [
      vitest,
      "run",
      "--config",
      "vitest.config.ts",
      "--reporter=json",
      `--outputFile=${reportPath}`,
      ...task.graders.map((g) => g.path),
    ],
    network: false,
    timeoutMs: 120_000,
    env: {
      CLANKIE_SETTINGS_FILE: join(workspace, "fixture-home/settings.json"),
      CLANKIE_STATE: join(workspace, "fixture-state"),
      pnpm_config_verify_deps_before_run: "false",
    },
  });
  let unchanged = false;
  try {
    unchanged =
      dependencySnapshot(workspace).sha256 === dependencies.sha256 &&
      local("write-tree").toString().trim() === receipt.candidateTree &&
      local("diff", "--no-ext-diff", "--no-textconv", "--name-only").length === 0 &&
      task.graders.every(
        (g) => existsSync(join(workspace, g.path)) && sha(readFileSync(join(workspace, g.path))) === g.sha256,
      );
  } catch {
    // Retain a failed result if the candidate removed files or replaced links.
  }
  let coverage = { complete: false, detail: "Missing or malformed structured verifier report" };
  let verifierReportSha256 = null;
  try {
    const bytes = readFileSync(reportPath);
    verifierReportSha256 = sha(bytes);
    coverage = validateGraderReport(task, workspace, JSON.parse(bytes));
  } catch {
    // An exit(0), import crash or malformed output cannot substitute for test execution.
  }
  const report = {
    coverage,
    verifierReportSha256,
    task: task.id,
    candidatePatchSha256: receipt.candidatePatchSha256,
    candidateTree: receipt.candidateTree,
    testHashes: task.graders,
    dependencies,
    runtime: { nodeVersion: process.version, nodeSha256: sha(readFileSync(process.execPath)) },
    runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
    isolationSha256: sha(readFileSync(join(repo, "scripts/evals/isolation.mjs"))),
    startedAt: new Date(started).toISOString(),
    ...result,
    status: !unchanged
      ? "grader-tampered"
      : coverage.complete && result.exitCode === 0 && !result.timedOut && !result.overflow
        ? "passed"
        : "failed-or-infrastructure",
    agentsLaunched: false,
  };
  json(join(root, "grading-result.json"), report);
  return report;
}

/** Never synthesize a zero for absent usage. Data here is imported evidence, not attestation. */
export function summarizeEvidence(evidence) {
  const issues = [];
  const agents = new Map();
  const calls = new Map();
  for (const agent of evidence.agents ?? []) {
    if (!agent.sessionId || !agent.accountId || !agent.transcriptSha256 || agents.has(agent.sessionId))
      issues.push("missing/duplicate agent identity");
    agents.set(agent.sessionId, agent);
    if (agent.parentSessionId && !(evidence.agents ?? []).some((a) => a.sessionId === agent.parentSessionId))
      issues.push("missing parent session");
  }
  for (const sessionId of evidence.discoveredSessionIds ?? [])
    if (!agents.has(sessionId)) issues.push(`unaccounted session ${sessionId}`);
  if (!agents.size || evidence.inventoryComplete !== true) issues.push("incomplete session inventory");
  for (const call of evidence.calls ?? []) {
    if (
      !agents.has(call.sessionId) ||
      !call.callId ||
      ![call.input, call.output, call.cacheRead, call.cacheWrite].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    ) {
      issues.push("invalid/missing call usage");
      continue;
    }
    const key = `${call.sessionId}:${call.callId}`;
    const prior = calls.get(key);
    if (prior && ["input", "output", "cacheRead", "cacheWrite"].some((key) => prior[key] !== call[key]))
      issues.push("conflicting duplicate usage");
    calls.set(key, call);
  }
  for (const agent of agents.values())
    if (!agent.usageComplete || ![...calls.values()].some((c) => c.sessionId === agent.sessionId))
      issues.push(`unknown usage for ${agent.sessionId}`);
  const events = evidence.events ?? [];
  for (const event of events)
    if (
      !["intervention", "green", "diff-review", ...failures].includes(event.kind) ||
      !Number.isFinite(event.atMs) ||
      event.atMs < 0 ||
      !event.detail
    )
      issues.push("invalid evidence event");
  const greens = events
    .filter(
      (e) =>
        e.kind === "green" &&
        e.passed === true &&
        /^[a-f0-9]{64}$/.test(e.graderSha256 ?? "") &&
        Number.isFinite(e.atMs) &&
        e.atMs >= 0,
    )
    .map((e) => e.atMs);
  return {
    status: issues.length ? "incomplete" : "imported-unverified",
    issues: [...new Set(issues)],
    agents: agents.size,
    totalTokens: issues.length
      ? null
      : [...calls.values()].reduce((n, c) => n + c.input + c.output + c.cacheRead + c.cacheWrite, 0),
    wallToGreenMs: greens.length ? Math.min(...greens) : null,
    interventions: events.filter((e) => e.kind === "intervention"),
    coordinationFailures: events.filter((e) => failures.includes(e.kind)),
    diffReviews: events.filter((e) => e.kind === "diff-review"),
    subscriptionWindows: evidence.windows ?? [],
    recommendation: null,
  };
}

/** Pure guard for a future native adapter: equality stops, resets never resume. */
export function windowGuard(accounts, snapshots, nowMs, stopAt = { five_hour: 0.8, seven_day: 0.5 }) {
  if (!accounts.length || !Number.isFinite(nowMs)) return { stop: "missing account identity/time" };
  for (const window of ["five_hour", "seven_day"])
    if (!(stopAt[window] > 0 && stopAt[window] <= 1)) return { stop: "invalid window threshold" };
  for (const accountId of accounts) {
    const snapshot = snapshots.find((s) => s.accountId === accountId);
    if (
      !snapshot ||
      !Number.isFinite(snapshot.atMs) ||
      nowMs - snapshot.atMs > 30_000 ||
      nowMs < snapshot.atMs ||
      snapshots.filter((s) => s.accountId === accountId).length !== 1
    )
      return { stop: `missing/stale/ambiguous usage for ${accountId}` };
    for (const window of ["five_hour", "seven_day"]) {
      const value = snapshot[window];
      if (!Number.isFinite(value) || value < 0 || value > 1)
        return { stop: `unknown ${window} for ${accountId}` };
      if (value >= stopAt[window])
        return { stop: `${accountId} reached ${window}; explicit future run decision required` };
    }
    if (snapshot.limited === true) return { stop: `${accountId} is rate limited` };
  }
  return { allowed: true };
}

export function nativeReadiness() {
  return {
    status: "refused-engineering-incomplete",
    ownerRunDecision: "separate-hold",
    agentsLaunched: false,
    engineeringGaps: [
      {
        code: "claude-stop-unavailable",
        source: "apps/clankie/src/captain/claude-worker-seat.ts",
        symbol: "ClaudeWorkerSeatControl.interrupt/close",
        detail:
          "Interactive Claude interrupt returns false and close is a no-op; no all-descendant quota stop is established",
      },
      {
        code: "descendant-inventory-incomplete",
        source: "packages/agent-transcript/src/subagents.ts",
        symbol: "readClaudeSubagents",
        detail:
          "Local UI summary cold-reads 2 MiB and retains 64 calls/32 sessions; it is not a complete native descendant ledger",
      },
      {
        code: "account-window-telemetry-unavailable",
        source: "packages/agent-hosts/src/seat.ts",
        symbol: "SeatEvent/SeatControl",
        detail:
          "Native control exposes no account-bound subscription windows or complete per-call descendant usage",
      },
      {
        code: "isolated-real-hire-unwired",
        source: "apps/clankie/src/captain/captain.ts",
        symbol: "hireSeat",
        detail:
          "Real hire routes through HerdrWatch.spawnSeat, but an isolated service/fleet credential and descendant containment boundary is not wired into this runner",
      },
      {
        code: "terminal-bench-native-bridge-unavailable",
        source: "scripts/evals/lead-tasks.json",
        detail:
          "Official source pins are retained; native interactive fleet/container and separate official verifier integration is not established",
      },
    ],
  };
}

export function refuseRun() {
  const error = Error(
    "Native execution is not implemented: complete descendant/account usage and isolated real hire/control adapters are required. Owner run authorization is also required; it cannot substitute for those adapters. No process, account probe, timer or model turn was started.",
  );
  error.readiness = nativeReadiness();
  throw error;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode = "plan", ...args] = process.argv.slice(2);
    if (["plan", "--dry-run"].includes(mode)) console.log(JSON.stringify(plan(args), null, 2));
    else if (mode === "prepare" || mode === "reference") {
      const [id, output, extra] = args;
      if (!id || !output || args.length > 3)
        throw Error(
          `${mode} requires TASK NEW_DIRECTORY ${mode === "reference" ? "before|after" : "[WORKERS]"}`,
        );
      const task = loadTasks().historical.find((t) => t.id === id);
      if (!task) throw Error("Unknown task");
      console.log(
        JSON.stringify(
          mode === "prepare"
            ? prepareReplay(task, output, extra === undefined ? 3 : Number(extra))
            : prepareReference(task, output, extra),
          null,
          2,
        ),
      );
    } else if (mode === "candidate") {
      if (args.length !== 3) throw Error("candidate requires TASK PATCH NEW_DIRECTORY");
      const task = loadTasks().historical.find((t) => t.id === args[0]);
      if (!task) throw Error("Unknown task");
      console.log(JSON.stringify(prepareCandidate(task, args[1], args[2]), null, 2));
    } else if (mode === "grade") {
      if (args.length !== 1) throw Error("grade requires PREPARED_CANDIDATE_DIRECTORY");
      console.log(JSON.stringify(await gradeCandidate(args[0]), null, 2));
    } else if (mode === "collect") {
      if (args.length !== 1) throw Error("collect requires an evidence JSON file");
      console.log(JSON.stringify(summarizeEvidence(JSON.parse(readFileSync(args[0], "utf8"))), null, 2));
    } else if (mode === "run") refuseRun();
    else
      throw Error(
        "Use plan [--dry-run], prepare TASK NEW_DIRECTORY [WORKERS], reference TASK NEW_DIRECTORY before|after, candidate TASK PATCH NEW_DIRECTORY, collect EVIDENCE.json, or run (blocked)",
      );
  } catch (error) {
    console.error(
      error.readiness ? JSON.stringify({ error: String(error), ...error.readiness }, null, 2) : String(error),
    );
    process.exitCode = 1;
  }
}
