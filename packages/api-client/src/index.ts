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
  type CaptainChannelTurnResult,
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
      throw new Error(`Clankie API ${response.status}: ${await response.text()}`);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
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
    const result = await this.request<unknown>("/v1/captain/channel-turns", {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(request),
    });
    return CaptainChannelTurnResultSchema.parse(result);
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
    return DiscordChannelProjectionMessageResultSchema.parse(result);
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
    // Refusals (and kin) come back as an error-shaped body, not a write
    // result; surfacing the reason beats a result-schema parse spray.
    if (result !== null && typeof result === "object" && "error" in result) {
      throw new Error(String((result as { error: unknown }).error));
    }
    return DiscordPresenceWriteResultSchema.parse(result);
  }

  /** Publishes a bridge-owned gateway/voice phase transition to the service. */
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
   * user credential. `undefined` means no opt-in exists for this profile hash.
   */
  public async inspectDiscordUserSessionOptIn(): Promise<DiscordUserSessionOptIn | undefined> {
    const result = await this.request<{ optIn: unknown | null }>("/v1/discord/user-session/opt-in", {
      headers: this.activityReadHeaders(),
    });
    return result.optIn === null || result.optIn === undefined
      ? undefined
      : DiscordUserSessionOptInSchema.parse(result.optIn);
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
    return DiscordUserSessionOptInSchema.parse(result.optIn);
  }

  public async revokeDiscordUserSessionOptIn(): Promise<DiscordUserSessionOptIn | undefined> {
    const result = await this.request<{ optIn: unknown | null }>("/v1/discord/user-session/opt-in", {
      method: "DELETE",
      headers: this.operatorHeaders(),
    });
    return result.optIn === null || result.optIn === undefined
      ? undefined
      : DiscordUserSessionOptInSchema.parse(result.optIn);
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
      PlayStillReadSchema.parse(body),
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
    return ActivityObservationReadSchema.parse(body);
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
