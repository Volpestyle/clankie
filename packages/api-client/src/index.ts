import {
  ApprovalRequestRecordSchema,
  ActionDecisionSchema,
  CaptainChannelTurnResultSchema,
  CaptainPresenceReportSchema,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteResultSchema,
  DiscordPresenceWriteSchema,
  LinearChannelTurnRequestSchema,
  MissionPlanSchema,
  TrackerNarrativeWriteResultSchema,
  TrackerNarrativeWriteSchema,
  type ActionRequest,
  type ApprovalDecisionInput,
  type ApprovalRequestRecord,
  type ApprovalRequestStatus,
  type CaptainPresenceReport,
  type DomainEvent,
  type CaptainChannelTurnResult,
  type DiscordPresenceWrite,
  type DiscordPresenceWriteResult,
  type DiscordPresenceChannelTurnRequest,
  type LinearChannelTurnRequest,
  type MissionPlan,
  type TaskSpec,
  type TrackerNarrativeWrite,
  type TrackerNarrativeWriteResult,
  type WorkerResult,
} from "@clankie/protocol";
import {
  DISCORD_PRESENCE_LIVE_PHASE_HEADER,
  DISCORD_PRESENCE_LIVE_REVISION_HEADER,
  DISCORD_PRESENCE_LIVE_SESSION_HEADER,
  DiscordPresenceLiveClaimSchema,
  DiscordPresencePhaseEventSchema,
  DiscordPresenceSessionRecordSchema,
  type DiscordPresenceLiveClaim,
  type DiscordPresencePhaseEvent,
  type DiscordPresenceSessionRecord,
} from "@clankie/interactive-environment";

export * from "./terminal-gateway.ts";

export interface ClankieApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  runnerToken?: string;
  runnerId?: string;
  captainToken?: string;
  operatorToken?: string;
}

export interface RunnerWorkerDescriptor {
  id: string;
  displayName: string;
  harness: "codex" | "claude" | "pi" | "local" | "shell" | "simulated";
  model?: string;
  capabilities: {
    kinds: TaskSpec["kind"][];
    canWrite: boolean;
    supportsStructuredEvents: boolean;
    supportsTerminal: boolean;
    supportsNativeSession: boolean;
  };
}

export interface RunnerAssignment {
  missionId: string;
  profileHash: string;
  workerRunId: string;
  attempt: number;
  task: TaskSpec;
  worker: RunnerWorkerDescriptor;
  runnerId: string;
  leaseExpiresAt: string;
}

export type WorkerSteerSourceLane = "tui" | "discord_text" | "discord_voice" | "api";

export type WorkerSteerIntent =
  | {
      type: "focus";
      target: "current_task" | "failing_test" | "acceptance_criteria" | "scope" | "diagnosis";
    }
  | { type: "continue" }
  | { type: "retry_last_step" }
  | { type: "summarize_status" };

export interface WorkerSteerRequest {
  schemaVersion: 1;
  commandId: string;
  correlationId: string;
  intent: WorkerSteerIntent;
}

export interface WorkerSteerCommand {
  schemaVersion: 1;
  commandId: string;
  workerRunId: string;
  attempt: number;
  sourceLane: WorkerSteerSourceLane;
  intent: WorkerSteerIntent;
  principal: { kind: "captain" | "operator"; id: string };
  correlationId: string;
  missionId: string;
  taskId: string;
  profileHash: string;
  input: string;
}

export type WorkerSteerOutcomeCode =
  | "delivered"
  | "stale_attempt"
  | "wrong_runner"
  | "worker_terminal"
  | "lease_expired"
  | "unsupported_adapter"
  | "human_control_active"
  | "delivery_failed";

export interface WorkerSteerOutcome {
  code: WorkerSteerOutcomeCode;
  message: string;
}

export interface WorkerSteerSubmission {
  accepted: true;
  command: Record<string, unknown>;
}

export interface RecoveryPairRequest {
  commandId: string;
  failedTaskId: string;
  debugger: TaskSpec;
  reverify: TaskSpec;
}

export interface ControlPlaneHealth {
  ok: true;
  service: "clankie-control-plane";
  doctrine: string;
  profileHash: string;
}

export class ClankieApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly runnerToken: string | undefined;
  private readonly runnerId: string;
  private readonly captainToken: string | undefined;
  private readonly operatorToken: string | undefined;

  public constructor(options: string | ClankieApiClientOptions) {
    this.baseUrl = typeof options === "string" ? options : options.baseUrl;
    this.fetchImpl = typeof options === "string" ? fetch : (options.fetchImpl ?? fetch);
    this.runnerToken = typeof options === "string" ? undefined : options.runnerToken;
    this.runnerId = typeof options === "string" ? "local" : (options.runnerId ?? "local");
    this.captainToken = typeof options === "string" ? undefined : options.captainToken;
    this.operatorToken = typeof options === "string" ? undefined : options.operatorToken;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Clankie API ${response.status}: ${await response.text()}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  public async createMission(input: {
    goal: string;
    context?: Record<string, unknown>;
    doctrineId?: string;
  }): Promise<{ missionId: string }> {
    return this.request("/v1/missions", { method: "POST", body: JSON.stringify(input) });
  }

  public async proposePlan(missionId: string, plan: MissionPlan): Promise<MissionPlan> {
    const result = await this.request<unknown>(`/v1/missions/${missionId}/plan`, {
      method: "PUT",
      body: JSON.stringify(plan),
    });
    return MissionPlanSchema.parse(result);
  }

  public async startMission(missionId: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/missions/${missionId}/start`, {
      method: "POST",
      headers: this.captainHeaders(),
    });
  }

  public async addRecovery(
    missionId: string,
    recovery: RecoveryPairRequest,
  ): Promise<Record<string, unknown>> {
    return this.request(`/v1/missions/${missionId}/recovery`, {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(recovery),
    });
  }

  public async recordCaptainPresence(input: CaptainPresenceReport): Promise<Record<string, unknown>> {
    const report = CaptainPresenceReportSchema.parse(input);
    return this.request("/v1/captain/presence", {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(report),
    });
  }

  public async getMission(missionId: string): Promise<Record<string, unknown>> {
    return this.request(`/v1/missions/${missionId}`);
  }

  public async getHealth(): Promise<ControlPlaneHealth> {
    return this.request<ControlPlaneHealth>("/health");
  }

  public async requestAction(input: ActionRequest) {
    const result = await this.request<unknown>("/v1/actions/decide", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return ActionDecisionSchema.parse(result);
  }

  /** Submits an already bounded Linear turn; the control plane reads the trusted full thread. */
  public async submitCaptainChannelTurn(input: LinearChannelTurnRequest): Promise<CaptainChannelTurnResult> {
    const request = LinearChannelTurnRequestSchema.parse(input);
    const result = await this.request<unknown>("/v1/captain/channel-turns", {
      method: "POST",
      body: JSON.stringify(request),
    });
    return CaptainChannelTurnResultSchema.parse(result);
  }

  /** Submits a bounded, ambient Discord text turn through the authenticated captain lane. */
  public async submitDiscordCaptainChannelTurn(
    input: DiscordPresenceChannelTurnRequest,
  ): Promise<CaptainChannelTurnResult> {
    const request = DiscordPresenceChannelTurnRequestSchema.parse(input);
    const result = await this.request<unknown>("/v1/captain/channel-turns", {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(request),
    });
    return CaptainChannelTurnResultSchema.parse(result);
  }

  /** Requests a policy-evaluated narrative write without exposing tracker credentials. */
  public async writeTrackerNarrative(input: TrackerNarrativeWrite): Promise<TrackerNarrativeWriteResult> {
    const write = TrackerNarrativeWriteSchema.parse(input);
    const result = await this.request<unknown>("/v1/tracker/narratives", {
      method: "POST",
      body: JSON.stringify(write),
    });
    return TrackerNarrativeWriteResultSchema.parse(result);
  }

  /**
   * Requests a policy-evaluated action gated by the bridge-owned Discord presence session.
   * Bot credentials stay behind the credential broker used by the trusted presence runtime module.
   */
  public async executeDiscordPresenceAction(
    input: DiscordPresenceWrite,
    liveClaim: DiscordPresenceLiveClaim,
  ): Promise<DiscordPresenceWriteResult> {
    const write = DiscordPresenceWriteSchema.parse(input);
    const claim = DiscordPresenceLiveClaimSchema.parse(liveClaim);
    const result = await this.request<unknown>("/v1/discord/presence-actions", {
      method: "POST",
      headers: {
        ...this.captainHeaders(),
        [DISCORD_PRESENCE_LIVE_SESSION_HEADER]: claim.sessionId,
        [DISCORD_PRESENCE_LIVE_PHASE_HEADER]: claim.phase,
        [DISCORD_PRESENCE_LIVE_REVISION_HEADER]: String(claim.revision),
      },
      body: JSON.stringify(write),
    });
    return DiscordPresenceWriteResultSchema.parse(result);
  }

  /** Publishes a bridge-owned gateway/voice phase transition to the semantic control plane. */
  public async recordDiscordPresencePhase(
    input: DiscordPresencePhaseEvent,
  ): Promise<{ accepted: boolean; session: DiscordPresenceSessionRecord }> {
    const event = DiscordPresencePhaseEventSchema.parse(input);
    const result = await this.request<{
      accepted: boolean;
      session: unknown;
    }>("/v1/discord/presence-session-events", {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(event),
    });
    return {
      accepted: result.accepted,
      session: DiscordPresenceSessionRecordSchema.parse(result.session),
    };
  }

  public async listDiscordPresenceSessions(): Promise<DiscordPresenceSessionRecord[]> {
    const result = await this.request<unknown>("/v1/discord/presence-sessions", {
      headers: this.captainHeaders(),
    });
    return DiscordPresenceSessionRecordSchema.array().parse(result);
  }

  public async listApprovals(status: ApprovalRequestStatus = "pending"): Promise<ApprovalRequestRecord[]> {
    const result = await this.request<unknown>(`/v1/approvals?status=${encodeURIComponent(status)}`, {
      headers: this.operatorHeaders(),
    });
    return ApprovalRequestRecordSchema.array().parse(result);
  }

  public async decideApproval(
    approvalId: string,
    input: ApprovalDecisionInput,
  ): Promise<ApprovalRequestRecord> {
    const result = await this.request<unknown>(`/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
      method: "POST",
      headers: this.operatorHeaders(),
      body: JSON.stringify(input),
    });
    return ApprovalRequestRecordSchema.parse(result);
  }

  public async steerWorker(
    workerRunId: string,
    input: string | WorkerSteerIntent | WorkerSteerRequest,
  ): Promise<WorkerSteerSubmission> {
    const request =
      typeof input === "string"
        ? {
            schemaVersion: 1 as const,
            commandId: crypto.randomUUID(),
            correlationId: crypto.randomUUID(),
            intent: parseLegacyWorkerSteerIntent(input),
          }
        : "schemaVersion" in input
          ? input
          : {
              schemaVersion: 1 as const,
              commandId: crypto.randomUUID(),
              correlationId: crypto.randomUUID(),
              intent: input,
            };
    return this.request(`/v1/workers/${workerRunId}/steer`, {
      method: "POST",
      headers: this.steerHeaders(),
      body: JSON.stringify(request),
    });
  }

  public async claimSteerCommand(
    workerRunId: string,
    attempt: number,
  ): Promise<WorkerSteerCommand | undefined> {
    const response = await this.request<{ command: WorkerSteerCommand } | undefined>(
      "/v1/runner/steering/claim",
      {
        method: "POST",
        headers: this.runnerHeaders(),
        body: JSON.stringify({ workerRunId, attempt }),
      },
    );
    return response?.command;
  }

  public async settleSteerCommand(
    commandId: string,
    workerRunId: string,
    attempt: number,
    outcome: WorkerSteerOutcome,
  ): Promise<Record<string, unknown>> {
    return this.request("/v1/runner/steering/settle", {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify({ commandId, workerRunId, attempt, outcome }),
    });
  }

  public async claimTask(
    claimId: string,
    workers: readonly RunnerWorkerDescriptor[],
  ): Promise<RunnerAssignment | undefined> {
    const response = await this.request<{ assignment: RunnerAssignment } | undefined>("/v1/runner/claims", {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify({ claimId, workers }),
    });
    return response?.assignment;
  }

  public async recordWorkerEvent(
    workerRunId: string,
    input: { attempt: number; eventId: string; type: string; data: Record<string, unknown> },
  ): Promise<{ accepted: boolean; event: DomainEvent }> {
    return this.request(`/v1/runner/workers/${workerRunId}/events`, {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify(input),
    });
  }

  public async settleWorker(
    workerRunId: string,
    attempt: number,
    result: WorkerResult,
  ): Promise<Record<string, unknown>> {
    return this.request(`/v1/runner/workers/${workerRunId}/settle`, {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify({ attempt, result }),
    });
  }

  public async heartbeatWorker(workerRunId: string, attempt: number): Promise<Record<string, unknown>> {
    return this.request(`/v1/runner/workers/${workerRunId}/heartbeat`, {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify({ attempt }),
    });
  }

  private runnerHeaders(): Record<string, string> {
    if (!this.runnerToken) throw new Error("CLANKIE_RUNNER_TOKEN is required for runner execution");
    return {
      authorization: `Bearer ${this.runnerToken}`,
      "x-clankie-runner-id": this.runnerId,
    };
  }

  private captainHeaders(): Record<string, string> {
    if (!this.captainToken) {
      throw new Error("CLANKIE_CAPTAIN_TOKEN is required for captain execution");
    }
    return { authorization: `Bearer ${this.captainToken}` };
  }

  private steerHeaders(): Record<string, string> {
    const token = this.captainToken ?? this.operatorToken;
    if (!token) throw new Error("A captain or operator token is required for worker steering");
    return { authorization: `Bearer ${token}` };
  }

  private operatorHeaders(): Record<string, string> {
    if (!this.operatorToken) {
      throw new Error("CLANKIE_OPERATOR_TOKEN is required for approval decisions");
    }
    return { authorization: `Bearer ${this.operatorToken}` };
  }
}

/**
 * Compatibility for callers that have not yet migrated to the finite intent
 * picker. Only canonical, non-privileged phrases map to typed steering.
 */
export function parseLegacyWorkerSteerIntent(input: string): WorkerSteerIntent {
  const intent = LEGACY_WORKER_STEER_INTENTS.get(input.trim().toLowerCase());
  if (!intent) {
    throw new Error(
      "Free-form worker steering is unsupported; select a typed focus, continue, retry, or status intent",
    );
  }
  return structuredClone(intent);
}

const LEGACY_WORKER_STEER_INTENTS = new Map<string, WorkerSteerIntent>([
  ["focus on the current task.", { type: "focus", target: "current_task" }],
  ["focus on the failing test.", { type: "focus", target: "failing_test" }],
  ["focus on the failing unit test first.", { type: "focus", target: "failing_test" }],
  ["focus only on the failing test.", { type: "focus", target: "failing_test" }],
  ["focus on the exact failing assertion.", { type: "focus", target: "failing_test" }],
  ["inspect the exact failing assertion.", { type: "focus", target: "failing_test" }],
  ["focus on the acceptance criteria.", { type: "focus", target: "acceptance_criteria" }],
  ["focus on scope.", { type: "focus", target: "scope" }],
  ["focus on diagnosis.", { type: "focus", target: "diagnosis" }],
  ["continue.", { type: "continue" }],
  ["retry the last step.", { type: "retry_last_step" }],
  ["summarize status.", { type: "summarize_status" }],
]);
