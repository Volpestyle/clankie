import { CodexWorkerAdapter } from "@clankie/worker-codex";
import { ClaudeWorkerAdapter } from "@clankie/worker-claude";
import { PiWorkerAdapter } from "@clankie/worker-pi";
import { SimulatedWorkerAdapter } from "@clankie/worker-sim";
import type { TaskKind, WorkerResult } from "@clankie/protocol";
import type { WorkerAdapter, WorkerRunContext } from "@clankie/worker-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";

/**
 * Injectable adapter constructors, defaulting to the real provider adapters.
 * Mirrors the repo's DI seams (codex/pi `transportFactory`, claude `query`,
 * api-client `fetchImpl`) so a test can observe the exact options — notably the
 * allowlisted `environment` — the runner wires into each descriptor without
 * reaching into private adapter state or spawning a real provider process.
 */
export interface WorkerAdapterConstructors {
  Codex?: typeof CodexWorkerAdapter;
  Claude?: typeof ClaudeWorkerAdapter;
  Pi?: typeof PiWorkerAdapter;
}

/**
 * Builds the worker adapters this runner advertises, role-appropriate per the
 * frozen scenario routing (docs/02-lead-agent-e2e-proof.md): Codex implements,
 * Claude verifies read-only, Pi debugs. Every real provider descriptor receives
 * the same allowlisted `workerEnvironment` so runner, captain, and connector
 * secrets never reach a worker process. When CLANKIE_SIM_WORKERS is set the
 * runner registers only simulated descriptors so the full task graph can
 * dry-run under runner isolation with zero provider credentials.
 */
export function buildWorkerAdapters(
  env: NodeJS.ProcessEnv,
  workerEnvironment: NodeJS.ProcessEnv,
  constructors: WorkerAdapterConstructors = {},
): WorkerAdapter[] {
  if (simWorkersEnabled(env)) return buildSimWorkerAdapters();

  const Codex = constructors.Codex ?? CodexWorkerAdapter;
  const Claude = constructors.Claude ?? ClaudeWorkerAdapter;
  const Pi = constructors.Pi ?? PiWorkerAdapter;

  const codexImplementer = new Codex({
    id: "codex-implementer",
    displayName: "Codex implementer",
    kinds: ["implementation", "debugging", "integration"],
    environment: workerEnvironment,
  });
  const codexVerifier = readOnly(
    new Codex({
      id: "codex-verifier",
      displayName: "Codex verifier",
      kinds: ["verification", "review"],
      environment: workerEnvironment,
    }),
  );
  const claudeVerifier = readOnly(
    new Claude({
      id: "claude-verifier",
      displayName: "Claude verifier",
      kinds: ["verification", "review"],
      environment: workerEnvironment,
    }),
  );
  const piDebugger = new Pi({
    id: "pi-debugger",
    displayName: "Pi debugger",
    kinds: ["debugging"],
    environment: workerEnvironment,
  });
  return [codexImplementer, codexVerifier, claudeVerifier, piDebugger];
}

export function simWorkersEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.CLANKIE_SIM_WORKERS?.trim().toLowerCase();
  return value === "1" || value === "true";
}

/** Read-only descriptor wrapper matching the existing codex-verifier pattern. */
function readOnly(adapter: WorkerAdapter): WorkerAdapter {
  return {
    descriptor: {
      ...adapter.descriptor,
      capabilities: { ...adapter.descriptor.capabilities, canWrite: false },
    },
    run: (context) => adapter.run(context),
  };
}

const SIM_ROLES: Array<{ id: string; displayName: string; kinds: TaskKind[]; canWrite: boolean }> = [
  {
    id: "sim-planner",
    displayName: "Simulated planner",
    kinds: ["context", "planning", "research"],
    canWrite: false,
  },
  {
    id: "sim-implementer",
    displayName: "Simulated implementer",
    kinds: ["implementation", "integration", "design"],
    canWrite: true,
  },
  {
    id: "sim-verifier",
    displayName: "Simulated verifier",
    kinds: ["verification", "review", "evaluation"],
    canWrite: false,
  },
  { id: "sim-debugger", displayName: "Simulated debugger", kinds: ["debugging"], canWrite: true },
];

function buildSimWorkerAdapters(): WorkerAdapter[] {
  return SIM_ROLES.map(
    (role) =>
      new SimulatedWorkerAdapter({
        id: role.id,
        displayName: role.displayName,
        harness: "simulated",
        kinds: role.kinds,
        canWrite: role.canWrite,
        handlers: {},
        defaultHandler: (context) => runScriptedSimTask(context, role.canWrite),
      }),
  );
}

interface SimTaskScript {
  files: Record<string, string>;
  status: WorkerResult["status"];
  summary: string | undefined;
  diagnosis: string | undefined;
}

/**
 * Executes the deterministic sim behavior declared by the plan author in
 * `task.metadata.sim` ({ files?, status?, summary?, diagnosis? }). Declared
 * files are written verbatim into the candidate so the runner's authoritative
 * Git evidence and write-scope enforcement are exercised for real. A synthetic
 * native session id is bound so the session-preservation pipeline runs
 * without any provider credential.
 */
async function runScriptedSimTask(context: WorkerRunContext, canWrite: boolean): Promise<WorkerResult> {
  const script = parseSimScript(context.task.metadata);
  const nativeSessionId = `sim:${context.workerRunId}`;
  context.emit({
    type: "worker.native_session.bound",
    missionId: context.missionId,
    taskId: context.task.id,
    workerRunId: context.workerRunId,
    profileHash: context.profileHash,
    data: { provider: "sim", nativeSessionId },
  });

  const changedFiles: string[] = [];
  for (const [path, content] of Object.entries(script.files)) {
    if (!canWrite) {
      return {
        status: "failed",
        summary: `Simulated ${context.task.role} refused to write ${path} from a read-only role.`,
        evidence: [],
        outputs: { workerRunId: context.workerRunId, nativeSessionId },
        diagnosis: "task.metadata.sim declared file writes for a read-only sim worker",
      };
    }
    const target = resolveInsideWorkspace(context.workspacePath, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
    changedFiles.push(path);
  }
  context.emit({
    type: "worker.command.completed",
    missionId: context.missionId,
    taskId: context.task.id,
    workerRunId: context.workerRunId,
    profileHash: context.profileHash,
    data: { command: `sim:${context.task.kind}:${context.task.id}`, exitCode: 0 },
  });
  return {
    status: script.status,
    summary:
      script.summary ??
      `Simulated ${context.task.role} completed ${context.task.id} (${changedFiles.length} scripted file(s)).`,
    evidence: [
      {
        kind: "log",
        label: "sim-worker-session",
        summary: `session=${nativeSessionId} scriptedFiles=${changedFiles.length}`,
      },
    ],
    outputs: { workerRunId: context.workerRunId, nativeSessionId, changedFiles },
    ...(script.diagnosis ? { diagnosis: script.diagnosis } : {}),
  };
}

function parseSimScript(metadata: Record<string, unknown>): SimTaskScript {
  const sim = metadata.sim;
  const record = sim && typeof sim === "object" && !Array.isArray(sim) ? (sim as Record<string, unknown>) : {};
  const files: Record<string, string> = {};
  if (record.files && typeof record.files === "object" && !Array.isArray(record.files)) {
    for (const [path, content] of Object.entries(record.files as Record<string, unknown>)) {
      if (typeof content !== "string") throw new Error(`task.metadata.sim.files.${path} must be a string`);
      files[path] = content;
    }
  }
  const status =
    record.status === "failed" || record.status === "blocked" ? record.status : ("succeeded" as const);
  return {
    files,
    status,
    summary: typeof record.summary === "string" ? record.summary : undefined,
    diagnosis: typeof record.diagnosis === "string" ? record.diagnosis : undefined,
  };
}

function resolveInsideWorkspace(workspacePath: string, path: string): string {
  const root = resolve(workspacePath);
  const target = resolve(root, path);
  if (isAbsolute(path) || (target !== root && !target.startsWith(root + sep))) {
    throw new Error(`task.metadata.sim declared a file outside the candidate: ${path}`);
  }
  return target;
}
