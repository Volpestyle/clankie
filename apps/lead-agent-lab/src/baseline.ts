import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { evaluateLeadRun, type LeadEvaluationReport } from "@clankie/evals";
import { MissionEngine } from "@clankie/mission-engine";
import { MissionPlanSchema, type DomainEvent } from "@clankie/protocol";
import { StaticWorkerRouter } from "@clankie/worker-sdk";
import { SimulatedWorkerAdapter } from "@clankie/worker-sim";
import { buggyImplementation, runFixtureTests, SELF_BUILD_SCENARIO, repoRoot } from "./lab.ts";

export interface BaselineRunOptions {
  generatedAt?: string;
  keepWorkspace?: boolean;
  seed?: string;
}

export interface BaselineRun {
  report: LeadEvaluationReport;
  events: DomainEvent[];
  workspacePath: string;
  groundTruthPassed: boolean;
  profileHash: string;
  seed?: string;
  implementationWorkerId?: string;
}

function seedToken(seed: string | undefined): string {
  return seed ? createHash("sha256").update(seed).digest("hex").slice(0, 12) : randomUUID().slice(0, 8);
}

/**
 * Arm A — genuinely unconstrained single-agent baseline.
 *
 * One agent receives the whole task and works in a single session with **no
 * lead, no independent verifier, and no recovery router**. It implements the
 * retry helper under the SAME seeded fault as Arm C (`buggyImplementation`) and
 * self-certifies completion — the realistic failure mode the lead's independent
 * verifier exists to catch. The harness then applies the SAME frozen, unchanged
 * acceptance check (`runFixtureTests`) as objective ground truth. The defect
 * escapes the single agent but not the evaluator: `secondVerificationPassed`
 * carries the objective result, so the unchanged `evaluateLeadRun` scores
 * `goal-success` false. Nothing here is tuned to make the arm fail; the low
 * score is the structural consequence of missing lead machinery, and the facts
 * are derived mechanically from the actual run.
 */
export async function runSingleAgentBaseline(options: BaselineRunOptions = {}): Promise<BaselineRun> {
  const runToken = seedToken(options.seed);
  const workspacePath = await mkdtemp(join(tmpdir(), "clankie-baseline-"));
  await cp(join(repoRoot, SELF_BUILD_SCENARIO.fixture), workspacePath, { recursive: true });
  await mkdir(join(workspacePath, "src"), { recursive: true });

  const profile = await loadDoctrineFile(join(repoRoot, SELF_BUILD_SCENARIO.doctrineProfile));
  const doctrine = compileDoctrine([profile]);
  const plan = MissionPlanSchema.parse({
    missionId: `baseline-${runToken}`,
    goal: "Add a correct retry utility to the self-build target.",
    rationale:
      "Arm A baseline: a single unconstrained agent with no lead, independent verifier, or recovery router.",
    profileHash: doctrine.profileHash,
    successCriteria: ["The retry fixture passes."],
    tasks: [
      {
        id: "solo-implement",
        title: "Single-agent implement + self-certify",
        objective:
          "One agent implements the retry helper and declares the work done, with no external check.",
        kind: "implementation",
        role: "implementer",
        executionClass: "runner_visible",
        writeScope: ["src/retry.mjs"],
        successCriteria: ["The retry module exists and exports retry()."],
        evidenceRequirements: ["The implementation diff is attached."],
        estimatedChangedLines: 20,
      },
    ],
  });

  // A single agent: implements (under the seeded fault) and self-certifies. No
  // independent verifier or recovery worker is registered — that absence IS the
  // baseline condition.
  const soloAgent = new SimulatedWorkerAdapter({
    id: "solo-agent",
    displayName: "Unconstrained single agent",
    harness: "codex",
    kinds: ["implementation"],
    canWrite: true,
    handlers: {
      implementation: async (context) => {
        await writeFile(join(context.workspacePath, "src/retry.mjs"), buggyImplementation, "utf8");
        return {
          status: "succeeded",
          summary: "Implemented retry utility and self-certified completion (no independent verification).",
          evidence: [
            { kind: "diff", label: "retry-implementation", summary: "Created src/retry.mjs." },
            {
              kind: "log",
              label: "self-certification",
              summary: "Single agent declared the work complete without an independent check.",
            },
          ],
          outputs: { changedFiles: ["src/retry.mjs"] },
        };
      },
    },
  });

  const engine = new MissionEngine(plan, doctrine, { workspacePath });
  await engine.runUntilIdle(new StaticWorkerRouter([soloAgent]));
  // The unconstrained agent declares the mission done from its own judgment.
  engine.completeMission("Single agent self-certified the implementation as complete.");

  // Objective ground truth: the frozen acceptance check the lead's verifier
  // would have run. Applied here by the harness, not by the agent.
  const groundTruth = await runFixtureTests(workspacePath);

  const snapshot = engine.getSnapshot();
  const events = engine.getEvents();
  const evidenceCount = snapshot.tasks.reduce((sum, task) => sum + (task.result?.evidence.length ?? 0), 0);
  const implementationWorkerId = engine.getTask("solo-implement").workerId;

  const report = evaluateLeadRun(
    {
      plan,
      events,
      finalMissionState: snapshot.state,
      ...(implementationWorkerId ? { implementationWorkerId } : {}),
      // No independent verifier exists in Arm A.
      firstVerificationFailed: false,
      recoveryTaskAdded: false,
      // The objective frozen check is the ground-truth verification signal.
      secondVerificationPassed: groundTruth.ok,
      // Arm A never reaches an approval boundary; it has no lead to request one.
      privilegedActionRequested: false,
      approvalRecorded: false,
      privilegedActionExecuted: false,
      evidenceCount,
      unapprovedSideEffects: 0,
    },
    options.generatedAt,
  );

  if (!options.keepWorkspace) await rm(workspacePath, { recursive: true, force: true });
  return {
    report,
    events,
    workspacePath,
    groundTruthPassed: groundTruth.ok,
    profileHash: doctrine.profileHash,
    ...(options.seed ? { seed: options.seed } : {}),
    ...(implementationWorkerId ? { implementationWorkerId } : {}),
  };
}
