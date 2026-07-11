import { randomUUID } from "node:crypto";
import type { RunnerAssignment, RunnerWorkerDescriptor } from "@sapling/api-client";
import type { WorkerResult } from "@sapling/protocol";
import type { WorkerAdapter } from "@sapling/worker-sdk";
import type { WorktreeLease, WorktreeManager } from "./worktrees.ts";
import {
  runVerificationChecks,
  type VerificationCheck,
  type VerificationSandbox,
} from "./verification-checks.ts";
import { collectGitEvidence, pathsChangedBetween, pathsOutsideWriteScope } from "./worker-evidence.ts";

export interface MissionControlClient {
  claimTask(
    claimId: string,
    workers: readonly RunnerWorkerDescriptor[],
  ): Promise<RunnerAssignment | undefined>;
  recordWorkerEvent(
    workerRunId: string,
    input: { attempt: number; eventId: string; type: string; data: Record<string, unknown> },
  ): Promise<unknown>;
  settleWorker(workerRunId: string, attempt: number, result: WorkerResult): Promise<unknown>;
  heartbeatWorker(workerRunId: string, attempt: number): Promise<unknown>;
}

export interface MissionWorkerOptions {
  client: MissionControlClient;
  adapters: readonly WorkerAdapter[];
  worktrees: WorktreeManager;
  artifactRoot: string;
  baseRef?: string;
  claimIdFactory?: () => string;
  workerEnvironment?: NodeJS.ProcessEnv;
  verificationChecks?: readonly VerificationCheck[];
  verificationSandbox?: VerificationSandbox;
  verificationTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  reportAttempts?: number;
}

/** Pulls one assignment at a time and retains each mission candidate for dependent verification. */
export class MissionWorker {
  private readonly options: MissionWorkerOptions;
  private readonly adapters = new Map<string, WorkerAdapter>();
  private readonly candidates = new Map<string, WorktreeLease>();
  private readonly claimIdFactory: () => string;

  public constructor(options: MissionWorkerOptions) {
    this.options = options;
    for (const adapter of options.adapters) {
      if (this.adapters.has(adapter.descriptor.id)) {
        throw new Error(`Duplicate worker adapter id ${adapter.descriptor.id}`);
      }
      this.adapters.set(adapter.descriptor.id, adapter);
    }
    if (this.adapters.size === 0) throw new Error("MissionWorker requires at least one adapter");
    this.claimIdFactory = options.claimIdFactory ?? randomUUID;
  }

  public async runOnce(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    if (signal.aborted) return false;
    const claimId = this.claimIdFactory();
    const workers = [...this.adapters.values()].map((adapter) => structuredClone(adapter.descriptor));
    const assignment = await retry(
      () => this.options.client.claimTask(claimId, workers),
      this.options.reportAttempts,
    );
    if (!assignment) return false;
    await this.execute(assignment, signal);
    return true;
  }

  public async runForever(signal: AbortSignal, pollIntervalMs = 1_000): Promise<void> {
    while (!signal.aborted) {
      const ran = await this.runOnce(signal);
      if (!ran) await abortableDelay(pollIntervalMs, signal);
    }
  }

  private async execute(assignment: RunnerAssignment, lifecycleSignal: AbortSignal): Promise<void> {
    if (lifecycleSignal.aborted) return;
    const adapter = this.adapters.get(assignment.worker.id);
    if (!adapter) {
      await this.settle(assignment, {
        status: "failed",
        summary: `Runner has no registered adapter ${assignment.worker.id}.`,
        evidence: [],
        outputs: {},
        diagnosis: "The claimed worker descriptor is unavailable in this runner process.",
      });
      return;
    }

    const abort = new AbortController();
    const heartbeatAbort = new AbortController();
    let heartbeat: Promise<unknown | undefined> | undefined;
    const abortForLifecycle = () => {
      abort.abort(lifecycleSignal.reason);
      heartbeatAbort.abort(lifecycleSignal.reason);
    };
    lifecycleSignal.addEventListener("abort", abortForLifecycle, { once: true });
    try {
      if (lifecycleSignal.aborted) {
        abortForLifecycle();
        return;
      }

      try {
        await retry(
          () => this.options.client.heartbeatWorker(assignment.workerRunId, assignment.attempt),
          this.options.reportAttempts,
        );
      } catch {
        return;
      }
      if (lifecycleSignal.aborted) return;

      let lease: WorktreeLease;
      try {
        lease = await this.candidateFor(assignment);
      } catch (error) {
        await this.settle(
          assignment,
          failedResult("Runner could not bind the mission candidate worktree.", error),
        );
        return;
      }
      if (lifecycleSignal.aborted) return;
      if (!lease.baseCommit) {
        await this.settle(assignment, {
          status: "failed",
          summary: "Mission candidate has no immutable base commit.",
          evidence: [],
          outputs: {},
          diagnosis: `Worktree lease ${lease.id} did not record baseCommit.`,
        });
        return;
      }

      let before;
      try {
        before = await collectGitEvidence({
          workspacePath: lease.path,
          baseCommit: lease.baseCommit,
          artifactRoot: this.options.artifactRoot,
          missionId: assignment.missionId,
          workerRunId: `${assignment.workerRunId}-before`,
          attempt: assignment.attempt,
        });
      } catch (error) {
        await this.settle(
          assignment,
          failedResult("Runner could not inspect the candidate before provider execution.", error),
        );
        return;
      }
      if (lifecycleSignal.aborted) return;

      heartbeat = this.heartbeatLoop(assignment, abort, heartbeatAbort.signal);
      const reports: Promise<unknown>[] = [];
      let eventSequence = 0;
      let result: WorkerResult;
      try {
        result = await adapter.run({
          missionId: assignment.missionId,
          workerRunId: assignment.workerRunId,
          task: assignment.task,
          workspacePath: lease.path,
          profileHash: assignment.profileHash,
          attempt: assignment.attempt,
          signal: abort.signal,
          emit: (event) => {
            if (!RUNNER_EVENT_TYPES.has(event.type)) return;
            eventSequence += 1;
            reports.push(
              retry(
                () =>
                  this.options.client.recordWorkerEvent(assignment.workerRunId, {
                    attempt: assignment.attempt,
                    eventId: `${assignment.workerRunId}:${assignment.attempt}:${eventSequence}`,
                    type: event.type,
                    data: event.data,
                  }),
                this.options.reportAttempts,
              ),
            );
          },
        });
      } catch (error) {
        result = failedResult("Worker adapter failed before producing a trusted result.", error);
      }
      try {
        await Promise.all(reports);
      } catch (error) {
        result = failedResult("Runner could not durably report worker events.", error, result.evidence);
      }
      if (lifecycleSignal.aborted) return;

      if (assignment.task.kind === "verification") {
        const checks = await runVerificationChecks(this.options.verificationChecks ?? [], {
          identity: {
            missionId: assignment.missionId,
            taskId: assignment.task.id,
            workerRunId: assignment.workerRunId,
            profileHash: assignment.profileHash,
            risk: assignment.task.risk,
            workspacePath: lease.path,
          },
          environment: this.options.workerEnvironment ?? {},
          signal: abort.signal,
          ...(this.options.verificationSandbox ? { sandbox: this.options.verificationSandbox } : {}),
          ...(this.options.verificationTimeoutMs ? { timeoutMs: this.options.verificationTimeoutMs } : {}),
        });
        result = { ...result, evidence: [...result.evidence, ...checks.evidence] };
        if (!checks.passed) {
          result = {
            ...result,
            status: "failed",
            summary: "Trusted runner verification checks did not pass.",
            diagnosis: checks.failures.join("; "),
          };
        }
      }
      if (lifecycleSignal.aborted) return;

      try {
        const after = await collectGitEvidence({
          workspacePath: lease.path,
          baseCommit: lease.baseCommit,
          artifactRoot: this.options.artifactRoot,
          missionId: assignment.missionId,
          workerRunId: assignment.workerRunId,
          attempt: assignment.attempt,
        });
        result = { ...result, evidence: [...result.evidence, after.evidence] };
        const readOnlyTask = assignment.task.writeScope.length === 0;
        const changedDuringRun = pathsChangedBetween(before, after);
        const contentViolations = readOnlyTask
          ? changedDuringRun
          : pathsOutsideWriteScope(changedDuringRun, assignment.task.writeScope);
        const structuralViolations =
          assignment.task.kind === "verification"
            ? [
                ...(before.headCommit === after.headCommit ? [] : ["<verification changed HEAD>"]),
                ...(before.indexTree === after.indexTree ? [] : ["<verification changed index>"]),
              ]
            : [];
        const violations = [...contentViolations, ...structuralViolations];
        if (violations.length > 0) {
          result = {
            ...result,
            status: "failed",
            summary: "Runner rejected the worker result because Git changes violated task write scope.",
            diagnosis: `Out-of-scope changes: ${violations.join(", ")}`,
            outputs: { ...result.outputs, changedPaths: after.changedPaths, diffSha256: after.sha256 },
          };
        } else {
          result = {
            ...result,
            outputs: { ...result.outputs, changedPaths: after.changedPaths, diffSha256: after.sha256 },
          };
        }
      } catch (error) {
        result = failedResult("Runner could not collect authoritative Git evidence.", error, result.evidence);
      }
      heartbeatAbort.abort();
      const heartbeatFailure = await heartbeat;
      if (heartbeatFailure) {
        result = failedResult(
          "Runner lost authority over the active worker lease.",
          heartbeatFailure,
          result.evidence,
        );
      }
      if (lifecycleSignal.aborted) return;
      await this.settle(assignment, result);
    } finally {
      heartbeatAbort.abort();
      await heartbeat;
      lifecycleSignal.removeEventListener("abort", abortForLifecycle);
    }
  }

  private async candidateFor(assignment: RunnerAssignment): Promise<WorktreeLease> {
    const cached = this.candidates.get(assignment.missionId);
    if (cached) return cached;
    const retained = (await this.options.worktrees.listLeases()).find(
      (lease) => lease.missionId === assignment.missionId,
    );
    if (retained) {
      this.candidates.set(assignment.missionId, retained);
      return retained;
    }
    try {
      const recovered = await this.options.worktrees.recoverCandidate(assignment.missionId, {
        missionId: assignment.missionId,
        taskId: assignment.task.id,
        workerRunId: assignment.workerRunId,
      });
      this.candidates.set(assignment.missionId, recovered);
      return recovered;
    } catch (error) {
      if (assignment.task.kind === "verification" || assignment.task.kind === "review") throw error;
      if (!String(error).includes("candidate_manifest_missing:")) throw error;
    }
    const created = await this.options.worktrees.create(
      {
        missionId: assignment.missionId,
        taskId: assignment.task.id,
        workerRunId: assignment.workerRunId,
      },
      this.options.baseRef ?? "HEAD",
    );
    await this.options.worktrees.persistCandidate(created);
    this.candidates.set(assignment.missionId, created);
    return created;
  }

  private settle(assignment: RunnerAssignment, result: WorkerResult): Promise<unknown> {
    return retry(
      () => this.options.client.settleWorker(assignment.workerRunId, assignment.attempt, result),
      this.options.reportAttempts,
    );
  }

  private async heartbeatLoop(
    assignment: RunnerAssignment,
    workerAbort: AbortController,
    signal: AbortSignal,
  ): Promise<unknown | undefined> {
    while (!signal.aborted) {
      await abortableDelay(this.options.heartbeatIntervalMs ?? 5_000, signal);
      if (signal.aborted) return undefined;
      try {
        await retry(
          () => this.options.client.heartbeatWorker(assignment.workerRunId, assignment.attempt),
          this.options.reportAttempts,
        );
      } catch (error) {
        workerAbort.abort(error);
        return error;
      }
    }
    return undefined;
  }
}

const RUNNER_EVENT_TYPES = new Set([
  "worker.native_session.bound",
  "worker.waiting_user",
  "worker.command.completed",
  "worker.file_change.completed",
  "worker.plan.updated",
  "worker.diff.updated",
]);

function failedResult(
  summary: string,
  error: unknown,
  evidence: WorkerResult["evidence"] = [],
): WorkerResult {
  return {
    status: "failed",
    summary,
    evidence,
    outputs: {},
    diagnosis: error instanceof Error ? error.message : String(error),
  };
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal.aborted) return resolvePromise();
    const timeout = setTimeout(resolvePromise, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolvePromise();
      },
      { once: true },
    );
  });
}

async function retry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      failure = error;
    }
  }
  throw failure;
}
