import {
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
  type BodyPossession,
  type CaptainPresenceReport,
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

  public async getHealth(): Promise<ControlPlaneHealth> {
    const body = await this.request<{ ok: true; service: "clankie"; profileHash?: string }>("/health");
    // The service runs a single unversioned doctrine profile; older callers
    // still stamp this constant into presence writes.
    return { ...body, profileHash: body.profileHash ?? "unversioned" };
  }

  public async recordCaptainPresence(input: CaptainPresenceReport): Promise<Record<string, unknown>> {
    const report = CaptainPresenceReportSchema.parse(input);
    return this.request("/v1/captain/presence", {
      method: "POST",
      headers: this.captainHeaders(),
      body: JSON.stringify(report),
    });
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
   * The catalog of Clankie's own browser (ADR 0082). `available: false` means
   * the host could not be reached — never that he has no browser.
   */
  public async listBrowserTools(): Promise<BrowserToolCatalog> {
    const body = await this.request<{ catalog: unknown }>("/v1/browser/tools", {
      headers: this.activityReadHeaders(),
    });
    return BrowserToolCatalogSchema.parse(body.catalog);
  }

  /**
   * Drive one browser tool. A risk-classed tool called with only a captain
   * token comes back `refused` with a reason, which he relays rather than
   * treats as a failure.
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
