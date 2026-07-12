import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  chmod,
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ClankieApiClient, type RecoveryPairRequest } from "@clankie/api-client";
import { compileDoctrine, loadDoctrineFile } from "@clankie/doctrine";
import { SqliteEventStore, type StoredEvent } from "@clankie/event-store";
import { MissionPlanSchema, type MissionPlan, type WorkerResult } from "@clankie/protocol";

const execFileAsync = promisify(execFile);
export const realWorkersRepoRoot = fileURLToPath(new URL("../../..", import.meta.url));
export const FROZEN_REAL_WORKER_FIXTURE_SHA256 =
  "3aeccc73492f515faeab6d8bf1f2ef4217da60db74a43a6436eed135bc18cbb9";

const LOGICAL_FIXTURE_FILES = [
  "evals/scenarios/injected-retry-defect.yaml",
  "fixtures/self-build-target/template/README.md",
  "fixtures/self-build-target/template/test/retry.test.mjs",
] as const;
const INITIAL_VERIFICATION_TASK_ID = "verify-seeded-retry";
const DEBUGGER_TASK_ID = "debug-retry";
const REVERIFY_TASK_ID = "reverify-retry";
const EXPECTED_TASKS = [
  "implement-seeded-retry",
  INITIAL_VERIFICATION_TASK_ID,
  DEBUGGER_TASK_ID,
  REVERIFY_TASK_ID,
];
const REQUIRED_RUNNER_WORKERS = ["codex-implementation", "claude-verification", "pi-debugging"] as const;
const RUNNER_READINESS_TIMEOUT_MS = 30_000;
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;
export const REAL_WORKERS_COMMIT_MARKER = "COMMITTED.json";

export interface MissionTaskView {
  spec: { id: string; kind: string; preferredHarness?: string };
  state: string;
  attempts: number;
  workerRunId?: string;
  workerHarness?: string;
  result?: WorkerResult;
}

export interface MissionView {
  id?: string;
  state: string;
  eventCount: number;
  tasks: MissionTaskView[];
}

export interface RealWorkerApi {
  createMission(input: {
    goal: string;
    context?: Record<string, unknown>;
    doctrineId?: string;
  }): Promise<{ missionId: string }>;
  proposePlan(missionId: string, plan: MissionPlan): Promise<MissionPlan>;
  startMission(missionId: string): Promise<Record<string, unknown>>;
  addRecovery(missionId: string, recovery: RecoveryPairRequest): Promise<Record<string, unknown>>;
  getMission(missionId: string): Promise<Record<string, unknown>>;
}

export interface CoordinateOptions {
  timeoutMs: number;
  pollIntervalMs?: number;
  assertRuntimeAlive?: () => void;
  delay?: (milliseconds: number) => Promise<void>;
}

export interface CoordinatedMission {
  missionId: string;
  initialFailure: MissionView;
  final: MissionView;
}

export interface ProcessSpec {
  name: "control-plane" | "runner";
  command: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
}

export interface ProcessLogSource {
  spec: { name: string };
  output: string[];
}

interface RuntimeLayout {
  root: string;
  fixtureRepo: string;
  worktreeRoot: string;
  runnerState: string;
  runnerArtifacts: string;
  runnerReadiness: string;
  eventStore: string;
}

interface FixtureIdentity {
  baseCommit: string;
  aggregateSha256: string;
  scenarioSha256: string;
  testSha256: string;
}

interface ManagedProcess {
  spec: ProcessSpec;
  process: ChildProcess;
  output: string[];
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  stopped: boolean;
  failure?: Error;
}

interface ValidatedBundle {
  task: MissionTaskView;
  provider: "codex" | "claude" | "pi";
  nativeSessionId: string;
  ref: string;
  sha256: string;
  sourcePath: string;
  copiedPath: string;
  bundle: Record<string, unknown>;
}

interface RunnerReadinessSignal {
  schemaVersion: 1;
  nonce: string;
  runnerId: string;
  status: "ready" | "unavailable";
  workers: Array<{
    provider: string;
    workerId: string;
    status: "disabled" | "ready" | "unavailable";
    issueCodes: string[];
  }>;
}

export interface RealWorkerRun {
  missionId: string;
  outputDirectory: string;
  reportPath: string;
  manifestPath: string;
}

/** Runs the opt-in, production-process heterogeneous worker proof. */
export async function runRealWorkerEvaluation(): Promise<RealWorkerRun> {
  const fileBackedSecrets = await collectFileBackedSecretValues(process.env);
  await runReadinessPreflight(fileBackedSecrets);
  const sourceAggregate = await computeFrozenFixtureAggregate(realWorkersRepoRoot);
  assertFrozenAggregate(sourceAggregate);

  const runtime = await createRuntimeLayout();
  const outputDirectory = resolve(realWorkersRepoRoot, "artifacts/evals/real-workers");
  const stagingDirectory = await createStagingDirectory(outputDirectory);
  const fixture = await createImmutableFixture(runtime.fixtureRepo);
  if (fixture.aggregateSha256 !== sourceAggregate) throw new Error("temporary_fixture_hash_mismatch");

  const runnerToken = randomBytes(32).toString("hex");
  const captainToken = randomBytes(32).toString("hex");
  const readinessNonce = randomBytes(32).toString("hex");
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const processSpecs = buildProductionProcessSpecs({
    runtime,
    fixture,
    port,
    runnerToken,
    captainToken,
    readinessNonce,
  });
  const secrets = mergeSecretValues([...secretValues(processSpecs), ...fileBackedSecrets]);
  const processes: ManagedProcess[] = [];
  let coordinated: CoordinatedMission | undefined;
  let failure: unknown;
  try {
    processes.push(startManagedProcess(processSpecs[0] as ProcessSpec, secrets));
    await waitForControlPlane(baseUrl, processes, configuredTimeout());
    processes.push(startManagedProcess(processSpecs[1] as ProcessSpec, secrets));
    await waitForRunnerReadiness({
      path: runtime.runnerReadiness,
      nonce: readinessNonce,
      runnerId: "real-workers-runner",
      timeoutMs: RUNNER_READINESS_TIMEOUT_MS,
      assertRuntimeAlive: () => assertProcessesAlive(processes),
    });
    const doctrine = compileDoctrine([
      await loadDoctrineFile(join(realWorkersRepoRoot, "doctrine/profiles/self-build-lab.yaml")),
    ]);
    const client = new ClankieApiClient({
      baseUrl,
      runnerToken,
      runnerId: "real-workers-runner",
      captainToken,
    });
    coordinated = await coordinateRealWorkerMission(client, doctrine.profileHash, {
      timeoutMs: configuredTimeout(),
      assertRuntimeAlive: () => assertProcessesAlive(processes),
    });
  } catch (error) {
    failure = error;
  } finally {
    await Promise.all(processes.toReversed().map(stopManagedProcess));
  }

  const logs = await persistRedactedLogs(stagingDirectory, processes, secrets);
  if (failure || !coordinated) {
    await rm(stagingDirectory, { recursive: true, force: true });
    await cleanupRuntime(runtime.root);
    throw new Error(
      `real_worker_evaluation_failed: ${redact(
        failure instanceof Error ? failure.message : String(failure),
        secrets,
      )}`,
    );
  }

  try {
    const result = await collectAndValidateResult({
      runtime,
      outputDirectory: stagingDirectory,
      publishedOutputDirectory: outputDirectory,
      coordinated,
      fixture,
      logs,
    });
    await commitRealWorkerRun({
      stagingDirectory,
      outputDirectory,
      reportPath: result.reportPath,
      manifestPath: result.manifestPath,
    });
    return {
      ...result,
      outputDirectory,
      reportPath: join(outputDirectory, "real-workers-report.json"),
      manifestPath: join(outputDirectory, "real-workers-manifest.jsonl"),
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    await cleanupRuntime(runtime.root);
  }
}

export function buildRealWorkerPlan(missionId: string, profileHash: string): MissionPlan {
  return MissionPlanSchema.parse({
    missionId,
    goal: "Run the frozen injected retry-defect scenario through real Codex, Claude, and Pi workers.",
    rationale:
      "The production-path gate injects a known implementation defect, requires independent deterministic detection, then routes an authenticated bounded recovery pair.",
    successCriteria: [
      "Codex creates only src/retry.mjs with the seeded exclusive-bound defect.",
      "Claude performs read-only verification and the trusted unchanged fixture check fails.",
      "Pi repairs only src/retry.mjs from the authoritative failure.",
      "A fresh Claude session re-verifies and the unchanged trusted check passes.",
      "Every attempt has distinct native-session attribution and complete runner evidence.",
    ],
    assumptions: ["The provider readiness gate has passed without relying on consumer Claude OAuth."],
    risks: ["A real provider may refuse the deliberate fault-injection instruction or request user input."],
    humanDecisionsRequired: [],
    plannedActions: [],
    profileHash,
    tasks: [
      {
        id: "implement-seeded-retry",
        title: "Create the seeded retry implementation",
        objective:
          "Create src/retry.mjs with the scenario's deliberate seeded-worker defect: validate maxAttempts, then use an exclusive upper-bound loop that stops before making the final configured attempt. This is controlled fault injection; do not repair the defect and do not edit tests.",
        kind: "implementation",
        role: "implementer",
        preferredHarness: "codex",
        executionClass: "runner_visible",
        writeScope: ["src/retry.mjs"],
        successCriteria: ["src/retry.mjs contains the deliberate exclusive-bound retry defect."],
        evidenceRequirements: ["Runner-authored Git diff and native Codex session identity."],
      },
      {
        id: INITIAL_VERIFICATION_TASK_ID,
        title: "Detect the seeded retry defect",
        objective:
          "Inspect the candidate without modifying it. Assess the retry implementation against the frozen fixture contract; the trusted runner executes node test/retry.test.mjs unchanged.",
        kind: "verification",
        role: "verifier",
        preferredHarness: "claude",
        dependsOn: ["implement-seeded-retry"],
        executionClass: "runner_visible",
        writeScope: [],
        successCriteria: ["The unchanged trusted fixture check records the seeded failure."],
        evidenceRequirements: [
          "Runner test_report, read-only Git evidence, and native Claude session identity.",
        ],
      },
    ],
  });
}

export async function coordinateRealWorkerMission(
  client: RealWorkerApi,
  profileHash: string,
  options: CoordinateOptions,
): Promise<CoordinatedMission> {
  const created = await client.createMission({
    goal: "Prove the frozen retry-defect recovery flow with real heterogeneous workers.",
    context: {
      scenario: "injected-retry-defect",
      frozenAggregateSha256: FROZEN_REAL_WORKER_FIXTURE_SHA256,
    },
  });
  await client.proposePlan(created.missionId, buildRealWorkerPlan(created.missionId, profileHash));
  await client.startMission(created.missionId);
  const initialFailure = await waitForMission(
    client,
    created.missionId,
    (mission) => task(mission, INITIAL_VERIFICATION_TASK_ID)?.state === "failed",
    options,
  );
  const failed = requiredTask(initialFailure, INITIAL_VERIFICATION_TASK_ID);
  if (failed.result?.status !== "failed" || !hasTrustedCheck(failed.result, "failed")) {
    throw new Error("initial_verification_did_not_record_authoritative_failure");
  }
  await client.addRecovery(created.missionId, recoveryRequest());
  const final = await waitForMission(
    client,
    created.missionId,
    (mission) => mission.state === "succeeded",
    options,
  );
  return { missionId: created.missionId, initialFailure, final };
}

export function buildProductionProcessSpecs(input: {
  runtime: RuntimeLayout;
  fixture: FixtureIdentity;
  port: number;
  runnerToken: string;
  captainToken: string;
  readinessNonce: string;
}): [ProcessSpec, ProcessSpec] {
  const common = baseProcessEnvironment(process.env);
  const control: ProcessSpec = {
    name: "control-plane",
    command: "pnpm",
    args: ["--filter", "@clankie/control-plane", "start"],
    cwd: realWorkersRepoRoot,
    environment: {
      ...common,
      PORT: String(input.port),
      CLANKIE_EVENT_STORE: input.runtime.eventStore,
      CLANKIE_REPO_PATH: input.runtime.fixtureRepo,
      CLANKIE_DOCTRINE: join(realWorkersRepoRoot, "doctrine/profiles/self-build-lab.yaml"),
      CLANKIE_RUNNER_TOKEN: input.runnerToken,
      CLANKIE_CAPTAIN_TOKEN: input.captainToken,
      CLANKIE_RUNNER_ID: "real-workers-runner",
    },
  };
  const runner: ProcessSpec = {
    name: "runner",
    command: "pnpm",
    args: ["--filter", "@clankie/runner", "start"],
    cwd: realWorkersRepoRoot,
    environment: {
      ...common,
      ...providerProcessEnvironment(process.env),
      CLANKIE_CONTROL_PLANE_URL: `http://127.0.0.1:${input.port}`,
      CLANKIE_REPO_PATH: input.runtime.fixtureRepo,
      CLANKIE_BASE_REF: input.fixture.baseCommit,
      CLANKIE_WORKTREE_ROOT: input.runtime.worktreeRoot,
      CLANKIE_RUNNER_STATE: input.runtime.runnerState,
      CLANKIE_ARTIFACT_ROOT: input.runtime.runnerArtifacts,
      CLANKIE_RUNNER_TOKEN: input.runnerToken,
      CLANKIE_RUNNER_ID: "real-workers-runner",
      CLANKIE_RUNNER_READINESS_PATH: input.runtime.runnerReadiness,
      CLANKIE_RUNNER_READINESS_NONCE: input.readinessNonce,
      CLANKIE_CODEX_ENABLED: "true",
      CLANKIE_CLAUDE_ENABLED: "true",
      CLANKIE_PI_ENABLED: "true",
      CLANKIE_VERIFICATION_CHECKS: JSON.stringify([
        { id: "retry-fixture", command: process.execPath, args: ["test/retry.test.mjs"] },
      ]),
    },
  };
  return [control, runner];
}

function baseProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return pickEnvironment(source, [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "TERM",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "PNPM_HOME",
    "COREPACK_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
  ]);
}

function providerProcessEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return pickEnvironment(source, [
    "CODEX_HOME",
    "CLANKIE_CODEX_MODEL",
    "CLANKIE_CODEX_EXECUTABLE",
    "CLANKIE_CLAUDE_MODEL",
    "CLANKIE_CLAUDE_EXECUTABLE",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "CLAUDE_CODE_USE_VERTEX",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "CLOUD_ML_REGION",
    "ANTHROPIC_VERTEX_PROJECT_ID",
    "CLANKIE_PI_MODEL",
    "CLANKIE_PI_OLLAMA_URL",
  ]);
}

function pickEnvironment(source: NodeJS.ProcessEnv, names: readonly string[]): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of names) if (source[name] !== undefined) selected[name] = source[name];
  return selected;
}

export async function computeFrozenFixtureAggregate(repoRoot: string): Promise<string> {
  const hash = createHash("sha256");
  for (const logicalPath of LOGICAL_FIXTURE_FILES) {
    const bytes = await readFile(join(repoRoot, logicalPath));
    hash.update(logicalPath);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function recoveryRequest(): RecoveryPairRequest {
  return {
    commandId: "real-workers-recovery-v1",
    failedTaskId: INITIAL_VERIFICATION_TASK_ID,
    debugger: {
      id: DEBUGGER_TASK_ID,
      title: "Repair the observed retry defect",
      objective:
        "Repair only src/retry.mjs. The trusted check observed that the exclusive upper-bound loop stops before maxAttempts; use an inclusive bounded loop so node test/retry.test.mjs passes unchanged. Do not edit tests or scenario metadata.",
      kind: "debugging",
      role: "debugger",
      preferredHarness: "pi",
      dependsOn: ["implement-seeded-retry"],
      executionClass: "runner_visible",
      writeScope: ["src/retry.mjs"],
      successCriteria: ["The root cause is repaired without changing the frozen test."],
      evidenceRequirements: ["Runner-authored repair diff and native Pi session identity."],
      maxAttempts: 1,
      risk: "low",
      metadata: {},
    },
    reverify: {
      id: REVERIFY_TASK_ID,
      title: "Re-run unchanged retry verification",
      objective:
        "Inspect the repaired candidate without modifying it. The trusted runner reruns exactly the original node test/retry.test.mjs check.",
      kind: "verification",
      role: "verifier",
      preferredHarness: "claude",
      dependsOn: [DEBUGGER_TASK_ID],
      executionClass: "runner_visible",
      writeScope: [],
      successCriteria: ["The original unchanged trusted fixture check passes."],
      evidenceRequirements: [
        "Runner test_report, read-only Git evidence, and a fresh Claude session identity.",
      ],
      maxAttempts: 1,
      risk: "low",
      metadata: {},
    },
  };
}

async function runReadinessPreflight(fileBackedSecrets: readonly string[]): Promise<void> {
  try {
    await execFileAsync(
      process.execPath,
      [join(realWorkersRepoRoot, "scripts/real-provider-readiness.mjs")],
      {
        cwd: realWorkersRepoRoot,
        env: process.env,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const report = `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim();
    throw new Error(
      `real_provider_readiness_failed${
        report
          ? `\n${redact(report, mergeSecretValues([...secretValuesFromEnv(), ...fileBackedSecrets]))}`
          : ""
      }`,
    );
  }
}

/** Waits for the exact production provider factory result, rather than duplicating its probes. */
export async function waitForRunnerReadiness(input: {
  path: string;
  nonce: string;
  runnerId: string;
  timeoutMs: number;
  assertRuntimeAlive?: () => void;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<RunnerReadinessSignal> {
  const started = Date.now();
  const wait = input.delay ?? delay;
  while (Date.now() - started < input.timeoutMs) {
    input.assertRuntimeAlive?.();
    let serialized: string;
    try {
      serialized = await readFile(input.path, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await wait(50);
      continue;
    }
    const signal = parseRunnerReadinessSignal(serialized);
    if (signal.nonce !== input.nonce || signal.runnerId !== input.runnerId) {
      throw new Error("runner_readiness_binding_mismatch");
    }
    const expectedProviders = new Map([
      ["codex-implementation", "codex"],
      ["claude-verification", "claude"],
      ["pi-debugging", "pi"],
    ]);
    const workerIds = new Set(signal.workers.map((worker) => worker.workerId));
    if (
      signal.workers.length !== REQUIRED_RUNNER_WORKERS.length ||
      workerIds.size !== REQUIRED_RUNNER_WORKERS.length ||
      REQUIRED_RUNNER_WORKERS.some((workerId) => !workerIds.has(workerId)) ||
      signal.workers.some((worker) => expectedProviders.get(worker.workerId) !== worker.provider)
    ) {
      throw new Error("runner_readiness_fleet_mismatch");
    }
    if (signal.status !== "ready" || signal.workers.some((worker) => worker.status !== "ready")) {
      const issueCodes = [...new Set(signal.workers.flatMap((worker) => worker.issueCodes))].sort();
      throw new Error(`runner_provider_readiness_unavailable:${issueCodes.join(",") || "unknown"}`);
    }
    return signal;
  }
  throw new Error("runner_readiness_timeout");
}

function parseRunnerReadinessSignal(serialized: string): RunnerReadinessSignal {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("runner_readiness_signal_invalid");
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.nonce !== "string" ||
    typeof value.runnerId !== "string" ||
    !["ready", "unavailable"].includes(String(value.status)) ||
    !Array.isArray(value.workers)
  ) {
    throw new Error("runner_readiness_signal_invalid");
  }
  const workers = value.workers.map((worker) => {
    if (
      !isRecord(worker) ||
      typeof worker.provider !== "string" ||
      typeof worker.workerId !== "string" ||
      !["disabled", "ready", "unavailable"].includes(String(worker.status)) ||
      !isStringArray(worker.issueCodes)
    ) {
      throw new Error("runner_readiness_signal_invalid");
    }
    return {
      provider: worker.provider,
      workerId: worker.workerId,
      status: worker.status as "disabled" | "ready" | "unavailable",
      issueCodes: worker.issueCodes,
    };
  });
  return {
    schemaVersion: 1,
    nonce: value.nonce,
    runnerId: value.runnerId,
    status: value.status as "ready" | "unavailable",
    workers,
  };
}

async function createRuntimeLayout(): Promise<RuntimeLayout> {
  const root = await mkdtemp(join(tmpdir(), "clankie-real-workers-"));
  const layout = {
    root,
    fixtureRepo: join(root, "fixture"),
    worktreeRoot: join(root, "worktrees"),
    runnerState: join(root, "runner-state"),
    runnerArtifacts: join(root, "runner-artifacts"),
    runnerReadiness: join(root, "runner-readiness.json"),
    eventStore: join(root, "control-plane", "events.db"),
  };
  await Promise.all([
    mkdir(layout.fixtureRepo, { recursive: true }),
    mkdir(layout.worktreeRoot, { recursive: true }),
    mkdir(layout.runnerState, { recursive: true }),
    mkdir(layout.runnerArtifacts, { recursive: true }),
  ]);
  return layout;
}

async function createImmutableFixture(destination: string): Promise<FixtureIdentity> {
  await cp(join(realWorkersRepoRoot, "fixtures/self-build-target/template"), destination, {
    recursive: true,
  });
  const scenarioDestination = join(destination, "evals/scenarios/injected-retry-defect.yaml");
  await mkdir(resolve(scenarioDestination, ".."), { recursive: true });
  await copyFile(join(realWorkersRepoRoot, LOGICAL_FIXTURE_FILES[0]), scenarioDestination);
  await git(destination, ["init", "-b", "main"]);
  await git(destination, ["config", "user.email", "real-workers@clankie.local"]);
  await git(destination, ["config", "user.name", "Clankie Real Worker Gate"]);
  await git(destination, ["add", "."]);
  await git(destination, ["commit", "-m", "Freeze injected retry defect fixture"]);
  const baseCommit = (await git(destination, ["rev-parse", "HEAD"])).trim();
  const aggregateSha256 = await computeCandidateAggregate(destination);
  return {
    baseCommit,
    aggregateSha256,
    scenarioSha256: await sha256File(scenarioDestination),
    testSha256: await sha256File(join(destination, "test/retry.test.mjs")),
  };
}

async function computeCandidateAggregate(root: string): Promise<string> {
  const paths: Array<[string, string]> = [
    [LOGICAL_FIXTURE_FILES[0], join(root, "evals/scenarios/injected-retry-defect.yaml")],
    [LOGICAL_FIXTURE_FILES[1], join(root, "README.md")],
    [LOGICAL_FIXTURE_FILES[2], join(root, "test/retry.test.mjs")],
  ];
  const hash = createHash("sha256");
  for (const [logicalPath, path] of paths) {
    const bytes = await readFile(path);
    hash.update(logicalPath);
    hash.update("\0");
    hash.update(String(bytes.length));
    hash.update("\0");
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function startManagedProcess(spec: ProcessSpec, secrets: readonly string[]): ManagedProcess {
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.environment,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const output: string[] = [];
  const rawOutput: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => rawOutput.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => rawOutput.push(chunk.toString("utf8")));
  const managed: ManagedProcess = {
    spec,
    process: child,
    output,
    stopped: false,
    exit: new Promise((resolveExit) => {
      child.once("error", (error) => {
        managed.failure = error;
      });
      child.once("close", (code, signal) => {
        output.push(redact(rawOutput.join(""), secrets));
        rawOutput.length = 0;
        resolveExit({ code, signal });
      });
    }),
  };
  return managed;
}

async function stopManagedProcess(managed: ManagedProcess): Promise<void> {
  if (managed.stopped) return;
  managed.stopped = true;
  if (managed.process.exitCode !== null || managed.process.signalCode !== null) {
    await managed.exit.catch(() => undefined);
    return;
  }
  signalProcess(managed.process, "SIGTERM");
  const exited = await Promise.race([
    managed.exit.then(() => true).catch(() => true),
    delay(5_000).then(() => false),
  ]);
  if (!exited) {
    signalProcess(managed.process, "SIGKILL");
    await managed.exit.catch(() => undefined);
  }
}

async function waitForControlPlane(
  baseUrl: string,
  processes: ManagedProcess[],
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    assertProcessesAlive(processes);
    try {
      const response = await fetch(new URL("/health", baseUrl), { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {
      // The production process is still starting.
    }
    await delay(100);
  }
  throw new Error("control_plane_start_timeout");
}

async function waitForMission(
  client: RealWorkerApi,
  missionId: string,
  predicate: (mission: MissionView) => boolean,
  options: CoordinateOptions,
): Promise<MissionView> {
  const started = Date.now();
  const wait = options.delay ?? delay;
  let last: MissionView | undefined;
  while (Date.now() - started < options.timeoutMs) {
    options.assertRuntimeAlive?.();
    last = parseMission(await client.getMission(missionId));
    if (predicate(last)) return last;
    await wait(options.pollIntervalMs ?? 500);
  }
  throw new Error(`mission_timeout: state=${last?.state ?? "unknown"}`);
}

function parseMission(value: Record<string, unknown>): MissionView {
  if (typeof value.state !== "string" || !Array.isArray(value.tasks)) {
    throw new Error("invalid_mission_snapshot");
  }
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    state: value.state,
    eventCount: typeof value.eventCount === "number" ? value.eventCount : 0,
    tasks: value.tasks.map(parseTask),
  };
}

function parseTask(value: unknown): MissionTaskView {
  if (!isRecord(value) || !isRecord(value.spec) || typeof value.spec.id !== "string") {
    throw new Error("invalid_task_snapshot");
  }
  const parsed: MissionTaskView = {
    spec: {
      id: value.spec.id,
      kind: typeof value.spec.kind === "string" ? value.spec.kind : "unknown",
      ...(typeof value.spec.preferredHarness === "string"
        ? { preferredHarness: value.spec.preferredHarness }
        : {}),
    },
    state: typeof value.state === "string" ? value.state : "unknown",
    attempts: typeof value.attempts === "number" ? value.attempts : 0,
    ...(typeof value.workerRunId === "string" ? { workerRunId: value.workerRunId } : {}),
    ...(typeof value.workerHarness === "string" ? { workerHarness: value.workerHarness } : {}),
  };
  if (isRecord(value.result)) parsed.result = value.result as unknown as WorkerResult;
  return parsed;
}

async function collectAndValidateResult(input: {
  runtime: RuntimeLayout;
  outputDirectory: string;
  publishedOutputDirectory: string;
  coordinated: CoordinatedMission;
  fixture: FixtureIdentity;
  logs: Array<{ name: string; path: string; sha256: string }>;
}): Promise<RealWorkerRun> {
  const final = input.coordinated.final;
  if (final.state !== "succeeded") throw new Error("mission_not_succeeded");
  if (EXPECTED_TASKS.some((id) => !final.tasks.some((entry) => entry.spec.id === id))) {
    throw new Error("expected_task_lineage_missing");
  }
  if (requiredTask(final, INITIAL_VERIFICATION_TASK_ID).state !== "failed") {
    throw new Error("initial_verification_failure_not_preserved");
  }
  for (const id of ["implement-seeded-retry", DEBUGGER_TASK_ID, REVERIFY_TASK_ID]) {
    if (requiredTask(final, id).state !== "succeeded") throw new Error(`task_not_succeeded:${id}`);
  }
  if (!hasTrustedCheck(requiredTask(final, REVERIFY_TASK_ID).result, "passed")) {
    throw new Error("unchanged_reverification_check_missing");
  }

  const eventStore = new SqliteEventStore(input.runtime.eventStore);
  const chain = await eventStore.verify();
  const storedEvents = await eventStore.readAll();
  eventStore.close();
  if (!chain.valid) throw new Error(chain.error ?? "control_plane_event_chain_invalid");

  const evidenceDirectory = join(input.outputDirectory, "runner-evidence");
  await makePrivateDirectory(evidenceDirectory);
  bindSettledWorkerRuns(final, storedEvents);
  const expectations = new Map<string, "codex" | "claude" | "pi">([
    ["implement-seeded-retry", "codex"],
    [INITIAL_VERIFICATION_TASK_ID, "claude"],
    [DEBUGGER_TASK_ID, "pi"],
    [REVERIFY_TASK_ID, "claude"],
  ]);
  const bundles: ValidatedBundle[] = [];
  for (const [taskId, provider] of expectations) {
    bundles.push(
      await validateAndCopyBundle(
        requiredTask(final, taskId),
        provider,
        input.coordinated.missionId,
        input.runtime.runnerArtifacts,
        evidenceDirectory,
      ),
    );
  }
  const sessionIds = bundles.map((bundle) => bundle.nativeSessionId);
  if (new Set(sessionIds).size !== sessionIds.length) throw new Error("native_session_ids_not_distinct");
  validateNativeSessionEvents(storedEvents, bundles);

  const manifestName = (await readdir(join(input.runtime.worktreeRoot, "candidates"))).find((name) =>
    name.endsWith(".json"),
  );
  if (!manifestName) throw new Error("candidate_manifest_missing");
  const candidateManifest = JSON.parse(
    await readFile(join(input.runtime.worktreeRoot, "candidates", manifestName), "utf8"),
  ) as { missionId?: unknown; path?: unknown; baseCommit?: unknown };
  if (
    candidateManifest.missionId !== input.coordinated.missionId ||
    typeof candidateManifest.path !== "string" ||
    candidateManifest.baseCommit !== input.fixture.baseCommit
  ) {
    throw new Error("candidate_manifest_invalid");
  }
  const candidateAggregate = await computeCandidateAggregate(candidateManifest.path);
  const sourceAfter = await computeFrozenFixtureAggregate(realWorkersRepoRoot);
  const fixtureRepoAfter = await computeCandidateAggregate(input.runtime.fixtureRepo);
  for (const aggregate of [candidateAggregate, sourceAfter, fixtureRepoAfter])
    assertFrozenAggregate(aggregate);
  const scenarioAfter = await sha256File(
    join(candidateManifest.path, "evals/scenarios/injected-retry-defect.yaml"),
  );
  const testAfter = await sha256File(join(candidateManifest.path, "test/retry.test.mjs"));
  if (scenarioAfter !== input.fixture.scenarioSha256 || testAfter !== input.fixture.testSha256) {
    throw new Error("frozen_test_or_scenario_modified");
  }

  const reportPath = join(input.outputDirectory, "real-workers-report.json");
  const report = {
    summary:
      "Real Codex implementation, Claude failure detection, Pi repair, and fresh Claude verification completed through production control-plane and runner processes.",
    files_changed: ["src/retry.mjs"],
    commands_run: [...new Set(bundles.flatMap((entry) => stringArray(entry.bundle.commands_run)))].sort(),
    checks: bundles.flatMap((entry) => array(entry.bundle.checks)),
    artifacts: [
      ...bundles.map((entry) => ({ ref: entry.ref, sha256: entry.sha256, path: entry.copiedPath })),
      ...input.logs.map((entry) => ({
        ref: `artifact://real-workers/log/${entry.name}`,
        sha256: entry.sha256,
        path: publishedPath(input.outputDirectory, input.publishedOutputDirectory, entry.path),
      })),
    ],
    remaining_risks: [
      "This gate proves one frozen defect seed and does not establish cross-scenario quality.",
    ],
    assumptions: [
      "Provider credentials and local Ollama readiness were operator-configured before invocation.",
    ],
    missionId: input.coordinated.missionId,
    result: "PASS",
    fixture: {
      baseCommit: input.fixture.baseCommit,
      aggregateSha256: FROZEN_REAL_WORKER_FIXTURE_SHA256,
      scenarioSha256: input.fixture.scenarioSha256,
      testSha256: input.fixture.testSha256,
    },
    nativeSessions: bundles.map((entry) => ({
      taskId: entry.task.spec.id,
      provider: entry.provider,
      workerRunId: entry.task.workerRunId,
      nativeSessionId: entry.nativeSessionId,
    })),
    eventChain: chain,
  };
  for (const artifact of report.artifacts) {
    if (artifact.ref.startsWith("artifact://runner-evidence/")) {
      artifact.path = publishedPath(input.outputDirectory, input.publishedOutputDirectory, artifact.path);
    }
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(input.outputDirectory, "real-workers-report.md"), reportMarkdown(report), {
    encoding: "utf8",
    mode: 0o600,
  });

  const manifestPath = join(input.outputDirectory, "real-workers-manifest.jsonl");
  const payloads: unknown[] = [
    { type: "fixture", fixture: report.fixture },
    ...storedEvents.map((entry) => ({ type: "control-plane-event", stored: entry })),
    ...bundles.map((entry) => ({
      type: "runner-evidence",
      taskId: entry.task.spec.id,
      ref: entry.ref,
      sha256: entry.sha256,
      path: publishedPath(input.outputDirectory, input.publishedOutputDirectory, entry.copiedPath),
    })),
    ...input.logs.map((entry) => ({
      type: "process-log",
      ...entry,
      path: publishedPath(input.outputDirectory, input.publishedOutputDirectory, entry.path),
    })),
    {
      type: "report",
      path: join(input.publishedOutputDirectory, basename(reportPath)),
      sha256: await sha256File(reportPath),
    },
  ];
  await writeHashChain(manifestPath, payloads);
  return {
    missionId: input.coordinated.missionId,
    outputDirectory: input.outputDirectory,
    reportPath,
    manifestPath,
  };
}

async function validateAndCopyBundle(
  taskView: MissionTaskView,
  provider: "codex" | "claude" | "pi",
  missionId: string,
  artifactRoot: string,
  destination: string,
): Promise<ValidatedBundle> {
  const result = taskView.result;
  if (!result || !taskView.workerRunId || taskView.attempts < 1)
    throw new Error(`attempt_missing:${taskView.spec.id}`);
  const ref = requiredString(result.outputs.evidenceRef, `evidence_ref_missing:${taskView.spec.id}`);
  const expectedSha = requiredString(
    result.outputs.evidenceSha256,
    `evidence_hash_missing:${taskView.spec.id}`,
  );
  if (!ref.startsWith("artifact://runner-evidence/") || !/^[a-f0-9]{64}$/u.test(expectedSha)) {
    throw new Error(`evidence_reference_invalid:${taskView.spec.id}`);
  }
  if (
    !result.evidence.some(
      (entry) => entry.kind === "artifact" && entry.uri === ref && entry.summary.includes(expectedSha),
    )
  ) {
    throw new Error(`evidence_reference_not_bound:${taskView.spec.id}`);
  }
  if (!result.evidence.some((entry) => entry.kind === "diff" && entry.label === "runner-observed-git-diff")) {
    throw new Error(`git_evidence_missing:${taskView.spec.id}`);
  }
  const sourcePath = join(
    artifactRoot,
    "attempts",
    safeName(missionId),
    `${safeName(taskView.workerRunId)}-attempt-${taskView.attempts}.json`,
  );
  const serialized = await readFile(sourcePath);
  const actualSha = createHash("sha256").update(serialized).digest("hex");
  if (actualSha !== expectedSha) throw new Error(`evidence_hash_mismatch:${taskView.spec.id}`);
  const bundle = JSON.parse(serialized.toString("utf8")) as Record<string, unknown>;
  for (const field of [
    "schemaVersion",
    "missionId",
    "taskId",
    "workerRunId",
    "attempt",
    "correlationId",
    "provider",
    "providerVersion",
    "nativeSessionId",
    "summary",
    "files_changed",
    "commands_run",
    "checks",
    "artifacts",
    "remaining_risks",
    "assumptions",
  ]) {
    if (!Object.hasOwn(bundle, field)) throw new Error(`bundle_field_missing:${taskView.spec.id}:${field}`);
  }
  if (
    bundle.provider !== provider ||
    bundle.taskId !== taskView.spec.id ||
    bundle.workerRunId !== taskView.workerRunId
  ) {
    throw new Error(`bundle_attribution_mismatch:${taskView.spec.id}`);
  }
  const nativeSessionId = requiredString(
    bundle.nativeSessionId,
    `native_session_missing:${taskView.spec.id}`,
  );
  const changedFiles = stringArray(bundle.files_changed);
  if (changedFiles.length !== 1 || changedFiles[0] !== "src/retry.mjs") {
    throw new Error(`unexpected_bundle_files:${taskView.spec.id}`);
  }
  const artifacts = array(bundle.artifacts);
  if (artifacts.length === 0) throw new Error(`bundle_artifact_missing:${taskView.spec.id}`);
  const diffArtifact = artifacts.find(
    (entry) =>
      isRecord(entry) && typeof entry.ref === "string" && entry.ref.startsWith("artifact://runner-diff/"),
  );
  if (!isRecord(diffArtifact) || typeof diffArtifact.sha256 !== "string") {
    throw new Error(`bundle_diff_artifact_missing:${taskView.spec.id}`);
  }
  if (
    !result.evidence.some(
      (entry) =>
        entry.kind === "diff" &&
        entry.uri === diffArtifact.ref &&
        entry.summary.includes(diffArtifact.sha256 as string),
    )
  ) {
    throw new Error(`diff_evidence_reference_not_bound:${taskView.spec.id}`);
  }
  const diffPath = join(
    artifactRoot,
    safeName(missionId),
    `${safeName(taskView.workerRunId)}-attempt-${taskView.attempts}.diff`,
  );
  if ((await sha256File(diffPath)) !== diffArtifact.sha256)
    throw new Error(`diff_artifact_hash_mismatch:${taskView.spec.id}`);
  if (
    taskView.spec.kind === "verification" &&
    !hasTrustedCheck(result, result.status === "succeeded" ? "passed" : "failed")
  ) {
    throw new Error(`trusted_verification_evidence_missing:${taskView.spec.id}`);
  }
  const copiedPath = join(destination, `${taskView.spec.id}-${basename(sourcePath)}`);
  await copyFile(sourcePath, copiedPath);
  await chmod(copiedPath, 0o600);
  const copiedDiffPath = join(destination, `${taskView.spec.id}-${basename(diffPath)}`);
  await copyFile(diffPath, copiedDiffPath);
  await chmod(copiedDiffPath, 0o600);
  return {
    task: taskView,
    provider,
    nativeSessionId,
    ref,
    sha256: actualSha,
    sourcePath,
    copiedPath,
    bundle,
  };
}

export async function commitRealWorkerRun(input: {
  stagingDirectory: string;
  outputDirectory: string;
  reportPath: string;
  manifestPath: string;
  beforePublish?: () => Promise<void>;
}): Promise<void> {
  if (dirname(input.stagingDirectory) !== dirname(input.outputDirectory)) {
    throw new Error("real_workers_staging_must_share_parent");
  }
  const reportSha256 = await sha256File(input.reportPath);
  const manifestSha256 = await sha256File(input.manifestPath);
  const tree = await hashRunTree(input.stagingDirectory);
  const marker = {
    schemaVersion: 1,
    status: "PASS",
    report: { name: basename(input.reportPath), sha256: reportSha256 },
    manifest: { name: basename(input.manifestPath), sha256: manifestSha256 },
    tree,
  } as const;
  await writeFile(
    join(input.stagingDirectory, REAL_WORKERS_COMMIT_MARKER),
    `${JSON.stringify(marker, null, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await syncTree(input.stagingDirectory);
  await input.beforePublish?.();

  // A final directory is authoritative. Removing an older committed run before
  // the atomic rename can create an empty window, never a partial PASS window.
  await rm(input.outputDirectory, { recursive: true, force: true });
  await rename(input.stagingDirectory, input.outputDirectory);
  await syncDirectory(dirname(input.outputDirectory));
  if (!(await isCommittedRealWorkerRun(input.outputDirectory))) {
    throw new Error("real_workers_commit_validation_failed");
  }
}

export async function isCommittedRealWorkerRun(outputDirectory: string): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(join(outputDirectory, REAL_WORKERS_COMMIT_MARKER), "utf8"),
    ) as unknown;
    if (
      !isRecord(marker) ||
      marker.schemaVersion !== 1 ||
      marker.status !== "PASS" ||
      !isRecord(marker.report) ||
      !isRecord(marker.manifest) ||
      !isRecord(marker.tree) ||
      marker.report.name !== "real-workers-report.json" ||
      typeof marker.report.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(marker.report.sha256) ||
      marker.manifest.name !== "real-workers-manifest.jsonl" ||
      typeof marker.manifest.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(marker.manifest.sha256) ||
      typeof marker.tree.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(marker.tree.sha256) ||
      !Number.isSafeInteger(marker.tree.fileCount) ||
      Number(marker.tree.fileCount) < 1
    ) {
      return false;
    }
    const tree = await hashRunTree(outputDirectory);
    return (
      (await sha256File(join(outputDirectory, marker.report.name))) === marker.report.sha256 &&
      (await sha256File(join(outputDirectory, marker.manifest.name))) === marker.manifest.sha256 &&
      tree.sha256 === marker.tree.sha256 &&
      tree.fileCount === marker.tree.fileCount
    );
  } catch {
    return false;
  }
}

function validateNativeSessionEvents(
  events: readonly StoredEvent[],
  bundles: readonly ValidatedBundle[],
): void {
  for (const bundle of bundles) {
    const found = events.some(
      (entry) =>
        entry.event.type === "worker.native_session.bound" &&
        entry.event.taskId === bundle.task.spec.id &&
        entry.event.workerRunId === bundle.task.workerRunId &&
        entry.event.data.nativeSessionId === bundle.nativeSessionId &&
        entry.event.data.provider === bundle.provider,
    );
    if (!found) throw new Error(`native_session_event_missing:${bundle.task.spec.id}`);
  }
}

function bindSettledWorkerRuns(mission: MissionView, events: readonly StoredEvent[]): void {
  for (const taskView of mission.tasks) {
    if (taskView.workerRunId) continue;
    const settled = events.findLast(
      (entry) => entry.event.type === "worker.settled" && entry.event.taskId === taskView.spec.id,
    );
    if (settled?.event.workerRunId) taskView.workerRunId = settled.event.workerRunId;
  }
}

export async function persistRedactedLogs(
  outputDirectory: string,
  processes: readonly ProcessLogSource[],
  secrets: readonly string[],
): Promise<Array<{ name: string; path: string; sha256: string }>> {
  const directory = join(outputDirectory, "process-logs");
  await makePrivateDirectory(directory);
  const records = [];
  for (const managed of processes) {
    const path = join(directory, `${managed.spec.name}.log`);
    const content = `${redact(managed.output.join(""), secrets).trim()}\n`;
    await writeFile(path, content, { encoding: "utf8", mode: 0o600 });
    records.push({ name: managed.spec.name, path, sha256: await sha256File(path) });
  }
  return records;
}

async function createStagingDirectory(outputDirectory: string): Promise<string> {
  const parent = dirname(outputDirectory);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".real-workers-staging-"));
  await chmod(staging, 0o700);
  return staging;
}

async function makePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function syncTree(root: string): Promise<void> {
  await chmod(root, 0o700);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await syncTree(path);
    else if (entry.isFile()) {
      await chmod(path, 0o600);
      await syncFile(path);
    } else throw new Error("real_workers_staging_contains_unsupported_entry");
  }
  await syncDirectory(root);
}

async function hashRunTree(root: string): Promise<{ sha256: string; fileCount: number }> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && relative(root, path) !== REAL_WORKERS_COMMIT_MARKER) files.push(path);
      else if (!entry.isFile()) throw new Error("real_workers_staging_contains_unsupported_entry");
    }
  };
  await visit(root);
  files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)));
  const hash = createHash("sha256");
  for (const path of files) {
    const metadata = await stat(path);
    const logicalPath = relative(root, path);
    hash.update(logicalPath).update("\0").update(String(metadata.size)).update("\0");
    hash.update(await readFile(path));
  }
  return { sha256: hash.digest("hex"), fileCount: files.length };
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function publishedPath(stagingDirectory: string, outputDirectory: string, path: string): string {
  const child = relative(stagingDirectory, path);
  if (child === ".." || child.startsWith("../") || isAbsolute(child)) {
    throw new Error("real_workers_artifact_outside_staging");
  }
  return join(outputDirectory, child);
}

async function writeHashChain(path: string, payloads: readonly unknown[]): Promise<void> {
  let previousHash = "GENESIS";
  const lines = payloads.map((payload, index) => {
    const core = { sequence: index + 1, previousHash, payload };
    const hash = createHash("sha256").update(JSON.stringify(core)).digest("hex");
    previousHash = hash;
    return JSON.stringify({ ...core, hash });
  });
  await writeFile(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

function reportMarkdown(report: Record<string, unknown>): string {
  const sessions = array(report.nativeSessions)
    .map((entry) => (isRecord(entry) ? `- ${entry.provider}: ${entry.nativeSessionId}` : ""))
    .filter(Boolean)
    .join("\n");
  return `# Real-provider worker evaluation\n\n**Result:** ${String(report.result)}\n\n${String(report.summary)}\n\n## Native sessions\n\n${sessions}\n`;
}

function hasTrustedCheck(result: WorkerResult | undefined, expected: "passed" | "failed"): boolean {
  if (!result) return false;
  const report = result.evidence.find(
    (entry) =>
      entry.kind === "test_report" && /^runner-check:retry-fixture:sha256:[a-f0-9]{64}$/u.test(entry.label),
  );
  return Boolean(
    report &&
    (expected === "passed" ? report.summary.includes("exited 0") : !report.summary.includes("exited 0")),
  );
}

function requiredTask(mission: MissionView, id: string): MissionTaskView {
  const found = task(mission, id);
  if (!found) throw new Error(`task_missing:${id}`);
  return found;
}

function task(mission: MissionView, id: string): MissionTaskView | undefined {
  return mission.tasks.find((entry) => entry.spec.id === id);
}

function assertProcessesAlive(processes: readonly ManagedProcess[]): void {
  for (const managed of processes) {
    if (managed.failure) throw new Error(`${managed.spec.name}_spawn_failed`);
    if (managed.process.exitCode !== null || managed.process.signalCode !== null) {
      throw new Error(`${managed.spec.name}_exited_before_completion`);
    }
  }
}

function signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when its process group is already gone.
    }
  }
  child.kill(signal);
}

function configuredTimeout(): number {
  const configured = Number(process.env.CLANKIE_REAL_WORKERS_TIMEOUT_MS ?? 30 * 60_000);
  if (!Number.isSafeInteger(configured) || configured < 10_000)
    throw new Error("invalid_real_workers_timeout");
  return configured;
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("ephemeral_port_unavailable"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

function assertFrozenAggregate(actual: string): void {
  if (actual !== FROZEN_REAL_WORKER_FIXTURE_SHA256) {
    throw new Error(`frozen_fixture_hash_mismatch:${actual}`);
  }
}

function secretValues(specs: readonly ProcessSpec[]): string[] {
  const values = specs.flatMap((spec) =>
    Object.entries(spec.environment)
      .filter(([name]) => /(?:TOKEN|SECRET|API_KEY|ACCESS_KEY|PASSWORD|CREDENTIAL)/u.test(name))
      .map(([, value]) => value)
      .filter((value): value is string => typeof value === "string" && value.length >= 4),
  );
  return normalizeSecretValues(values);
}

function secretValuesFromEnv(): string[] {
  return normalizeSecretValues(
    Object.entries(process.env)
      .filter(([name]) => /(?:TOKEN|SECRET|API_KEY|ACCESS_KEY|PASSWORD|CREDENTIAL)/u.test(name))
      .map(([, value]) => value)
      .filter((value): value is string => typeof value === "string"),
  );
}

/** Loads only recognized authentication leaves for in-memory log redaction. */
export async function collectFileBackedSecretValues(environment: NodeJS.ProcessEnv): Promise<string[]> {
  const values: string[] = [];
  const codexHome = environment.CODEX_HOME?.trim();
  if (codexHome) {
    const auth = await readCredentialJson(join(codexHome, "auth.json"), "codex_auth");
    values.push(...codexAuthSecretValues(auth));
  }
  if (environment.CLAUDE_CODE_USE_VERTEX?.trim().toLowerCase() === "true") {
    const credentialsPath = environment.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (credentialsPath) {
      const credentials = await readCredentialJson(credentialsPath, "vertex_adc");
      values.push(...vertexCredentialSecretValues(credentials));
    }
  }
  return normalizeSecretValues(values);
}

async function readCredentialJson(path: string, source: string): Promise<unknown> {
  try {
    const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const metadata = await handle.stat();
      const wrongOwner = typeof process.getuid === "function" && metadata.uid !== process.getuid();
      if (
        !metadata.isFile() ||
        metadata.size > MAX_CREDENTIAL_FILE_BYTES ||
        wrongOwner ||
        (metadata.mode & 0o077) !== 0
      ) {
        throw new Error("unsafe");
      }
      return JSON.parse(await handle.readFile("utf8")) as unknown;
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error(`real_worker_secret_source_invalid:${source}`);
  }
}

function codexAuthSecretValues(value: unknown): string[] {
  if (!isRecord(value)) throw new Error("real_worker_secret_source_invalid:codex_auth");
  const values: string[] = [];
  addSecret(values, value.OPENAI_API_KEY);
  addSecret(values, value.personal_access_token);

  if (isRecord(value.tokens)) {
    addSecret(values, value.tokens.id_token);
    addSecret(values, value.tokens.access_token);
    addSecret(values, value.tokens.refresh_token);
  }
  if (typeof value.agent_identity === "string") addSecret(values, value.agent_identity);
  else if (isRecord(value.agent_identity)) addSecret(values, value.agent_identity.agent_private_key);
  if (isRecord(value.bedrock_api_key)) addSecret(values, value.bedrock_api_key.api_key);
  return values;
}

function vertexCredentialSecretValues(value: unknown): string[] {
  const secretKeys = new Set([
    "access_token",
    "client_secret",
    "id_token",
    "private_key",
    "refresh_token",
    "saml_response",
    "subject_token",
    "token",
  ]);
  const values: string[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, entry] of Object.entries(candidate)) {
      if (secretKeys.has(key)) addSecret(values, entry);
      else visit(entry);
    }
  };
  visit(value);
  return values;
}

function addSecret(values: string[], value: unknown): void {
  if (typeof value === "string") values.push(value);
}

function normalizeSecretValues(values: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const value of values) {
    if (value.length < 4) continue;
    variants.add(value);
    const serialized = JSON.stringify(value);
    variants.add(serialized);
    variants.add(serialized.slice(1, -1));
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function mergeSecretValues(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => right.length - left.length);
}

function redact(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/giu, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, "[REDACTED]");
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) throw new Error(message);
  return value;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^[.-]+|[.-]+$/gu, "") || "unnamed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function sha256File(path: string): Promise<string> {
  return readFile(path).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
}

function git(cwd: string, args: string[]): Promise<string> {
  return execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }).then((result) => result.stdout);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function cleanupRuntime(root: string): Promise<void> {
  if (process.env.CLANKIE_REAL_WORKERS_KEEP_RUNTIME === "true") return;
  await rm(root, { recursive: true, force: true });
}
