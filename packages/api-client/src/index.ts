import {
  AdoptWorkerResultSchema,
  BrowserToolCatalogSchema,
  CallBrowserToolResultSchema,
  GenerateImageResultSchema,
  GenerateVideoResultSchema,
  MEDIA_IMAGE_GENERATION_PATH,
  MEDIA_VIDEO_GENERATION_PATH,
  type GenerateImageRequest,
  type GenerateImageResult,
  type GenerateVideoRequest,
  type GenerateVideoResult,
  type BrowserToolCatalog,
  type CallBrowserToolRequest,
  type CallBrowserToolResult,
  AgentCensusSchema,
  DirectAdoptedWorkerResultSchema,
  ApprovalRequestRecordSchema,
  ActionDecisionSchema,
  BodyPossessionReadSchema,
  CaptainChannelTurnResultSchema,
  CaptainPresenceReportSchema,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteResultSchema,
  DiscordPresenceWriteSchema,
  DiscordUserSessionOptInSchema,
  EmbodimentAssignmentSchema,
  EmbodimentSessionSchema,
  EmbodimentSubmitResultSchema,
  LinearChannelTurnRequestSchema,
  SlackChannelTurnRequestSchema,
  ActiveMissionSelectionSchema,
  MissionEventAuthFailureSchema,
  MissionEventRecoverySchema,
  MissionEventSnapshotSchema,
  MissionEventTailLineSchema,
  MissionPlanSchema,
  TrackerNarrativeWriteResultSchema,
  TrackerNarrativeWriteSchema,
  type ActionRequest,
  type ActiveMissionSelection,
  type AdoptWorkerRequest,
  type AdoptWorkerResult,
  type AgentCensus,
  type ApprovalDecisionInput,
  type DirectAdoptedWorkerRequest,
  type DirectAdoptedWorkerResult,
  type ReleaseWorkerAdoptionRequest,
  type ApprovalRequestRecord,
  type ApprovalRequestStatus,
  type BodyPossession,
  type CaptainPresenceReport,
  type DomainEvent,
  type CaptainChannelTurnResult,
  type DiscordPresenceWrite,
  type DiscordPresenceWriteResult,
  type DiscordPresenceChannelTurnRequest,
  type CaptainEpisode,
  type CaptainSessionLaneV2,
  type DiscordPersonIdentity,
  type DiscordPersonMemoryDeleteResult,
  type DiscordPersonMemoryExport,
  type DiscordPersonMemoryProjection,
  type DiscordPersonMemoryProposal,
  type DiscordUserSessionOptIn,
  type EmbodimentAssignment,
  type EmbodimentClaim,
  type EmbodimentIntent,
  type EmbodimentLifecycleReport,
  type EmbodimentSession,
  type EmbodimentSubmitResult,
  type LinearChannelTurnRequest,
  type SlackChannelTurnRequest,
  type MissionPlan,
  type MissionEventRecovery,
  type MissionEventSnapshot,
  type MissionFeedEvent,
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
  ActivityObservationReadSchema,
  DiscordPresencePhaseEventSchema,
  DiscordPresenceSessionRecordSchema,
  type DiscordPresenceLiveClaim,
  type DiscordPresencePhaseEvent,
  type DiscordPresenceSessionRecord,
  DiscordVoiceHistorySchema,
  type DiscordVoiceStay,
  type ActivityObservationRead,
} from "@clankie/interactive-environment";

export * from "./terminal-gateway.ts";
export type {
  ActivityObservationRead,
  ActivityObservationSnapshot,
  GbaActivityObservationSnapshot,
} from "@clankie/interactive-environment";

export interface ClankieApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  runnerToken?: string;
  runnerId?: string;
  captainToken?: string;
  operatorToken?: string;
  /** Paired-device session token used by Garden reads and finite worker steering. */
  deviceToken?: string;
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

export interface RunnerScopeReservation {
  id: string;
  workspaceRoot: string;
  writeScope: string[];
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

export type WorkerSteerPrincipal = {
  kind: "captain" | "operator" | "device";
  id: string;
};

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
  principal: WorkerSteerPrincipal;
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

export interface MissionEventResumeState {
  cursor: string;
  afterSourceSequence: number;
  lastEventId?: string;
}

export interface ObserveMissionEventsOptions {
  signal?: AbortSignal;
  reconnectDelayMs?: number;
  /** Resume an already-applied Garden projection without requesting another snapshot. */
  resume?: MissionEventResumeState;
}

export type MissionEventObservation =
  | { type: "snapshot"; snapshot: MissionEventSnapshot }
  | {
      type: "event";
      phase: "tail";
      event: MissionFeedEvent;
      resume: MissionEventResumeState;
    }
  | { type: "recovery"; recovery: MissionEventRecovery };

export type MissionEventFeedClientErrorCode =
  | "authentication_failed"
  | "feed_unavailable"
  | "identity_mismatch"
  | "duplicate_conflict"
  | "out_of_order"
  | "sequence_gap"
  | "tail_truncated";

export class MissionEventFeedClientError extends Error {
  public readonly code: MissionEventFeedClientErrorCode;

  public constructor(code: MissionEventFeedClientErrorCode) {
    super(MISSION_EVENT_CLIENT_MESSAGES[code]);
    this.name = "MissionEventFeedClientError";
    this.code = code;
  }
}

export interface DiscordControlPlaneReadiness {
  readonly schemaVersion: 1;
  readonly ready: boolean;
  readonly service: "clankie-control-plane";
  /** Changes every time the control-plane process starts; safe for restart evidence. */
  readonly instanceId: string;
  readonly profileHash: string;
  readonly checks: {
    readonly captainChannelTurns: boolean;
    readonly discordPresenceRuntime: boolean;
    readonly eventStore: boolean;
  };
}

/**
 * Realtime voice briefing request (ADR 0057). Ids only, deliberately: the
 * control plane's strict schema rejects any other key, so a bridge cannot
 * supply or widen persona, instructions, or person memory.
 */
export interface DiscordVoiceBriefingRequest {
  readonly schemaVersion: 1;
  readonly guildId: string;
  readonly channelId: string;
  /** Consented speaker ids (≤ 25, snowflake-shaped). */
  readonly consentedUserIds: readonly string[];
}

export interface DiscordVoiceBriefing {
  readonly schemaVersion: 1;
  /** Persona + lane + realtime surface rules, composed control-plane-side; ≤ 8000 chars. */
  readonly instructions: string;
  /** Bounded self-state, shareable episodes, and approved person memory; ≤ 8000 chars. */
  readonly briefing: string;
  readonly refreshedAt: string;
}

export class ClankieApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly runnerToken: string | undefined;
  private readonly runnerId: string;
  private readonly captainToken: string | undefined;
  private readonly operatorToken: string | undefined;
  private readonly deviceToken: string | undefined;

  public constructor(options: string | ClankieApiClientOptions) {
    this.baseUrl = typeof options === "string" ? options : options.baseUrl;
    this.fetchImpl = typeof options === "string" ? fetch : (options.fetchImpl ?? fetch);
    this.runnerToken = typeof options === "string" ? undefined : options.runnerToken;
    this.runnerId = typeof options === "string" ? "local" : (options.runnerId ?? "local");
    this.captainToken = typeof options === "string" ? undefined : options.captainToken;
    this.operatorToken = typeof options === "string" ? undefined : options.operatorToken;
    this.deviceToken = typeof options === "string" ? undefined : options.deviceToken;
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

  /** Discover the single event-store-selected mission currently presented by Garden. */
  public async discoverActiveMission(): Promise<ActiveMissionSelection> {
    const response = await this.fetchDevice("/v1/missions/active");
    await this.requireMissionEventSuccess(response);
    return ActiveMissionSelectionSchema.parse(await response.json());
  }

  /** Read the bounded current semantic snapshot or an explicit replacement outcome. */
  public async getMissionEventSnapshot(
    missionId: string,
  ): Promise<MissionEventSnapshot | MissionEventRecovery> {
    const response = await this.fetchDevice(`/v1/missions/${encodeURIComponent(missionId)}/events`);
    if (response.status === 409) return MissionEventRecoverySchema.parse(await response.json());
    await this.requireMissionEventSuccess(response);
    return MissionEventSnapshotSchema.parse(await response.json());
  }

  /**
   * Yield one bounded snapshot, then replay/tail from its opaque cursor. Normal
   * transport EOF reconnects from the last accepted cursor. Duplicate events
   * are suppressed; conflicting duplicates, regressions, and sequence gaps
   * fail closed before the Garden projection sees them.
   */
  public async *observeMissionEvents(
    missionId: string,
    options: ObserveMissionEventsOptions = {},
  ): AsyncIterable<MissionEventObservation> {
    const reconnectDelayMs = options.reconnectDelayMs ?? 250;
    if (!Number.isInteger(reconnectDelayMs) || reconnectDelayMs < 0 || reconnectDelayMs > 60_000) {
      throw new Error("Mission event reconnect delay must be between 0 and 60000 milliseconds");
    }
    let cursor: string;
    let lastSequence: number;
    let lastEventId: string | undefined;
    const seen = new Map<number, string>();
    if (options.resume) {
      cursor = options.resume.cursor;
      lastSequence = options.resume.afterSourceSequence;
      lastEventId = options.resume.lastEventId;
      if (lastEventId) seen.set(lastSequence, lastEventId);
    } else {
      const snapshot = await this.getMissionEventSnapshot(missionId);
      if (snapshot.outcome !== "snapshot") {
        yield { type: "recovery", recovery: snapshot };
        return;
      }
      validateMissionSnapshot(missionId, snapshot);
      cursor = snapshot.nextCursor;
      lastSequence = snapshot.resumeAfterSourceSequence;
      lastEventId = snapshot.events.at(-1)?.eventId;
      for (const event of snapshot.events) seen.set(event.sourceSequence, event.eventId);
      yield { type: "snapshot", snapshot };
    }

    while (!options.signal?.aborted) {
      let response: Response;
      try {
        response = await this.fetchDevice(
          `/v1/missions/${encodeURIComponent(missionId)}/events/tail?cursor=${encodeURIComponent(cursor)}`,
          options.signal ? { signal: options.signal } : undefined,
        );
      } catch (error) {
        if (options.signal?.aborted) return;
        throw error;
      }
      if (response.status === 409) {
        yield { type: "recovery", recovery: MissionEventRecoverySchema.parse(await response.json()) };
        return;
      }
      await this.requireMissionEventSuccess(response);
      if (!response.body) throw new MissionEventFeedClientError("tail_truncated");
      for await (const line of parseMissionEventNdjson(response.body)) {
        if (line.type === "mission_event.recovery") {
          yield { type: "recovery", recovery: line.recovery };
          return;
        }
        if (line.type === "mission_event.auth_failed") {
          throw new MissionEventFeedClientError("authentication_failed");
        }
        const event = line.event;
        if (event.missionId !== missionId) throw new MissionEventFeedClientError("identity_mismatch");
        if (event.sourceSequence <= lastSequence) {
          if (seen.get(event.sourceSequence) === event.eventId) {
            cursor = line.cursor;
            continue;
          }
          throw new MissionEventFeedClientError(
            seen.has(event.sourceSequence) ? "duplicate_conflict" : "out_of_order",
          );
        }
        if (event.previousSourceSequence !== lastSequence) {
          throw new MissionEventFeedClientError("sequence_gap");
        }
        lastSequence = event.sourceSequence;
        lastEventId = event.eventId;
        cursor = line.cursor;
        seen.set(lastSequence, lastEventId);
        pruneSeenSequences(seen, 1_024);
        yield {
          type: "event",
          phase: "tail",
          event,
          resume: { cursor, afterSourceSequence: lastSequence, lastEventId },
        };
      }
      if (options.signal?.aborted) return;
      await waitForReconnect(reconnectDelayMs, options.signal);
    }
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

  /** Submits a bounded Slack thread turn; the thread is the conversation address (ADR 0080). */
  public async submitSlackCaptainChannelTurn(
    input: SlackChannelTurnRequest,
  ): Promise<CaptainChannelTurnResult> {
    const request = SlackChannelTurnRequestSchema.parse(input);
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
    // Approval-required (and kin) come back as an error-shaped body, not a
    // write result; surfacing the reason beats a result-schema parse spray.
    if (result !== null && typeof result === "object" && "error" in result) {
      throw new Error(String((result as { error: unknown }).error));
    }
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

  /**
   * Reads the durable owner opt-in for the user-session transport (ADR 0048).
   *
   * The user-session bridge calls this *before* connecting, so a missing or
   * revoked record keeps the process from ever opening a gateway with a normal
   * user credential. `undefined` means no opt-in exists for this doctrine.
   */
  public async inspectDiscordUserSessionOptIn(): Promise<DiscordUserSessionOptIn | undefined> {
    const result = await this.request<{ optIn: unknown | null }>("/v1/discord/user-session/opt-in", {
      headers: this.captainHeaders(),
    });
    return result.optIn === null || result.optIn === undefined
      ? undefined
      : DiscordUserSessionOptInSchema.parse(result.optIn);
  }

  public async listDiscordPresenceSessions(): Promise<DiscordPresenceSessionRecord[]> {
    const result = await this.request<unknown>("/v1/discord/presence-sessions", {
      headers: this.captainHeaders(),
    });
    return DiscordPresenceSessionRecordSchema.array().parse(result);
  }

  /**
   * Completed voice stays with join-time room context (VUH-940) — where
   * Clankie's body was, when, and who shared the channel. A read-side
   * projection over the durable phase stream; nothing is written.
   */
  public async listDiscordVoiceHistory(limit?: number): Promise<DiscordVoiceStay[]> {
    const query = limit === undefined ? "" : `?limit=${String(limit)}`;
    const result = await this.request<unknown>(`/v1/discord/voice-history${query}`, {
      headers: this.captainHeaders(),
    });
    return DiscordVoiceHistorySchema.parse(result).stays;
  }

  public inspectDiscordReadiness(): Promise<DiscordControlPlaneReadiness> {
    return this.request("/v1/discord/readiness", {
      headers: this.captainHeaders(),
    });
  }

  /**
   * Fetches the control-plane-composed realtime voice session briefing
   * (ADR 0057) through the authenticated captain lane. The request carries only
   * ids; persona, lane instructions, self-state, episodes, and approved person
   * memory are all resolved from control-plane-owned stores.
   */
  public async fetchDiscordVoiceBriefing(input: DiscordVoiceBriefingRequest): Promise<DiscordVoiceBriefing> {
    const briefing = await this.request<DiscordVoiceBriefing>("/v1/discord/voice-briefing", {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(input),
    });
    if (
      briefing.schemaVersion !== 1 ||
      typeof briefing.instructions !== "string" ||
      typeof briefing.briefing !== "string" ||
      typeof briefing.refreshedAt !== "string"
    ) {
      throw new Error("Clankie API returned a malformed Discord voice briefing");
    }
    return briefing;
  }

  public proposeDiscordPersonMemory(input: DiscordPersonMemoryProposal): Promise<Record<string, unknown>> {
    return this.request("/v1/memory/discord-people/proposals", {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(input),
    });
  }

  public recallDiscordPersonMemory(
    identity: DiscordPersonIdentity,
    options: { readonly channelId?: string; readonly query?: string } = {},
  ): Promise<DiscordPersonMemoryProjection> {
    const query = new URLSearchParams();
    if (options.channelId !== undefined) query.set("channelId", options.channelId);
    if (options.query !== undefined) query.set("query", options.query);
    const suffix = query.size === 0 ? "" : `?${query.toString()}`;
    return this.request(
      `/v1/memory/discord-people/${encodeURIComponent(identity.guildId)}/${encodeURIComponent(identity.userId)}${suffix}`,
      { headers: this.captainHeaders() },
    );
  }

  public recordCaptainEpisode(episode: CaptainEpisode): Promise<{ episodeId: string }> {
    return this.request("/v1/memory/captain-episodes", {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(episode),
    });
  }

  /**
   * The lane is the recall scope, so it must come from the eve channel the
   * control plane stamped — never from anything the model chose. There is
   * deliberately no tool wrapping this call.
   */
  public recallCaptainEpisodes(lane: CaptainSessionLaneV2): Promise<{ recallCard: string }> {
    return this.request(`/v1/memory/captain-episodes?lane=${encodeURIComponent(lane)}`, {
      headers: this.captainHeaders(),
    });
  }

  public exportDiscordPersonMemory(identity: DiscordPersonIdentity): Promise<DiscordPersonMemoryExport> {
    return this.request(
      `/v1/memory/discord-people/${encodeURIComponent(identity.guildId)}/${encodeURIComponent(identity.userId)}/export`,
      { headers: this.operatorHeaders() },
    );
  }

  public deleteDiscordPersonMemory(
    identity: DiscordPersonIdentity,
  ): Promise<DiscordPersonMemoryDeleteResult> {
    return this.request(
      `/v1/memory/discord-people/${encodeURIComponent(identity.guildId)}/${encodeURIComponent(identity.userId)}`,
      { method: "DELETE", headers: this.operatorHeaders() },
    );
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
    reservations: readonly RunnerScopeReservation[] = [],
  ): Promise<RunnerAssignment | undefined> {
    const response = await this.request<{ assignment: RunnerAssignment } | undefined>("/v1/runner/claims", {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify({ claimId, workers, reservations }),
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

  /** Submit an asked-play intent (ADR 0063); the control plane answers with the typed outcome. */
  public async submitEmbodimentIntent(intent: EmbodimentIntent): Promise<EmbodimentSubmitResult> {
    const result = await this.request<unknown>("/v1/embodiment/intents", {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(intent),
    });
    return EmbodimentSubmitResultSchema.parse(result);
  }

  public async getEmbodimentSession(sessionId: string): Promise<EmbodimentSession | undefined> {
    const response = await this.fetchImpl(
      new URL(`/v1/embodiment/sessions/${encodeURIComponent(sessionId)}`, this.baseUrl),
      { headers: { "content-type": "application/json", ...this.captainHeaders() } },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Clankie API ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as { session: unknown };
    return EmbodimentSessionSchema.parse(body.session);
  }

  /** The single non-terminal asked session, if one exists: one body, one driver. */
  public async getLiveEmbodimentSession(): Promise<EmbodimentSession | undefined> {
    const headers = this.captainToken !== undefined ? this.captainHeaders() : this.runnerHeaders();
    const body = await this.request<{ session: unknown }>("/v1/embodiment/sessions/live", { headers });
    if (body.session === null || body.session === undefined) return undefined;
    return EmbodimentSessionSchema.parse(body.session);
  }

  /** Latest settled state of Clankie's own active activity, without another lane's transcript. */
  public async getCurrentActivityObservation(): Promise<ActivityObservationRead> {
    const body = await this.request<unknown>("/v1/embodiment/sessions/live/activity", {
      headers: this.activityReadHeaders(),
    });
    return ActivityObservationReadSchema.parse(body);
  }

  /**
   * Which agents are running on this machine (ADR 0078), including ones this
   * fleet did not start. `transportAvailable: false` means he could not look —
   * never that the machine is quiet.
   */
  /**
   * The doctrine-projected catalog of Clankie's own browser (ADR 0082).
   * `available: false` means the host could not be reached — never that he has
   * no browser.
   */
  public async listBrowserTools(): Promise<BrowserToolCatalog> {
    const body = await this.request<{ catalog: unknown }>("/v1/browser/tools", {
      headers: this.activityReadHeaders(),
    });
    return BrowserToolCatalogSchema.parse(body.catalog);
  }

  /**
   * Drive one browser tool. An approval-class tool called with only a captain
   * token comes back `refused` with `approval_required`, which he relays
   * rather than treats as a failure.
   */
  public async callBrowserTool(request: CallBrowserToolRequest): Promise<CallBrowserToolResult> {
    const body = await this.request<{ result: unknown }>("/v1/browser/call", {
      method: "POST",
      headers: this.activityReadHeaders(),
      body: JSON.stringify(request),
    });
    return CallBrowserToolResultSchema.parse(body.result);
  }

  /**
   * Draw something, or edit something he already drew (ADR 0085). The provider
   * and model are operator config, so the request only says what to make.
   */
  public async generateImage(request: GenerateImageRequest): Promise<GenerateImageResult> {
    const body = await this.request<{ result: unknown }>(MEDIA_IMAGE_GENERATION_PATH, {
      method: "POST",
      headers: this.activityReadHeaders(),
      body: JSON.stringify(request),
    });
    return GenerateImageResultSchema.parse(body.result);
  }

  /**
   * Render a clip, or pick up one already rendering. A `pending` result is the
   * normal shape for a render that outlasts the call's patience: the same
   * method with its `requestId` resumes rather than paying to render twice.
   */
  public async generateVideo(request: GenerateVideoRequest): Promise<GenerateVideoResult> {
    const body = await this.request<{ result: unknown }>(MEDIA_VIDEO_GENERATION_PATH, {
      method: "POST",
      headers: this.activityReadHeaders(),
      body: JSON.stringify(request),
    });
    return GenerateVideoResultSchema.parse(body.result);
  }

  public async getAgentCensus(): Promise<AgentCensus> {
    const body = await this.request<{ census: unknown }>("/v1/agents/census", {
      headers: this.activityReadHeaders(),
    });
    return AgentCensusSchema.parse(body.census);
  }

  /**
   * Take bounded responsibility for an agent this fleet did not start. A
   * `directed` grade needs an operator token; a captain token alone comes back
   * refused with `approval_required` rather than throwing, because being told
   * no is a normal outcome he should be able to relay.
   */
  public async adoptAgent(request: AdoptWorkerRequest): Promise<AdoptWorkerResult> {
    const body = await this.request<{ result: unknown }>("/v1/agents/adopt", {
      method: "POST",
      headers: this.activityReadHeaders(),
      body: JSON.stringify(request),
    });
    return AdoptWorkerResultSchema.parse(body.result);
  }

  /**
   * Send bounded steering text to an adopted agent. Refusals are typed results,
   * not throws: `binding_lapsed` means the agent that was there has been
   * replaced, which is a normal thing to report rather than an error.
   */
  public async directAdoptedAgent(request: DirectAdoptedWorkerRequest): Promise<DirectAdoptedWorkerResult> {
    const body = await this.request<{ result: unknown }>("/v1/agents/direct", {
      method: "POST",
      headers: this.activityReadHeaders(),
      body: JSON.stringify(request),
    });
    return DirectAdoptedWorkerResultSchema.parse(body.result);
  }

  /** Give an adopted agent back. */
  public async releaseAgentAdoption(request: ReleaseWorkerAdoptionRequest): Promise<void> {
    await this.request("/v1/agents/release", {
      method: "POST",
      headers: this.activityReadHeaders(),
      body: JSON.stringify(request),
    });
  }

  /**
   * Who holds Clankie's body right now (VUH-938): a liveness-checked view of
   * the cross-process body lock, which sees every suitor — including an MCP
   * possessor no embodiment session ever recorded. `undefined` means nobody.
   */
  public async getBodyPossession(): Promise<BodyPossession | undefined> {
    const body = await this.request<unknown>("/v1/embodiment/possession", {
      headers: this.captainHeaders(),
    });
    return BodyPossessionReadSchema.parse(body).possession ?? undefined;
  }

  public async claimEmbodiment(claim: EmbodimentClaim): Promise<EmbodimentAssignment | undefined> {
    const response = await this.request<{ assignment: unknown } | undefined>("/v1/embodiment/claims", {
      method: "POST",
      headers: this.runnerHeaders(),
      body: JSON.stringify(claim),
      // A claim is one cheap poll on a 1s cadence. Without a bound, one
      // request hung across a control-plane restart wedges the entire claim
      // loop silently — the runner looks alive and claims nothing forever.
      signal: AbortSignal.timeout(10_000),
    });
    if (response === undefined) return undefined;
    return EmbodimentAssignmentSchema.parse(response.assignment);
  }

  public async reportEmbodiment(report: EmbodimentLifecycleReport): Promise<EmbodimentSession> {
    const result = await this.request<{ accepted: boolean; session: unknown }>(
      `/v1/embodiment/sessions/${encodeURIComponent(report.sessionId)}/report`,
      {
        method: "POST",
        headers: this.runnerHeaders(),
        body: JSON.stringify(report),
        // Lifecycle reporting is safety-critical, but it cannot wedge the
        // runner forever when the control plane disappears mid-shutdown.
        signal: AbortSignal.timeout(10_000),
      },
    );
    return EmbodimentSessionSchema.parse(result.session);
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
    const token = this.captainToken ?? this.operatorToken ?? this.deviceToken;
    if (!token) {
      throw new Error("A captain, operator, or paired-device token is required for worker steering");
    }
    return { authorization: `Bearer ${token}` };
  }

  private operatorHeaders(): Record<string, string> {
    if (!this.operatorToken) {
      throw new Error("CLANKIE_OPERATOR_TOKEN is required for approval decisions");
    }
    return { authorization: `Bearer ${this.operatorToken}` };
  }

  private activityReadHeaders(): Record<string, string> {
    const token = this.captainToken ?? this.operatorToken;
    if (!token) {
      throw new Error("A captain or operator token is required for activity observation");
    }
    return { authorization: `Bearer ${token}` };
  }

  private deviceHeaders(): Record<string, string> {
    if (!this.deviceToken) {
      throw new Error("A paired device session token is required for mission event reads");
    }
    return { authorization: `Bearer ${this.deviceToken}` };
  }

  private fetchDevice(path: string, init?: RequestInit): Promise<Response> {
    return this.fetchImpl(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        ...this.deviceHeaders(),
        accept: "application/json, application/x-ndjson",
        ...init?.headers,
      },
    });
  }

  private async requireMissionEventSuccess(response: Response): Promise<void> {
    if (response.ok) return;
    if (response.status === 401 || response.status === 403) {
      MissionEventAuthFailureSchema.parse(await response.json());
      throw new MissionEventFeedClientError("authentication_failed");
    }
    throw new MissionEventFeedClientError("feed_unavailable");
  }
}

const MISSION_EVENT_CLIENT_MESSAGES: Record<MissionEventFeedClientErrorCode, string> = {
  authentication_failed: "Mission event authentication failed",
  feed_unavailable: "Mission event feed is unavailable",
  identity_mismatch: "Mission event identity does not match the selected mission",
  duplicate_conflict: "Mission event sequence was reused for different content",
  out_of_order: "Mission event delivery regressed out of canonical order",
  sequence_gap: "Mission event delivery contains a sequence gap",
  tail_truncated: "Mission event tail ended without a readable stream",
};

function validateMissionSnapshot(missionId: string, snapshot: MissionEventSnapshot): void {
  if (snapshot.mission.missionId !== missionId) throw new MissionEventFeedClientError("identity_mismatch");
  let previous = -1;
  const eventIds = new Set<string>();
  for (const event of snapshot.events) {
    if (event.missionId !== missionId) throw new MissionEventFeedClientError("identity_mismatch");
    if (event.sourceSequence <= previous) throw new MissionEventFeedClientError("out_of_order");
    if (eventIds.has(event.eventId)) throw new MissionEventFeedClientError("duplicate_conflict");
    eventIds.add(event.eventId);
    previous = event.sourceSequence;
  }
  const last = snapshot.events.at(-1)?.sourceSequence;
  if (last !== undefined && last !== snapshot.resumeAfterSourceSequence) {
    throw new MissionEventFeedClientError("sequence_gap");
  }
}

async function* parseMissionEventNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<ReturnType<typeof MissionEventTailLineSchema.parse>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    while (true) {
      const next = await reader.read();
      buffered += decoder.decode(next.value, { stream: !next.done });
      let boundary = buffered.indexOf("\n");
      while (boundary >= 0) {
        const line = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 1);
        if (line) yield MissionEventTailLineSchema.parse(JSON.parse(line));
        boundary = buffered.indexOf("\n");
      }
      if (next.done) break;
    }
    if (buffered.trim()) throw new MissionEventFeedClientError("tail_truncated");
  } finally {
    reader.releaseLock();
  }
}

function pruneSeenSequences(seen: Map<number, string>, limit: number): void {
  while (seen.size > limit) {
    const oldest = seen.keys().next().value as number | undefined;
    if (oldest === undefined) return;
    seen.delete(oldest);
  }
}

function waitForReconnect(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (delayMs === 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(settle, delayMs);
    function settle() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", settle);
      resolve();
    }
    signal?.addEventListener("abort", settle, { once: true });
  });
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
