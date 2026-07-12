import type { DomainEvent, MissionPlan } from "@clankie/protocol";
import {
  TrackerIssueMutationSchema,
  TrackerIssueRefSchema,
  TrackerAppIdentitySchema,
  TrackerMissionContractSchema,
  type TrackerAppIdentity,
  type TrackerClient,
  type TrackerDriftReport,
  type TrackerEventAttribution,
  type TrackerIssue,
  type TrackerIssueMutation as TrackerIssueMutationType,
  type TrackerIssueRef,
  type TrackerMissionContract,
  type TrackerMirrorPort,
  type TrackerPolicyGateway,
  type TrackerWriteAction,
} from "./types.ts";

export class TrackerAuthorityConflictError extends Error {
  public readonly changedFields: readonly string[];

  public constructor(changedFields: readonly string[]) {
    super(`Mission plan conflicts with tracker authority: ${changedFields.join(", ")}`);
    this.name = "TrackerAuthorityConflictError";
    this.changedFields = changedFields;
  }
}

export class TrackerPolicyError extends Error {
  public readonly action: TrackerWriteAction;
  public readonly effect: "deny" | "require_approval";

  public constructor(action: TrackerWriteAction, effect: "deny" | "require_approval", reason: string) {
    super(`Tracker write ${action} was ${effect}: ${reason}`);
    this.name = "TrackerPolicyError";
    this.action = action;
    this.effect = effect;
  }
}

export class TrackerMirror implements TrackerMirrorPort {
  private readonly contracts = new Map<string, TrackerMissionContract>();
  private identity: TrackerAppIdentity | undefined;
  private readonly client: TrackerClient;
  private readonly policy: TrackerPolicyGateway;
  private readonly clock: () => Date;

  public constructor(
    client: TrackerClient,
    policy: TrackerPolicyGateway,
    clock: () => Date = () => new Date(),
  ) {
    this.client = client;
    this.policy = policy;
    this.clock = clock;
  }

  public async importMission(missionId: string, rawRef: TrackerIssueRef): Promise<TrackerMissionContract> {
    if (this.contracts.has(missionId)) throw new Error(`Mission ${missionId} is already tracker-bound`);
    const ref = TrackerIssueRefSchema.parse(rawRef);
    if (ref.connector !== this.client.connector) {
      throw new Error(`Tracker connector ${this.client.connector} cannot bind ${ref.connector}`);
    }
    const [source, appIdentity] = await Promise.all([this.client.getIssue(ref), this.getIdentity()]);
    const contract = TrackerMissionContractSchema.parse({
      schemaVersion: 1,
      missionId,
      source,
      appIdentity,
      importedAt: this.clock().toISOString(),
    });
    this.contracts.set(missionId, contract);
    return structuredClone(contract);
  }

  public restore(rawContract: TrackerMissionContract): void {
    const contract = TrackerMissionContractSchema.parse(rawContract);
    if (contract.source.ref.connector !== this.client.connector) {
      throw new Error(`Tracker contract requires unavailable connector ${contract.source.ref.connector}`);
    }
    this.contracts.set(contract.missionId, structuredClone(contract));
  }

  public validatePlan(plan: MissionPlan): void {
    const contract = this.contracts.get(plan.missionId);
    if (!contract) return;
    const changed: string[] = [];
    if (plan.goal !== contract.source.intent.title) changed.push("product_intent");
    if (!sameStrings(plan.successCriteria, contract.source.acceptanceCriteria)) {
      changed.push("acceptance_criteria");
    }
    if (changed.length > 0) throw new TrackerAuthorityConflictError(changed);
  }

  public async reconcile(missionId: string): Promise<TrackerDriftReport | undefined> {
    const contract = this.requireContract(missionId);
    const upstream = await this.client.getIssue(contract.source.ref);
    const changedFields: TrackerDriftReport["changedFields"] = [];
    if (!sameValue(contract.source.intent, upstream.intent)) changedFields.push("intent");
    if (!sameValue(contract.source.priority, upstream.priority)) changedFields.push("priority");
    if (!sameStrings(contract.source.acceptanceCriteria, upstream.acceptanceCriteria)) {
      changedFields.push("acceptanceCriteria");
    }
    if (changedFields.length === 0) return undefined;
    return {
      missionId,
      ref: structuredClone(contract.source.ref),
      baselineRevision: contract.source.revision,
      upstreamRevision: upstream.revision,
      changedFields,
      baseline: authoritativeFields(contract.source),
      upstream: authoritativeFields(upstream),
    };
  }

  public async publish(event: DomainEvent, attribution: TrackerEventAttribution): Promise<void> {
    const contract = this.contracts.get(event.missionId);
    if (!contract) return;
    await this.assertContractIdentity(contract);
    if (event.type === "worker.leased") {
      const key = eventKey(event, "assignment");
      await this.authorize("tracker.assignment.mirror", "reversible-write", contract, key);
      await this.client.mirrorAssignment({
        ref: contract.source.ref,
        appIdentityId: contract.appIdentity.id,
        idempotencyKey: key,
      });
    }
    const body = renderEventComment(event, attribution);
    if (!body) return;
    const key = eventKey(event, "comment");
    await this.authorize("tracker.comment.create", "reversible-write", contract, key);
    await this.client.postComment({ ref: contract.source.ref, body, idempotencyKey: key });
  }

  public async mutate(
    missionId: string,
    rawMutation: TrackerIssueMutationType,
    idempotencyKey: string,
  ): Promise<void> {
    const contract = this.requireContract(missionId);
    await this.assertContractIdentity(contract);
    const mutation = TrackerIssueMutationSchema.parse(rawMutation);
    if (!mutation.priority && !mutation.completionState) throw new Error("Tracker mutation is empty");
    if (mutation.priority) {
      await this.authorize("tracker.priority.update", "reversible-write", contract, idempotencyKey);
    }
    if (mutation.completionState) {
      await this.authorize("tracker.completion.update", "irreversible-write", contract, idempotencyKey);
    }
    await this.client.mutateIssue({ ref: contract.source.ref, mutation, idempotencyKey });
  }

  private async getIdentity(): Promise<TrackerAppIdentity> {
    this.identity ??= TrackerAppIdentitySchema.parse(await this.client.getAppIdentity());
    return this.identity;
  }

  private async assertContractIdentity(contract: TrackerMissionContract): Promise<void> {
    const identity = await this.getIdentity();
    if (identity.id !== contract.appIdentity.id) {
      throw new Error("Tracker app identity does not match the imported mission contract");
    }
  }

  private requireContract(missionId: string): TrackerMissionContract {
    const contract = this.contracts.get(missionId);
    if (!contract) throw new Error(`Mission ${missionId} has no tracker contract`);
    return contract;
  }

  private async authorize(
    action: TrackerWriteAction,
    riskClass: "reversible-write" | "irreversible-write",
    contract: TrackerMissionContract,
    idempotencyKey: string,
  ): Promise<void> {
    const decision = await this.policy.authorize({
      action,
      riskClass,
      missionId: contract.missionId,
      ref: contract.source.ref,
      idempotencyKey,
    });
    if (decision.effect !== "allow") throw new TrackerPolicyError(action, decision.effect, decision.reason);
  }
}

function renderEventComment(event: DomainEvent, attribution: TrackerEventAttribution): string | undefined {
  if (
    ![
      "mission.execution.started",
      "task.started",
      "task.blocked",
      "task.succeeded",
      "task.failed",
      "worker.settled",
      "mission.succeeded",
      "mission.failed",
      "tracker.drift.detected",
    ].includes(event.type)
  ) {
    return undefined;
  }
  const summary = eventSummary(event);
  const nativeSessions = attribution.nativeSessionIds?.length
    ? attribution.nativeSessionIds.join(", ")
    : "none";
  return [
    `### Clankie mission update · ${event.type}`,
    "",
    summary,
    "",
    "---",
    "Clankie worker attribution",
    `- missionId: \`${event.missionId}\``,
    `- taskId: ${event.taskId ? `\`${event.taskId}\`` : "none"}`,
    `- workerRunId: ${event.workerRunId ? `\`${event.workerRunId}\`` : "none"}`,
    `- role: \`${attribution.role}\``,
    `- nativeSessionIds: ${nativeSessions}`,
    `- eventId: \`${event.id}\``,
  ].join("\n");
}

function eventSummary(event: DomainEvent): string {
  const result = event.data.result;
  if (event.type === "worker.settled" && result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    const evidence = Array.isArray(record.evidence)
      ? record.evidence
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
          .map((entry) => `- ${String(entry.label ?? "Evidence")}: ${String(entry.summary ?? "recorded")}`)
      : [];
    return [
      String(record.summary ?? "Worker settled."),
      ...(evidence.length ? ["", "Evidence:", ...evidence] : []),
    ].join("\n");
  }
  if (event.type === "tracker.drift.detected") {
    const fields = Array.isArray(event.data.changedFields) ? event.data.changedFields.join(", ") : "unknown";
    return `Tracker authority drift detected in: ${fields}. The mission contract was not overwritten.`;
  }
  for (const key of ["summary", "reason", "title"] as const) {
    if (typeof event.data[key] === "string") return event.data[key];
  }
  return `Recorded ${event.type}.`;
}

function authoritativeFields(issue: TrackerIssue) {
  return structuredClone({
    intent: issue.intent,
    priority: issue.priority,
    acceptanceCriteria: issue.acceptanceCriteria,
  });
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function eventKey(event: DomainEvent, operation: string): string {
  return `clankie:${event.id}:${operation}`;
}
