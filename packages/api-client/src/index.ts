import {
  MinecraftHostCommandSchema,
  type MinecraftHostCommand,
  parseProtocolResponse,
  safeParseProtocolResponse,
} from "@clankie/protocol";
export * from "./discord-setup.ts";
import {
  ISSUE_METRICS_PATH,
  IssueMetricsQuerySchema,
  IssueMetricsReportSchema,
  type IssueMetricsQuery,
  type IssueMetricsReport,
  DISCORD_DIRECTORY_PATH,
  DiscordDirectoryRequestSchema,
  DiscordDirectorySnapshotSchema,
} from "@clankie/protocol";
import {
  DISCORD_VOICE_OUTPUT_GUARD_PATH,
  DISCORD_ROOM_VOICE_PATH,
  DiscordRoomVoiceCommandSchema,
  DiscordRoomVoiceStatusSchema,
} from "@clankie/protocol";
import {
  DISCORD_ROOM_EVIDENCE_PATH,
  DISCORD_ROOMS_PATH,
  DISCORD_ROOM_GUIDANCE_PATH,
  DISCORD_SETTINGS_PATH,
  DiscordRoomEvidenceSchema,
  DiscordRoomsSnapshotSchema,
  DiscordRoomGuidanceRequestSchema,
  DiscordRoomGuidanceSchema,
  DiscordSettingsSnapshotSchema,
  DiscordSettingsUpdateSchema,
  type DiscordRoomEvidence,
} from "@clankie/protocol";
import {
  CONVERSATION_HEAD_PATH,
  ConversationHeadRequestSchema,
  OperatorConversationSchema,
  type ConversationHeadRequest,
  type OperatorConversation,
} from "@clankie/protocol";
import {
  BodyVoiceReconcileGuardSchema,
  type BodyVoiceReconcileGuard,
  BodyVoiceLeaseRequestSchema,
  type BodyVoiceLeaseRequest,
  type BodyLeaseResult,
} from "@clankie/protocol";
import { BodyLeaseResultSchema } from "@clankie/protocol";
import { HERDR_BINDING_PATH, HerdrBindingSchema, type HerdrBinding } from "@clankie/protocol";
import {
  CaptainChannelTurnResultSchema,
  DiscordChannelProjectionMessagePath,
  DiscordChannelProjectionMessageResultSchema,
  DiscordChannelProjectionMessageSchema,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteResultSchema,
  DiscordPresenceWriteSchema,
  DiscordStreamWatchReportSchema,
  DiscordUserSessionOptInRequestSchema,
  DiscordUserSessionOptInSchema,
  DISCORD_STREAM_WATCH_PATH,
  CAPTAIN_TURN_METRICS_PATH,
  CaptainTurnMetricsPageSchema,
  type CaptainChannelTurnResult,
  type CaptainTurnMetricsPage,
  type DiscordChannelProjectionMessage,
  type DiscordChannelProjectionMessageResult,
  type DiscordPresenceWrite,
  type DiscordPresenceWriteResult,
  type DiscordPresenceChannelTurnRequest,
  type CaptainEpisode,
  type CaptainEpisodeEdit,
  type CaptainSessionLaneV2,
  type DiscordPersonIdentity,
  type DiscordPersonMemoryEdit,
  type DiscordPersonMemoryExport,
  type DiscordPersonMemoryProjection,
  type DiscordPersonMemoryProposal,
  type OperatorMemoryCatalog,
  type DiscordStreamWatchReport,
  type DiscordUserSessionOptIn,
  type DiscordUserSessionOptInRequest,
} from "@clankie/protocol";
import {
  DISCORD_PRESENCE_LIVE_PHASE_HEADER,
  DISCORD_PRESENCE_LIVE_REVISION_HEADER,
  DISCORD_PRESENCE_LIVE_SESSION_HEADER,
  DiscordPresenceLiveClaimSchema,
  ActivityObservationReadSchema,
  PLAY_STILL_PATH,
  PlayStillReadSchema,
  DiscordPresencePhaseEventSchema,
  DiscordPresenceSessionRecordSchema,
  type DiscordPresenceLiveClaim,
  type DiscordPresencePhaseEvent,
  type DiscordPresenceSessionRecord,
  type ActivityObservationRead,
  type PlayStillRead,
} from "@clankie/interactive-environment";

export type {
  ActivityObservationRead,
  ActivityObservationSnapshot,
  GbaActivityObservationSnapshot,
} from "@clankie/interactive-environment";

export interface ClankieApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  captainToken?: string;
  operatorToken?: string;
}

export interface ControlPlaneHealth {
  ok: true;
  service: "clankie";
  profileHash: string;
}

export interface DiscordControlPlaneReadiness {
  readonly schemaVersion: 1;
  readonly ready: boolean;
  readonly service: "clankie";
  /** Changes every time the service process starts; safe for restart evidence. */
  readonly instanceId: string;
  readonly profileHash: string;
  readonly checks: {
    readonly captainChannelTurns: boolean;
    readonly discordPresenceRuntime: boolean;
  };
}

/**
 * Realtime voice briefing request (ADR 0057). Ids only, deliberately: the
 * service's strict schema rejects any other key, so a bridge cannot supply or
 * widen persona, instructions, or person memory.
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
  /** Persona + lane + realtime surface rules, composed service-side; ≤ 8000 chars. */
  readonly instructions: string;
  /** Bounded self-state, shareable episodes, and approved person memory; ≤ 8000 chars. */
  readonly briefing: string;
  readonly refreshedAt: string;
}

export class ClankieApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly captainToken: string | undefined;
  private readonly operatorToken: string | undefined;

  public constructor(options: string | ClankieApiClientOptions) {
    this.baseUrl = typeof options === "string" ? options : options.baseUrl;
    this.fetchImpl = typeof options === "string" ? fetch : (options.fetchImpl ?? fetch);
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
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* Preserve the original HTTP error. */
      }
      const lease = safeParseProtocolResponse(BodyLeaseResultSchema, parsed);
      const error = new Error(`Clankie API ${response.status}: ${text}`);
      if (lease.success) Object.assign(error, { bodyLease: lease.data });
      throw error;
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  public async getHerdrBinding(connection?: string): Promise<HerdrBinding> {
    return parseProtocolResponse(
      HerdrBindingSchema,
      await this.request(
        HERDR_BINDING_PATH + (connection ? `?connection=${encodeURIComponent(connection)}` : ""),
        {
          headers: this.operatorHeaders(),
          signal: AbortSignal.timeout(connection ? 10_000 : 5_000),
          redirect: "error",
        },
      ),
    );
  }

  /** Runs a typed hosting action; tunnel claim returns its URL without waiting for owner approval. */
  public async commandMinecraftHost(
    input: MinecraftHostCommand,
    conversationId?: string,
  ): Promise<Record<string, unknown>> {
    const command = MinecraftHostCommandSchema.parse(input);
    return this.request("/v1/minecraft/host", {
      method: "POST",
      headers: {
        ...this.operatorHeaders(),
        ...(conversationId ? { "x-clankie-conversation-id": conversationId } : {}),
      },
      body: JSON.stringify(command),
    });
  }

  public async getHealth(): Promise<ControlPlaneHealth> {
    const body = await this.request<{ ok: true; service: "clankie"; profileHash?: string }>("/health");
    // The service runs a single unversioned profile hash; older callers
    // still stamp this constant into presence writes.
    return { ...body, profileHash: body.profileHash ?? "unversioned" };
  }

  /** Submits a bounded, ambient Discord text turn through the authenticated captain lane. */
  public async submitDiscordCaptainChannelTurn(
    input: DiscordPresenceChannelTurnRequest,
  ): Promise<CaptainChannelTurnResult> {
    const request = DiscordPresenceChannelTurnRequestSchema.parse(input);
    const path = "/v1/captain/channel-turns";
    // Voice already has its own floor and latency budget. Only text turns can
    // spend minutes working while their bridge waits for a final response.
    if (request.trigger.kind === "voice_event") {
      return parseProtocolResponse(
        CaptainChannelTurnResultSchema,
        await this.request<unknown>(path, {
          method: "POST",
          headers: this.captainHeaders(),
          body: JSON.stringify(request),
        }),
      );
    }
    const submit = () =>
      this.request<unknown>(path, {
        method: "POST",
        headers: { ...this.captainHeaders(), prefer: "respond-async" },
        body: JSON.stringify(request),
      });
    let result = await submit();
    while (result !== null && typeof result === "object" && "state" in result && result.state === "pending") {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const response = await this.fetchImpl(
        new URL(`${path}/${encodeURIComponent(request.deliveryId)}`, this.baseUrl),
        { headers: this.captainHeaders() },
      );
      if (response.status === 404) {
        // A service restart forgot its in-memory turn. The stable delivery ID
        // lets a new service resume through the bridge's durable inbox.
        result = await submit();
      } else {
        if (!response.ok) throw new Error(`Clankie API ${response.status}: ${await response.text()}`);
        result = await response.json();
      }
    }
    return parseProtocolResponse(CaptainChannelTurnResultSchema, result);
  }

  /**
   * Offers one guild message to a Clankie channel projected onto that guild
   * (ADR 0146). `not_projected` means the service took nothing and the caller
   * carries on with ordinary ingress.
   */
  public async submitDiscordChannelProjectionMessage(
    input: DiscordChannelProjectionMessage,
  ): Promise<DiscordChannelProjectionMessageResult> {
    const request = DiscordChannelProjectionMessageSchema.parse(input);
    const result = await this.request<unknown>(DiscordChannelProjectionMessagePath, {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(request),
    });
    return parseProtocolResponse(DiscordChannelProjectionMessageResultSchema, result);
  }

  /**
   * Requests a policy-evaluated action gated by the bridge-owned Discord presence session.
   * Bot credentials stay behind the credential broker used by the trusted presence runtime module.
   */
  public async setConversationHead(input: ConversationHeadRequest): Promise<OperatorConversation> {
    return parseProtocolResponse(
      OperatorConversationSchema,
      await this.request(CONVERSATION_HEAD_PATH, {
        method: "POST",
        headers: this.operatorHeaders(),
        body: JSON.stringify(ConversationHeadRequestSchema.parse(input)),
      }),
    );
  }

  public async voiceReconcileGuard(input: BodyVoiceReconcileGuard): Promise<boolean> {
    const result = await this.request<{ authorized?: unknown }>("/v1/discord/voice-reconcile-guard", {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(BodyVoiceReconcileGuardSchema.parse(input)),
    });
    return result.authorized === true;
  }

  public async voiceLease(input: BodyVoiceLeaseRequest): Promise<BodyLeaseResult> {
    try {
      const result = await this.request<unknown>("/v1/discord/voice-lease", {
        method: "POST",
        headers: this.captainHeaders(),
        body: JSON.stringify(BodyVoiceLeaseRequestSchema.parse(input)),
      });
      return parseProtocolResponse(BodyLeaseResultSchema, result);
    } catch (error) {
      const result = safeParseProtocolResponse(
        BodyLeaseResultSchema,
        error !== null && typeof error === "object" && "bodyLease" in error ? error.bodyLease : undefined,
      );
      if (result.success) return result.data;
      throw error;
    }
  }

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
    // Refusals (and kin) come back as an error-shaped body, not a write
    // result; surfacing the reason beats a result-schema parse spray.
    if (result !== null && typeof result === "object" && "error" in result) {
      throw new Error(String((result as { error: unknown }).error));
    }
    return parseProtocolResponse(DiscordPresenceWriteResultSchema, result);
  }

  /** Publishes a bridge-owned gateway/voice phase transition to the service. */
  public async voiceOutputGuard(input: {
    nonce: string;
    stayId: string;
    action: "mute_output" | "unmute_output" | "leave";
  }): Promise<void> {
    await this.request(DISCORD_VOICE_OUTPUT_GUARD_PATH, {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(input),
    });
  }
  public async discordRoomVoice() {
    return parseProtocolResponse(
      DiscordRoomVoiceStatusSchema,
      await this.request(DISCORD_ROOM_VOICE_PATH, { headers: this.operatorHeaders() }),
    );
  }
  public async controlDiscordRoomVoice(input: unknown) {
    return parseProtocolResponse(
      DiscordRoomVoiceStatusSchema,
      await this.request(DISCORD_ROOM_VOICE_PATH, {
        method: "POST",
        headers: this.operatorHeaders(),
        body: JSON.stringify(DiscordRoomVoiceCommandSchema.parse(input)),
      }),
    );
  }
  public async recordDiscordRoomEvidence(input: DiscordRoomEvidence): Promise<void> {
    await this.request(DISCORD_ROOM_EVIDENCE_PATH, {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(DiscordRoomEvidenceSchema.parse(input)),
    });
  }
  public async discordRooms() {
    return parseProtocolResponse(
      DiscordRoomsSnapshotSchema,
      await this.request(DISCORD_ROOMS_PATH, { headers: this.operatorHeaders() }),
    );
  }
  public async discordRoomGuidance(input: {
    conversationId: string;
    text?: string;
    expectedRevision: number;
  }) {
    return parseProtocolResponse(
      DiscordRoomGuidanceSchema,
      await this.request(DISCORD_ROOM_GUIDANCE_PATH, {
        method: "POST",
        headers: this.operatorHeaders(),
        body: JSON.stringify(DiscordRoomGuidanceRequestSchema.parse(input)),
      }),
    );
  }
  public async discordSettings() {
    return parseProtocolResponse(
      DiscordSettingsSnapshotSchema,
      await this.request(DISCORD_SETTINGS_PATH, { headers: this.operatorHeaders() }),
    );
  }
  public async discordDirectory(input: unknown = {}) {
    const query = DiscordDirectoryRequestSchema.parse(input);
    const params = new URLSearchParams({ kind: query.kind, limit: String(query.limit) });
    if (query.guildId) params.set("guildId", query.guildId);
    if (query.after) params.set("after", query.after);
    return parseProtocolResponse(
      DiscordDirectorySnapshotSchema,
      await this.request(`${DISCORD_DIRECTORY_PATH}?${params}`, { headers: this.operatorHeaders() }),
    );
  }
  public async updateDiscordSettings(input: unknown) {
    return parseProtocolResponse(
      DiscordSettingsSnapshotSchema,
      await this.request(DISCORD_SETTINGS_PATH, {
        method: "POST",
        headers: this.operatorHeaders(),
        body: JSON.stringify(DiscordSettingsUpdateSchema.parse(input)),
      }),
    );
  }

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
      session: parseProtocolResponse(DiscordPresenceSessionRecordSchema, result.session),
    };
  }

  /**
   * Reads the durable owner opt-in for the user-session transport (ADR 0048).
   *
   * The user-session bridge calls this *before* connecting, so a missing or
   * revoked record keeps the process from ever opening a gateway with a normal
   * user credential. `undefined` means no opt-in exists for this profile hash.
   */
  public async inspectDiscordUserSessionOptIn(): Promise<DiscordUserSessionOptIn | undefined> {
    const result = await this.request<{ optIn: unknown | null }>("/v1/discord/user-session/opt-in", {
      headers: this.activityReadHeaders(),
    });
    return result.optIn === null || result.optIn === undefined
      ? undefined
      : parseProtocolResponse(DiscordUserSessionOptInSchema, result.optIn);
  }

  public async recordDiscordUserSessionOptIn(
    request: DiscordUserSessionOptInRequest,
  ): Promise<DiscordUserSessionOptIn> {
    const body = DiscordUserSessionOptInRequestSchema.parse(request);
    const result = await this.request<{ optIn: unknown }>("/v1/discord/user-session/opt-in", {
      method: "POST",
      headers: this.operatorHeaders(),
      body: JSON.stringify(body),
    });
    return parseProtocolResponse(DiscordUserSessionOptInSchema, result.optIn);
  }

  public async revokeDiscordUserSessionOptIn(): Promise<DiscordUserSessionOptIn | undefined> {
    const result = await this.request<{ optIn: unknown | null }>("/v1/discord/user-session/opt-in", {
      method: "DELETE",
      headers: this.operatorHeaders(),
    });
    return result.optIn === null || result.optIn === undefined
      ? undefined
      : parseProtocolResponse(DiscordUserSessionOptInSchema, result.optIn);
  }

  public async reportDiscordStreamWatch(report: DiscordStreamWatchReport): Promise<void> {
    const body = DiscordStreamWatchReportSchema.parse(report);
    await this.request<void>(DISCORD_STREAM_WATCH_PATH, {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(body),
    });
  }

  public inspectDiscordReadiness(): Promise<DiscordControlPlaneReadiness> {
    return this.request("/v1/discord/readiness", {
      headers: this.captainHeaders(),
    });
  }

  /**
   * Fetches the service-composed realtime voice session briefing (ADR 0057)
   * through the authenticated captain lane. The request carries only ids;
   * persona, lane instructions, self-state, episodes, and approved person
   * memory are all resolved from service-owned stores.
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

  public fetchPlayStill(): Promise<PlayStillRead> {
    return this.request(PLAY_STILL_PATH, { headers: this.activityReadHeaders() }).then((body) =>
      parseProtocolResponse(PlayStillReadSchema, body),
    );
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

  public inspectMemory(): Promise<OperatorMemoryCatalog> {
    return this.request("/v1/memory", { headers: this.operatorHeaders() });
  }

  public async readIssueMetrics(query: IssueMetricsQuery = {}): Promise<IssueMetricsReport> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(IssueMetricsQuerySchema.parse(query)))
      if (value !== undefined) search.set(key, value);
    const suffix = search.size === 0 ? "" : `?${search.toString()}`;
    return IssueMetricsReportSchema.parse(
      await this.request<unknown>(`${ISSUE_METRICS_PATH}${suffix}`, {
        headers: this.operatorHeaders(),
      }),
    );
  }

  /** Recent settled captain turns, newest first. Counters only — no transcript. */
  public async readCaptainTurnMetrics(
    query: { readonly limit?: number; readonly runId?: string } = {},
  ): Promise<CaptainTurnMetricsPage> {
    const search = new URLSearchParams();
    if (query.limit !== undefined) search.set("limit", String(query.limit));
    if (query.runId !== undefined) search.set("runId", query.runId);
    const suffix = search.size === 0 ? "" : `?${search.toString()}`;
    const body = await this.request<unknown>(`${CAPTAIN_TURN_METRICS_PATH}${suffix}`, {
      headers: this.operatorHeaders(),
    });
    return parseProtocolResponse(CaptainTurnMetricsPageSchema, body);
  }

  public updateDiscordPersonMemoryFact(
    identity: DiscordPersonIdentity,
    factId: string,
    edit: DiscordPersonMemoryEdit,
  ): Promise<DiscordPersonMemoryExport["facts"][number]> {
    return this.request(
      `/v1/memory/discord-people/${encodeURIComponent(identity.guildId)}/${encodeURIComponent(identity.userId)}/${encodeURIComponent(factId)}`,
      { method: "PATCH", headers: this.operatorHeaders(), body: JSON.stringify(edit) },
    );
  }

  public deleteDiscordPersonMemoryFact(identity: DiscordPersonIdentity, factId: string): Promise<void> {
    return this.request(
      `/v1/memory/discord-people/${encodeURIComponent(identity.guildId)}/${encodeURIComponent(identity.userId)}/${encodeURIComponent(factId)}`,
      { method: "DELETE", headers: this.operatorHeaders() },
    );
  }

  public updateCaptainEpisode(
    lane: CaptainSessionLaneV2,
    episodeId: string,
    edit: CaptainEpisodeEdit,
  ): Promise<CaptainEpisode> {
    return this.request(
      `/v1/memory/captain-episodes/${encodeURIComponent(lane)}/${encodeURIComponent(episodeId)}`,
      { method: "PATCH", headers: this.operatorHeaders(), body: JSON.stringify(edit) },
    );
  }

  public deleteCaptainEpisode(lane: CaptainSessionLaneV2, episodeId: string): Promise<void> {
    return this.request(
      `/v1/memory/captain-episodes/${encodeURIComponent(lane)}/${encodeURIComponent(episodeId)}`,
      { method: "DELETE", headers: this.operatorHeaders() },
    );
  }

  /** Latest settled state of Clankie's own active activity, without another lane's transcript. */
  public async getCurrentActivityObservation(): Promise<ActivityObservationRead> {
    const body = await this.request<unknown>("/v1/embodiment/sessions/live/activity", {
      headers: this.activityReadHeaders(),
    });
    return parseProtocolResponse(ActivityObservationReadSchema, body);
  }

  private captainHeaders(): Record<string, string> {
    if (!this.captainToken) {
      throw new Error("CLANKIE_CAPTAIN_TOKEN is required for captain execution");
    }
    return { authorization: `Bearer ${this.captainToken}` };
  }

  private operatorHeaders(): Record<string, string> {
    if (!this.operatorToken) {
      throw new Error("CLANKIE_OPERATOR_TOKEN is required for operator reads");
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
}
