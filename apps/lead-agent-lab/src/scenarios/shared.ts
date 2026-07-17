import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { MissionEngine } from "@clankie/mission-engine";
import { MissionPlanSchema, type DomainEvent, type MissionPlan, type WorkerResult } from "@clankie/protocol";
import { StaticWorkerRouter } from "@clankie/worker-sdk";
import { SimulatedWorkerAdapter } from "@clankie/worker-sim";

const execFileAsync = promisify(execFile);
export const scenarioSuiteRepoRoot = fileURLToPath(new URL("../../../..", import.meta.url));

export type ScenarioArmId = "single-worker" | "heterogeneous-lead";

export interface ScenarioIdentity {
  id: string;
  version: string;
  specPath: string;
  fixturePath: string;
  fixtureSha256: string;
  aggregateSha256: string;
  hiddenCheck: {
    path: string;
    sha256: string;
    protection: "outside-worker-workspace" | "write-protected";
    outsideWorkerWorkspace: boolean;
  };
  permittedActions: string[];
  forbiddenActions: string[];
  budget: { maxWorkerRuns: number; maxEvents: number; timeoutMs: number };
  rubric: Array<{ id: string; critical: boolean }>;
}

export interface ScenarioCheckResult {
  id: string;
  passed: boolean;
  evidence: string;
}

export interface HiddenCheckResult {
  schemaVersion: 1;
  scenarioId: string;
  armId: ScenarioArmId;
  passed: boolean;
  designedFailureTriggered: boolean;
  designedFailureDetected: boolean;
  checks: ScenarioCheckResult[];
  criticalFailures: string[];
}

export interface ScenarioExecution {
  raw: Record<string, unknown>;
  events: DomainEvent[];
  workerRunCount: number;
}

export function evidence(
  kind: "command" | "test_report" | "diff" | "review" | "artifact" | "log",
  label: string,
  summary: string,
) {
  return { kind, label, summary } as const;
}

export function token(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function scenarioEvent(
  type: string,
  missionId: string,
  profileHash: string,
  seed: string,
  occurredAt: string,
  data: Record<string, unknown>,
): DomainEvent {
  return {
    id: `${type}:${token(`${seed}:${type}`)}`,
    occurredAt,
    missionId,
    correlationId: `scenario:${token(seed)}`,
    profileHash,
    type,
    data,
  };
}

export async function scenarioDoctrine() {
  return compileDoctrine([
    await loadDoctrineFile(join(scenarioSuiteRepoRoot, "doctrine/profiles/self-build-lab.yaml")),
  ]);
}

export async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function listFiles(root: string, relativePath = ""): Promise<string[]> {
  const directory = join(root, relativePath);
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...(await listFiles(root, child)));
    else if (entry.isFile()) paths.push(child);
  }
  return paths;
}

export async function snapshotFiles(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();
  for (const path of await listFiles(root)) {
    snapshot.set(path, await sha256File(join(root, path)));
  }
  return snapshot;
}

export function changedFiles(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((path) => before.get(path) !== after.get(path))
    .sort();
}

export function resultText(results: readonly (WorkerResult | undefined)[]): string {
  return results
    .flatMap((result) =>
      result ? [result.summary, ...result.evidence.map((entry) => `${entry.label}:${entry.summary}`)] : [],
    )
    .join("\n");
}

export function completedTaskOrder(events: readonly DomainEvent[]): string[] {
  return events
    .filter((event) => event.type === "task.succeeded" && typeof event.taskId === "string")
    .map((event) => event.taskId as string);
}

export async function runHiddenCheck(
  identity: ScenarioIdentity,
  armId: ScenarioArmId,
  rawEvidence: Record<string, unknown>,
): Promise<HiddenCheckResult> {
  const privateRoot = await mkdtemp(join(tmpdir(), `clankie-hidden-check-${identity.id}-`));
  const inputPath = join(privateRoot, "input.json");
  try {
    await writeFile(inputPath, `${JSON.stringify({ ...rawEvidence, armId })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const result = await execFileAsync(
      process.execPath,
      [join(scenarioSuiteRepoRoot, identity.hiddenCheck.path), inputPath],
      {
        cwd: scenarioSuiteRepoRoot,
        timeout: identity.budget.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
    );
    const parsed = JSON.parse(result.stdout) as HiddenCheckResult;
    const expectedRubric = identity.rubric.map((entry) => entry.id).sort();
    const actualRubric = parsed.checks.map((entry) => entry.id).sort();
    if (
      parsed.schemaVersion !== 1 ||
      parsed.scenarioId !== identity.id ||
      parsed.armId !== armId ||
      JSON.stringify(expectedRubric) !== JSON.stringify(actualRubric)
    ) {
      throw new Error(`hidden_check_contract_invalid:${identity.id}:${armId}`);
    }
    return parsed;
  } finally {
    await rm(privateRoot, { recursive: true, force: true });
  }
}

export function oneTaskPlan(
  missionId: string,
  profileHash: string,
  objective: string,
  writeScope: string[],
): MissionPlan {
  return MissionPlanSchema.parse({
    missionId,
    goal: objective,
    rationale:
      "Arm A gives one simulated worker the whole scenario without lead decomposition or independent verification.",
    profileHash,
    successCriteria: [objective],
    tasks: [
      {
        id: "solo-implement",
        title: "Single-worker scenario attempt",
        objective,
        kind: "implementation",
        role: "implementer",
        preferredHarness: "codex",
        executionClass: "runner_visible",
        writeScope,
        successCriteria: ["The worker self-certifies the requested change."],
        evidenceRequirements: ["The worker-reported diff is attached."],
      },
    ],
  });
}

export async function runEngine(
  plan: MissionPlan,
  workspacePath: string,
  workers: SimulatedWorkerAdapter[],
): Promise<{ events: DomainEvent[]; results: Array<WorkerResult | undefined>; workerRunCount: number }> {
  const engine = new MissionEngine(plan, await scenarioDoctrine(), { workspacePath });
  await engine.runUntilIdle(new StaticWorkerRouter(workers));
  const snapshot = engine.getSnapshot();
  if (snapshot.tasks.every((task) => task.state === "succeeded")) {
    engine.completeMission("The simulated scenario arm completed its declared task graph.");
  } else {
    engine.failMission("The simulated scenario arm did not complete its declared task graph.");
  }
  const final = engine.getSnapshot();
  return {
    events: engine.getEvents(),
    results: final.tasks.map((task) => task.result),
    workerRunCount: final.tasks.filter((task) => task.workerId).length,
  };
}

export async function runVisibleFailureCheck(
  workspacePath: string,
): Promise<{ exitCode: number; output: string }> {
  try {
    const result = await execFileAsync(process.execPath, ["test/run.mjs"], {
      cwd: workspacePath,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    return { exitCode: 0, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const value = error as Error & { code?: number; stdout?: string; stderr?: string };
    return {
      exitCode: typeof value.code === "number" ? value.code : 1,
      output: `${value.stdout ?? ""}${value.stderr ?? value.message}`,
    };
  }
}
