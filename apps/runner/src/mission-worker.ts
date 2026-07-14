import { randomUUID } from "node:crypto";
import type {
  RunnerAssignment,
  RunnerWorkerDescriptor,
  WorkerSteerCommand,
  WorkerSteerOutcome,
} from "@clankie/api-client";
import type { Evidence, WorkerResult } from "@clankie/protocol";
import type { WorkerAdapter } from "@clankie/worker-sdk";
import {
  AttemptEvidenceStore,
  writeEvidenceBundle,
  type SettledAttemptArtifact,
  type SettledAttemptCheck,
} from "./evidence-bundle.ts";
import type { ProviderMetadata } from "./provider-factory.ts";
import type { WorktreeLease, WorktreeManager } from "./worktrees.ts";
import type { TerminalManager } from "./terminals.ts";
import type { WorkerTranscriptProjection } from "./worker-transcript.ts";
import {
  runVerificationChecks,
  type VerificationCheck,
  type VerificationSandbox,
} from "./verification-checks.ts";
import {
  collectGitEvidence,
  pathsChangedBetween,
  pathsOutsideWriteScope,
  type GitEvidence,
} from "./worker-evidence.ts";

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
  claimSteerCommand(workerRunId: string, attempt: number): Promise<WorkerSteerCommand | undefined>;
  settleSteerCommand(
    commandId: string,
    workerRunId: string,
    attempt: number,
    outcome: WorkerSteerOutcome,
  ): Promise<unknown>;
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
  retryDelayMs?: number;
  maxBackoffMs?: number;
  waitingUserPolicy?: "allow" | "block";
  providerMetadata?: ReadonlyMap<string, ProviderMetadata>;
  evidenceStore?: AttemptEvidenceStore;
  steeringPollIntervalMs?: number;
  hasHumanControlLease?: (workerRunId: string) => boolean | Promise<boolean>;
  terminalManager?: Pick<TerminalManager, "bindNativeSession">;
  /** Runner-owned redacted semantic transcript; raw provider/terminal output never enters it. */
  transcriptProjection?: WorkerTranscriptProjection;
}

interface AttemptFacts {
  nativeSessionId?: string | null;
  commands?: string[];
  checks?: SettledAttemptCheck[];
  git?: GitEvidence;
  runnerEvidence?: Evidence[];
  remainingRisks?: string[];
  diagnosis?: string;
}

/** Pulls one assignment at a time and retains each mission candidate for dependent verification. */
export class MissionWorker {
  private readonly options: MissionWorkerOptions;
  private readonly adapters = new Map<string, WorkerAdapter>();
  private readonly candidates = new Map<string, WorktreeLease>();
  private readonly claimIdFactory: () => string;
  private readonly evidenceStore: AttemptEvidenceStore;
  private readonly deliveredSteerCommandIds = new Set<string>();

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
    this.evidenceStore =
      options.evidenceStore ?? new AttemptEvidenceStore(`${options.artifactRoot}/attempts`);
  }

  public async runOnce(signal: AbortSignal = new AbortController().signal): Promise<boolean> {
    if (signal.aborted) return false;
    const claimId = this.claimIdFactory();
    const workers = [...this.adapters.values()].map((adapter) => structuredClone(adapter.descriptor));
    const assignment = await retry(
      () => this.options.client.claimTask(claimId, workers),
      this.options.reportAttempts,
      this.options.retryDelayMs,
      signal,
    );
    if (!assignment) return false;
    await this.execute(assignment, signal);
    return true;
  }

  public async runForever(signal: AbortSignal, pollIntervalMs = 1_000): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const ran = await this.runOnce(signal);
        consecutiveFailures = 0;
        if (!ran) await abortableDelay(pollIntervalMs, signal);
      } catch {
        consecutiveFailures += 1;
        const backoff = Math.min(
          this.options.maxBackoffMs ?? 30_000,
          (this.options.retryDelayMs ?? 100) * 2 ** Math.min(consecutiveFailures - 1, 8),
        );
        await abortableDelay(backoff, signal);
      }
    }
  }

  private async execute(assignment: RunnerAssignment, lifecycleSignal: AbortSignal): Promise<void> {
    if (lifecycleSignal.aborted) return;
    const adapter = this.adapters.get(assignment.worker.id);
    if (!adapter) {
      await this.settle(
        assignment,
        {
          status: "failed",
          summary: "Runner could not bind the assigned provider.",
          evidence: [],
          outputs: {},
          diagnosis: "The claimed worker descriptor is unavailable in this runner process.",
        },
        { diagnosis: "The assigned provider is unavailable." },
      );
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
          this.options.retryDelayMs,
          lifecycleSignal,
        );
      } catch {
        return;
      }
      if (lifecycleSignal.aborted) return;
      heartbeat = this.heartbeatLoop(assignment, abort, heartbeatAbort.signal);

      let lease: WorktreeLease;
      try {
        lease = await this.candidateFor(assignment);
      } catch {
        await this.settle(assignment, failedResult("Runner could not bind the mission candidate worktree."), {
          diagnosis: "Runner could not bind the mission candidate worktree.",
        });
        return;
      }
      if (lifecycleSignal.aborted) return;
      if (!lease.baseCommit) {
        await this.settle(assignment, failedResult("Mission candidate has no immutable base commit."), {
          diagnosis: "Mission candidate has no immutable base commit.",
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
      } catch {
        await this.settle(
          assignment,
          failedResult("Runner could not inspect the candidate before provider execution."),
          { diagnosis: "Runner could not inspect the candidate before provider execution." },
        );
        return;
      }
      if (lifecycleSignal.aborted) return;

      const reports: Promise<unknown>[] = [];
      let eventSequence = 0;
      let result: WorkerResult;
      let nativeSessionId: string | null = null;
      let blockedOnUser = false;
      const commands: string[] = [];
      const runnerEvidence: Evidence[] = [];
      let checkFacts: SettledAttemptCheck[] = [];
      let finalGit: GitEvidence | undefined;
      const remainingRisks: string[] = [];
      const steeringAbort = new AbortController();
      const steering = this.steeringLoop(assignment, adapter, steeringAbort.signal);
      try {
        const providerResult = await adapter.run({
          missionId: assignment.missionId,
          workerRunId: assignment.workerRunId,
          task: assignment.task,
          workspacePath: lease.path,
          profileHash: assignment.profileHash,
          attempt: assignment.attempt,
          signal: abort.signal,
          emit: (event) => {
            if (!RUNNER_EVENT_TYPES.has(event.type)) return;
            const data = normalizeRunnerEventData(event.type, event.data);
            if (!data) return;
            const nextSequence = eventSequence + 1;
            const eventId = `${assignment.workerRunId}:${assignment.attempt}:${nextSequence}`;
            if (event.type === "worker.native_session.bound" && typeof data.nativeSessionId === "string") {
              nativeSessionId = data.nativeSessionId;
              this.options.terminalManager?.bindNativeSession(
                assignment.workerRunId,
                assignment.attempt,
                data.nativeSessionId,
              );
            }
            if (event.type === "worker.command.completed" && typeof data.commandFingerprint === "string") {
              commands.push(`provider:${String(data.provider)}:sha256:${data.commandFingerprint}`);
            }
            if (event.type === "worker.waiting_user" && this.options.waitingUserPolicy !== "allow") {
              blockedOnUser = true;
              abort.abort(new Error("noninteractive_worker_waiting_user"));
            }
            eventSequence = nextSequence;
            if (this.options.transcriptProjection) {
              reports.push(
                this.options.transcriptProjection.append(
                  transcriptCandidateForRunnerEvent(assignment, eventId, event.type, data),
                ),
              );
            }
            reports.push(
              retry(
                () =>
                  this.options.client.recordWorkerEvent(assignment.workerRunId, {
                    attempt: assignment.attempt,
                    eventId,
                    type: event.type,
                    data,
                  }),
                this.options.reportAttempts,
                this.options.retryDelayMs,
                abort.signal,
              ),
            );
          },
        });
        if (this.options.transcriptProjection) {
          reports.push(
            this.options.transcriptProjection.append({
              key: transcriptKey(assignment),
              occurredAt: new Date().toISOString(),
              correlationId: assignment.workerRunId,
              profileHash: assignment.profileHash,
              sourceEventId: `${assignment.workerRunId}:${assignment.attempt}:summary`,
              source: "worker_summary",
              trust: "worker_authored",
              kind: "narrative",
              data: { summaryCode: `reported_${providerResult.status}` },
            }),
          );
        }
        result = observedProviderResult(providerResult.status, assignment.worker.id);
      } catch {
        result = failedResult("Worker adapter failed before producing a trusted result.");
      }
      steeringAbort.abort();
      await steering;
      if (blockedOnUser) {
        result = {
          status: "blocked",
          summary: "Runner blocked a noninteractive worker that requested user input.",
          evidence: [],
          outputs: {},
          diagnosis: "Unexpected waiting_user in a noninteractive worker gate.",
        };
        remainingRisks.push("Worker requires an explicit interactive handoff before it can continue.");
      } else if (result.status === "succeeded" && !nativeSessionId) {
        result = failedResult("Provider completed without binding a native session ID.");
        remainingRisks.push("Provider session identity is unavailable for replay or attribution.");
      }
      try {
        await Promise.all(reports);
      } catch {
        result = failedResult("Runner could not durably report worker events.");
        remainingRisks.push("One or more semantic events were not durably reported.");
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
        runnerEvidence.push(...checks.evidence);
        checkFacts = checks.checks;
        if (!checks.passed) {
          result = {
            ...result,
            status: "failed",
            summary: "Trusted runner verification checks did not pass.",
            diagnosis: checks.failures.join("; "),
          };
          remainingRisks.push("One or more trusted runner checks failed or could not execute.");
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
        runnerEvidence.push(after.evidence);
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
          remainingRisks.push("Authoritative Git evidence contains changes outside the assigned scope.");
        } else {
          result = {
            ...result,
            outputs: { ...result.outputs, changedPaths: after.changedPaths, diffSha256: after.sha256 },
          };
        }
        finalGit = after;
      } catch {
        result = failedResult("Runner could not collect authoritative Git evidence.");
        remainingRisks.push("Authoritative Git evidence could not be collected.");
      }
      heartbeatAbort.abort();
      const heartbeatFailure = await heartbeat;
      if (heartbeatFailure) {
        result = failedResult("Runner lost authority over the active worker lease.");
        remainingRisks.push("Runner lost authority over the active worker lease.");
      }
      if (lifecycleSignal.aborted) return;
      await this.settle(assignment, result, {
        nativeSessionId,
        commands,
        checks: checkFacts,
        ...(finalGit ? { git: finalGit } : {}),
        runnerEvidence,
        remainingRisks,
        ...(result.diagnosis ? { diagnosis: result.diagnosis } : {}),
      });
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

  private async settle(
    assignment: RunnerAssignment,
    result: WorkerResult,
    facts: AttemptFacts = {},
  ): Promise<unknown> {
    const metadata = this.options.providerMetadata?.get(assignment.worker.id);
    const artifacts: SettledAttemptArtifact[] = facts.git
      ? [{ ref: facts.git.evidence.uri ?? "artifact://runner-diff/unavailable", sha256: facts.git.sha256 }]
      : [];
    // Per-worker evidence bundle beside the diff artifacts (AGENTS.md
    // completed-implementation block, VUH-815) — written in addition to the
    // validated immutable attempt store below.
    const written = await writeEvidenceBundle({
      artifactRoot: this.options.artifactRoot,
      missionId: assignment.missionId,
      taskId: assignment.task.id,
      workerRunId: assignment.workerRunId,
      attempt: assignment.attempt,
      worker: {
        id: assignment.worker.id,
        displayName: assignment.worker.displayName,
        harness: assignment.worker.harness,
      },
      result,
      nativeSessionId: facts.nativeSessionId ?? null,
      filesChanged: facts.git?.changedPaths ?? [],
      commandsRun: facts.commands ?? [],
      checks: facts.checks ?? [],
      artifacts: facts.git?.evidence.uri ? [facts.git.evidence.uri] : [],
    });
    const stored = await this.evidenceStore.write({
      schemaVersion: 1,
      missionId: assignment.missionId,
      taskId: assignment.task.id,
      workerRunId: assignment.workerRunId,
      attempt: assignment.attempt,
      correlationId: assignment.workerRunId,
      provider: metadata?.provider ?? assignment.worker.harness,
      providerVersion: metadata?.version ?? "unknown",
      nativeSessionId: facts.nativeSessionId ?? null,
      summary: `Runner observed a ${result.status} provider outcome and recorded authoritative attempt facts.`,
      files_changed: facts.git?.changedPaths ?? [],
      commands_run: [...new Set(facts.commands ?? [])].sort(),
      checks: facts.checks ?? [],
      artifacts,
      remaining_risks: [...new Set(facts.remainingRisks ?? [])],
      assumptions: [
        "Provider prose, raw output, and self-reported evidence are not authoritative runner evidence.",
      ],
    });
    const trustedResult: WorkerResult = {
      status: result.status,
      summary: stored.bundle.summary,
      evidence: [...(facts.runnerEvidence ?? []), written.evidence, stored.evidence],
      outputs: {
        changedPaths: stored.bundle.files_changed,
        ...(facts.git ? { diffSha256: facts.git.sha256 } : {}),
        nativeSessionId: stored.bundle.nativeSessionId,
        evidenceRef: stored.ref,
        evidenceSha256: stored.sha256,
      },
      ...(facts.diagnosis ? { diagnosis: facts.diagnosis } : {}),
    };
    if (this.options.transcriptProjection) {
      const occurredAt = new Date().toISOString();
      await this.options.transcriptProjection.append({
        key: transcriptKey(assignment),
        occurredAt,
        correlationId: assignment.workerRunId,
        profileHash: assignment.profileHash,
        sourceEventId: `${assignment.workerRunId}:${assignment.attempt}:evidence`,
        source: "runner_settlement",
        trust: "runner_observed",
        kind: "artifact",
        data: { ref: stored.ref },
      });
      await this.options.transcriptProjection.append({
        key: transcriptKey(assignment),
        occurredAt,
        correlationId: assignment.workerRunId,
        profileHash: assignment.profileHash,
        sourceEventId: `${assignment.workerRunId}:${assignment.attempt}:completion`,
        source: "runner_settlement",
        trust: "runner_observed",
        kind: "completion",
        data: { status: result.status, evidenceRefs: [stored.ref] },
      });
    }
    return retry(
      () => this.options.client.settleWorker(assignment.workerRunId, assignment.attempt, trustedResult),
      this.options.reportAttempts,
      this.options.retryDelayMs,
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
          this.options.retryDelayMs,
          signal,
        );
      } catch (error) {
        workerAbort.abort(error);
        return error;
      }
    }
    return undefined;
  }

  private async steeringLoop(
    assignment: RunnerAssignment,
    adapter: WorkerAdapter,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      await abortableDelay(this.options.steeringPollIntervalMs ?? 100, signal);
      if (signal.aborted) return;
      let command: WorkerSteerCommand | undefined;
      try {
        command = await retry(
          () => this.options.client.claimSteerCommand(assignment.workerRunId, assignment.attempt),
          this.options.reportAttempts,
          this.options.retryDelayMs,
          signal,
        );
      } catch {
        continue;
      }
      if (!command) continue;
      let outcome: WorkerSteerOutcome;
      if (
        command.workerRunId !== assignment.workerRunId ||
        command.attempt !== assignment.attempt ||
        command.missionId !== assignment.missionId ||
        command.taskId !== assignment.task.id ||
        command.profileHash !== assignment.profileHash
      ) {
        outcome =
          command.attempt === assignment.attempt
            ? steerOutcome("wrong_runner")
            : steerOutcome("stale_attempt");
      } else if (await this.options.hasHumanControlLease?.(assignment.workerRunId)) {
        outcome = steerOutcome("human_control_active");
      } else if (!adapter.steer) {
        outcome = steerOutcome("unsupported_adapter");
      } else if (this.deliveredSteerCommandIds.has(command.commandId)) {
        outcome = steerOutcome("delivered");
      } else {
        try {
          await adapter.steer(assignment.workerRunId, command);
          this.deliveredSteerCommandIds.add(command.commandId);
          outcome = steerOutcome("delivered");
        } catch {
          outcome = steerOutcome("delivery_failed");
        }
      }
      await retry(
        () =>
          this.options.client.settleSteerCommand(
            command.commandId,
            assignment.workerRunId,
            assignment.attempt,
            outcome,
          ),
        this.options.reportAttempts,
        this.options.retryDelayMs,
      ).catch(() => undefined);
    }
  }
}

function steerOutcome(code: WorkerSteerOutcome["code"]): WorkerSteerOutcome {
  const message: Record<WorkerSteerOutcome["code"], string> = {
    delivered: "The typed worker adapter accepted the command.",
    stale_attempt: "The command does not target this worker attempt.",
    wrong_runner: "The command identity does not match this runner assignment.",
    worker_terminal: "The worker is terminal.",
    lease_expired: "The worker lease expired.",
    unsupported_adapter: "The provider adapter does not support typed steering.",
    human_control_active: "Automated steering is paused by a human control lease.",
    delivery_failed: "The typed provider steering operation failed.",
  };
  return { code, message: message[code] };
}

const RUNNER_EVENT_TYPES = new Set([
  "worker.native_session.bound",
  "worker.turn.started",
  "worker.turn.settled",
  "worker.waiting_user",
  "worker.status.signal",
  "worker.command.completed",
  "worker.file_change.completed",
  "worker.plan.updated",
  "worker.diff.updated",
]);

function transcriptKey(assignment: RunnerAssignment) {
  return {
    missionId: assignment.missionId,
    taskId: assignment.task.id,
    workerRunId: assignment.workerRunId,
  };
}

function transcriptCandidateForRunnerEvent(
  assignment: RunnerAssignment,
  eventId: string,
  type: string,
  data: Record<string, unknown>,
) {
  const common = {
    key: transcriptKey(assignment),
    occurredAt: typeof data.observedAt === "string" ? data.observedAt : new Date().toISOString(),
    correlationId: assignment.workerRunId,
    profileHash: assignment.profileHash,
    sourceEventId: eventId,
    source: "runner_event" as const,
    trust: "runner_observed" as const,
  };
  if (type === "worker.waiting_user") {
    return { ...common, kind: "blocker" as const, data };
  }
  if (type === "worker.turn.started" || type === "worker.turn.settled" || type === "worker.status.signal") {
    return { ...common, kind: "status" as const, data };
  }
  const action =
    type === "worker.command.completed"
      ? "command"
      : type === "worker.file_change.completed"
        ? "file_change"
        : type === "worker.plan.updated"
          ? "plan"
          : type === "worker.diff.updated"
            ? "diff"
            : type === "worker.native_session.bound"
              ? "session"
              : "worker";
  return {
    ...common,
    kind: "action" as const,
    data: {
      action,
      result:
        data.result === "passed"
          ? "succeeded"
          : type.endsWith(".updated") || type === "worker.native_session.bound"
            ? "started"
            : "failed",
      fingerprint: data.commandFingerprint,
    },
  };
}

function observedProviderResult(status: WorkerResult["status"], workerId: string): WorkerResult {
  return {
    status,
    summary: `Runner observed provider ${workerId} settle with status ${status}.`,
    evidence: [],
    outputs: {},
  };
}

function failedResult(summary: string): WorkerResult {
  return {
    status: "failed",
    summary,
    evidence: [],
    outputs: {},
    diagnosis: summary,
  };
}

function normalizeRunnerEventData(
  type: string,
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (type === "worker.native_session.bound") {
    if (typeof value.nativeSessionId !== "string" || !value.nativeSessionId.trim()) return undefined;
    return {
      provider: safeToken(value.provider),
      nativeSessionId: value.nativeSessionId.slice(0, 256),
    };
  }
  if (type === "worker.command.completed") {
    if (typeof value.commandFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.commandFingerprint)) {
      return undefined;
    }
    return {
      provider: safeToken(value.provider),
      commandFingerprint: value.commandFingerprint,
      exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
      result: value.result === "passed" ? "passed" : "failed",
    };
  }
  if (type === "worker.file_change.completed") {
    const pathFingerprints = Array.isArray(value.pathFingerprints)
      ? value.pathFingerprints.filter(
          (entry): entry is string => typeof entry === "string" && /^[a-f0-9]{64}$/u.test(entry),
        )
      : [];
    return {
      provider: safeToken(value.provider),
      changeCount: Number.isInteger(value.changeCount) ? value.changeCount : pathFingerprints.length,
      pathFingerprints,
      result: value.result === "passed" ? "passed" : "failed",
    };
  }
  if (
    type === "worker.turn.started" ||
    type === "worker.turn.settled" ||
    type === "worker.waiting_user" ||
    type === "worker.status.signal"
  ) {
    return {
      state: safeToken(value.state),
      source: safeToken(value.source),
      tier: Number.isInteger(value.tier) ? value.tier : 0,
      confidence: typeof value.confidence === "number" ? value.confidence : 1,
      observedAt:
        typeof value.observedAt === "string" ? value.observedAt.slice(0, 64) : new Date().toISOString(),
      ...(type === "worker.waiting_user" || value.state === "waiting_user"
        ? { questionSummary: "Worker requires user input." }
        : {}),
    };
  }
  if (type === "worker.plan.updated" || type === "worker.diff.updated") {
    return { source: safeToken(value.source) };
  }
  return undefined;
}

function safeToken(value: unknown): string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,80}$/u.test(value) ? value : "unknown";
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

async function retry<T>(
  operation: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 25,
  signal?: AbortSignal,
): Promise<T> {
  let failure: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      failure = error;
      if (attempt < attempts)
        await abortableDelay(baseDelayMs * 2 ** (attempt - 1), signal ?? new AbortController().signal);
    }
  }
  throw failure;
}
