import { DiscordVoiceTranscriptStore } from "@clankie/discord-presence-core";
import {
  DISCORD_PRESENCE_LIVE_PHASE_HEADER,
  DISCORD_PRESENCE_LIVE_REVISION_HEADER,
  DISCORD_PRESENCE_LIVE_SESSION_HEADER,
  DiscordPresenceLiveClaimSchema,
  DiscordPresencePhaseEventSchema,
  isDiscordPresenceActionAvailable,
  resolveDiscordPresencePhaseToolExposure,
  resolveDiscordPresenceToolExposure,
  type DiscordPresenceSessionRecord,
} from "@clankie/interactive-environment";
import {
  CaptainChannelTurnResultSchema,
  DISCORD_ROOM_EVIDENCE_PATH,
  DISCORD_STREAM_WATCH_PATH,
  DISCORD_VOICE_TRANSCRIPTS_PATH,
  DISCORD_VOICE_TRANSCRIPT_PAGE_LIMIT_MAX,
  DiscordChannelProjectionMessagePath,
  DiscordChannelProjectionMessageSchema,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteSchema,
  DiscordRoomEvidenceSchema,
  DiscordStreamWatchReportSchema,
  DiscordUserSessionOptInRequestSchema,
  DiscordUserSessionOptInSchema,
  DiscordVoiceTranscriptCursorSchema,
  discordDeliveryStage,
  type CaptainChannelTurnResult,
  type DiscordChannelProjectionMessageResult,
  type DiscordPresenceWriteResult,
  type DomainEvent,
} from "@clankie/protocol";
import { resolveDiscordSettings } from "@clankie/settings";
import { Hono, type Context } from "hono";
import { createHash } from "node:crypto";
import type { BodyConversationIdentity } from "../body-lease-router.ts";
import { CaptainPresenceManager } from "../captain-presence.ts";
import { DiscordTurnReceipts } from "../captain/discord-turn-receipts.ts";
import { discordTurnSessionKey } from "../captain/discord-turn.ts";
import {
  DiscordPresenceSessionProjection,
  DiscordVoiceHistoryProjection,
  discordPresenceDomainEvent,
} from "../discord-presence-session.ts";
import { type RoomAccess, type RoomAuthorization } from "../discord-room-routes.ts";
import {
  DISCORD_USER_SESSION_OPT_IN_RECORDED,
  DISCORD_USER_SESSION_OPT_IN_REVOKED,
  DISCORD_USER_SESSION_OPT_IN_STREAM_ID,
  DiscordUserSessionOptInProjection,
} from "../discord-user-session-opt-in.ts";
import { EmbodimentManager } from "../embodiment.ts";
import { RecentEvents } from "../event-log.ts";
import { DiscordStreamWatchProjection } from "../stream-watch-observation.ts";
import { authenticateCaptain, authenticateOperator, captainTransportKind, readJson } from "./http-auth.ts";
import { logger } from "./log.ts";
import { DELIVERY_RETENTION_MS, pruneExpired, withSerializedLock } from "./request-state.ts";
import { type ClankieAppDependencies } from "./types.ts";
import { registerVoiceBriefingRoute } from "./voice-briefing.ts";
/**
 * Several wire schemas still carry a profile-hash slot from the retired policy
 * engine. One constant fills them all. User-session opt-in still compares
 * against it, so changing the constant re-asks for that consent; nothing else
 * branches on the value.
 */
export const PROFILE_HASH = "unversioned";

const DISCORD_USER_SESSION_CREDENTIAL_REF = "discord_user_session";

export function discordPresenceBindingKey(identity: {
  readonly transportKind: "bot" | "user_session";
  readonly characterId: string;
  readonly credentialRef: string;
}): string {
  return JSON.stringify([identity.transportKind, identity.characterId, identity.credentialRef]);
}
export interface RegisterDiscordRoutesContext {
  readonly app: Hono;
  readonly dependencies: ClankieAppDependencies;
  readonly instanceId: `${string}-${string}-${string}-${string}-${string}`;
  readonly settingsSource: NonNullable<ClankieAppDependencies["settings"]>;
  readonly clock: () => Date;
  readonly captainPresence: CaptainPresenceManager;
  readonly discordPresenceSessions: DiscordPresenceSessionProjection;
  readonly discordStreamWatch: DiscordStreamWatchProjection;
  readonly embodiment: EmbodimentManager;
  readonly recordEvent: (
    type: string,
    streamId: string,
    occurredAt: string,
    data: Record<string, unknown>,
    envelope?: { correlationId?: string },
  ) => DomainEvent;
  readonly idFactory: () => string;
  readonly discordPresenceLiveSessions: Map<string, DiscordPresenceSessionRecord>;
  readonly discordUserSessionOptIns: DiscordUserSessionOptInProjection;
  readonly discordPresenceSessionLocks: Map<string, Promise<unknown>>;
  readonly recentEvents: RecentEvents;
  readonly appendEvent: (event: DomainEvent) => void;
  readonly discordVoiceHistory: DiscordVoiceHistoryProjection;
  readonly authorizeRoom: (request: Request, access: RoomAccess) => Promise<RoomAuthorization | undefined>;
  readonly voiceTranscriptStore: DiscordVoiceTranscriptStore;
  readonly authenticateCaptainOrOperator: (
    context: Context,
  ) => Promise<{ principal: { kind: "captain" | "operator"; id: string } } | { denial: Response }>;
  readonly discordPresenceLocks: Map<string, Promise<unknown>>;
  readonly discordPresenceResults: Map<
    string,
    { fingerprint: string; result: DiscordPresenceWriteResult; expiresAtMs: number }
  >;
  readonly discordTurnReceipts: DiscordTurnReceipts;
  readonly captainTurnResults: Map<
    string,
    {
      fingerprint: string;
      lane: "discord_text" | "discord_voice";
      result: Promise<CaptainChannelTurnResult>;
      settled?: CaptainChannelTurnResult;
      rejected?: boolean;
    }
  >;
  readonly channelProjectionResults: Map<
    string,
    { result: DiscordChannelProjectionMessageResult; expiresAtMs: number }
  >;
}

export function registerDiscordRoutes(ctx: RegisterDiscordRoutesContext) {
  ctx.app.get("/v1/discord/readiness", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const checks = {
      captainChannelTurns: true,
      discordPresenceRuntime: ctx.dependencies.discordPresenceRuntime !== undefined,
    };
    const ready = Object.values(checks).every(Boolean);
    return context.json(
      {
        schemaVersion: 1 as const,
        ready,
        service: "clankie" as const,
        instanceId: ctx.instanceId,
        profileHash: PROFILE_HASH,
        checks,
      },
      ready ? 200 : 503,
    );
  });

  registerVoiceBriefingRoute(ctx);

  ctx.app.post(DISCORD_ROOM_EVIDENCE_PATH, async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (
      !captain ||
      captain === "unavailable" ||
      !["discord_text", "discord_voice"].includes(captain.steerSourceLane ?? "")
    )
      return context.json({ error: "discord_body_required" }, 403);
    const parsed = DiscordRoomEvidenceSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_room_evidence" }, 400);
    if (!ctx.dependencies.roomObservations)
      return context.json({ error: "room_observations_unavailable" }, 503);
    const evidence = parsed.data;
    const voice = evidence.voiceStayId !== undefined;
    if (captain.steerSourceLane !== (voice ? "discord_voice" : "discord_text"))
      return context.json({ error: "discord_body_mismatch" }, 403);
    if (captainTransportKind(captain) !== evidence.transportKind)
      return context.json({ error: "discord_body_mismatch" }, 403);
    const capturedSource = [...ctx.discordPresenceLiveSessions.values()].find(
      (session) =>
        session.sessionId === evidence.presenceSessionId && session.transportKind === evidence.transportKind,
    );
    const settings = resolveDiscordSettings(
      (await ctx.settingsSource.load()).discord,
      ctx.dependencies.discordEnvironment ?? process.env,
    ).settings;
    const freshCaptain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (
      !freshCaptain ||
      freshCaptain === "unavailable" ||
      freshCaptain.captainId !== captain.captainId ||
      freshCaptain.steerSourceLane !== captain.steerSourceLane ||
      captainTransportKind(freshCaptain) !== evidence.transportKind
    )
      return context.json({ error: "discord_body_revoked" }, 403);
    const finalSettings = resolveDiscordSettings(
      (await ctx.settingsSource.load()).discord,
      ctx.dependencies.discordEnvironment ?? process.env,
    ).settings;
    if (JSON.stringify(finalSettings) !== JSON.stringify(settings))
      return context.json({ error: "room_evidence_settings_changed" }, 409);
    const user = evidence.transportKind === "user_session";
    const guilds = user ? settings.userSessionGuildIds : settings.ingressGuildIds;
    const channels = user ? settings.userSessionChannelIds : settings.ingressChannelIds;
    const dmPolicy = user ? settings.userSessionDmPolicy : settings.ingressDmPolicy;
    const dmUsers = user ? settings.userSessionDmUserIds : settings.ingressDmUserIds;
    const admitted = voice
      ? settings.voiceEnabled && evidence.guildId !== undefined
      : evidence.guildId === undefined
        ? dmPolicy === "owner_only"
          ? evidence.actorId === settings.ownerUserId
          : dmPolicy === "allowlist" && dmUsers.includes(evidence.actorId)
        : guilds.includes(evidence.guildId) &&
          (channels.length === 0 || channels.includes(evidence.channelId));
    // A channel address is observation context only. The body credential and
    // exact registered live generation establish who may report its outcome.
    const live = [...ctx.discordPresenceLiveSessions.values()].find(
      (session) =>
        session.sessionId === evidence.presenceSessionId && session.transportKind === evidence.transportKind,
    );
    if (
      !admitted ||
      settings.activeBody !== (user ? "user_session" : "bot") ||
      !(voice ? settings.voiceEnabled : user ? settings.userSessionEnabled : settings.textIngressEnabled) ||
      !live?.gatewayConnected ||
      live !== capturedSource ||
      (user &&
        (!settings.userSessionEnabled ||
          ctx.discordUserSessionOptIns.resolveActive(PROFILE_HASH) === undefined))
    )
      return context.json({ error: "room_evidence_source_stale" }, 403);
    const id = ctx.dependencies.captain.bodyRoomConversation(
      voice ? "discord_voice" : "discord_presence",
      `${evidence.guildId ?? "dm"}:${evidence.channelId}`,
    );
    if (
      voice &&
      !ctx.dependencies.bodyVoiceStays?.observesAudioSource({
        stayId: evidence.voiceStayId!,
        guildId: evidence.guildId!,
        channelId: evidence.channelId,
        presenceSessionId: evidence.presenceSessionId,
      })
    )
      return context.json({ error: "room_evidence_stay_stale" }, 403);
    ctx.dependencies.roomObservations.record(id, evidence);
    return context.json({ accepted: true });
  });

  ctx.app.post("/v1/discord/presence-session-events", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const parsed = DiscordPresencePhaseEventSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_presence_phase_event" }, 400);
    const event = parsed.data;
    const sessionKey = discordPresenceBindingKey(event.data.session);
    return withSerializedLock(ctx.discordPresenceSessionLocks, sessionKey, async () => {
      const domainEvent = discordPresenceDomainEvent(event, PROFILE_HASH);
      if (ctx.recentEvents.has(event.id)) {
        const existing = ctx.recentEvents.get(event.id);
        if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(domainEvent)) {
          return context.json({ error: "discord_presence_event_id_conflict" }, 409);
        }
        const session = ctx.discordPresenceSessions.resolve(event.data.session);
        if (session === undefined) {
          return context.json({ error: "discord_presence_event_id_conflict" }, 409);
        }
        // An idempotent acknowledgement proves durability, not liveness.
        return context.json({ accepted: false, session });
      }
      try {
        const durableBefore = ctx.discordPresenceSessions.resolve(event.data.session);
        const session = ctx.discordPresenceSessions.apply(event);
        if (durableBefore === undefined || session.revision > durableBefore.revision) {
          ctx.discordPresenceLiveSessions.set(sessionKey, session);
        }
        ctx.appendEvent(domainEvent);
        return context.json({ accepted: true, session });
      } catch (error) {
        const code = error instanceof Error ? error.message : "discord_presence_session_conflict";
        return context.json({ error: code }, 409);
      }
    });
  });

  ctx.app.get("/v1/discord/presence-sessions", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    return context.json(ctx.discordPresenceSessions.list());
  });

  /** Completed voice stays with the room context captured at join time (VUH-940). */
  ctx.app.get("/v1/discord/voice-history", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const rawLimit = context.req.query("limit");
    const parsedLimit = rawLimit === undefined ? 5 : Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 32) {
      return context.json({ error: "invalid_voice_history_limit" }, 400);
    }
    return context.json({
      schemaVersion: 1 as const,
      stays: ctx.discordVoiceHistory.list(parsedLimit),
    });
  });

  /** Exact retained speech is private, bounded, and unreadable while retention is disabled. */
  ctx.app.get(DISCORD_VOICE_TRANSCRIPTS_PATH, async (context) => {
    const roomAuthority = await ctx.authorizeRoom(context.req.raw, "observe");
    const captain =
      roomAuthority === undefined
        ? await authenticateCaptain(context.req.raw, ctx.dependencies)
        : { captainId: "owner" };
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const rawLimit = context.req.query("limit");
    const limit = rawLimit === undefined ? 100 : Number.parseInt(rawLimit, 10);
    const rawCursor = context.req.query("cursor");
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > DISCORD_VOICE_TRANSCRIPT_PAGE_LIMIT_MAX ||
      (rawCursor !== undefined && !DiscordVoiceTranscriptCursorSchema.safeParse(rawCursor).success)
    ) {
      return context.json({ error: "invalid_voice_transcript_query" }, 400);
    }
    let enabled: boolean;
    try {
      enabled = (await ctx.settingsSource.load()).discord.voiceTranscriptLoggingEnabled;
    } catch {
      return context.json({ error: "voice_transcript_settings_unavailable" }, 503);
    }
    if (roomAuthority !== undefined) {
      try {
        await roomAuthority.guard();
        if (!roomAuthority.current()) throw Error("revoked");
      } catch {
        return context.json({ error: "room_observe_required" }, 403);
      }
    }
    context.header("cache-control", "no-store");
    if (!enabled) {
      return context.json({
        schemaVersion: 1 as const,
        enabled: false,
        entries: [],
        nextCursor: "000000000000",
        hasMore: false,
      });
    }
    try {
      const page = await ctx.voiceTranscriptStore.read(rawCursor, limit);
      if (roomAuthority !== undefined) {
        await roomAuthority.guard();
        if (!roomAuthority.current()) return context.json({ error: "room_observe_required" }, 403);
      }
      if (!(await ctx.settingsSource.load()).discord.voiceTranscriptLoggingEnabled)
        return context.json({ error: "voice_transcripts_disabled" }, 403);
      if (roomAuthority !== undefined) {
        await roomAuthority.guard();
        if (!roomAuthority.current()) return context.json({ error: "room_observe_required" }, 403);
      }
      return context.json({ schemaVersion: 1 as const, enabled: true, ...page });
    } catch {
      return context.json({ error: "voice_transcript_read_failed" }, 500);
    }
  });

  /** Operator-readable presence status for `clankie status`; phase and counts only. */
  ctx.app.get("/v1/discord/presence-status", async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    return context.json({
      schemaVersion: 1 as const,
      sessions: ctx.discordPresenceSessions.list().map((session) => ({
        phase: session.phase,
        gatewayConnected: session.gatewayConnected,
        transportKind: session.transportKind,
        voiceGuildCount: session.voiceGuildIds.length,
        activityCount: session.activityInstances.length,
        updatedAt: session.updatedAt,
      })),
      streams: ctx.discordStreamWatch.current().streams.map((stream) => ({
        userId: stream.userId,
        channelId: stream.channelId,
        watching: stream.watching,
        hasFrame: stream.hasFrame,
      })),
    });
  });

  /**
   * Records the owner's acceptance of user-session transport risk (ADR 0048).
   * Operator-authenticated on purpose: this is the human accepting Discord ToS
   * and account risk on their own account. The record is durable.
   */
  ctx.app.post("/v1/discord/user-session/opt-in", async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = DiscordUserSessionOptInRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_user_session_opt_in" }, 400);
    const recordedAt = ctx.clock().toISOString();
    const optIn = DiscordUserSessionOptInSchema.parse({
      schemaVersion: 1,
      optInId: `discord-user-session-opt-in-${ctx.idFactory()}`,
      characterId: parsed.data.characterId,
      credentialRef: DISCORD_USER_SESSION_CREDENTIAL_REF,
      profileHash: PROFILE_HASH,
      acknowledgement: parsed.data.acknowledgement,
      guildIds: parsed.data.guildIds,
      channelIds: parsed.data.channelIds,
      dmPolicy: parsed.data.dmPolicy,
      recordedAt,
    });
    const event = ctx.recordEvent(
      DISCORD_USER_SESSION_OPT_IN_RECORDED,
      DISCORD_USER_SESSION_OPT_IN_STREAM_ID,
      recordedAt,
      {
        optIn,
        operatorId: operator.operatorId,
      },
    );
    ctx.discordUserSessionOptIns.apply(event);
    return context.json({ schemaVersion: 1, optIn }, 201);
  });

  ctx.app.delete("/v1/discord/user-session/opt-in", async (context) => {
    const operator = await authenticateOperator(context.req.raw, ctx.dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const existing = ctx.discordUserSessionOptIns.resolve();
    if (existing === undefined || existing.revokedAt !== undefined) {
      return context.json({ error: "discord_user_session_opt_in_not_active" }, 409);
    }
    const revokedAt = ctx.clock().toISOString();
    const event = ctx.recordEvent(
      DISCORD_USER_SESSION_OPT_IN_REVOKED,
      DISCORD_USER_SESSION_OPT_IN_STREAM_ID,
      revokedAt,
      {
        optInId: existing.optInId,
        revokedAt,
        operatorId: operator.operatorId,
      },
    );
    ctx.discordUserSessionOptIns.apply(event);
    return context.json({ schemaVersion: 1, optIn: ctx.discordUserSessionOptIns.resolve() });
  });

  /** Read by the user-session bridge before it opens a gateway, and by the TUI. */
  ctx.app.get("/v1/discord/user-session/opt-in", async (context) => {
    const authorization = await ctx.authenticateCaptainOrOperator(context);
    if ("denial" in authorization) return authorization.denial;
    return context.json({ schemaVersion: 1, optIn: ctx.discordUserSessionOptIns.resolve() ?? null });
  });

  ctx.app.post(DISCORD_STREAM_WATCH_PATH, async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const parsed = DiscordStreamWatchReportSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_stream_watch_report" }, 400);
    ctx.discordStreamWatch.apply(parsed.data, ctx.clock());
    return context.body(null, 204);
  });

  ctx.app.get(DISCORD_STREAM_WATCH_PATH, async (context) => {
    const authorization = await ctx.authenticateCaptainOrOperator(context);
    if ("denial" in authorization) return authorization.denial;
    return context.json(ctx.discordStreamWatch.current());
  });

  ctx.app.post("/v1/discord/presence-actions", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const revisionHeader = context.req.header(DISCORD_PRESENCE_LIVE_REVISION_HEADER);
    const liveClaim = DiscordPresenceLiveClaimSchema.safeParse({
      schemaVersion: 1,
      sessionId: context.req.header(DISCORD_PRESENCE_LIVE_SESSION_HEADER),
      phase: context.req.header(DISCORD_PRESENCE_LIVE_PHASE_HEADER),
      revision: revisionHeader === undefined ? undefined : Number(revisionHeader),
    });
    if (!liveClaim.success) {
      return context.json({ error: "discord_presence_live_claim_required" }, 400);
    }
    const parsed = DiscordPresenceWriteSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_presence_write" }, 400);
    const write = parsed.data;
    // Transport is bound to *authentication*, never to the request body.
    if (write.identity.transportKind !== captainTransportKind(captain)) {
      return context.json({ error: "discord_presence_transport_not_authenticated" }, 403);
    }
    if (write.identity.transportKind === "user_session") {
      const optIn = ctx.discordUserSessionOptIns.resolveActive(PROFILE_HASH);
      if (optIn === undefined) {
        return context.json({ error: "discord_user_session_opt_in_required" }, 403);
      }
      if (optIn.characterId !== write.identity.characterId) {
        return context.json({ error: "discord_user_session_opt_in_character_mismatch" }, 403);
      }
    }
    const discordPresenceRuntime =
      write.identity.transportKind === "user_session"
        ? ctx.dependencies.discordUserPresenceRuntime
        : ctx.dependencies.discordPresenceRuntime;
    if (!discordPresenceRuntime) {
      return context.json({ error: "discord_presence_runtime_unavailable" }, 503);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(write)).digest("hex");
    return withSerializedLock(ctx.discordPresenceLocks, write.idempotencyKey, async () => {
      pruneExpired(ctx.discordPresenceResults, ctx.clock().getTime());
      const persistedWrite =
        ctx.dependencies.bodyLeases === undefined
          ? undefined
          : ctx.discordTurnReceipts.get(`write:${write.idempotencyKey}`);
      if (persistedWrite !== undefined) {
        if (persistedWrite.fingerprint !== fingerprint)
          return context.json({ error: "discord_presence_idempotency_conflict" }, 409);
        if (persistedWrite.writeResult !== undefined) return context.json(persistedWrite.writeResult);
        return context.json({ error: "discord_presence_write_uncertain", deliveryStage: "uncertain" }, 409);
      }
      const previous = ctx.discordPresenceResults.get(write.idempotencyKey);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          return context.json({ error: "discord_presence_idempotency_conflict" }, 409);
        }
        return context.json(previous.result);
      }
      const session = ctx.discordPresenceSessions.resolve(write.identity);
      if (session === undefined) {
        return context.json({ error: "discord_presence_session_unavailable" }, 409);
      }
      const advertisedTools = resolveDiscordPresenceToolExposure(session, "discord_presence");
      if (
        advertisedTools?.presenceTools.includes("discord_presence_act") !== true ||
        !isDiscordPresenceActionAvailable({ action: write.action, session })
      ) {
        return context.json({ error: "discord_presence_action_unavailable", phase: session.phase }, 409);
      }
      const liveSession = ctx.discordPresenceLiveSessions.get(discordPresenceBindingKey(write.identity));
      if (
        liveSession === undefined ||
        liveClaim.data.sessionId !== liveSession.sessionId ||
        liveClaim.data.phase !== liveSession.phase ||
        liveClaim.data.revision !== liveSession.revision
      ) {
        return context.json(
          {
            error: "discord_presence_live_claim_stale",
            claimedRevision: liveClaim.data.revision,
            ...(liveSession === undefined
              ? {}
              : { currentRevision: liveSession.revision, phase: liveSession.phase }),
          },
          409,
        );
      }
      const liveExposure = resolveDiscordPresencePhaseToolExposure(liveClaim.data.phase, "discord_presence");
      if (!liveExposure.presenceTools.includes("discord_presence_act")) {
        return context.json(
          {
            error: "discord_presence_action_unavailable",
            phase: liveClaim.data.phase,
            source: "live_session",
          },
          409,
        );
      }
      try {
        let result: DiscordPresenceWriteResult;
        if (ctx.dependencies.bodyLeases === undefined || write.payload.kind === "typing_start") {
          result = await discordPresenceRuntime.execute(write, session, () =>
            ctx.discordTurnReceipts.enforceGuard(write.idempotencyKey),
          );
        } else {
          const sourceId =
            write.sourceDeliveryId ??
            ("replyToMessageId" in write.payload
              ? write.payload.replyToMessageId
              : "messageId" in write.payload
                ? write.payload.messageId
                : undefined);
          const origin =
            sourceId === undefined ? undefined : ctx.discordTurnReceipts.get(`discord:${sourceId}`)?.origin;
          if (
            origin === undefined ||
            origin.messageId !== sourceId ||
            ("channelId" in write.payload &&
              write.payload.kind !== "go_live_start" &&
              origin.channelId !== write.payload.channelId) ||
            ("guildId" in write.payload && origin.guildId !== write.payload.guildId) ||
            origin.presenceSessionId !== write.identity.presenceSessionId ||
            origin.transportKind !== captainTransportKind(captain) ||
            origin.characterId !== write.identity.characterId ||
            origin.credentialRef !== write.identity.credentialRef
          )
            return context.json({ outcome: "rejected", reason: "identity_required" }, 409);
          const conversationId = ctx.dependencies.captain.bodyRoomConversation(
            "discord_presence",
            `${origin.guildId ?? "dm"}:${origin.channelId}`,
          );
          const identity: BodyConversationIdentity = {
            conversationId,
            ...(origin.baseSessionKey === undefined
              ? {}
              : {
                  route: {
                    owner: {
                      conversationId,
                      discord: {
                        baseSessionKey: origin.baseSessionKey,
                        targetId: `${origin.guildId ?? "dm"}:${origin.channelId}`,
                        actorId: origin.actorId,
                        ...(origin.guildId === undefined ? {} : { guildId: origin.guildId }),
                        channelId: origin.channelId,
                        messageId: origin.messageId,
                        transportKind: origin.transportKind,
                      },
                    },
                    mode: "social" as const,
                  },
                }),
            current: () => {
              const current = ctx.discordPresenceLiveSessions.get(discordPresenceBindingKey(write.identity));
              return (
                !context.req.raw.signal.aborted &&
                current?.revision === liveClaim.data.revision &&
                current.sessionId === liveClaim.data.sessionId &&
                current.phase === liveClaim.data.phase
              );
            },
            authorize: async () => {
              const currentCaptain = await authenticateCaptain(context.req.raw, ctx.dependencies);
              const currentSession = ctx.discordPresenceSessions.resolve(write.identity);
              return (
                currentCaptain !== undefined &&
                currentCaptain !== "unavailable" &&
                captainTransportKind(currentCaptain) === origin.transportKind &&
                currentSession !== undefined &&
                isDiscordPresenceActionAvailable({ action: write.action, session: currentSession }) &&
                (origin.transportKind !== "user_session" ||
                  ctx.discordUserSessionOptIns.resolveActive(PROFILE_HASH) !== undefined)
              );
            },
          };
          let publish: import("@clankie/discord-presence-core").BodyEffectGuard["publish"];
          if (write.payload.kind === "go_live_start") {
            const target = await ctx.dependencies.resolveBodyVoiceTarget?.({
              guildId: write.payload.guildId,
              actorId: origin.actorId,
              publishChannelId: write.payload.channelId,
            });
            if (
              target === undefined ||
              target.guildId !== write.payload.guildId ||
              target.channelId !== write.payload.channelId ||
              target.actorId !== origin.actorId ||
              target.presenceSessionId !== liveClaim.data.sessionId ||
              target.transportKind !== origin.transportKind
            )
              return context.json({ outcome: "rejected", reason: "identity_required" }, 409);
            if (ctx.dependencies.bodyVoiceStays?.compatibleTarget(conversationId, target) === false) {
              const lease = ctx.dependencies.bodyLeases.store.status("voice");
              if (lease !== undefined)
                return context.json({ outcome: "busy", lease, actions: ["queue", "ask"] }, 409);
            }
            const issued = await ctx.dependencies.bodyVoiceStays?.ticket(identity, target, "publish");
            if (issued === undefined)
              return context.json({ outcome: "rejected", reason: "unavailable" }, 409);
            if (!("ticket" in issued)) return context.json(issued, 409);
            publish = { ticket: issued.ticket, target };
          } else if (write.payload.kind === "go_live_stop") {
            const stay = ctx.dependencies.bodyVoiceStays?.publishing(conversationId);
            if (
              stay === undefined ||
              stay.target.guildId !== write.payload.guildId ||
              stay.target.presenceSessionId !== liveClaim.data.sessionId
            )
              return context.json({ outcome: "rejected", reason: "identity_required" }, 409);
            publish = { stayId: stay.stayId, target: stay.target };
          }
          const leased = await ctx.dependencies.bodyLeases.router.run(
            identity,
            publish === undefined ? "discord_mouth" : "voice",
            async (guard) => {
              await guard();
              ctx.discordTurnReceipts.begin(`write:${write.idempotencyKey}`, {
                fingerprint,
                lane: "discord_text",
                origin,
                bodyConversationId: conversationId,
              });
              const effectGuard = Object.assign(
                async () => {
                  await guard();
                  await ctx.discordTurnReceipts.enforceGuard(write.idempotencyKey);
                  if (
                    publish?.stayId !== undefined &&
                    ctx.dependencies.bodyVoiceStays?.publishing(conversationId)?.stayId !== publish.stayId
                  )
                    throw new Error("Publish stay changed");
                },
                publish === undefined ? {} : { publish },
              );
              const result = await discordPresenceRuntime.execute(write, session, effectGuard);
              ctx.discordTurnReceipts.settleWrite(`write:${write.idempotencyKey}`, fingerprint, result);
              return result;
            },
            { lifetime: publish === undefined ? "operation" : "session" },
          );
          if (leased.outcome !== "completed") return context.json(leased, 409);
          result = leased.value;
        }
        ctx.discordPresenceResults.set(write.idempotencyKey, {
          fingerprint,
          result,
          expiresAtMs: ctx.clock().getTime() + DELIVERY_RETENTION_MS,
        });
        logger.info(
          {
            correlationId: write.identity.correlationId,
            action: write.action,
            transportKind: result.transportKind,
          },
          "Discord presence action completed",
        );
        return context.json(result);
      } catch (error) {
        const code =
          error instanceof Error && error.message.startsWith("discord_presence_")
            ? error.message
            : "discord_presence_failed";
        logger.error(
          {
            correlationId: write.identity.correlationId,
            action: write.action,
            code,
            errorName: error instanceof Error ? error.name.slice(0, 64) : "Error",
            errorMessage: error instanceof Error ? error.message.slice(0, 256) : String(error).slice(0, 256),
          },
          "Discord presence action failed",
        );
        return context.json({ error: code }, 502);
      }
    });
  });

  /** One Discord text/voice message becomes one captain turn. Discord family only. */
  ctx.app.post("/v1/captain/channel-turns", async (context) => {
    const body = await readJson(context.req.raw);
    const parsed = DiscordPresenceChannelTurnRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_captain_channel_turn" }, 400);
    const request = parsed.data;
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const expectedLane = request.trigger.kind === "voice_event" ? "discord_voice" : "discord_text";
    if (captain.steerSourceLane !== expectedLane) {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const deliveryKey = `discord:${request.deliveryId}`;
    let receipt;
    try {
      receipt = ctx.discordTurnReceipts.get(deliveryKey);
    } catch {
      return context.json({ error: "captain_channel_turn_uncertain", deliveryStage: "uncertain" }, 502);
    }
    if (receipt !== undefined && receipt.lane !== expectedLane) {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    if (receipt !== undefined && receipt.fingerprint !== fingerprint) {
      return context.json({ error: "captain_turn_idempotency_conflict" }, 409);
    }
    if (receipt?.settled !== undefined) return context.json(receipt.settled);
    let record = ctx.captainTurnResults.get(deliveryKey);
    if (record === undefined && receipt !== undefined) {
      return context.json({ error: "captain_channel_turn_uncertain", deliveryStage: "uncertain" }, 502);
    }
    if (record === undefined) {
      try {
        ctx.discordTurnReceipts.begin(deliveryKey, {
          fingerprint,
          lane: expectedLane,
          origin: {
            baseSessionKey: discordTurnSessionKey(request),
            presenceSessionId:
              request.identity.presenceSessionId ??
              `discord:${request.trigger.guildId ?? "dm"}:${request.trigger.channelId}`,
            characterId: request.identity.characterId,
            credentialRef: request.identity.credentialRef,
            transportKind: request.identity.transportKind,
            ...(request.trigger.guildId === undefined ? {} : { guildId: request.trigger.guildId }),
            channelId: request.trigger.channelId,
            messageId: request.deliveryId,
            actorId: request.trigger.actorId,
          },
        });
      } catch {
        return context.json({ error: "captain_channel_turn_uncertain", deliveryStage: "uncertain" }, 502);
      }
      const turn = Promise.resolve().then(async () => {
        const result = CaptainChannelTurnResultSchema.parse(
          await ctx.dependencies.captain.submitDiscordTurn(request),
        );
        const staged = { ...result, deliveryStage: discordDeliveryStage(result) };
        ctx.discordTurnReceipts.settle(deliveryKey, fingerprint, staged);
        return staged;
      });
      record = { fingerprint, lane: expectedLane, result: turn };
      ctx.captainTurnResults.set(deliveryKey, record);
      const observed = record;
      void turn.then(
        (result) => {
          observed.settled = result;
        },
        () => {
          observed.rejected = true;
        },
      );
    }
    if (context.req.header("prefer") === "respond-async") {
      if (record.rejected)
        return context.json({ error: "captain_channel_turn_uncertain", deliveryStage: "uncertain" }, 502);
      return record.settled === undefined
        ? context.json({ state: "pending", deliveryStage: "stored" }, 202)
        : context.json(record.settled);
    }
    try {
      const result = await record.result;
      logger.info(
        {
          correlationId: request.identity.correlationId,
          deliveryId: request.deliveryId,
          state: result.state,
        },
        "Discord channel captain turn settled",
      );
      return context.json(result);
    } catch {
      return context.json({ error: "captain_channel_turn_uncertain", deliveryStage: "uncertain" }, 502);
    }
  });

  /** A Discord bridge can wait for a long turn without keeping one HTTP request open. */
  ctx.app.get("/v1/captain/channel-turns/:deliveryId", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const deliveryKey = `discord:${context.req.param("deliveryId")}`;
    let receipt;
    try {
      receipt = ctx.discordTurnReceipts.get(deliveryKey);
    } catch {
      return context.json({ error: "captain_channel_turn_uncertain", deliveryStage: "uncertain" }, 502);
    }
    if (receipt === undefined) return context.json({ error: "captain_channel_turn_not_found" }, 404);
    if (captain.steerSourceLane !== receipt.lane) {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    if (receipt.settled !== undefined) return context.json(receipt.settled);
    const record = ctx.captainTurnResults.get(deliveryKey);
    if (record === undefined)
      return context.json({ error: "captain_channel_turn_uncertain", deliveryStage: "uncertain" }, 502);
    if (record.rejected)
      return context.json({ error: "captain_channel_turn_uncertain", deliveryStage: "uncertain" }, 502);
    return record.settled === undefined
      ? context.json({ state: "pending", deliveryStage: "stored" }, 202)
      : context.json(record.settled);
  });

  /**
   * A message typed in a guild channel a Clankie channel is projected onto
   * (ADR 0146). The bridge asks about every message it would otherwise hand to
   * ordinary ingress; `not_projected` sends it back down that path, so a guild
   * Clankie merely reads is completely unaffected by channels existing.
   */
  ctx.app.post(DiscordChannelProjectionMessagePath, async (context) => {
    const body = await readJson(context.req.raw);
    const parsed = DiscordChannelProjectionMessageSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_channel_projection_message" }, 400);
    const request = parsed.data;
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    pruneExpired(ctx.channelProjectionResults, ctx.clock().getTime());
    const previous = ctx.channelProjectionResults.get(request.deliveryId);
    if (previous !== undefined) return context.json(previous.result);
    try {
      const result = await ctx.dependencies.captain.submitChannelProjectionMessage(request);
      ctx.channelProjectionResults.set(request.deliveryId, {
        result,
        expiresAtMs: ctx.clock().getTime() + DELIVERY_RETENTION_MS,
      });
      if (result.state === "accepted") {
        logger.info(
          {
            guildId: request.guildId,
            channelId: request.channelId,
            conversationId: result.conversationId,
            runId: result.runId,
          },
          "Discord channel projection message accepted",
        );
      }
      return context.json(result);
    } catch {
      return context.json({ error: "channel_projection_message_failed" }, 502);
    }
  });
}
