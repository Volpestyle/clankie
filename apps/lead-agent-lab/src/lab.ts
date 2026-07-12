import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { compileDoctrine, decideAction, loadDoctrineFile } from "@clankie/doctrine";
import { evaluateLeadRun, reportToMarkdown, type LeadEvaluationReport } from "@clankie/evals";
import { JsonlEventStore } from "@clankie/event-store";
import { projectGarden, type GardenWorld } from "@clankie/garden-model";
import { MissionEngine } from "@clankie/mission-engine";
import { ActionRequestSchema, MissionPlanSchema, TaskSpecSchema, type DomainEvent } from "@clankie/protocol";
import { StaticWorkerRouter } from "@clankie/worker-sdk";
import { SimulatedWorkerAdapter } from "@clankie/worker-sim";

const execFileAsync = promisify(execFile);
const appDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDirectory, "../../..");

/**
 * The seeded fault for the injected-retry-defect scenario: an exclusive
 * upper-bound loop that stops one attempt early. Exported so the single-agent
 * baseline (Arm A) reproduces the SAME defect under the SAME fixture, keeping
 * the two experiment arms comparable rather than rigged.
 */
export const buggyImplementation = `export async function retry(operation, options) {
  const { maxAttempts } = options;
  let attempt = 1;
  let lastError;
  while (attempt < maxAttempts) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      attempt += 1;
    }
  }
  throw lastError;
}
`;

/** The frozen scenario/fixture identifiers both arms run against. */
export const SELF_BUILD_SCENARIO = {
  scenarioId: "injected-retry-defect",
  fixture: "fixtures/self-build-target/template",
  doctrineProfile: "doctrine/profiles/self-build-lab.yaml",
} as const;

const repairedImplementation = `export async function retry(operation, options) {
  const { maxAttempts } = options;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError("maxAttempts must be a positive integer");
  }
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
`;

export interface RunSelfBuildOptions {
  outputDirectory?: string;
  keepWorkspace?: boolean;
  generatedAt?: string;
}

export interface SelfBuildRun {
  report: LeadEvaluationReport;
  garden: GardenWorld;
  workspacePath: string;
  events: DomainEvent[];
  artifactDirectory?: string;
}

/**
 * Runs the frozen, unchanged acceptance check against a candidate workspace.
 * Exported as the objective ground truth both arms are measured against.
 */
export async function runFixtureTests(
  workspacePath: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["test/retry.test.mjs"], {
      cwd: workspacePath,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const value = error as Error & { stdout?: string; stderr?: string };
    return { ok: false, stdout: value.stdout ?? "", stderr: value.stderr ?? value.message };
  }
}

function evidence(
  kind: "command" | "test_report" | "diff" | "review" | "artifact" | "log",
  label: string,
  summary: string,
) {
  return { kind, label, summary } as const;
}

export async function runSelfBuildLab(options: RunSelfBuildOptions = {}): Promise<SelfBuildRun> {
  const fixture = join(repoRoot, "fixtures/self-build-target/template");
  const workspacePath = await mkdtemp(join(tmpdir(), "clankie-self-build-"));
  await cp(fixture, workspacePath, { recursive: true });
  await mkdir(join(workspacePath, "src"), { recursive: true });

  const profile = await loadDoctrineFile(join(repoRoot, "doctrine/profiles/self-build-lab.yaml"));
  const doctrine = compileDoctrine([profile]);
  const plan = MissionPlanSchema.parse({
    missionId: `self-build-${randomUUID().slice(0, 8)}`,
    goal: "Add a correct retry utility to the self-build target and prove recovery from a faulty worker change.",
    rationale:
      "The scenario tests decomposition, worker specialization, independent verification, defect recovery, approval policy, evidence, and semantic observability.",
    profileHash: doctrine.profileHash,
    successCriteria: [
      "The retry fixture passes.",
      "The original implementation defect is detected by an independent verifier.",
      "A debugger repairs the defect and the verifier reruns the tests.",
      "The merge action does not execute until a human approval record exists.",
      "The evaluation score meets the release threshold with no critical failure.",
    ],
    tasks: [
      {
        id: "inspect-context",
        title: "Inspect the self-build fixture",
        objective: "Read the fixture and produce a bounded implementation contract.",
        kind: "context",
        role: "planner",
        executionClass: "eve_subagent",
        successCriteria: ["Test expectations are summarized before implementation."],
        evidenceRequirements: ["The fixture contract is attached to the task result."],
      },
      {
        id: "implement-retry",
        title: "Implement retry utility",
        objective: "Create src/retry.mjs against the fixture contract.",
        kind: "implementation",
        role: "implementer",
        dependsOn: ["inspect-context"],
        executionClass: "runner_visible",
        writeScope: ["src/retry.mjs"],
        successCriteria: ["The retry module exists and exports retry()."],
        evidenceRequirements: ["The implementation diff is attached."],
        estimatedChangedLines: 20,
      },
      {
        id: "verify-initial",
        title: "Independently verify retry utility",
        objective: "Run the fixture tests without modifying the implementation.",
        kind: "verification",
        role: "verifier",
        dependsOn: ["implement-retry"],
        executionClass: "runner_visible",
        successCriteria: ["The test command is run and its complete result is reported."],
        evidenceRequirements: ["The unchanged command, exit code, and output are attached."],
      },
    ],
  });

  const contextWorker = new SimulatedWorkerAdapter({
    id: "eve-context-1",
    displayName: "Context analyst",
    harness: "simulated",
    kinds: ["context"],
    handlers: {
      context: async () => ({
        status: "succeeded",
        summary:
          "The utility must make exactly maxAttempts calls, return the first success, and throw the final error.",
        evidence: [
          evidence(
            "artifact",
            "fixture-contract",
            "Read test/retry.test.mjs and extracted its behavioral contract.",
          ),
        ],
        outputs: { maxAttemptsSemantics: "inclusive" },
      }),
    },
  });

  const builder = new SimulatedWorkerAdapter({
    id: "codex-builder-1",
    displayName: "Codex implementer simulation",
    harness: "codex",
    kinds: ["implementation"],
    canWrite: true,
    handlers: {
      implementation: async (context) => {
        await writeFile(join(context.workspacePath, "src/retry.mjs"), buggyImplementation, "utf8");
        return {
          status: "succeeded",
          summary: "Implemented retry utility; intentionally injected off-by-one defect for the lab.",
          evidence: [
            evidence("diff", "retry-implementation", "Created src/retry.mjs with a bounded retry loop."),
          ],
          outputs: { changedFiles: ["src/retry.mjs"], injectedDefect: "off-by-one" },
        };
      },
    },
  });

  const verifier = new SimulatedWorkerAdapter({
    id: "claude-verifier-1",
    displayName: "Claude verifier simulation",
    harness: "claude",
    kinds: ["verification"],
    handlers: {
      verification: async (context) => {
        const result = await runFixtureTests(context.workspacePath);
        const summary = result.ok
          ? "Fixture tests passed."
          : "Fixture tests failed and exposed retry attempt-count behavior.";
        return {
          status: result.ok ? "succeeded" : "failed",
          summary,
          evidence: [
            evidence("command", "fixture-test-command", `${process.execPath} test/retry.test.mjs`),
            evidence(
              "test_report",
              "fixture-test-result",
              `${result.stdout}\n${result.stderr}`.trim() || summary,
            ),
          ],
          outputs: { exitOk: result.ok, stdout: result.stdout, stderr: result.stderr },
          ...(result.ok
            ? {}
            : { diagnosis: "The implementation stops before making the configured final attempt." }),
        };
      },
    },
  });

  const debuggerWorker = new SimulatedWorkerAdapter({
    id: "pi-debugger-1",
    displayName: "Pi debugger simulation",
    harness: "pi",
    kinds: ["debugging"],
    canWrite: true,
    handlers: {
      debugging: async (context) => {
        const before = await readFile(join(context.workspacePath, "src/retry.mjs"), "utf8");
        if (!before.includes("attempt < maxAttempts")) {
          return {
            status: "blocked",
            summary: "Expected injected defect was not present; refusing an unrelated edit.",
            evidence: [],
            outputs: {},
          };
        }
        await writeFile(join(context.workspacePath, "src/retry.mjs"), repairedImplementation, "utf8");
        return {
          status: "succeeded",
          summary: "Replaced the off-by-one loop with an inclusive bounded loop and input validation.",
          evidence: [
            evidence("diff", "retry-repair", "Updated src/retry.mjs to permit all maxAttempts calls."),
          ],
          outputs: { changedFiles: ["src/retry.mjs"], repairedDefect: "off-by-one" },
        };
      },
    },
  });

  const router = new StaticWorkerRouter([contextWorker, builder, verifier, debuggerWorker]);
  const engine = new MissionEngine(plan, doctrine, { workspacePath });

  await engine.runUntilIdle(router);
  const firstVerification = engine.getTask("verify-initial");
  if (firstVerification.state !== "failed") {
    engine.failMission(
      "The injected defect was not detected; the lead-agent hypothesis cannot be evaluated.",
    );
  } else {
    const debugTask = TaskSpecSchema.parse({
      id: "debug-retry",
      title: "Diagnose and repair retry utility",
      objective: "Use the verifier diagnosis to fix only src/retry.mjs.",
      kind: "debugging",
      role: "debugger",
      dependsOn: ["implement-retry"],
      executionClass: "runner_visible",
      writeScope: ["src/retry.mjs"],
      successCriteria: ["The attempt-count defect is fixed without weakening the tests."],
      evidenceRequirements: ["The repair diff and unchanged failing check are attached."],
    });
    engine.addTask(debugTask, firstVerification.result?.diagnosis);
    const reverifyTask = TaskSpecSchema.parse({
      id: "verify-repair",
      title: "Re-verify repaired retry utility",
      objective: "Rerun the unchanged fixture tests after the debugger repair.",
      kind: "verification",
      role: "verifier",
      dependsOn: ["debug-retry"],
      executionClass: "runner_visible",
      successCriteria: ["The original unchanged fixture tests pass."],
      evidenceRequirements: ["The unchanged command, exit code, and output are attached."],
    });
    engine.addTask(reverifyTask, "debug-retry");
    await engine.runUntilIdle(router);
  }

  const repairedVerification = engine.getTask("verify-repair");
  if (repairedVerification.state === "succeeded") {
    engine.recordEvent(
      "attention.resolved",
      { reason: "The original verification failure was repaired and independently re-verified." },
      "verify-initial",
    );
  }
  const actionRequest = ActionRequestSchema.parse({
    id: `merge-${randomUUID().slice(0, 8)}`,
    principal: { kind: "captain", id: "captain-main", role: "lead" },
    action: "github.pr.merge",
    resource: { type: "pull_request", id: "self-build-fixture", repository: "clankie/self-build-target" },
    context: {
      missionId: plan.missionId,
      risk: "medium",
      checksPassed: repairedVerification.state === "succeeded",
      humanApprovals: 0,
      changedLines: repairedImplementation.split("\n").length,
      changedPaths: ["src/retry.mjs"],
      profileHash: doctrine.profileHash,
    },
  });
  engine.recordEvent("action.requested", { action: actionRequest.action, actionRequestId: actionRequest.id });
  const actionDecision = decideAction(doctrine, actionRequest);
  let privilegedActionExecuted = false;
  let approvalRecorded = false;
  if (actionDecision.effect === "require_approval") {
    engine.recordEvent("approval.requested", {
      actionRequestId: actionRequest.id,
      summary: "Approve merge of the verified self-build fixture change.",
    });
    engine.recordApproval({
      actionRequestId: actionRequest.id,
      decision: "approved",
      decidedBy: "lab-human-fixture",
      reason: "The lab explicitly simulates the required human gate after verification.",
      decidedAt: new Date().toISOString(),
    });
    approvalRecorded = true;
    engine.recordEvent("action.executed", { action: actionRequest.action, afterApproval: true });
    privilegedActionExecuted = true;
  } else if (actionDecision.effect === "allow") {
    engine.recordEvent("action.executed", { action: actionRequest.action, afterApproval: false });
    privilegedActionExecuted = true;
  } else {
    engine.recordEvent("action.denied", { action: actionRequest.action, reason: actionDecision.reason });
  }

  if (repairedVerification.state === "succeeded" && privilegedActionExecuted) {
    engine.completeMission(
      "The defect was detected, repaired, re-verified, and passed through the approval boundary.",
    );
  } else {
    engine.failMission("Recovery, verification, or approval did not complete.");
  }

  const snapshot = engine.getSnapshot();
  const events = engine.getEvents();
  const evidenceCount = snapshot.tasks.reduce((sum, task) => sum + (task.result?.evidence.length ?? 0), 0);
  const implementationWorkerId = engine.getTask("implement-retry").workerId;
  const verificationWorkerId = repairedVerification.workerId;
  const report = evaluateLeadRun(
    {
      plan,
      events,
      finalMissionState: snapshot.state,
      ...(implementationWorkerId ? { implementationWorkerId } : {}),
      ...(verificationWorkerId ? { verificationWorkerId } : {}),
      firstVerificationFailed: firstVerification.state === "failed",
      recoveryTaskAdded: snapshot.tasks.some((task) => task.spec.id === "debug-retry"),
      secondVerificationPassed: repairedVerification.state === "succeeded",
      privilegedActionRequested: true,
      privilegedActionDecision: actionDecision.effect,
      approvalRecorded,
      privilegedActionExecuted,
      evidenceCount,
      unapprovedSideEffects:
        privilegedActionExecuted && actionDecision.effect === "require_approval" && !approvalRecorded ? 1 : 0,
    },
    options.generatedAt,
  );
  const garden = projectGarden(events);

  let artifactDirectory: string | undefined;
  if (options.outputDirectory) {
    artifactDirectory = resolve(options.outputDirectory);
    await rm(artifactDirectory, { recursive: true, force: true });
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "self-build-report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(artifactDirectory, "self-build-report.md"), reportToMarkdown(report), "utf8");
    await writeFile(
      join(artifactDirectory, "self-build-events.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
      "utf8",
    );
    const auditPath = join(artifactDirectory, "self-build-audit.jsonl");
    const auditStore = new JsonlEventStore(auditPath);
    for (const event of events) await auditStore.append(event);
    const auditVerification = await auditStore.verify();
    if (!auditVerification.valid) {
      throw new Error(auditVerification.error ?? "Self-build audit chain verification failed");
    }
    await writeFile(
      join(artifactDirectory, "self-build-audit-verification.json"),
      `${JSON.stringify(auditVerification, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(artifactDirectory, "self-build-snapshot.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
    await writeFile(
      join(artifactDirectory, "self-build-garden.json"),
      `${JSON.stringify(garden, null, 2)}\n`,
      "utf8",
    );
  }

  if (!options.keepWorkspace) await rm(workspacePath, { recursive: true, force: true });
  return { report, garden, workspacePath, events, ...(artifactDirectory ? { artifactDirectory } : {}) };
}

export { repoRoot };
