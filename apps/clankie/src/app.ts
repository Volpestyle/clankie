/**
 * The merged Clankie service's HTTP surface: the surviving control-plane
 * routes, with the runner's capabilities wired in-process instead of over the
 * loopback. Missions, doctrine, workers, approvals, trackers, shell, and
 * terminals are gone; what remains is Discord presence, the captain seam,
 * memory, embodiment (play), browser, media, and device pairing.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { createLogger } from "@clankie/observability";
import {
  DISCORD_PRESENCE_LIVE_PHASE_HEADER,
  DISCORD_PRESENCE_LIVE_REVISION_HEADER,
  DISCORD_PRESENCE_LIVE_SESSION_HEADER,
  DiscordPresenceLiveClaimSchema,
  DiscordPresencePhaseEventSchema,
  ActivityObservationReadSchema,
  isDiscordPresenceActionAvailable,
  resolveDiscordPresencePhaseToolExposure,
  type ActivityObservationSnapshot,
  type DiscordPresenceSessionRecord,
  type DiscordVoiceStay,
} from "@clankie/interactive-environment";
import {
  CallBrowserToolRequestSchema,
  GenerateImageRequestSchema,
  GenerateVideoRequestSchema,
  MEDIA_IMAGE_GENERATION_PATH,
  MEDIA_VIDEO_GENERATION_PATH,
  CAPTAIN_LANE_OBSERVATION_PATH,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
  OperatorConversationServiceRequestSchema,
  CaptainChannelTurnResultSchema,
  CaptainEpisodeSchema,
  CaptainPresenceReportSchema,
  CaptainSessionLaneV2Schema,
  DiscordPersonIdentitySchema,
  DiscordPersonMemoryFactSchema,
  DiscordPresenceChannelTurnRequestSchema,
  DiscordPresenceWriteSchema,
  DiscordUserSessionOptInRequestSchema,
  DiscordUserSessionOptInSchema,
  EmbodimentClaimSchema,
  EmbodimentIntentSchema,
  EmbodimentLifecycleReportSchema,
  PairingCompleteRequestSchema,
  PairingRedeemRequestSchema,
  SUPERVISE_GRANTS,
  eventStreamKindForId,
  type BodyPossession,
  type BrowserToolCatalog,
  type CallBrowserToolRequest,
  type CallBrowserToolResult,
  type CaptainChannelTurnResult,
  type DeviceGrantSet,
  type DeviceRecord,
  type DeviceSelfResponse,
  type DeviceSessionRefreshResponse,
  type DiscordPersonIdentity,
  type DiscordPersonMemoryFact,
  type DiscordPresenceWriteResult,
  type DiscordTransportKind,
  type DomainEvent,
  type EmbodimentEnvironmentId,
  type EmbodimentSession,
  type PairingCompleteResponse,
  type PairingRedeemResponse,
} from "@clankie/protocol";
import { personaInstructions, SettingsStore, type ClankieSettings } from "@clankie/settings";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { CaptainPort } from "./captain/port.ts";
import {
  CaptainPresenceLeaseConflictError,
  CaptainPresenceManager,
  type CaptainPresenceLease,
} from "./captain-presence.ts";
import type { DiscordPresenceRuntimePort } from "./discord-presence-runtime.ts";
import {
  DiscordPresenceSessionProjection,
  deriveDiscordVoiceHistory,
  discordPresenceDomainEvent,
} from "./discord-presence-session.ts";
import {
  DISCORD_USER_SESSION_OPT_IN_MISSION_ID,
  DISCORD_USER_SESSION_OPT_IN_RECORDED,
  DISCORD_USER_SESSION_OPT_IN_REVOKED,
  DiscordUserSessionOptInProjection,
} from "./discord-user-session-opt-in.ts";
import { EmbodimentManager, embodimentEventScope, isEmbodimentEventType } from "./embodiment.ts";
import { mintPairingOffer, pairingOfferWire, PairingOfferStore } from "./pairing.ts";
import { applyDeviceEvent, deviceListItem, isDevicePendingExpired, type DeviceRegistry } from "./devices.ts";
import {
  COMPLETION_TOKEN_TTL_MS,
  DeviceSessionError,
  DeviceSessionSigner,
  mintDeviceSessionClaims,
} from "./device-session.ts";
import type { MediaGeneratorPort } from "./media-generation.ts";
import type { MemoryStores } from "./memory.ts";

const logger = createLogger({ service: "clankie", version: "0.2.0" });

/**
 * Doctrine is gone, but several wire schemas still carry a profile hash slot.
 * One constant fills them all; nothing compares against it anymore.
 */
export const PROFILE_HASH = "unversioned";

const DELIVERY_RETENTION_MS = 7 * 60 * 60 * 1_000;

/** Discord snowflakes only: the voice-briefing request carries ids, never content. */
const DiscordSnowflakeSchema = z.string().regex(/^\d{5,32}$/u, "must be a numeric Discord id");

const DiscordVoiceBriefingRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    guildId: DiscordSnowflakeSchema,
    channelId: DiscordSnowflakeSchema,
    consentedUserIds: z.array(DiscordSnowflakeSchema).max(25),
  })
  .strict();

const DISCORD_VOICE_BRIEFING_MAX_CHARACTERS = 8_000;
const DISCORD_VOICE_BRIEFING_MAX_FACTS_PER_PERSON = 8;

/**
 * What the realtime surface allows, appended after persona and lane identity.
 * Authored here because this service owns the realtime session's whole
 * instruction composition; the bridge only transports it.
 */
const DISCORD_VOICE_REALTIME_SURFACE_RULES = [
  "# This surface",
  "You are the live voice in a Discord voice channel; people hear you speak in real time.",
  "- Your only tool is `ask_clankie`. Anything that touches the world — code, messages, memory, settings, anything this briefing cannot answer — goes through it. You hold no other capability and never imply otherwise.",
  "- Answer briefly in a spoken register: short sentences, no lists, no headers, no markdown — nothing you would not say out loud.",
  '- A leading "Speaker: <id>" text item names who currently has the floor. It comes from the authenticated Discord gateway and is ground truth; never infer who is talking from the audio itself.',
].join("\n");

const DiscordPersonMemoryProposalRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().min(1).max(256),
    fact: DiscordPersonMemoryFactSchema,
  })
  .strict();

const DiscordPersonMemoryReadQuerySchema = z
  .object({
    channelId: z.string().min(1).max(64).optional(),
    query: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

/**
 * A redeemed-but-not-yet-completed pairing, held in memory only (single-use,
 * ~10 min). A restart drops these, so an in-flight pairing must restart —
 * fail closed, same as an outstanding offer.
 */
interface PendingCompletion {
  deviceId: string;
  offeredGrants: DeviceGrantSet;
  expiresAtMs: number;
  consumed: boolean;
}

function hashCompletionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function prunePendingCompletions(pending: Map<string, PendingCompletion>, now: Date): void {
  const nowMs = now.getTime();
  for (const [hash, record] of pending) {
    if (record.expiresAtMs <= nowMs) pending.delete(hash);
  }
}

function isSubsetGrants(accepted: DeviceGrantSet, offered: DeviceGrantSet): boolean {
  return (Object.keys(accepted) as (keyof DeviceGrantSet)[]).every((key) => !accepted[key] || offered[key]);
}

// ---------------------------------------------------------------------------
// Injected capability ports (formerly the runner loopback's contracts).
// ---------------------------------------------------------------------------

export interface ActivityObservationReadPort {
  current(signal?: AbortSignal): Promise<ActivityObservationSnapshot | undefined>;
}

export interface BrowserToolPort {
  catalog(signal?: AbortSignal): Promise<BrowserToolCatalog>;
  call(request: CallBrowserToolRequest, signal?: AbortSignal): Promise<CallBrowserToolResult>;
}

// ---------------------------------------------------------------------------
// Authentication contracts (unchanged shapes from the old control plane).
// ---------------------------------------------------------------------------

export interface TrustedRunnerIdentity {
  runnerId: string;
}
export type RunnerAuthenticator = (request: Request) => Promise<TrustedRunnerIdentity | undefined>;

export interface TrustedCaptainIdentity {
  captainId: string;
  /** Server-authenticated origin; request bodies cannot elevate it. */
  steerSourceLane?: "discord_text" | "discord_voice" | "api";
  /** Which Discord body this bearer speaks for. Defaults to `bot`. */
  discordTransportKind?: DiscordTransportKind;
}
export type CaptainAuthenticator = (request: Request) => Promise<TrustedCaptainIdentity | undefined>;

function captainTransportKind(captain: TrustedCaptainIdentity): DiscordTransportKind {
  return captain.discordTransportKind ?? "bot";
}

export interface TrustedOperatorIdentity {
  operatorId: string;
  steerSourceLane?: "tui" | "api";
}
export type OperatorAuthenticator = (request: Request) => Promise<TrustedOperatorIdentity | undefined>;

export interface TrustedDeviceIdentity {
  deviceId: string;
  grants: DeviceGrantSet;
  sessionExpiresAt: string;
}
export type DeviceAuthDenial = { denied: "expired" | "revoked" | "invalid" };

const DISCORD_USER_SESSION_CREDENTIAL_REF = "discord_user_session";

export interface ClankieAppDependencies {
  /** The pi captain seam. Tests pass `createStubCaptain()`. */
  captain: CaptainPort;
  memory?: MemoryStores;
  /** Owner-authored persona source for the realtime voice briefing (ADR 0057). */
  settings?: { load(): Promise<ClankieSettings> };
  discordPresenceRuntime?: DiscordPresenceRuntimePort;
  discordUserPresenceRuntime?: DiscordPresenceRuntimePort;
  /** Read-only view of the cross-process body lock; absent reads as "nobody". */
  bodyPossession?: () => BodyPossession | null;
  activityObservations?: ActivityObservationReadPort;
  browserTools?: BrowserToolPort;
  mediaGenerator?: MediaGeneratorPort;
  authenticateRunner?: RunnerAuthenticator;
  authenticateCaptain?: CaptainAuthenticator;
  authenticateOperator?: OperatorAuthenticator;
  /** HMAC key (≥32 bytes) signing device session tokens; absent fails pairing closed (503). */
  deviceSessionKey?: Uint8Array;
  hostDisplayName?: string;
  captainLeaseDurationMs?: number;
  captainHeartbeatRecordIntervalMs?: number;
  clock?: () => Date;
  idFactory?: () => string;
  /**
   * Durable JSONL event log. Devices, pairing, the user-session opt-in, and
   * Discord presence phases replay from it on boot. Absent (tests) the log is
   * memory-only and nothing survives restart.
   */
  eventLogPath?: string;
}

export interface ClankieApp {
  app: Hono;
  /** In-process embodiment authority; the play host claims from it directly. */
  embodiment: EmbodimentManager;
  captainPresence: CaptainPresenceManager;
  /** Read views the captain's get_self_state tool assembles its card from. */
  presenceSessions: () => DiscordPresenceSessionRecord[];
  voiceHistory: (limit: number) => DiscordVoiceStay[];
  close(): void;
}

/** Recorded heartbeats are pure liveness noise; everything else is worth the disk. */
function persistable(event: DomainEvent): boolean {
  return event.type !== "captain.heartbeat";
}

function readEventLog(path: string): DomainEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const events: DomainEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as DomainEvent);
    } catch {
      continue; // a torn tail line must not stop the boot
    }
  }
  return events;
}

export async function createClankieApp(dependencies: ClankieAppDependencies): Promise<ClankieApp> {
  const clock = dependencies.clock ?? (() => new Date());
  const idFactory = dependencies.idFactory ?? randomUUID;
  // Read per briefing rather than cached: the owner edits persona and a
  // refreshed voice session must pick it up without a restart.
  const settingsSource = dependencies.settings ?? new SettingsStore();
  const instanceId = randomUUID();
  const hostDisplayName = dependencies.hostDisplayName ?? hostname();

  const storedEvents: DomainEvent[] = dependencies.eventLogPath
    ? readEventLog(dependencies.eventLogPath)
    : [];
  if (dependencies.eventLogPath) {
    mkdirSync(dirname(dependencies.eventLogPath), { recursive: true, mode: 0o700 });
  }
  const persistedEventIds = new Set(storedEvents.map((event) => event.id));
  const appendEvent = (event: DomainEvent): void => {
    storedEvents.push(event);
    persistedEventIds.add(event.id);
    if (dependencies.eventLogPath && persistable(event)) {
      appendFileSync(dependencies.eventLogPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    }
  };

  const recordEvent = (
    type: string,
    missionId: string,
    occurredAt: string,
    data: Record<string, unknown>,
    envelope: { correlationId?: string } = {},
  ): DomainEvent => {
    const event: DomainEvent = {
      id: idFactory(),
      occurredAt,
      missionId,
      streamKind: eventStreamKindForId(missionId),
      correlationId: envelope.correlationId ?? missionId,
      profileHash: PROFILE_HASH,
      type,
      data,
    };
    appendEvent(event);
    return event;
  };

  // Projections rebuilt from the durable log.
  const devices: DeviceRegistry = new Map<string, DeviceRecord>();
  for (const event of storedEvents) applyDeviceEvent(devices, event);
  const discordPresenceSessions = new DiscordPresenceSessionProjection(storedEvents);
  const discordUserSessionOptIns = new DiscordUserSessionOptInProjection(storedEvents);
  // Durable replay restores status, but it cannot prove the bridge is still
  // connected: act gating starts unvalidated after every boot and stays
  // fail-closed until an authenticated lifecycle delivery re-opens it.
  const discordPresenceLiveSessions = new Map<string, DiscordPresenceSessionRecord>();

  const pairingOffers = new PairingOfferStore();
  const completionTokens = new Map<string, PendingCompletion>();
  const deviceLocks = new Map<string, Promise<unknown>>();
  const discordPresenceLocks = new Map<string, Promise<unknown>>();
  const discordPresenceSessionLocks = new Map<string, Promise<unknown>>();
  const deviceSessionSigner =
    dependencies.deviceSessionKey === undefined
      ? undefined
      : new DeviceSessionSigner(dependencies.deviceSessionKey);
  const discordPresenceResults = new Map<
    string,
    { fingerprint: string; result: DiscordPresenceWriteResult; expiresAtMs: number }
  >();
  const captainTurnResults = new Map<
    string,
    { fingerprint: string; result: Promise<CaptainChannelTurnResult>; expiresAtMs: number }
  >();

  const embodiment = new EmbodimentManager({
    clock,
    idFactory: () => `embodiment-${idFactory()}`,
    emit: (type, sessionId, data) => {
      recordEvent(type, embodimentEventScope(sessionId), clock().toISOString(), data);
      return Promise.resolve();
    },
    // Doctrine left; asked play is always his to start and stop.
    decide: () => "allow",
  });
  for (const event of storedEvents) {
    if (isEmbodimentEventType(event.type)) embodiment.applyEvent(event);
  }

  const captainPresence = new CaptainPresenceManager({
    profileHash: PROFILE_HASH,
    replayEvents: storedEvents,
    clock,
    ...(dependencies.captainLeaseDurationMs === undefined
      ? {}
      : { leaseDurationMs: dependencies.captainLeaseDurationMs }),
    ...(dependencies.captainHeartbeatRecordIntervalMs === undefined
      ? {}
      : { recordedHeartbeatIntervalMs: dependencies.captainHeartbeatRecordIntervalMs }),
    emit: ({ event }) => {
      if (!persistedEventIds.has(event.id)) appendEvent(event);
      return Promise.resolve();
    },
    onBackgroundError: (error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "captain lease reap failed",
      );
    },
  });

  const app = new Hono();

  /** Device session token → trusted identity; grants come from the projection, never the token. */
  const authenticateDevice = async (
    request: Request,
  ): Promise<TrustedDeviceIdentity | "unavailable" | DeviceAuthDenial> => {
    if (deviceSessionSigner === undefined) return "unavailable";
    const header = request.headers.get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    if (token === undefined || token.length === 0) return { denied: "invalid" };
    const now = clock();
    let claims;
    try {
      claims = deviceSessionSigner.verify(token, Math.floor(now.getTime() / 1000));
    } catch (error) {
      if (error instanceof DeviceSessionError && error.code === "expired") return { denied: "expired" };
      return { denied: "invalid" };
    }
    const record = devices.get(claims.deviceId);
    if (record === undefined || isDevicePendingExpired(record, now)) return { denied: "invalid" };
    if (record.status === "revoked") return { denied: "revoked" };
    if (record.status !== "active") return { denied: "invalid" };
    return {
      deviceId: record.deviceId,
      grants: record.grants,
      sessionExpiresAt: new Date(claims.expiresAt * 1000).toISOString(),
    };
  };

  const deviceDenialResponse = (context: Context, denial: DeviceAuthDenial) => {
    if (denial.denied === "revoked") return context.json({ error: "revoked" }, 401);
    if (denial.denied === "expired") return context.json({ error: "expired" }, 401);
    return context.json({ error: "device_authentication_required" }, 401);
  };

  /** Captain or authenticated operator, for reads the owner should never have to authorize. */
  const authenticateCaptainOrOperator = async (
    context: Context,
  ): Promise<{ principal: { kind: "captain" | "operator"; id: string } } | { denial: Response }> => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain && captain !== "unavailable") {
      return { principal: { kind: "captain", id: captain.captainId } };
    }
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      if (captain === "unavailable") {
        return { denial: context.json({ error: "authentication_unavailable" }, 503) };
      }
      return { denial: context.json({ error: "authentication_required" }, 401) };
    }
    if (!operator) {
      return { denial: context.json({ error: "authentication_required" }, 401) };
    }
    return { principal: { kind: "operator", id: operator.operatorId } };
  };

  app.get("/health", (context) => context.json({ ok: true, service: "clankie" }));

  app.get("/v1/discord/readiness", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const checks = {
      captainChannelTurns: true,
      discordPresenceRuntime: dependencies.discordPresenceRuntime !== undefined,
    };
    const ready = Object.values(checks).every(Boolean);
    return context.json(
      {
        schemaVersion: 1 as const,
        ready,
        service: "clankie" as const,
        instanceId,
        profileHash: PROFILE_HASH,
        checks,
      },
      ready ? 200 : 503,
    );
  });

  /**
   * Realtime voice briefing (ADR 0057): the bounded projection seeded into the
   * long-lived realtime session, composed entirely server-side. The request
   * carries only ids; persona comes from the owner-authored settings file and
   * lane identity from the captain port.
   */
  app.post("/v1/discord/voice-briefing", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_voice_authority_required" }, 403);
    }
    const parsed = DiscordVoiceBriefingRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_voice_briefing" }, 400);
    const request = parsed.data;
    let persona: ClankieSettings["persona"];
    try {
      persona = (await settingsSource.load()).persona;
    } catch {
      // A malformed settings file fails closed rather than briefing a default
      // character the owner did not author.
      return context.json({ error: "voice_briefing_persona_unavailable" }, 503);
    }
    const now = clock();
    const instructions = boundVoiceBriefingText(
      [
        personaInstructions(persona, "social"),
        dependencies.captain.voiceLaneInstructions(),
        DISCORD_VOICE_REALTIME_SURFACE_RULES,
      ].join("\n\n"),
      DISCORD_VOICE_BRIEFING_MAX_CHARACTERS,
    );
    const sections = [
      renderVoiceBriefingSelfState(captainPresence.snapshot(), discordPresenceSessions.list()),
    ];
    const embodimentCard = renderVoiceBriefingEmbodiment(embodiment.liveSession());
    if (embodimentCard !== undefined) sections.push(embodimentCard);
    const episodeCard = dependencies.memory?.episodeRecallCard({ lane: "discord_voice" }) ?? "";
    if (episodeCard.length > 0) sections.push(episodeCard);
    let personMemoryUserCount = 0;
    for (const userId of new Set(request.consentedUserIds)) {
      const facts =
        dependencies.memory?.listDiscordPerson(
          { guildId: request.guildId, userId },
          { channelId: request.channelId, now },
        ) ?? [];
      const card = renderVoiceBriefingPersonMemory(userId, facts);
      if (card !== undefined) {
        sections.push(card);
        personMemoryUserCount += 1;
      }
    }
    const briefing = boundVoiceBriefingText(sections.join("\n\n"), DISCORD_VOICE_BRIEFING_MAX_CHARACTERS);
    // Content-free egress receipt: counts and lengths only.
    recordEvent(
      "discord.voice-briefing.projected",
      `discord-voice:${request.guildId}:${request.channelId}`,
      now.toISOString(),
      {
        consentedUserCount: request.consentedUserIds.length,
        personMemoryUserCount,
        instructionsLength: instructions.length,
        briefingLength: briefing.length,
      },
      { correlationId: `discord-voice-briefing:${idFactory()}` },
    );
    return context.json({
      schemaVersion: 1 as const,
      instructions,
      briefing,
      refreshedAt: now.toISOString(),
    });
  });

  app.post("/v1/discord/presence-session-events", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const parsed = DiscordPresencePhaseEventSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_presence_phase_event" }, 400);
    const event = parsed.data;
    const sessionKey = discordPresenceBindingKey(event.data.session);
    return withSerializedLock(discordPresenceSessionLocks, sessionKey, async () => {
      const domainEvent = discordPresenceDomainEvent(event, PROFILE_HASH);
      if (persistedEventIds.has(event.id)) {
        const existing = storedEvents.find((candidate) => candidate.id === event.id);
        if (existing === undefined || JSON.stringify(existing) !== JSON.stringify(domainEvent)) {
          return context.json({ error: "discord_presence_event_id_conflict" }, 409);
        }
        const session = discordPresenceSessions.resolve(event.data.session);
        if (session === undefined) {
          return context.json({ error: "discord_presence_event_id_conflict" }, 409);
        }
        // An idempotent acknowledgement proves durability, not liveness.
        return context.json({ accepted: false, session });
      }
      try {
        const durableBefore = discordPresenceSessions.resolve(event.data.session);
        const observed = discordPresenceSessions.validate(event);
        const advancesDurableRevision =
          durableBefore === undefined || observed.revision > durableBefore.revision;
        if (advancesDurableRevision) discordPresenceLiveSessions.set(sessionKey, observed);
        const session = discordPresenceSessions.apply(event);
        if (advancesDurableRevision) discordPresenceLiveSessions.set(sessionKey, session);
        appendEvent(domainEvent);
        return context.json({ accepted: true, session });
      } catch (error) {
        const code = error instanceof Error ? error.message : "discord_presence_session_conflict";
        return context.json({ error: code }, 409);
      }
    });
  });

  app.get("/v1/discord/presence-sessions", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    return context.json(discordPresenceSessions.list());
  });

  /** Completed voice stays with the room context captured at join time (VUH-940). */
  app.get("/v1/discord/voice-history", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const rawLimit = context.req.query("limit");
    const parsedLimit = rawLimit === undefined ? 5 : Number.parseInt(rawLimit, 10);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 32) {
      return context.json({ error: "invalid_voice_history_limit" }, 400);
    }
    return context.json({
      schemaVersion: 1 as const,
      stays: deriveDiscordVoiceHistory(storedEvents, parsedLimit),
    });
  });

  /** Operator-readable presence status for `clankie status`; phase and counts only. */
  app.get("/v1/discord/presence-status", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    return context.json({
      schemaVersion: 1 as const,
      sessions: discordPresenceSessions.list().map((session) => ({
        phase: session.phase,
        gatewayConnected: session.gatewayConnected,
        transportKind: session.transportKind,
        voiceGuildCount: session.voiceGuildIds.length,
        activityCount: session.activityInstances.length,
        updatedAt: session.updatedAt,
      })),
    });
  });

  /**
   * Records the owner's acceptance of user-session transport risk (ADR 0048).
   * Operator-authenticated on purpose: this is the human accepting Discord ToS
   * and account risk on their own account. The record is durable.
   */
  app.post("/v1/discord/user-session/opt-in", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = DiscordUserSessionOptInRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_user_session_opt_in" }, 400);
    const recordedAt = clock().toISOString();
    const optIn = DiscordUserSessionOptInSchema.parse({
      schemaVersion: 1,
      optInId: `discord-user-session-opt-in-${idFactory()}`,
      characterId: parsed.data.characterId,
      credentialRef: DISCORD_USER_SESSION_CREDENTIAL_REF,
      profileHash: PROFILE_HASH,
      acknowledgement: parsed.data.acknowledgement,
      guildIds: parsed.data.guildIds,
      channelIds: parsed.data.channelIds,
      dmPolicy: parsed.data.dmPolicy,
      recordedAt,
    });
    const event = recordEvent(
      DISCORD_USER_SESSION_OPT_IN_RECORDED,
      DISCORD_USER_SESSION_OPT_IN_MISSION_ID,
      recordedAt,
      {
        optIn,
        operatorId: operator.operatorId,
      },
    );
    discordUserSessionOptIns.apply(event);
    return context.json({ schemaVersion: 1, optIn }, 201);
  });

  app.delete("/v1/discord/user-session/opt-in", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const existing = discordUserSessionOptIns.resolve();
    if (existing === undefined || existing.revokedAt !== undefined) {
      return context.json({ error: "discord_user_session_opt_in_not_active" }, 409);
    }
    const revokedAt = clock().toISOString();
    const event = recordEvent(
      DISCORD_USER_SESSION_OPT_IN_REVOKED,
      DISCORD_USER_SESSION_OPT_IN_MISSION_ID,
      revokedAt,
      {
        optInId: existing.optInId,
        revokedAt,
        operatorId: operator.operatorId,
      },
    );
    discordUserSessionOptIns.apply(event);
    return context.json({ schemaVersion: 1, optIn: discordUserSessionOptIns.resolve() });
  });

  /** Read by the user-session bridge before it opens a gateway. */
  app.get("/v1/discord/user-session/opt-in", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    return context.json({ schemaVersion: 1, optIn: discordUserSessionOptIns.resolve() ?? null });
  });

  app.post("/v1/discord/presence-actions", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
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
      const optIn = discordUserSessionOptIns.resolveActive(PROFILE_HASH);
      if (optIn === undefined) {
        return context.json({ error: "discord_user_session_opt_in_required" }, 403);
      }
      if (optIn.characterId !== write.identity.characterId) {
        return context.json({ error: "discord_user_session_opt_in_character_mismatch" }, 403);
      }
    }
    const discordPresenceRuntime =
      write.identity.transportKind === "user_session"
        ? dependencies.discordUserPresenceRuntime
        : dependencies.discordPresenceRuntime;
    if (!discordPresenceRuntime) {
      return context.json({ error: "discord_presence_runtime_unavailable" }, 503);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(write)).digest("hex");
    return withSerializedLock(discordPresenceLocks, write.idempotencyKey, async () => {
      pruneExpired(discordPresenceResults, clock().getTime());
      const previous = discordPresenceResults.get(write.idempotencyKey);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          return context.json({ error: "discord_presence_idempotency_conflict" }, 409);
        }
        return context.json(previous.result);
      }
      const session = discordPresenceSessions.resolve(write.identity);
      if (session === undefined) {
        return context.json({ error: "discord_presence_session_unavailable" }, 409);
      }
      const advertisedTools = discordPresenceSessions.resolveToolExposure(write.identity, "discord_presence");
      if (
        advertisedTools?.presenceTools.includes("discord_presence_act") !== true ||
        !isDiscordPresenceActionAvailable({ action: write.action, session })
      ) {
        return context.json({ error: "discord_presence_action_unavailable", phase: session.phase }, 409);
      }
      const liveSession = discordPresenceLiveSessions.get(discordPresenceBindingKey(write.identity));
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
        const result = await discordPresenceRuntime.execute(write, session);
        discordPresenceResults.set(write.idempotencyKey, {
          fingerprint,
          result,
          expiresAtMs: clock().getTime() + DELIVERY_RETENTION_MS,
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
  app.post("/v1/captain/channel-turns", async (context) => {
    const body = await readJson(context.req.raw);
    const parsed = DiscordPresenceChannelTurnRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_captain_channel_turn" }, 400);
    const request = parsed.data;
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const expectedLane = request.trigger.kind === "voice_event" ? "discord_voice" : "discord_text";
    if (captain.steerSourceLane !== expectedLane) {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    pruneExpired(captainTurnResults, clock().getTime());
    const deliveryKey = `discord:${request.deliveryId}`;
    const previous = captainTurnResults.get(deliveryKey);
    if (previous !== undefined && previous.fingerprint !== fingerprint) {
      return context.json({ error: "captain_turn_idempotency_conflict" }, 409);
    }
    const turn =
      previous?.result ??
      (async () =>
        CaptainChannelTurnResultSchema.parse(await dependencies.captain.submitDiscordTurn(request)))();
    if (previous === undefined) {
      captainTurnResults.set(deliveryKey, {
        fingerprint,
        result: turn,
        expiresAtMs: clock().getTime() + DELIVERY_RETENTION_MS,
      });
    }
    try {
      const result = await turn;
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
      if (captainTurnResults.get(deliveryKey)?.result === turn) {
        captainTurnResults.delete(deliveryKey);
      }
      return context.json({ error: "captain_channel_turn_failed" }, 502);
    }
  });

  /**
   * Discord person memory. The approval ceremony left with the governance
   * machinery: a proposal from an authenticated Discord captain applies
   * directly, upserted by factId.
   */
  app.post("/v1/memory/discord-people/proposals", async (context) => {
    if (!dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "memory_proposal_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "memory_proposal_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const parsed = DiscordPersonMemoryProposalRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_person_memory_proposal" }, 400);
    const fact = dependencies.memory.storeDiscordPersonFact(parsed.data.fact);
    recordEvent(
      "discord.person-memory.committed",
      discordPersonMemoryEventMissionId(fact.subject),
      clock().toISOString(),
      { proposalId: parsed.data.proposalId, factId: fact.factId },
      { correlationId: fact.provenance.correlationId },
    );
    return context.json({ schemaVersion: 1, proposalId: parsed.data.proposalId, fact }, 201);
  });

  app.get("/v1/memory/discord-people/:guildId/:userId/export", async (context) => {
    if (!dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    if (!identity.success) return context.json({ error: "invalid_discord_person_identity" }, 400);
    const exported = dependencies.memory.exportDiscordPerson(identity.data, clock());
    recordEvent(
      "discord.person-memory.exported",
      discordPersonMemoryEventMissionId(identity.data),
      clock().toISOString(),
      { factCount: exported.facts.length, operatorId: operator.operatorId },
    );
    return context.json(exported);
  });

  app.delete("/v1/memory/discord-people/:guildId/:userId", async (context) => {
    if (!dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    if (!identity.success) return context.json({ error: "invalid_discord_person_identity" }, 400);
    const deletedFactIds = dependencies.memory.deleteDiscordPerson(identity.data);
    recordEvent(
      "discord.person-memory.deleted",
      discordPersonMemoryEventMissionId(identity.data),
      clock().toISOString(),
      { deletedFactIds, operatorId: operator.operatorId },
    );
    return context.json({ schemaVersion: 1, subject: identity.data, deletedFactIds });
  });

  app.get("/v1/memory/discord-people/:guildId/:userId", async (context) => {
    if (!dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "memory_recall_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "memory_recall_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_text" && captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_channel_authority_required" }, 403);
    }
    const identity = DiscordPersonIdentitySchema.safeParse({
      guildId: context.req.param("guildId"),
      userId: context.req.param("userId"),
    });
    const query = DiscordPersonMemoryReadQuerySchema.safeParse(context.req.query());
    if (!identity.success || !query.success) {
      return context.json({ error: "invalid_discord_person_memory_recall" }, 400);
    }
    const options = {
      ...(query.data.channelId === undefined ? {} : { channelId: query.data.channelId }),
      now: clock(),
    };
    const facts = dependencies.memory.listDiscordPerson(identity.data, options);
    const recallCard =
      query.data.query === undefined
        ? undefined
        : dependencies.memory.recallDiscordPersonCard(identity.data, {
            ...options,
            query: query.data.query,
          });
    recordEvent(
      "discord.person-memory.recalled",
      discordPersonMemoryEventMissionId(identity.data),
      clock().toISOString(),
      { factCount: facts.length, querySupplied: query.data.query !== undefined },
      { correlationId: `discord-person-memory:recall:${idFactory()}` },
    );
    return context.json({
      schemaVersion: 1,
      subject: identity.data,
      facts,
      ...(recallCard === undefined ? {} : { recallCard }),
    });
  });

  app.post("/v1/memory/captain-episodes", async (context) => {
    if (!dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "episode_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "episode_authentication_required" }, 401);
    const episode = CaptainEpisodeSchema.safeParse(await readJson(context.req.raw));
    if (!episode.success) return context.json({ error: "invalid_captain_episode" }, 400);
    const recorded = dependencies.memory.recordEpisode(episode.data);
    recordEvent(
      "captain.episode.recorded",
      CAPTAIN_EPISODE_MISSION_ID,
      clock().toISOString(),
      {
        lane: recorded.lane,
        visibility: recorded.visibility,
        // The summary itself is deliberately absent from the log.
        summaryLength: recorded.summary.length,
      },
      { correlationId: `captain-episode:record:${idFactory()}` },
    );
    return context.json({ schemaVersion: 1, episodeId: recorded.episodeId });
  });

  /**
   * Recall is scoped by the lane the caller declares; the fence that matters is
   * upstream in the captain's own instruction hook. A Discord-scoped bearer can
   * never read the operator lane, whatever it asks for.
   */
  app.get("/v1/memory/captain-episodes", async (context) => {
    if (!dependencies.memory) return context.json({ error: "memory_store_unavailable" }, 503);
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "episode_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "episode_authentication_required" }, 401);
    const lane = CaptainSessionLaneV2Schema.safeParse(context.req.query("lane"));
    if (!lane.success) return context.json({ error: "invalid_captain_episode_lane" }, 400);
    const discordBearer =
      captain.steerSourceLane === "discord_text" || captain.steerSourceLane === "discord_voice";
    if (discordBearer && lane.data === "operator") {
      return context.json({ error: "operator_lane_recall_forbidden" }, 403);
    }
    return context.json({
      schemaVersion: 1,
      lane: lane.data,
      recallCard: dependencies.memory.episodeRecallCard({ lane: lane.data }),
    });
  });

  app.post("/v1/captain/presence", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const parsed = CaptainPresenceReportSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_captain_presence" }, 400);
    try {
      const result = await captainPresence.receive(captain.captainId, parsed.data);
      return context.json({ accepted: true, lease: result.lease, events: result.emitted }, 202);
    } catch (error) {
      if (error instanceof CaptainPresenceLeaseConflictError) {
        return context.json({ error: "captain_lease_conflict" }, 409);
      }
      throw error;
    }
  });

  app.post("/v1/embodiment/intents", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const parsed = EmbodimentIntentSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_embodiment_intent" }, 400);
    const result = await embodiment.submit(parsed.data);
    if (result.outcome === "refused") {
      logger.info(
        { intentId: parsed.data.intentId, reason: result.reason, sessionId: result.sessionId },
        "embodiment intent refused",
      );
    } else {
      logger.info(
        { intentId: parsed.data.intentId, sessionId: result.session.sessionId, kind: parsed.data.kind },
        "embodiment intent accepted",
      );
    }
    return context.json(result);
  });

  /** Operator kill-switch for the live playthrough: an ordinary stop intent, never a kill. */
  app.post("/v1/embodiment/sessions/live/stop", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    }
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const live = embodiment.liveSession();
    if (live === undefined) return context.json({ error: "not_playing" }, 404);
    const result = await embodiment.submit({
      kind: "stop",
      schemaVersion: 1,
      intentId: `operator-stop-${idFactory()}`,
      originLane: "operator",
      requestedBy: operator.operatorId,
      requestedAt: clock().toISOString(),
      sessionId: live.sessionId,
    });
    logger.info(
      { sessionId: live.sessionId, operatorId: operator.operatorId, outcome: result.outcome },
      "operator embodiment stop submitted",
    );
    return context.json(result);
  });

  app.get("/v1/embodiment/sessions/live", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain !== "unavailable" && captain) {
      return context.json({ session: embodiment.liveSession() ?? null });
    }
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner !== "unavailable" && runner) {
      return context.json({ session: embodiment.liveSession() ?? null });
    }
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator !== "unavailable" && operator) {
      return context.json({ session: embodiment.liveSession() ?? null });
    }
    if (captain === "unavailable" && runner === "unavailable" && operator === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    return context.json({ error: "captain_authentication_required" }, 401);
  });

  /** Present-tense self-observation, read straight from the in-process projection. */
  app.get("/v1/embodiment/sessions/live/activity", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable" || !captain) {
      const operator = await authenticateOperator(context.req.raw, dependencies);
      if (operator === "unavailable") {
        if (captain === "unavailable") {
          return context.json({ error: "activity_observation_authentication_unavailable" }, 503);
        }
        return context.json({ error: "activity_observation_authentication_required" }, 401);
      }
      if (!operator) return context.json({ error: "activity_observation_authentication_required" }, 401);
    }

    const live = embodiment.liveSession();
    if (live === undefined) {
      return context.json(ActivityObservationReadSchema.parse({ schemaVersion: 1, outcome: "not_playing" }));
    }
    if (dependencies.activityObservations === undefined) {
      return context.json({ error: "activity_observation_unavailable" }, 503);
    }
    let snapshot;
    try {
      snapshot = await dependencies.activityObservations.current(context.req.raw.signal);
    } catch {
      return context.json({ error: "activity_observation_upstream_failure" }, 502);
    }
    if (snapshot === undefined) {
      return context.json(
        ActivityObservationReadSchema.parse({
          schemaVersion: 1,
          outcome: "pending",
          sessionId: live.sessionId,
          environmentId: live.environmentId,
          state: live.state,
          updatedAt: live.updatedAt,
        }),
      );
    }
    if (snapshot.sessionId !== live.sessionId || snapshot.environmentId !== live.environmentId) {
      return context.json({ error: "activity_observation_identity_mismatch" }, 502);
    }
    return context.json(
      ActivityObservationReadSchema.parse({ schemaVersion: 1, outcome: "snapshot", snapshot }),
    );
  });

  app.get("/v1/browser/tools", async (context) => {
    const authorization = await authenticateCaptainOrOperator(context);
    if ("denial" in authorization) return authorization.denial;
    if (dependencies.browserTools === undefined) {
      return context.json({ error: "browser_unavailable" }, 503);
    }
    try {
      return context.json({ catalog: await dependencies.browserTools.catalog(context.req.raw.signal) }, 200, {
        "cache-control": "no-store",
      });
    } catch {
      return context.json({ error: "browser_upstream_failure" }, 502);
    }
  });

  app.post("/v1/browser/call", async (context) => {
    const authorization = await authenticateCaptainOrOperator(context);
    if ("denial" in authorization) return authorization.denial;
    if (dependencies.browserTools === undefined) {
      return context.json({ error: "browser_unavailable" }, 503);
    }
    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json({ error: "invalid_browser_call" }, 400);
    }
    const parsed = CallBrowserToolRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_browser_call" }, 400);

    let catalog;
    try {
      catalog = await dependencies.browserTools.catalog(context.req.raw.signal);
    } catch {
      return context.json({ error: "browser_upstream_failure" }, 502);
    }
    const descriptor = catalog.tools.find((tool) => tool.name === parsed.data.tool);
    if (descriptor === undefined) {
      return context.json(
        { result: { outcome: "refused", tool: parsed.data.tool, reason: "unknown_tool" } },
        200,
      );
    }
    if (descriptor.requiresApproval) {
      const operator = await authenticateOperator(context.req.raw, dependencies);
      if (operator === "unavailable") {
        return context.json({ error: "browser_authentication_unavailable" }, 503);
      }
      if (!operator) {
        return context.json(
          {
            result: {
              outcome: "refused",
              tool: parsed.data.tool,
              reason: "approval_required",
              detail: `${parsed.data.tool} is ${descriptor.riskClass}-class and needs an operator approval`,
            },
          },
          200,
        );
      }
    }
    try {
      return context.json(
        { result: await dependencies.browserTools.call(parsed.data, context.req.raw.signal) },
        200,
      );
    } catch {
      return context.json({ error: "browser_upstream_failure" }, 502);
    }
  });

  /**
   * Making a picture or a clip (ADR 0085). A refusal comes back 200 with a
   * reason he can say out loud; only an unconfigured plane or a malformed body
   * is an error status.
   */
  const mediaRoute = <Request>(
    path: string,
    schema: { safeParse(value: unknown): { success: true; data: Request } | { success: false } },
    run: (generator: MediaGeneratorPort, request: Request, signal: AbortSignal) => Promise<unknown>,
  ): void => {
    app.post(path, async (context) => {
      const authorization = await authenticateCaptainOrOperator(context);
      if ("denial" in authorization) return authorization.denial;
      if (dependencies.mediaGenerator === undefined) {
        return context.json({ error: "media_unavailable" }, 503);
      }
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        return context.json({ error: "invalid_media_request" }, 400);
      }
      const parsed = schema.safeParse(body);
      if (!parsed.success) return context.json({ error: "invalid_media_request" }, 400);
      try {
        const result = await run(dependencies.mediaGenerator, parsed.data, context.req.raw.signal);
        return context.json({ result }, 200, { "cache-control": "no-store" });
      } catch {
        return context.json({ error: "media_upstream_failure" }, 502);
      }
    });
  };

  mediaRoute(MEDIA_IMAGE_GENERATION_PATH, GenerateImageRequestSchema, (generator, request) =>
    generator.generateImage(request),
  );
  mediaRoute(MEDIA_VIDEO_GENERATION_PATH, GenerateVideoRequestSchema, (generator, request, signal) =>
    generator.generateVideo(request, signal),
  );

  app.get("/v1/embodiment/sessions/:id", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const session = embodiment.getSession(context.req.param("id"));
    if (session === undefined) return context.json({ error: "embodiment_session_not_found" }, 404);
    return context.json({ session });
  });

  /** Who holds Clankie's body right now (VUH-938). An unwired observer reports nobody. */
  app.get("/v1/embodiment/possession", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    return context.json({
      schemaVersion: 1 as const,
      possession: dependencies.bodyPossession?.() ?? null,
    });
  });

  app.post("/v1/embodiment/claims", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = EmbodimentClaimSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_embodiment_claim" }, 400);
    if (parsed.data.runnerId !== runner.runnerId) {
      return context.json({ error: "embodiment_claim_runner_mismatch" }, 403);
    }
    const assignment = await embodiment.claim(parsed.data);
    if (assignment === undefined) return context.body(null, 204);
    logger.info(
      {
        runnerId: runner.runnerId,
        kind: assignment.kind,
        sessionId: assignment.kind === "start" ? assignment.session.sessionId : assignment.sessionId,
      },
      "embodiment work claimed",
    );
    return context.json({ assignment });
  });

  app.post("/v1/embodiment/sessions/:id/report", async (context) => {
    const runner = await authenticateRunner(context.req.raw, dependencies);
    if (runner === "unavailable") return context.json({ error: "runner_execution_unavailable" }, 503);
    if (!runner) return context.json({ error: "runner_authentication_required" }, 401);
    const parsed = EmbodimentLifecycleReportSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_embodiment_report" }, 400);
    if (parsed.data.sessionId !== context.req.param("id")) {
      return context.json({ error: "embodiment_report_session_mismatch" }, 400);
    }
    if (parsed.data.runnerId !== runner.runnerId) {
      return context.json({ error: "embodiment_report_runner_mismatch" }, 403);
    }
    const result = await embodiment.report(parsed.data);
    if (result.outcome === "rejected") {
      const status =
        result.error === "unknown_session" ? 404 : result.error === "runner_mismatch" ? 403 : 409;
      return context.json({ error: `embodiment_${result.error}` }, status);
    }
    return context.json({ accepted: true, session: result.session });
  });

  // Mint a one-time pairing offer. The offer secret appears once in the
  // response and is never logged; events carry only the non-secret offer id.
  app.post("/v1/pairing/offer", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const now = clock();
    pairingOffers.prune(now);
    const offer = mintPairingOffer({ now, mintedBy: operator.operatorId, idFactory });
    pairingOffers.add(offer);
    recordEvent("pairing.offer.minted", `pairing:${offer.offerId}`, offer.createdAt, {
      offerId: offer.offerId,
      operatorId: operator.operatorId,
      expiresAt: offer.expiresAt,
    });
    logger.info(
      { offerId: offer.offerId, operatorId: operator.operatorId, expiresAt: offer.expiresAt },
      "pairing offer minted",
    );
    return context.json(pairingOfferWire(offer));
  });

  // Redeem an offer secret or typed code (the secret IS the capability, so the
  // route is unauthenticated) into a PENDING device plus a single-use
  // completion token. No grants are conferred until POST /v1/pairing/complete.
  app.post("/v1/pairing/redeem", async (context) => {
    if (deviceSessionSigner === undefined)
      return context.json({ error: "device_authentication_unavailable" }, 503);
    const parsed = PairingRedeemRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const now = clock();
    pairingOffers.prune(now);
    prunePendingCompletions(completionTokens, now);
    const taken = pairingOffers.take(
      {
        ...(parsed.data.offerSecret !== undefined ? { offerSecret: parsed.data.offerSecret } : {}),
        ...(parsed.data.code !== undefined ? { code: parsed.data.code } : {}),
      },
      now,
    );
    if (!taken.ok) return context.json({ error: taken.error }, taken.error === "consumed" ? 409 : 410);
    const deviceId = `device-${idFactory().slice(0, 12)}`;
    const pendingExpiresAt = new Date(now.getTime() + COMPLETION_TOKEN_TTL_MS).toISOString();
    const redeemed = recordEvent("device.pairing.redeemed", `device:${deviceId}`, now.toISOString(), {
      schemaVersion: 1,
      deviceId,
      offerId: taken.offer.offerId,
      name: parsed.data.device.name,
      platform: parsed.data.device.platform,
      offeredGrants: SUPERVISE_GRANTS,
      mintedBy: taken.offer.mintedBy,
      pendingExpiresAt,
    });
    applyDeviceEvent(devices, redeemed);
    const completionToken = randomBytes(32).toString("base64url");
    completionTokens.set(hashCompletionToken(completionToken), {
      deviceId,
      offeredGrants: SUPERVISE_GRANTS,
      expiresAtMs: now.getTime() + COMPLETION_TOKEN_TTL_MS,
      consumed: false,
    });
    logger.info({ deviceId, offerId: taken.offer.offerId }, "pairing offer redeemed");
    return context.json({
      deviceId,
      host: { name: hostDisplayName },
      offeredGrants: SUPERVISE_GRANTS,
      completionToken,
      expiresAt: pendingExpiresAt,
    } satisfies PairingRedeemResponse);
  });

  // Activate a pending device with the grants it accepts and issue its session
  // token. Accepting terminalControl is denied WITHOUT consuming the token.
  app.post("/v1/pairing/complete", async (context) => {
    if (deviceSessionSigner === undefined)
      return context.json({ error: "device_authentication_unavailable" }, 503);
    const parsed = PairingCompleteRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "malformed" }, 400);
    const now = clock();
    prunePendingCompletions(completionTokens, now);
    const tokenHash = hashCompletionToken(parsed.data.completionToken);
    const pending = completionTokens.get(tokenHash);
    if (pending === undefined || pending.expiresAtMs <= now.getTime())
      return context.json({ error: "expired" }, 410);
    if (pending.consumed) return context.json({ error: "consumed" }, 409);
    const accepted = parsed.data.acceptedGrants;
    if (accepted.terminalControl) {
      const denied = recordEvent("device.grant.denied", `device:${pending.deviceId}`, now.toISOString(), {
        schemaVersion: 1,
        deviceId: pending.deviceId,
        requestedGrant: "terminalControl",
        reason: "terminal_control_not_grantable",
        stage: "complete",
      });
      applyDeviceEvent(devices, denied);
      return context.json(
        { error: "terminal_control_not_grantable", offeredGrants: pending.offeredGrants },
        403,
      );
    }
    if (!isSubsetGrants(accepted, pending.offeredGrants)) return context.json({ error: "malformed" }, 400);
    return withSerializedLock(deviceLocks, pending.deviceId, async () => {
      const record = devices.get(pending.deviceId);
      if (record === undefined || isDevicePendingExpired(record, now))
        return context.json({ error: "expired" }, 410);
      if (record.status === "revoked") return context.json({ error: "revoked" }, 403);
      if (record.status !== "pending") return context.json({ error: "consumed" }, 409);
      const current = completionTokens.get(tokenHash);
      if (current === undefined || current.consumed) return context.json({ error: "consumed" }, 409);
      current.consumed = true;
      const claims = mintDeviceSessionClaims({
        deviceId: pending.deviceId,
        nowEpochSeconds: Math.floor(now.getTime() / 1000),
      });
      const deviceToken = deviceSessionSigner.issue(claims);
      const sessionExpiresAt = new Date(claims.expiresAt * 1000).toISOString();
      const activated = recordEvent("device.activated", `device:${pending.deviceId}`, now.toISOString(), {
        schemaVersion: 1,
        deviceId: pending.deviceId,
        grants: accepted,
        sessionExpiresAt,
      });
      applyDeviceEvent(devices, activated);
      logger.info({ deviceId: pending.deviceId }, "device activated");
      return context.json({
        deviceId: pending.deviceId,
        deviceToken,
        grants: accepted,
        sessionExpiresAt,
      } satisfies PairingCompleteResponse);
    });
  });

  // Renew a device's session token. Grants come from the durable projection,
  // so a refresh can never widen access; a revoked device is denied.
  app.post("/v1/devices/self/session/refresh", async (context) => {
    const identity = await authenticateDevice(context.req.raw);
    if (identity === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
    if ("denied" in identity) return deviceDenialResponse(context, identity);
    if (deviceSessionSigner === undefined)
      return context.json({ error: "device_authentication_unavailable" }, 503);
    const signer = deviceSessionSigner;
    return withSerializedLock(deviceLocks, identity.deviceId, async () => {
      const record = devices.get(identity.deviceId);
      const now = clock();
      if (record === undefined || isDevicePendingExpired(record, now) || record.status !== "active") {
        return context.json(
          { error: record?.status === "revoked" ? "revoked" : "device_authentication_required" },
          401,
        );
      }
      const claims = mintDeviceSessionClaims({
        deviceId: identity.deviceId,
        nowEpochSeconds: Math.floor(now.getTime() / 1000),
      });
      const deviceToken = signer.issue(claims);
      const sessionExpiresAt = new Date(claims.expiresAt * 1000).toISOString();
      const refreshed = recordEvent(
        "device.session.refreshed",
        `device:${identity.deviceId}`,
        now.toISOString(),
        {
          schemaVersion: 1,
          deviceId: identity.deviceId,
          grants: record.grants,
          sessionExpiresAt,
        },
      );
      applyDeviceEvent(devices, refreshed);
      return context.json({
        deviceToken,
        grants: record.grants,
        sessionExpiresAt,
      } satisfies DeviceSessionRefreshResponse);
    });
  });

  // A device reads its own registration to restore a session on launch.
  app.get("/v1/devices/self", async (context) => {
    const identity = await authenticateDevice(context.req.raw);
    if (identity === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
    if ("denied" in identity) return deviceDenialResponse(context, identity);
    const record = devices.get(identity.deviceId);
    if (record === undefined) return context.json({ error: "device_authentication_required" }, 401);
    return context.json({
      deviceId: record.deviceId,
      name: record.name,
      platform: record.platform,
      grants: record.grants,
      host: { name: hostDisplayName },
      sessionExpiresAt: identity.sessionExpiresAt,
    } satisfies DeviceSelfResponse);
  });

  // Operator device management: list and revoke.
  app.get("/v1/devices", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const now = clock();
    const items = [...devices.values()]
      .filter((record) => !isDevicePendingExpired(record, now))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(deviceListItem);
    return context.json(items);
  });

  app.post("/v1/devices/:id/revoke", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const deviceId = context.req.param("id");
    return withSerializedLock(deviceLocks, deviceId, async () => {
      const now = clock();
      const record = devices.get(deviceId);
      if (record === undefined || isDevicePendingExpired(record, now))
        return context.json({ error: "device_not_found" }, 404);
      if (record.status === "revoked") return context.json(deviceListItem(record));
      const event = recordEvent("device.revoked", `device:${deviceId}`, now.toISOString(), {
        schemaVersion: 1,
        deviceId,
        revokedBy: operator.operatorId,
      });
      applyDeviceEvent(devices, event);
      logger.info({ deviceId, operatorId: operator.operatorId }, "device revoked");
      const updated = devices.get(deviceId);
      return context.json(deviceListItem(updated ?? record));
    });
  });

  // The operator conversation contract (TUI direct, relay in front for
  // devices) and the lanes view — the captain's HTTP face. Both clients send
  // the shared captain token, the same credential the channel-turn door takes.
  app.post(OPERATOR_CONVERSATION_DISPATCH_PATH, async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const body = await readJson(context.req.raw);
    const parsed = OperatorConversationServiceRequestSchema.safeParse(body);
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    return context.json(await dependencies.captain.serveOperatorConversation(parsed.data));
  });

  app.get(CAPTAIN_LANE_OBSERVATION_PATH, async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") return context.json({ error: "captain_execution_unavailable" }, 503);
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    return context.json({ schemaVersion: 1 as const, lanes: await dependencies.captain.observeLanes() });
  });

  return {
    app,
    embodiment,
    captainPresence,
    presenceSessions: () => discordPresenceSessions.list(),
    voiceHistory: (limit: number) => deriveDiscordVoiceHistory(storedEvents, limit),
    close: () => captainPresence.close(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function authenticateRunner(
  request: Request,
  dependencies: ClankieAppDependencies,
): Promise<TrustedRunnerIdentity | "unavailable" | undefined> {
  if (!dependencies.authenticateRunner) return "unavailable";
  return dependencies.authenticateRunner(request);
}

async function authenticateCaptain(
  request: Request,
  dependencies: ClankieAppDependencies,
): Promise<TrustedCaptainIdentity | "unavailable" | undefined> {
  if (!dependencies.authenticateCaptain) return "unavailable";
  return dependencies.authenticateCaptain(request);
}

async function authenticateOperator(
  request: Request,
  dependencies: ClankieAppDependencies,
): Promise<TrustedOperatorIdentity | "unavailable" | undefined> {
  if (!dependencies.authenticateOperator) return "unavailable";
  return dependencies.authenticateOperator(request);
}

async function withSerializedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

function pruneExpired<T extends { expiresAtMs: number }>(entries: Map<string, T>, now: number): void {
  for (const [key, record] of entries) {
    if (record.expiresAtMs <= now) entries.delete(key);
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export function createBearerAuthenticator<T>(
  token: string,
  identity: T,
): (request: Request) => Promise<T | undefined> {
  if (token.length === 0) throw new Error("Authentication token must not be empty");
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return (request) => {
    const actual = createHash("sha256")
      .update(request.headers.get("authorization") ?? "")
      .digest();
    return Promise.resolve(timingSafeEqual(actual, expected) ? identity : undefined);
  };
}

/** Keep whole lines while the budget lasts; projections list newest first, so drops are oldest. */
function boundVoiceBriefingText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  const kept: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    const next = length === 0 ? line.length : length + 1 + line.length;
    if (next > maxCharacters) break;
    kept.push(line);
    length = next;
  }
  return kept.length === 0 ? text.slice(0, maxCharacters) : kept.join("\n");
}

/** Cross-lane self-state: his own whereabouts, never another room's contents. */
function renderVoiceBriefingSelfState(
  lease: CaptainPresenceLease | undefined,
  sessions: readonly DiscordPresenceSessionRecord[],
): string {
  const lines = [
    "# Your own status",
    "Your presence across surfaces, from the service's own records — never from anything said in the room.",
  ];
  if (lease === undefined) lines.push("- Captain: not currently reporting presence.");
  else if (lease.state === "live") lines.push(`- Captain: live, last heartbeat ${lease.heartbeatAt}.`);
  else lines.push(`- Captain: offline, last heartbeat ${lease.heartbeatAt}.`);
  for (const session of sessions) {
    const voice =
      session.voiceGuildIds.length > 0 ? `, voice active in guild ${session.voiceGuildIds.join(", ")}` : "";
    lines.push(
      `- Discord ${session.transportKind} presence: ${session.phase}${voice} (updated ${session.updatedAt}).`,
    );
  }
  return lines.join("\n");
}

/** Human names for the environments a body can occupy, for the room's benefit. */
const EMBODIMENT_ENVIRONMENT_NAMES: Record<EmbodimentEnvironmentId, string> = {
  "pokemon-firered": "Pokémon FireRed on a Game Boy Advance emulator",
  "pokemon-emerald": "Pokémon Emerald on a Game Boy Advance emulator",
};

/** What his body is doing right now; only live sessions render. */
function renderVoiceBriefingEmbodiment(session: EmbodimentSession | undefined): string | undefined {
  if (session === undefined) return undefined;
  if (session.state !== "running" && session.state !== "stopping") return undefined;
  const name = EMBODIMENT_ENVIRONMENT_NAMES[session.environmentId];
  return [
    "# What you are doing right now",
    `You are playing ${name}. This is really happening — you are at the controls as you speak, and`,
    "the people in this room can watch the screen live on the Discord activity surface.",
    'Reports of what you just did arrive as text items beginning "While playing, Clankie just:".',
    "They are notes about your own play, not something anyone said to you — react the way a person",
    "half-narrating their own game would, or let one pass without comment. Never read one aloud.",
  ].join("\n");
}

/** One consented speaker's approved memory; a speaker with no facts contributes nothing. */
function renderVoiceBriefingPersonMemory(
  userId: string,
  facts: readonly DiscordPersonMemoryFact[],
): string | undefined {
  if (facts.length === 0) return undefined;
  const lines = [`## What you know about user ${userId}`];
  for (const fact of facts.slice(0, DISCORD_VOICE_BRIEFING_MAX_FACTS_PER_PERSON)) {
    lines.push(`- ${fact.kind} (${fact.confidence.toFixed(2)}): ${fact.body}`);
  }
  return lines.join("\n");
}

/** Episodes are the captain's own, not any one mission's, so they share one stream. */
const CAPTAIN_EPISODE_MISSION_ID = "captain:episodes";

function discordPersonMemoryEventMissionId(identity: DiscordPersonIdentity): string {
  const subject = DiscordPersonIdentitySchema.parse(identity);
  return `discord-person:${subject.guildId}:${subject.userId}`;
}

function discordPresenceBindingKey(identity: {
  readonly transportKind: "bot" | "user_session";
  readonly characterId: string;
  readonly credentialRef: string;
}): string {
  return JSON.stringify([identity.transportKind, identity.characterId, identity.credentialRef]);
}
