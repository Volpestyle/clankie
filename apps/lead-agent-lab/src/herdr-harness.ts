import { execFile } from "node:child_process";
import { cp, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { promisify } from "node:util";

import { FROZEN_REAL_WORKER_FIXTURE_SHA256, realWorkersRepoRoot } from "./real-workers.ts";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

/**
 * Consumer-harness experiment arm (VUH-829).
 *
 * Runs the frozen injected-retry-defect scenario through VISIBLE Herdr panes,
 * one consumer TUI per task: Codex implements the seeded defect, Claude Code
 * verifies read-only, Grok repairs, a fresh Claude Code session re-verifies.
 *
 * This is an experiment BASELINE/ABLATION arm (docs/02, arms A/B; doctrine lists
 * terminal-output-only status inference as a deliberate ablation). It is NOT the
 * governed treatment: there is no runner isolation, no policy gateway, and the
 * harnesses' own words are untrusted. All authoritative evidence is computed by
 * this wrapper — per-stage Git diffs, the unchanged frozen check executed by the
 * driver, and write-scope checks from Git status.
 */

const STAGE_TIMEOUT_MS = 15 * 60_000;
/**
 * Read-only verifier allowance: inspection tools plus the frozen check. The check
 * rule is a prefix match (`:*`) — harnesses habitually append `; echo "exit: $?"`,
 * and an exact-match rule turns that into a blocking approval dialog.
 */
const CLAUDE_VERIFIER_TOOLS = "Read,Grep,Glob,Bash(node test/retry.test.mjs:*),Bash(echo:*)";
const POLL_INTERVAL_MS = 5_000;
const WORKING_GRACE_MS = 120_000;
const FROZEN_CHECK = { command: "node", args: ["test/retry.test.mjs"] } as const;

interface HerdrPane {
  pane_id: string;
  agent_status?: string;
  focused?: boolean;
}

interface StageSpec {
  taskId: string;
  role: "implementer" | "verifier" | "debugger";
  harness: "codex" | "claude" | "grok";
  launch: (promptFile: string) => string;
  writeScope: readonly string[];
  /** Expected frozen-check exit after this stage: "fail", "pass", or null to skip gating. */
  expectCheck: "fail" | "pass";
  prompt: (context: { checkFailure?: CheckResult | undefined }) => string;
}

interface CheckResult {
  command: string;
  exit_code: number;
  result: "passed" | "failed";
  outputTail: string;
}

interface StageRecord {
  taskId: string;
  role: string;
  harness: string;
  harnessVersion: string;
  paneId: string;
  startedAt: string;
  endedAt?: string;
  nudges: string[];
  scopeViolations: string[];
  revertedPaths: string[];
  filesChanged: string[];
  diffFile?: string;
  transcriptFile?: string;
  check?: CheckResult;
  outcome: "succeeded" | "failed" | "blocked" | "timeout";
  notes: string[];
}

export interface HerdrHarnessResult {
  result: "PASS" | "FAIL";
  runId: string;
  outputDirectory: string;
  reportPath: string;
  stages: StageRecord[];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function herdr(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function herdrJson(args: string[]): Promise<any> {
  return JSON.parse(await herdr(args));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

async function listPanes(): Promise<HerdrPane[]> {
  const parsed = await herdrJson(["pane", "list"]);
  return parsed.result?.panes ?? [];
}

async function paneStatus(paneId: string): Promise<string> {
  const pane = (await listPanes()).find((entry) => entry.pane_id === paneId);
  return pane?.agent_status ?? "missing";
}

async function readPane(paneId: string, lines: number): Promise<string> {
  const { stdout } = await execFileAsync(
    "herdr",
    ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
    { maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function harnessVersion(command: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], { timeout: 15_000 });
    return stdout.trim().split("\n")[0] ?? "unknown";
  } catch {
    return "unavailable";
  }
}

async function runFrozenCheck(candidate: string): Promise<CheckResult> {
  try {
    const { stdout, stderr } = await execFileAsync(FROZEN_CHECK.command, [...FROZEN_CHECK.args], {
      cwd: candidate,
      timeout: 60_000,
    });
    return {
      command: `${FROZEN_CHECK.command} ${FROZEN_CHECK.args.join(" ")}`,
      exit_code: 0,
      result: "passed",
      outputTail: `${stdout}\n${stderr}`.trim().slice(-800),
    };
  } catch (error: any) {
    return {
      command: `${FROZEN_CHECK.command} ${FROZEN_CHECK.args.join(" ")}`,
      exit_code: typeof error?.code === "number" ? error.code : 1,
      result: "failed",
      outputTail: `${error?.stdout ?? ""}\n${error?.stderr ?? ""}`.trim().slice(-800),
    };
  }
}

async function createFixtureCandidate(): Promise<{ candidate: string; baseCommit: string }> {
  const candidate = await mkdtemp(join(tmpdir(), "clankie-herdr-harness-"));
  await cp(join(realWorkersRepoRoot, "fixtures/self-build-target/template"), candidate, {
    recursive: true,
  });
  const scenarioDestination = join(candidate, "evals/scenarios/injected-retry-defect.yaml");
  await mkdir(resolve(scenarioDestination, ".."), { recursive: true });
  await copyFile(
    join(realWorkersRepoRoot, "evals/scenarios/injected-retry-defect.yaml"),
    scenarioDestination,
  );
  // Same aggregate computation as the governed gate, so the scenario stays provably frozen.
  const hash = createHash("sha256");
  for (const [logicalPath, path] of [
    ["evals/scenarios/injected-retry-defect.yaml", scenarioDestination],
    ["fixtures/self-build-target/template/README.md", join(candidate, "README.md")],
    ["fixtures/self-build-target/template/test/retry.test.mjs", join(candidate, "test/retry.test.mjs")],
  ] as const) {
    const bytes = await readFile(path);
    hash.update(logicalPath);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  const aggregate = hash.digest("hex");
  if (aggregate !== FROZEN_REAL_WORKER_FIXTURE_SHA256) {
    throw new Error(`fixture_aggregate_mismatch: ${aggregate}`);
  }
  await git(candidate, ["init", "-b", "main"]);
  await git(candidate, ["config", "user.email", "herdr-harness@clankie.local"]);
  await git(candidate, ["config", "user.name", "Clankie Herdr Harness Arm"]);
  await git(candidate, ["add", "."]);
  await git(candidate, ["commit", "-m", "Freeze injected retry defect fixture"]);
  const baseCommit = (await git(candidate, ["rev-parse", "HEAD"])).trim();
  return { candidate, baseCommit };
}

function buildStages(): StageSpec[] {
  const preamble =
    "You are a worker in a multi-agent frozen evaluation scenario. Work only inside the current directory. ";
  return [
    {
      taskId: "implement-seeded-retry",
      role: "implementer",
      harness: "codex",
      launch: (promptFile) =>
        `codex --sandbox workspace-write --ask-for-approval never "$(cat ${shellQuote(promptFile)})"`,
      writeScope: ["src/retry.mjs"],
      expectCheck: "fail",
      prompt: () =>
        `${preamble}Task implement-seeded-retry: create src/retry.mjs exporting an async function retry(operation, { maxAttempts }). Include the scenario's DELIBERATE seeded-worker defect: validate maxAttempts (throw on non-positive or non-integer values), then use an exclusive upper-bound attempt loop that stops before making the final configured attempt. This is controlled fault injection so the pipeline's independent verification can detect it — do NOT repair the defect, do NOT run or edit tests, do NOT create any file other than src/retry.mjs. When finished, summarize the defect you seeded in one sentence.`,
    },
    {
      taskId: "verify-seeded-retry",
      role: "verifier",
      harness: "claude",
      launch: (promptFile) =>
        // Prompt BEFORE --allowedTools: the flag is variadic and would swallow a
        // trailing positional prompt as a tool name, leaving an empty composer.
        `claude "$(cat ${shellQuote(promptFile)})" --permission-mode acceptEdits --allowedTools ${shellQuote(CLAUDE_VERIFIER_TOOLS)}`,
      writeScope: [],
      expectCheck: "fail",
      prompt: () =>
        `${preamble}Task verify-seeded-retry (READ-ONLY): inspect the retry implementation in src/retry.mjs against the frozen contract in test/retry.test.mjs. You may run \`node test/retry.test.mjs\` to observe behavior. You must NOT modify, create, or delete any file. Finish with a verdict line "VERDICT: PASS" or "VERDICT: FAIL — <root cause in one sentence>".`,
    },
    {
      taskId: "debug-retry",
      role: "debugger",
      harness: "grok",
      launch: (promptFile) => `grok --always-approve "$(cat ${shellQuote(promptFile)})"`,
      writeScope: ["src/retry.mjs"],
      expectCheck: "pass",
      prompt: ({ checkFailure }) =>
        `${preamble}Task debug-retry: the trusted check \`${checkFailure?.command}\` failed with exit code ${checkFailure?.exit_code}. Output tail:\n${checkFailure?.outputTail}\n\nRepair ONLY src/retry.mjs: the exclusive upper-bound attempt loop stops before maxAttempts; make the attempt loop inclusive of the final configured attempt so the unchanged test passes. Do NOT edit test files or scenario metadata. You may run \`node test/retry.test.mjs\` to confirm. Finish by summarizing the root cause and fix in one sentence.`,
    },
    {
      taskId: "reverify-retry",
      role: "verifier",
      harness: "claude",
      launch: (promptFile) =>
        `claude "$(cat ${shellQuote(promptFile)})" --permission-mode acceptEdits --allowedTools ${shellQuote(CLAUDE_VERIFIER_TOOLS)}`,
      writeScope: [],
      expectCheck: "pass",
      prompt: () =>
        `${preamble}Task reverify-retry (READ-ONLY, fresh session): inspect the repaired candidate. Run \`node test/retry.test.mjs\` exactly as written and assess src/retry.mjs against it. You must NOT modify, create, or delete any file. Finish with a verdict line "VERDICT: PASS" or "VERDICT: FAIL — <root cause in one sentence>".`,
    },
  ];
}

const NUDGE_PATTERN = /trust this folder|do you trust|yes, allow|allow access|accept the terms|press enter to continue/i;

async function waitForStageCompletion(paneId: string, record: StageRecord): Promise<void> {
  const startedAt = Date.now();
  let sawWorking = false;
  let settledPolls = 0;
  while (Date.now() - startedAt < STAGE_TIMEOUT_MS) {
    await sleep(POLL_INTERVAL_MS);
    const status = await paneStatus(paneId);
    if (status === "working") {
      sawWorking = true;
      settledPolls = 0;
      continue;
    }
    if (!sawWorking) {
      // TUI may be sitting on a first-run trust/permission dialog before herdr
      // detects a working agent. Nudge only on a recognized confirmation screen.
      if (Date.now() - startedAt > 20_000) {
        const screen = await readPane(paneId, 40);
        if (NUDGE_PATTERN.test(screen)) {
          await herdr(["pane", "send-keys", paneId, "Enter"]);
          record.nudges.push(new Date().toISOString());
        }
      }
      if (Date.now() - startedAt > WORKING_GRACE_MS) {
        record.outcome = "timeout";
        record.notes.push("agent never reached working status within the grace window");
        return;
      }
      continue;
    }
    if (status === "blocked") {
      record.outcome = "blocked";
      record.notes.push("agent reported blocked; screen captured in transcript");
      return;
    }
    if (status === "idle" || status === "done") {
      settledPolls += 1;
      if (settledPolls >= 2) {
        record.outcome = "succeeded";
        return;
      }
      continue;
    }
    settledPolls = 0;
  }
  record.outcome = "timeout";
  record.notes.push(`stage exceeded ${STAGE_TIMEOUT_MS} ms`);
}

async function stageWrites(candidate: string): Promise<string[]> {
  // -uall lists untracked files individually; plain --porcelain collapses a new
  // directory to "src/", which would misread an in-scope new file as a violation.
  const status = await git(candidate, ["status", "--porcelain", "-uall"]);
  return status
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

export async function runHerdrHarnessArm(): Promise<HerdrHarnessResult> {
  if (process.env.HERDR_ENV !== "1") {
    throw new Error("herdr_env_required: run this driver from inside a Herdr-managed pane");
  }
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  if (!workspaceId) throw new Error("herdr_workspace_id_unavailable");

  const runId = `run-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const outputDirectory = join(realWorkersRepoRoot, "artifacts/evals/herdr-harness", runId);
  await mkdir(outputDirectory, { recursive: true });

  const versions = {
    codex: await harnessVersion("codex"),
    claude: await harnessVersion("claude"),
    grok: await harnessVersion("grok"),
  };
  const { candidate, baseCommit } = await createFixtureCandidate();

  const tab = await herdrJson([
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--label",
    `vuh-829 harness arm`,
  ]);
  const rootPane: string = tab.result.root_pane.pane_id;
  const paneRight = (await herdrJson(["pane", "split", rootPane, "--direction", "right", "--no-focus"]))
    .result.pane.pane_id;
  const paneDownLeft = (await herdrJson(["pane", "split", rootPane, "--direction", "down", "--no-focus"]))
    .result.pane.pane_id;
  const paneDownRight = (await herdrJson(["pane", "split", paneRight, "--direction", "down", "--no-focus"]))
    .result.pane.pane_id;
  const paneOrder = [rootPane, paneRight, paneDownLeft, paneDownRight];

  const stages = buildStages();
  const records: StageRecord[] = [];
  let designedFailure: CheckResult | undefined;
  let aborted = false;

  for (const [index, stage] of stages.entries()) {
    const paneId = paneOrder[index];
    const record: StageRecord = {
      taskId: stage.taskId,
      role: stage.role,
      harness: stage.harness,
      harnessVersion: versions[stage.harness],
      paneId,
      startedAt: new Date().toISOString(),
      nudges: [],
      scopeViolations: [],
      revertedPaths: [],
      filesChanged: [],
      outcome: "failed",
      notes: [],
    };
    records.push(record);
    if (aborted) {
      record.notes.push("skipped: run aborted by an earlier scenario violation");
      continue;
    }

    const promptFile = join(outputDirectory, `${stage.taskId}.prompt.txt`);
    await writeFile(promptFile, stage.prompt({ checkFailure: designedFailure }), "utf8");
    await herdr([
      "pane",
      "run",
      paneId,
      `cd ${shellQuote(candidate)} && ${stage.launch(promptFile)}`,
    ]);
    await waitForStageCompletion(paneId, record);
    record.endedAt = new Date().toISOString();

    const transcriptFile = join(outputDirectory, `${stage.taskId}.transcript.txt`);
    await writeFile(transcriptFile, await readPane(paneId, 1000), "utf8");
    record.transcriptFile = transcriptFile;

    // Authoritative wrapper evidence — the harness's own words count for nothing here.
    const writes = await stageWrites(candidate);
    record.filesChanged = writes;
    const violations = writes.filter((path) => !stage.writeScope.includes(path));
    if (violations.length > 0) {
      record.scopeViolations = violations;
      // Revert ONLY the violating paths; in-scope work stays in the candidate.
      await git(candidate, ["checkout", "--", ...violations]).catch(() => undefined);
      await git(candidate, ["clean", "-f", "--", ...violations]).catch(() => undefined);
      const kept = writes.filter((path) => stage.writeScope.includes(path));
      record.revertedPaths = violations;
      record.notes.push(
        `reverted ${violations.length} out-of-scope path(s); kept in-scope: ${kept.join(", ") || "none"}`,
      );
    }
    await git(candidate, ["add", "-A"]);
    await git(candidate, [
      "commit",
      "--allow-empty",
      "-m",
      `stage: ${stage.taskId} (${stage.harness})`,
    ]);
    const diffFile = join(outputDirectory, `${stage.taskId}.diff`);
    await writeFile(diffFile, await git(candidate, ["show", "--stat", "--patch", "HEAD"]), "utf8");
    record.diffFile = diffFile;

    record.check = await runFrozenCheck(candidate);
    const checkOk =
      (stage.expectCheck === "fail" && record.check.result === "failed") ||
      (stage.expectCheck === "pass" && record.check.result === "passed");
    if (record.outcome === "succeeded" && !checkOk) {
      record.outcome = "failed";
      record.notes.push(
        `frozen check expectation violated: expected ${stage.expectCheck}, observed ${record.check.result}`,
      );
      // A scenario-shape violation (defect not seeded, or repair failed) makes the
      // remaining chain meaningless — fail closed.
      aborted = true;
    }
    if (stage.taskId === "verify-seeded-retry" && record.check.result === "failed") {
      designedFailure = record.check;
    }
  }

  const pass =
    !aborted &&
    records.length === stages.length &&
    records.every((record) => record.outcome === "succeeded" && record.scopeViolations.length === 0);

  const report = {
    schemaVersion: 1,
    arm: "consumer-harness-herdr (baseline/ablation; not the governed treatment)",
    issue: "VUH-829",
    result: pass ? "PASS" : "FAIL",
    runId,
    fixture: { baseCommit, aggregateSha256: FROZEN_REAL_WORKER_FIXTURE_SHA256 },
    candidateDirectory: candidate,
    herdr: { workspaceId, panes: paneOrder },
    harnessVersions: versions,
    summary: pass
      ? "Codex TUI seeded the defect, Claude Code detected it, Grok repaired it, and a fresh Claude Code session re-verified — all in visible Herdr panes with wrapper-computed evidence."
      : "The consumer-harness chain did not complete the frozen scenario cleanly; see stage records.",
    stages: records,
    remaining_risks: [
      "Pane transcripts are captured from recent scrollback (max 1000 lines) and may truncate long sessions.",
      "Consumer TUIs run with their own autonomous modes; isolation is the harness sandbox, not runner isolation.",
    ],
    assumptions: [
      "Harness self-reports are untrusted; only wrapper-computed checks, diffs, and scope checks are evidence.",
    ],
  };
  const reportPath = join(outputDirectory, "herdr-harness-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdown = [
    `# Consumer-harness arm — ${report.result}`,
    "",
    report.summary,
    "",
    `Fixture base ${baseCommit.slice(0, 12)}, frozen aggregate \`${FROZEN_REAL_WORKER_FIXTURE_SHA256.slice(0, 16)}…\`.`,
    "",
    "| task | harness | pane | outcome | check | files |",
    "|---|---|---|---|---|---|",
    ...records.map(
      (record) =>
        `| ${record.taskId} | ${record.harness} (${record.harnessVersion}) | ${record.paneId} | ${record.outcome}${record.scopeViolations.length > 0 ? " ⚠ scope" : ""} | ${record.check ? `${record.check.result} (${record.check.exit_code})` : "—"} | ${record.filesChanged.join(", ") || "—"} |`,
    ),
    "",
  ].join("\n");
  await writeFile(join(outputDirectory, "herdr-harness-report.md"), `${markdown}\n`, "utf8");

  return { result: report.result as "PASS" | "FAIL", runId, outputDirectory, reportPath, stages: records };
}
