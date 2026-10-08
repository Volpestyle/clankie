import { createMachineJoinRoutes } from "../machine-join-routes.ts";
import { createPersonaVoiceSettingsRoutes } from "../persona-voice-settings-routes.ts";
import { createMachineAccessRoutes } from "../machine-access-routes.ts";
import { isDeepStrictEqual } from "node:util";
import { roomForkIdOf } from "../captain/captain-discord-turns.ts";
import { hostedActivityViewer } from "../hosted-activity-viewer.ts";
import { createWorkerAccountHoldsRoutes } from "../worker-account-holds-routes.ts";
import { createFleetSettingsRoutes } from "../fleet-settings-routes.ts";
import { createFleetResourceRoutes } from "../fleet-resource-routes.ts";
import { createRuntimeHealthRoutes } from "../runtime-health-routes.ts";
import { RuntimeHealthObservationSchema } from "@clankie/protocol";
import { resolveFleetSettingsContext } from "../fleet-settings-context.ts";
import { FleetPrepareRequestSchema } from "@clankie/protocol";
import { WORKER_ACCOUNTS_PATH } from "@clankie/protocol/worker-accounts";
import { SupportGrantStore } from "../support-access.ts";
import { SUPPORT_DEVICE_GRANTS } from "@clankie/protocol/support-access";
import { createIntegrationRoutes } from "../integrate-routes.ts";
import { DiscordVoiceTranscriptStore } from "@clankie/discord-presence-core";
import {
  ActivityObservationReadSchema,
  PLAY_STILL_PATH,
  PLAY_STORY_PATH,
  isDiscordPresenceActionAvailable,
  type DiscordPresenceSessionRecord,
} from "@clankie/interactive-environment";
import {
  BodyLeaseRequestSchema,
  BodyResourceSchema,
  BodyVoiceLeaseRequestSchema,
  BodyVoiceReconcileGuardSchema,
  BodyVoiceReconcileRequestSchema,
  CONVERSATION_HEAD_PATH,
  CallBrowserToolRequestSchema,
  CaptainPresenceReportSchema,
  ConversationHeadRequestSchema,
  DISCORD_ROOM_VOICE_PATH,
  DISCORD_VOICE_OUTPUT_GUARD_PATH,
  DiscordRoomVoiceCommandSchema,
  DiscordVoiceOutputControlSchema,
  EmbodimentIntentSchema,
  GenerateImageRequestSchema,
  GenerateVideoRequestSchema,
  HERDR_BINDING_PATH,
  MEDIA_IMAGE_GENERATION_PATH,
  MEDIA_VIDEO_GENERATION_PATH,
  RivalsCommandSchema,
  ProcessHealthSnapshotSchema,
  eventStreamKindForId,
  type CaptainChannelTurnResult,
  type CaptainSessionLaneV2,
  type DevicePushBinding,
  type DeviceRecord,
  type DiscordChannelProjectionMessageResult,
  type DiscordPresenceWriteResult,
  type DomainEvent,
} from "@clankie/protocol";
import { hostedOperatorAllows } from "@clankie/protocol/hosted-operator";
import { HostedDiscordEnvelopeSchema } from "@clankie/protocol/hosted-discord";
import { HOSTED_OPERATOR_PATH } from "@clankie/protocol/public-gateway";
import { GameplaySettingsSchema, SettingsStore } from "@clankie/settings";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { z } from "zod";
import { createAccountRoutes } from "../account-routes.ts";
import { createAgentSessionRoutes } from "../agent-session-routes.ts";
import type { BodyConversationIdentity } from "../body-lease-router.ts";
import { pumpBodyRequests } from "../body-request-pump.ts";
import { BodyLeaseRecovery } from "../body-lease-recovery.ts";
import { CaptainPresenceLeaseConflictError, CaptainPresenceManager } from "../captain-presence.ts";
import { DiscordTurnReceipts } from "../captain/discord-turn-receipts.ts";
import { registerComputerRoutes } from "../computer-http.ts";
import { ActivitySharingRequestSchema } from "../activity-sharing.ts";
import { ActivityShareRequestError } from "@clankie/rendered-surface-client";
import { changeRuntime } from "../connections.ts";
import { DeviceSessionError, DeviceSessionSigner } from "../device-session.ts";
import { applyDeviceEvent, isDevicePendingExpired, type DeviceRegistry } from "../devices.ts";
import { createDiscordIngressRoutes } from "../discord-ingress.ts";
import {
  DiscordPresenceSessionProjection,
  DiscordVoiceHistoryProjection,
} from "../discord-presence-session.ts";
import { createDiscordRoomRoutes, type RoomAccess, type RoomAuthorization } from "../discord-room-routes.ts";
import { DiscordUserSessionOptInProjection } from "../discord-user-session-opt-in.ts";
import { EmbodimentManager, embodimentEventScope, isEmbodimentEventType } from "../embodiment.ts";
import { RecentEvents, appendEventLog, loadEventLog, persistable } from "../event-log.ts";
import { createFleetProjectMembershipRoutes } from "../fleet-project-membership-routes.ts";
import { ExecutionConnectSchema } from "../herdr-session.ts";
import { createComposerTranscriptionRoutes } from "../composer-transcription.ts";
import { createHostSettingsRoutes } from "../host-settings-routes.ts";
import { registerLinearRoutes } from "./linear-routes.ts";
import type { MediaGeneratorPort } from "../media-generation.ts";
import { createMinecraftRoutes } from "../minecraft-routes.ts";
import { GAME_EXTENSIONS_PATH } from "@clankie/protocol";
import { createModelKeyRoutes } from "../model-key-routes.ts";
import { createHarnessLoginRoutes } from "../harness-login-routes.ts";
import { PairingOfferStore, replayReviewOffers } from "../pairing.ts";
import { createProjectRoutes } from "../project-routes.ts";
import { createPushDispatcher, type PushDispatcher } from "../push.ts";
import { createRuntimeUpdateRoutes } from "../runtime-update-routes.ts";
import { DiscordStreamWatchProjection } from "../stream-watch-observation.ts";
import { defaultDiscordLiveReceiptPath, readVoiceSpeechSnapshot } from "../voice-receipt-activity.ts";
import { WorkHttpRequestSchema, WorkRequestError } from "../work-items.ts";
import { WorkerGrantRequestSchema } from "../worker-mcp.ts";
import { registerConversationRoutes } from "./conversation-routes.ts";
import { PROFILE_HASH, discordPresenceBindingKey, registerDiscordRoutes } from "./discord-routes.ts";
import { authenticateCaptain, authenticateOperator, captainTransportKind, readJson } from "./http-auth.ts";
import { logger } from "./log.ts";
import { registerMemoryRoutes } from "./memory-routes.ts";
import { registerPairingRoutes } from "./pairing-routes.ts";
import { withSerializedLock } from "./request-state.ts";
import { registerSeatRoutes } from "./seat-routes.ts";
import { registerFleetHealthMetricsRoutes } from "./fleet-health-metrics-routes.ts";
import {
  type ClankieApp,
  type ClankieAppDependencies,
  type DeviceAuthDenial,
  type PendingCompletion,
  type TrustedDeviceIdentity,
} from "./types.ts";

export async function createClankieApp(dependencies: ClankieAppDependencies): Promise<ClankieApp> {
  const clock = dependencies.clock ?? (() => new Date());
  const idFactory = dependencies.idFactory ?? randomUUID;
  // Read per briefing rather than cached: the owner edits persona and a
  // refreshed voice session must pick it up without a restart.
  const settingsSource = dependencies.settings ?? new SettingsStore();
  const voiceTranscriptStore = dependencies.voiceTranscriptStore ?? new DiscordVoiceTranscriptStore();
  const instanceId = randomUUID();
  const hostDisplayName = dependencies.hostDisplayName ?? hostname();

  // Replayed once below, then dropped: after boot the projections hold state
  // and `recentEvents` holds only what redelivery checks need.
  const storedEvents: DomainEvent[] = dependencies.eventLogPath
    ? loadEventLog(dependencies.eventLogPath, (message) =>
        logger.warn({ event: "event_log.compaction" }, message),
      )
    : [];
  const recentEvents = new RecentEvents(storedEvents);
  const discordVoiceHistory = new DiscordVoiceHistoryProjection(storedEvents);
  const appendEvent = (event: DomainEvent): void => {
    // Heartbeats neither reach the disk nor stay in memory: the presence
    // manager keeps the current lease, and nothing replays liveness noise.
    if (!persistable(event)) return;
    recentEvents.add(event);
    discordVoiceHistory.apply(event);
    if (dependencies.eventLogPath) appendEventLog(dependencies.eventLogPath, event);
  };

  const recordEvent = (
    type: string,
    streamId: string,
    occurredAt: string,
    data: Record<string, unknown>,
    envelope: { correlationId?: string } = {},
  ): DomainEvent => {
    const event: DomainEvent = {
      id: idFactory(),
      occurredAt,
      missionId: streamId,
      streamKind: eventStreamKindForId(streamId),
      correlationId: envelope.correlationId ?? streamId,
      profileHash: PROFILE_HASH,
      type,
      data,
    };
    appendEvent(event);
    return event;
  };

  // Projections rebuilt from the durable log.
  const devices: DeviceRegistry = new Map<string, DeviceRecord>();
  let supportSyncRunning = false;
  let supportSyncClosed = false;
  let supportSyncedRevision: number | undefined;
  let supportSyncRetryAt = 0;
  const syncSupportGrants = async () => {
    if (
      supportSyncRunning ||
      supportSyncClosed ||
      dependencies.supportGrantSync === undefined ||
      clock().getTime() < supportSyncRetryAt
    )
      return;
    supportSyncRunning = true;
    try {
      const snapshot = supportGrants.snapshot();
      if (snapshot.revision === supportSyncedRevision) return;
      await dependencies.supportGrantSync.syncSupportGrants(snapshot);
      supportSyncedRevision = snapshot.revision;
    } catch {
      supportSyncRetryAt = clock().getTime() + 5000;
      logger.warn({ event: "support.sync_unavailable" }, "Support grant sync will retry");
    } finally {
      supportSyncRunning = false;
    }
  };
  const supportGrants = new SupportGrantStore({
    events: storedEvents,
    recordEvent,
    clock,
    requireAudit: dependencies.hostedBody !== undefined || dependencies.hostedPairing !== undefined,
    ...(dependencies.supportTelemetry === undefined ? {} : { telemetry: dependencies.supportTelemetry }),
    ...(dependencies.supportDeviceRefKey === undefined
      ? {}
      : { deviceRefKey: dependencies.supportDeviceRefKey }),
    changed: () => {
      void syncSupportGrants();
    },
  });
  supportGrants.expire();
  const supportTimer = setInterval(() => {
    try {
      supportGrants.expire();
    } catch {
      logger.warn({ event: "support.expiry_unavailable" }, "Support grant expiration will retry");
    }
    void syncSupportGrants();
  }, 1000);
  supportTimer.unref();
  void syncSupportGrants();
  for (const event of storedEvents) applyDeviceEvent(devices, event);
  const discordPresenceSessions = new DiscordPresenceSessionProjection(storedEvents);
  const discordUserSessionOptIns = new DiscordUserSessionOptInProjection(storedEvents);
  const discordStreamWatch = new DiscordStreamWatchProjection(
    process.env.CLANKIE_DISCORD_ATTACHMENT_ROOT?.trim() || undefined,
  );
  // Durable replay restores status, but it cannot prove the bridge is still
  // connected: act gating starts unvalidated after every boot and stays
  // fail-closed until an authenticated lifecycle delivery re-opens it.
  const discordPresenceLiveSessions = new Map<string, DiscordPresenceSessionRecord>();

  const pairingOffers = new PairingOfferStore();
  // Review offers outlive a restart (ADR 0154): rebuild the open ones from
  // their hash-only audit events and give the gateway their routes back.
  for (const record of replayReviewOffers(storedEvents, clock())) {
    pairingOffers.add(record);
    dependencies.pairingOfferPublisher?.restorePairingRoute?.(record);
  }
  const completionTokens = new Map<string, PendingCompletion>();
  const deviceLocks = new Map<string, Promise<unknown>>();
  const discordPresenceLocks = new Map<string, Promise<unknown>>();
  const discordPresenceSessionLocks = new Map<string, Promise<unknown>>();
  let deviceSessionSigner =
    dependencies.hostedBody !== undefined || dependencies.deviceSessionKey === undefined
      ? undefined
      : new DeviceSessionSigner(dependencies.deviceSessionKey);
  let securityClosed = false;
  let composerAuthKeyId: string | undefined;
  const publishHostedSupportDevice = async (record: DeviceRecord) => {
    if (record.supportGrantId === undefined || dependencies.hostedBody === undefined) return;
    if (dependencies.hostedDeviceSecurity?.publishSupportDevice === undefined)
      throw new Error("Hosted support device publication unavailable");
    await dependencies.hostedDeviceSecurity.publishSupportDevice(record.deviceId, record.supportGrantId);
  };
  const reconcileHostedSecurity = async () => {
    if (securityClosed || deviceSessionSigner !== undefined) return;
    try {
      if (dependencies.hostedDeviceSecurity === undefined) throw new Error("Hosted security unavailable");
      const restored = await dependencies.hostedDeviceSecurity.prepare(
        dependencies.deviceSessionKey,
        [...devices.values()]
          .filter((record) => record.status === "revoked")
          .map((record) => record.deviceId),
      );
      for (const record of devices.values()) await publishHostedSupportDevice(record);
      if (securityClosed) return;
      for (const tombstone of restored.revocations) {
        const record = devices.get(tombstone.dev);
        if (record === undefined || record.status === "revoked") continue;
        const event = recordEvent(
          "device.revoked",
          `device:${tombstone.dev}`,
          new Date(tombstone.at).toISOString(),
          {
            schemaVersion: 1,
            deviceId: tombstone.dev,
            revokedBy: "hosted-fleet",
          },
        );
        applyDeviceEvent(devices, event);
        if (event.type === "device.revoked" && typeof event.data.deviceId === "string")
          dependencies.captain.invalidateQuestionPrincipal?.(event.data.deviceId);
      }
      // Publish the signer last. Pairing, refresh and relay self-authorize
      // remain unavailable throughout reconciliation or any failed retry.
      deviceSessionSigner = new DeviceSessionSigner(restored.key);
      composerAuthKeyId = restored.keyId;
    } catch {
      logger.warn({ event: "hosted.security.unavailable" }, "hosted device admission unavailable");
    }
  };
  let securityRetry: Promise<void> | undefined;
  const retryHostedSecurity = () =>
    (securityRetry ??= reconcileHostedSecurity().finally(() => {
      securityRetry = undefined;
    }));
  if (dependencies.hostedBody !== undefined) await retryHostedSecurity();
  const securityRetryTimer =
    dependencies.hostedBody === undefined
      ? undefined
      : setInterval(() => {
          void retryHostedSecurity();
        }, 30_000);
  securityRetryTimer?.unref();
  const discordPresenceResults = new Map<
    string,
    { fingerprint: string; result: DiscordPresenceWriteResult; expiresAtMs: number }
  >();
  const discordTurnReceipts =
    dependencies.discordTurnReceipts ?? new DiscordTurnReceipts(dependencies.discordTurnReceiptPath);
  let bodyRequestsOpen = true;
  let pumpingBodyRequests = false;
  const conversationBodyRouteAuthorized = (
    owner: import("../captain/conversation-owner.ts").ConversationOwner,
  ): boolean => {
    if (!bodyRequestsOpen) return false;
    const origin = owner.discord;
    const forkId = roomForkIdOf(origin?.deliveryId);
    if (origin !== undefined && forkId !== undefined) {
      // An owner-directed room turn: the owner's operator-lane fork is the
      // authority, not a receipt for someone's message. The room's bot presence
      // must still be live and able to reply.
      const grant = dependencies.captain.roomForkGrant?.(forkId);
      if (
        grant === undefined ||
        grant.room !== owner.conversationId ||
        !isDeepStrictEqual(grant.origin, origin)
      )
        return false;
      const live = discordPresenceLiveSessions.get(
        discordPresenceBindingKey({
          transportKind: "bot",
          characterId: "clankie",
          credentialRef: "discord_bot",
        }),
      );
      return (
        live?.gatewayConnected === true &&
        isDiscordPresenceActionAvailable({ action: "discord.presence.reply", session: live })
      );
    }
    if (origin !== undefined) {
      const source = discordTurnReceipts.get(`discord:${origin.deliveryId ?? origin.messageId}`)?.origin;
      if (
        source === undefined ||
        source.baseSessionKey !== origin.baseSessionKey ||
        source.actorId !== origin.actorId ||
        source.guildId !== origin.guildId ||
        source.channelId !== origin.channelId ||
        source.transportKind !== origin.transportKind
      )
        return false;
      const live = discordPresenceLiveSessions.get(discordPresenceBindingKey(source));
      if (
        live?.gatewayConnected !== true ||
        !isDiscordPresenceActionAvailable({ action: "discord.presence.reply", session: live }) ||
        (origin.transportKind === "user_session" &&
          discordUserSessionOptIns.resolveActive(PROFILE_HASH) === undefined)
      )
        return false;
    }
    return true;
  };
  const bodyRequestCaptain = {
    routeCurrent: conversationBodyRouteAuthorized,
    designatedConversationHead: dependencies.captain.designatedConversationHead,
    validateConversationOwner: async (
      owner: import("../captain/conversation-owner.ts").ConversationOwner,
      mode?: "machine" | "social",
    ) =>
      (await dependencies.captain.validateConversationOwner(owner, mode)) &&
      conversationBodyRouteAuthorized(owner),
    wakeConversation: dependencies.captain.wakeConversation,
  };
  const bodyRequestTimer =
    dependencies.bodyLeases === undefined
      ? undefined
      : setInterval(() => {
          if (pumpingBodyRequests || !bodyRequestsOpen) return;
          pumpingBodyRequests = true;
          void pumpBodyRequests(dependencies.bodyLeases!.router, bodyRequestCaptain, () => bodyRequestsOpen)
            .catch((error) => logger.warn({ error }, "Body request delivery failed"))
            .finally(() => {
              pumpingBodyRequests = false;
            });
        }, 1000);
  bodyRequestTimer?.unref();
  const stopBodyRequests = () => {
    bodyRequestsOpen = false;
    if (bodyRequestTimer !== undefined) clearInterval(bodyRequestTimer);
    bodyRecovery?.close();
    return bodyRecovery?.settled() ?? Promise.resolve();
  };
  const bodyRecovery =
    dependencies.bodyLeases === undefined
      ? undefined
      : new BodyLeaseRecovery({
          store: dependencies.bodyLeases.store,
          router: dependencies.bodyLeases.router,
          holderTurnEnded: (id) => dependencies.captain.conversationTurnIdle(id),
          confirmStopped: confirmBodyStopped,
          remindHolder: async (held, guard) =>
            dependencies.captain.conversationHasNativeSeat(held.conversationId) &&
            dependencies.captain.wakeConversation(
              { conversationId: held.conversationId },
              [
                `Your ${held.resource} lease expired and is held for recovery, so no other conversation (Discord rooms included) can use the ${held.resource}.`,
                `If you are finished with it, recover it; the host confirms it stopped before releasing:`,
                `clankie body request '${JSON.stringify({ action: "recover", resource: held.resource, conversationId: held.conversationId })}'`,
              ].join("\n"),
              guard,
              "machine",
              false,
            ),
          current: () => bodyRequestsOpen,
          onError: (error) => logger.warn({ error }, "Body recovery check failed; lease remains held"),
        });
  bodyRecovery?.start();
  const captainTurnResults = new Map<
    string,
    {
      fingerprint: string;
      lane: "discord_text" | "discord_voice";
      result: Promise<CaptainChannelTurnResult>;
      settled?: CaptainChannelTurnResult;
      rejected?: boolean;
    }
  >();
  /** A gateway redelivery must not run a channel round a second time (ADR 0146). */
  const channelProjectionResults = new Map<
    string,
    { result: DiscordChannelProjectionMessageResult; expiresAtMs: number }
  >();

  const embodiment = new EmbodimentManager({
    ...(dependencies.startPlayHost === undefined ? {} : { startHost: dependencies.startPlayHost }),
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
      if (!recentEvents.has(event.id)) appendEvent(event);
      return Promise.resolve();
    },
    onBackgroundError: (error) => {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        "captain lease reap failed",
      );
    },
  });

  // Every boot projection has consumed the log; release its replay buffer.
  storedEvents.length = 0;

  const app = new Hono();
  registerFleetHealthMetricsRoutes(app, dependencies);
  const supportAuditedRequests = new WeakSet<Request>();
  let managedDiscordClosed = false;
  let managedDiscordSyncRunning = false;
  const syncManagedDiscord = async () => {
    if (managedDiscordClosed || managedDiscordSyncRunning || dependencies.managedDiscord === undefined)
      return;
    managedDiscordSyncRunning = true;
    try {
      await dependencies.managedDiscord.sync();
    } finally {
      managedDiscordSyncRunning = false;
    }
  };
  void syncManagedDiscord();
  const managedDiscordTimer =
    dependencies.managedDiscord === undefined
      ? undefined
      : setInterval(() => void syncManagedDiscord(), 5000);
  managedDiscordTimer?.unref();
  const discordWebRequests = new WeakMap<Request, RoomAuthorization>();

  /** Device session token → trusted identity; grants come from the projection, never the token. */
  const authenticateDevice = async (
    request: Request,
  ): Promise<TrustedDeviceIdentity | "unavailable" | DeviceAuthDenial> => {
    if (deviceSessionSigner === undefined) return "unavailable";
    const header = request.headers.get("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    if (token === undefined || token.length === 0) return { denied: "invalid" };
    let now = clock();
    let claims;
    try {
      claims = deviceSessionSigner.verify(token, Math.floor(now.getTime() / 1000));
    } catch (error) {
      if (error instanceof DeviceSessionError && error.code === "expired") return { denied: "expired" };
      return { denied: "invalid" };
    }
    let record = devices.get(claims.deviceId);
    if (record === undefined || isDevicePendingExpired(record, now)) return { denied: "invalid" };
    if (record.status === "revoked") return { denied: "revoked" };
    if (record.status !== "active") return { denied: "invalid" };
    try {
      await publishHostedSupportDevice(record);
    } catch {
      return "unavailable";
    }
    now = clock();
    record = devices.get(claims.deviceId);
    if (record === undefined || isDevicePendingExpired(record, now)) return { denied: "invalid" };
    if (record.status === "revoked") return { denied: "revoked" };
    if (record.status !== "active") return { denied: "invalid" };
    if (claims.expiresAt <= Math.floor(now.getTime() / 1000)) return { denied: "expired" };
    if (record.supportGrantId !== undefined) {
      const grant = supportGrants.active(record.supportGrantId);
      if (grant === undefined) return { denied: "revoked" };
      if (grant.scope !== "read-state") return { denied: "invalid" };
      const path = new URL(request.url).pathname;
      // Support pairing carries read-state only; shell access is the fleet's separate path.
      if (
        !(
          (request.method === "GET" && path === "/v1/devices/self") ||
          (request.method === "POST" && path === "/v1/devices/self/session/refresh")
        )
      )
        return { denied: "invalid" };
      if (!supportAuditedRequests.has(request)) {
        try {
          supportGrants.accessed(
            record.supportGrantId,
            record.deviceId,
            path === "/v1/devices/self/session/refresh" ? "device-session" : "device-state",
          );
        } catch {
          return "unavailable";
        }
        supportAuditedRequests.add(request);
      }
    }
    if (record.lastSeenAt === undefined || now.getTime() - Date.parse(record.lastSeenAt) >= 60_000) {
      const seen = recordEvent("device.seen", `device:${record.deviceId}`, now.toISOString(), {
        schemaVersion: 1,
        deviceId: record.deviceId,
      });
      applyDeviceEvent(devices, seen);
    }
    return {
      deviceId: record.deviceId,
      grants: record.supportGrantId === undefined ? record.grants : SUPPORT_DEVICE_GRANTS,
      sessionExpiresAt: new Date(claims.expiresAt * 1000).toISOString(),
    };
  };

  // Only requests created inside the authenticated device bridge acquire operator
  // authority. No header, client platform, or ordinary pairing link can assert it.
  const hostedRequests = new WeakMap<Request, string>();
  const hostedOriginalRequests = new WeakMap<Request, Request>();
  const localOperator = dependencies.authenticateOperator;
  const localCaptain = dependencies.authenticateCaptain;
  if (dependencies.hostedPairing !== undefined)
    dependencies = {
      ...dependencies,
      authenticateOperator: async (request) => {
        const candidate = hostedRequests.get(request);
        const deviceId =
          candidate !== undefined && devices.get(candidate)?.status === "active" ? candidate : undefined;
        return deviceId === undefined
          ? localOperator?.(request)
          : { operatorId: deviceId, steerSourceLane: "tui" };
      },
      authenticateCaptain: async (request) => {
        const candidate = hostedRequests.get(request);
        const deviceId =
          candidate !== undefined && devices.get(candidate)?.status === "active" ? candidate : undefined;
        return deviceId === undefined
          ? localCaptain?.(request)
          : { captainId: deviceId, steerSourceLane: "api" };
      },
    };
  app.post(HOSTED_OPERATOR_PATH, bodyLimit({ maxSize: 2 * 1024 * 1024 }), async (context) => {
    if (dependencies.hostedDiscordOperator !== undefined && !context.req.header("authorization")) {
      const parsed = HostedDiscordEnvelopeSchema.safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "unauthorized" }, 401);
      return dependencies.hostedDiscordOperator.accept(parsed.data, async (request) => {
        const inner = new Request(`http://control${request.path}`, {
          method: request.method,
          headers: {
            "content-type": "application/json",
            ...(request.body === undefined
              ? {}
              : { "content-length": String(Buffer.byteLength(request.body)) }),
          },
          signal: context.req.raw.signal,
          ...(request.body === undefined ? {} : { body: request.body }),
        });
        discordWebRequests.set(inner, {
          guard: request.guard,
          current: () => !inner.signal.aborted && request.current(),
        });
        try {
          return await app.fetch(inner);
        } finally {
          discordWebRequests.delete(inner);
        }
      });
    }
    const identity = await authenticateDevice(context.req.raw);
    if (identity === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
    if ("denied" in identity) return deviceDenialResponse(context, identity);
    const record = devices.get(identity.deviceId);
    if (
      dependencies.hostedPairing === undefined ||
      record?.mintedBy !== "hosted-account-operator" ||
      !identity.grants.terminalControl
    )
      return context.json({ error: "operator_device_required" }, 403);
    const parsed = z
      .object({
        method: z.enum(["GET", "POST"]),
        path: z.string().max(2048),
        body: z
          .string()
          .max(1024 * 1024)
          .optional(),
      })
      .strict()
      .safeParse(await readJson(context.req.raw));
    if (!parsed.success || !hostedOperatorAllows(parsed.data.method, parsed.data.path, parsed.data.body))
      return context.json({ error: "invalid_operator_route" }, 400);
    const inner = new Request(`http://control${parsed.data.path}`, {
      method: parsed.data.method,
      // This body was constructed here, not streamed from an untrusted sender.
      // Its exact byte length lets inner body-limit middleware keep the Request
      // identity carrying the hosted-device proof instead of buffering a clone.
      headers: {
        "content-type": "application/json",
        ...(parsed.data.method === "POST" && parsed.data.body !== undefined
          ? { "content-length": String(Buffer.byteLength(parsed.data.body, "utf8")) }
          : {}),
      },
      signal: context.req.raw.signal,
      ...(parsed.data.method === "POST" && parsed.data.body !== undefined ? { body: parsed.data.body } : {}),
    });
    hostedRequests.set(inner, identity.deviceId);
    hostedOriginalRequests.set(inner, context.req.raw);
    try {
      const response = await app.fetch(inner);
      // A parked tail can outlive revocation or expiry. Recheck before releasing
      // its page; admission of an earlier write is not undone by this denial.
      const current = await authenticateDevice(context.req.raw);
      if (current === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
      if ("denied" in current) return deviceDenialResponse(context, current);
      return response;
    } finally {
      hostedRequests.delete(inner);
      hostedOriginalRequests.delete(inner);
    }
  });

  app.post("/v1/activity/viewer", bodyLimit({ maxSize: 32 * 1024 }), async (context) => {
    if (!dependencies.hostedActivity || !dependencies.activitySharing)
      return context.json({ error: "activity_unavailable" }, 503);
    return hostedActivityViewer(
      context.req.raw,
      dependencies.hostedActivity,
      dependencies.activitySharing,
      () => clock().getTime(),
    );
  });

  app.post("/v1/activity/shares", async (context) => {
    const identity = await authenticateOperator(context.req.raw, dependencies);
    if (identity === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!identity) return context.json({ error: "operator_authentication_required" }, 401);
    if (dependencies.activitySharing === undefined)
      return context.json({ error: "activity_sharing_unavailable" }, 503);
    const parsed = ActivitySharingRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_request" }, 400);
    try {
      const result = await dependencies.activitySharing.request(parsed.data, async () => {
        const current = await authenticateOperator(context.req.raw, dependencies);
        return current !== "unavailable" && current?.operatorId === identity.operatorId;
      });
      context.header("cache-control", "no-store");
      return context.json(result);
    } catch (error) {
      if (error instanceof ActivityShareRequestError) {
        return context.json(
          {
            error: "activity_share_request_failed",
            outcome: error.outcome,
            operation: error.operation,
            ...(error.shareId === undefined ? {} : { shareId: error.shareId }),
            ...(error.generation === undefined ? {} : { generation: error.generation }),
          },
          error.outcome === "uncertain" ? 503 : 409,
        );
      }
      const name = error instanceof Error ? error.message : "";
      if (name === "operator_authentication_required") return context.json({ error: name }, 401);
      if (name === "activity_destination_refused") return context.json({ error: name }, 403);
      if (name === "activity_source_unavailable") return context.json({ error: name }, 404);
      if (name === "activity_share_generation_conflict") return context.json({ error: name }, 409);
      if (name === "activity_share_gone" || name === "activity_artifact_unavailable")
        return context.json({ error: name }, 404);
      if (name === "activity_share_capacity") return context.json({ error: name }, 409);
      if (name === "activity_share_busy") return context.json({ error: name }, 429);
      if (error instanceof z.ZodError) return context.json({ error: "invalid_activity_media" }, 400);
      logger.warn({ phase: "activity_share", action: parsed.data.action }, "activity share request failed");
      return context.json({ error: "activity_sharing_unavailable" }, 503);
    }
  });

  const deviceDenialResponse = (context: Context, denial: DeviceAuthDenial) => {
    if (denial.denied === "revoked") return context.json({ error: "revoked" }, 401);
    if (denial.denied === "expired") return context.json({ error: "expired" }, 401);
    return context.json({ error: "device_authentication_required" }, 401);
  };

  // Dedicated paired-device guidance does not enter the hosted operator bridge.
  // Captains, platform hints, and caller-supplied source lanes are never owner proof.
  const authorizeRoom = async (
    request: Request,
    access: RoomAccess,
  ): Promise<RoomAuthorization | undefined> => {
    const web = discordWebRequests.get(request);
    if (web !== undefined) return access !== "guidance" && web.current() ? web : undefined;
    const hostedOriginal = hostedOriginalRequests.get(request);
    const original = hostedOriginal ?? request;
    if (hostedOriginal === undefined) {
      const operator = await localOperator?.(request);
      if (operator)
        return {
          current: () => !request.signal.aborted,
          guard: async () => {
            if (!(await localOperator?.(request))) throw new Error("operator_revoked");
          },
        };
    }
    const device = await authenticateDevice(original);
    if (device === "unavailable" || "denied" in device) return undefined;
    const current = (): boolean => {
      const record = devices.get(device.deviceId);
      if (
        original.signal.aborted ||
        record?.status !== "active" ||
        clock().getTime() >= Date.parse(device.sessionExpiresAt)
      )
        return false;
      if (hostedOriginal !== undefined)
        return record.mintedBy === "hosted-account-operator" && record.grants.terminalControl;
      return access === "observe"
        ? record.grants.terminalObserve
        : access === "guidance"
          ? record.grants.steer
          : false;
    };
    if (!current()) return undefined;
    return {
      current,
      guard: async () => {
        const fresh = await authenticateDevice(original);
        if (fresh === "unavailable" || "denied" in fresh || fresh.deviceId !== device.deviceId || !current())
          throw new Error("room_authority_revoked");
      },
    };
  };
  if (dependencies.roomObservations !== undefined)
    app.route(
      "/",
      createDiscordRoomRoutes({
        machineName: dependencies.hostedBody ? "his cloud computer" : hostDisplayName,
        environment: dependencies.discordEnvironment ?? process.env,
        ...(dependencies.discordDirectory ? { directory: dependencies.discordDirectory } : {}),
        ...(dependencies.discordPermissions ? { permissions: dependencies.discordPermissions } : {}),
        ...(dependencies.discordTestPost ? { testPost: dependencies.discordTestPost } : {}),
        ...(dependencies.managedDiscord ? { policy: dependencies.managedDiscord } : {}),
        ...(dependencies.officialDiscord ? { officialBot: dependencies.officialDiscord } : {}),
        authorize: authorizeRoom,
        captain: dependencies.captain,
        observations: dependencies.roomObservations,
        settings: settingsSource,
      }),
    );

  app.get(DISCORD_ROOM_VOICE_PATH, async (context) => {
    const authority = await authorizeRoom(context.req.raw, "observe");
    if (!authority) return context.json({ error: "room_observe_required" }, 403);
    if (!dependencies.roomVoice) return context.json({ error: "voice_unavailable" }, 503);
    try {
      const status = await dependencies.roomVoice.status();
      await authority.guard();
      if (!authority.current()) return context.json({ error: "room_observe_required" }, 403);
      context.header("cache-control", "no-store");
      return context.json(status);
    } catch {
      return context.json({ error: "voice_unavailable" }, 503);
    }
  });
  app.post(DISCORD_ROOM_VOICE_PATH, async (context) => {
    const authority = await authorizeRoom(context.req.raw, "settings");
    if (!authority) return context.json({ error: "operator_required" }, 403);
    const parsed = DiscordRoomVoiceCommandSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_voice_control" }, 400);
    if (!dependencies.roomVoice) return context.json({ error: "voice_unavailable" }, 503);
    const command = parsed.data;
    if (command.action === "join") {
      const room = await dependencies.captain.serveOperatorConversation({
        op: "get",
        schemaVersion: 1,
        conversationId: command.conversationId,
      });
      const settings = await settingsSource.load();
      if (
        room.op !== "get" ||
        room.conversation?.scope.kind !== "room" ||
        room.conversation.scope.lane !== "discord_voice" ||
        !settings.discord.ownerUserId
      )
        return context.json({ error: "exact_voice_room_required" }, 409);
      try {
        return context.json(
          await dependencies.roomVoice.join(
            command.conversationId,
            room.conversation.scope.targetId,
            settings.discord.ownerUserId,
            authority,
          ),
        );
      } catch {
        return context.json({ error: "voice_control_refused" }, 409);
      }
    }
    if (
      (command.action !== "mute_output" &&
        command.action !== "unmute_output" &&
        command.action !== "leave") ||
      command.stayId === undefined
    )
      return context.json({ error: "voice_control_unsupported" }, 409);
    try {
      return context.json(
        await dependencies.roomVoice.control(
          command.conversationId,
          command.stayId,
          command.action,
          authority,
        ),
      );
    } catch {
      return context.json({ error: "voice_control_refused" }, 409);
    }
  });
  app.post(DISCORD_VOICE_OUTPUT_GUARD_PATH, async (context) => {
    const parsed = DiscordVoiceOutputControlSchema.safeParse(await readJson(context.req.raw));
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (
      !captain ||
      captain === "unavailable" ||
      (captain.steerSourceLane !== "discord_voice" && captain.steerSourceLane !== "discord_text")
    )
      return context.json({ error: "discord_body_required" }, 403);
    if (!parsed.success || !dependencies.roomVoice)
      return context.json({ error: "voice_control_unknown" }, 403);
    try {
      await dependencies.roomVoice.authorize(parsed.data);
      return context.json({ authorized: true });
    } catch {
      return context.json({ error: "voice_control_unknown" }, 403);
    }
  });

  app.route("/", createDiscordIngressRoutes(dependencies.discordIngress));
  app.route(
    "/",
    createRuntimeUpdateRoutes({
      updater: dependencies.runtimeUpdater,
      canary: dependencies.runtimeCanary,
      refreshHarnesses: dependencies.refreshHarnesses,
      settings: settingsSource,
      setup: { runtimes: dependencies.runtimes, herdrBinding: dependencies.herdrBinding },
      pluginVersionInstalled: dependencies.pluginVersionInstalled,
      refreshWorkerCatalogs: dependencies.refreshWorkerCatalogs,
      restartWorkerTools: dependencies.captain.restartWorkerTools,
      holds: dependencies.deployHolds,
      authorize: async (request) => {
        const identity = await authenticateOperator(request, dependencies);
        if (!identity || identity === "unavailable") return undefined;
        let current = true;
        return {
          initiator: {
            kind: request.headers.get("x-clankie-client") === "cli" ? "cli" : "operator",
            operatorId: identity.operatorId,
            ...(request.headers.get("x-clankie-update-conversation")
              ? { claimedConversationId: request.headers.get("x-clankie-update-conversation")! }
              : {}),
            ...(request.headers.get("x-clankie-update-seat-session")
              ? { claimedSeatSessionId: request.headers.get("x-clankie-update-seat-session")! }
              : {}),
          },
          current: () => current,
          guard: async () => {
            const fresh = await authenticateOperator(request, dependencies);
            current = Boolean(fresh && fresh !== "unavailable" && fresh.operatorId === identity.operatorId);
            if (!current) throw new Error("operator_revoked");
          },
        };
      },
    }),
  );
  app.route(
    "/",
    createIntegrationRoutes({
      queue: dependencies.integration,
      holds: dependencies.deployHolds,
      authorize: async (request) => {
        const identity = await authenticateOperator(request, dependencies);
        if (!identity || identity === "unavailable") return undefined;
        return async () => {
          const current = await authenticateOperator(request, dependencies);
          if (!current || current === "unavailable" || current.operatorId !== identity.operatorId)
            throw Error("operator_revoked");
        };
      },
    }),
  );
  /** Owner operator or a current Take Control device: model keys and account connections. */
  const authorizeOwnerSecrets = async (
    request: Request,
  ): Promise<true | "authentication_required" | "forbidden"> => {
    const operator = await authenticateOperator(request, dependencies);
    if (operator && operator !== "unavailable") return true;
    const device = await authenticateDevice(request);
    if (device === "unavailable" || "denied" in device) return "authentication_required";
    return device.grants.terminalControl ? true : "forbidden";
  };
  app.route(
    "/",
    createFleetProjectMembershipRoutes(dependencies.fleetProjectMembership, authorizeOwnerSecrets),
  );
  app.route(
    "/",
    createHarnessLoginRoutes(dependencies.harnessLogins, authorizeOwnerSecrets, async (request) => {
      const operator = await authenticateOperator(request, dependencies);
      if (operator && operator !== "unavailable") return `operator:${operator.operatorId}`;
      const device = await authenticateDevice(request);
      if (device === "unavailable" || "denied" in device || !device.grants.terminalControl) return undefined;
      return `device:${device.deviceId}`;
    }),
  );
  const readCaptainReadiness = async () => {
    if (dependencies.captain.operatorSeatReady?.()) return { ready: true } as const;
    if (!dependencies.modelKeys?.readiness) throw Error("readiness_unavailable");
    const { CaptainReadinessResponseSchema } = await import("@clankie/protocol/captain-readiness");
    return CaptainReadinessResponseSchema.parse(await dependencies.modelKeys.readiness());
  };
  app.route(
    "/",
    createModelKeyRoutes(dependencies.modelKeys, authorizeOwnerSecrets, {
      keyEntryAllowed: async (request) => {
        const setup = dependencies.modelDeviceSetup ?? {
          platform: process.platform,
          hosted: Boolean(dependencies.hostedBody),
        };
        if (setup.platform !== "darwin" || setup.hosted) return true;
        const operator = await authenticateOperator(request, dependencies);
        if (operator && operator !== "unavailable" && !hostedOriginalRequests.has(request)) return true;
        return !(await readCaptainReadiness()).ready;
      },
      signInAuthority: async (request) => {
        const operator = await authenticateOperator(request, dependencies);
        if (operator && operator !== "unavailable")
          return {
            principal: `operator:${operator.operatorId}`,
            commit: async (operation) => {
              const fresh = await authenticateOperator(request, dependencies);
              if (!fresh || fresh === "unavailable" || fresh.operatorId !== operator.operatorId) return false;
              await operation();
              return true;
            },
          };
        const device = await authenticateDevice(request);
        if (device === "unavailable" || "denied" in device || !device.grants.terminalControl)
          return undefined;
        return {
          principal: `device:${device.deviceId}`,
          commit: (operation) =>
            withSerializedLock(deviceLocks, device.deviceId, async () => {
              const fresh = await authenticateDevice(request);
              if (
                fresh === "unavailable" ||
                "denied" in fresh ||
                fresh.deviceId !== device.deviceId ||
                !fresh.grants.terminalControl
              )
                return false;
              await operation();
              return true;
            }),
        };
      },
    }),
  );
  app.route(
    "/",
    createPersonaVoiceSettingsRoutes({
      settings: settingsSource,
      authorizePersona: authorizeOwnerSecrets,
      operator: async (request) => {
        const identity = await authenticateOperator(request, dependencies);
        return identity === "unavailable" ? "unavailable" : identity?.operatorId;
      },
      ...(dependencies.voiceSettingsEnv === undefined
        ? {}
        : { voiceSettingsEnv: dependencies.voiceSettingsEnv }),
    }),
  );

  app.route(
    "/",
    createHostSettingsRoutes(authorizeOwnerSecrets, settingsSource, {
      ...(dependencies.autoUpdateManaged === undefined
        ? {}
        : { autoUpdateManaged: dependencies.autoUpdateManaged }),
      ...(dependencies.applyKeepAwake === undefined ? {} : { applyKeepAwake: dependencies.applyKeepAwake }),
      ...(dependencies.hostPower === undefined ? {} : { power: dependencies.hostPower }),
      ...(dependencies.keepAwakeStatus === undefined
        ? {}
        : { keepAwakeStatus: dependencies.keepAwakeStatus }),
    }),
  );
  app.route("/", createMachineJoinRoutes(dependencies.machineJoins, authorizeOwnerSecrets));
  app.route("/", createAccountRoutes(dependencies.accounts, authorizeOwnerSecrets, settingsSource));
  app.route(
    "/",
    createFleetResourceRoutes(authorizeOwnerSecrets, dependencies.fleetResources, (error) =>
      logger.warn({ error, event: "fleet_resources.simulator_failed" }, "Simulator request failed"),
    ),
  );
  app.route(
    "/",
    createProjectRoutes(
      authorizeOwnerSecrets,
      settingsSource,
      dependencies.projectWorktreeRoot ? { worktreeRoot: dependencies.projectWorktreeRoot } : {},
    ),
  );
  app.route(
    "/",
    createFleetSettingsRoutes(authorizeOwnerSecrets, settingsSource, {
      runtimes: dependencies.runtimes,
      herdrBinding: dependencies.herdrBinding,
      configureResources:
        dependencies.fleetResources === undefined
          ? undefined
          : (policy) => dependencies.fleetResources!.configure(policy),
    }),
  );
  app.route(
    "/",
    createRuntimeHealthRoutes(
      authorizeOwnerSecrets,
      settingsSource,
      () =>
        dependencies.runtimeHealth?.() ?? { state: "starting", durationMs: 0, reasons: [], delivery: "none" },
    ),
  );
  /**
   * Owner operator or any active paired device: account data that is not a
   * secret and needs no terminal grant.
   */
  const authorizeOwnerDevice = async (
    request: Request,
  ): Promise<true | "authentication_required" | "forbidden"> => {
    const operator = await authenticateOperator(request, dependencies);
    if (operator && operator !== "unavailable") return true;
    const device = await authenticateDevice(request);
    return device === "unavailable" || "denied" in device ? "authentication_required" : true;
  };
  app.get("/v1/devices/self/diagnostics-default", async (context) => {
    const authorized = await authorizeOwnerDevice(context.req.raw);
    if (authorized !== true) return context.json({ error: authorized }, 401);
    if (dependencies.hostedBody && !dependencies.accountSettings)
      return context.json({ error: "unavailable" }, 503);
    try {
      const { AccountDiagnosticsDefaultSchema } = await import("@clankie/protocol/account-diagnostics");
      const settings = dependencies.accountSettings
        ? await dependencies.accountSettings.readAccountSettings()
        : { diagnosticsDefault: true };
      return context.json(AccountDiagnosticsDefaultSchema.parse(settings), 200, {
        "cache-control": "no-store",
      });
    } catch {
      return context.json({ error: "unavailable" }, 503);
    }
  });
  app.get("/v1/captain/readiness", async (context) => {
    const authorized = await authorizeOwnerDevice(context.req.raw);
    if (authorized !== true)
      return context.json({ error: authorized }, authorized === "forbidden" ? 403 : 401);
    try {
      return context.json(await readCaptainReadiness(), 200, { "cache-control": "no-store" });
    } catch {
      return context.json({ error: "unavailable" }, 503);
    }
  });
  if (dependencies.runtimeProvider?.quota)
    app.route("/", dependencies.runtimeProvider.quota.routes(authorizeOwnerDevice));
  app.route(
    "/",
    createComposerTranscriptionRoutes(dependencies.composerTranscriptions, async (request) => {
      const original = hostedOriginalRequests.get(request) ?? request;
      const identity = await authenticateDevice(original);
      if (identity === "unavailable" || "denied" in identity || !identity.grants.chat) return undefined;
      const eligible = () => {
        const record = devices.get(identity.deviceId);
        return (
          record?.status === "active" &&
          record.grants.chat &&
          record.supportGrantId === undefined &&
          !original.signal.aborted &&
          clock().getTime() < Date.parse(identity.sessionExpiresAt)
        );
      };
      if (!eligible()) return undefined;
      return {
        deviceId: identity.deviceId,
        sessionExpiresAtMs: Date.parse(identity.sessionExpiresAt),
        support: devices.get(identity.deviceId)?.supportGrantId !== undefined,
        ...(composerAuthKeyId === undefined ? {} : { authKeyId: composerAuthKeyId }),
        current: eligible,
        authorize: async () => {
          const fresh = await authenticateDevice(original);
          return (
            fresh !== "unavailable" &&
            !("denied" in fresh) &&
            fresh.deviceId === identity.deviceId &&
            fresh.grants.chat &&
            eligible()
          );
        },
      };
    }),
  );

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

  /**
   * Which captain lane a bearer speaks for. The operator credential and the
   * console's own captain token are the operator; a Discord bridge bearer is
   * the social lane it serves. This is the one place a bearer becomes a lane,
   * so the seat's tool bank and the headless prompt reads cannot disagree
   * about who holds what.
   */
  const authenticateLane = async (
    context: Context,
  ): Promise<{ lane: CaptainSessionLaneV2 } | { denial: Response }> => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain && captain !== "unavailable") {
      if (captain.steerSourceLane === "discord_text") return { lane: "discord_presence" };
      if (captain.steerSourceLane === "discord_voice") return { lane: "discord_voice" };
      return { lane: "operator" };
    }
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator && operator !== "unavailable") return { lane: "operator" };
    if (captain === "unavailable" && operator === "unavailable") {
      return { denial: context.json({ error: "authentication_unavailable" }, 503) };
    }
    return { denial: context.json({ error: "authentication_required" }, 401) };
  };

  app.get("/v1/connections", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const [runtimes, linear] = await Promise.all([
      dependencies.runtimes?.list() ?? [],
      dependencies.workerMcp?.linearAccount() ?? { status: "unavailable" },
    ]);
    return context.json({ runtimes, accounts: { linear } });
  });

  app.get("/v1/machines", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.runtimes) return context.json({ error: "machines_unavailable" }, 503);
    return context.json(await dependencies.runtimes.machines.list(context.req.query("discover") === "true"));
  });
  app.post("/v1/machines", bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.runtimes) return context.json({ error: "machines_unavailable" }, 503);
    try {
      await dependencies.runtimes.machines.add(await context.req.json());
      return context.json(await dependencies.runtimes.machines.list(true));
    } catch (error) {
      return context.json({ error: "invalid_machine", detail: String(error) }, 400);
    }
  });
  app.route(
    "/",
    createMachineAccessRoutes({
      machines: dependencies.runtimes?.machines,
      authenticateOperator: dependencies.authenticateOperator,
    }),
  );
  app.delete("/v1/machines/:id", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.runtimes) return context.json({ error: "machines_unavailable" }, 503);
    try {
      await dependencies.runtimes.machines.remove(context.req.param("id"));
      return context.json({ ok: true });
    } catch (error) {
      return context.json({ error: "invalid_machine", detail: String(error) }, 400);
    }
  });

  app.get(WORKER_ACCOUNTS_PATH, async (context) => {
    const authority = await authorizeOwnerSecrets(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    if (!dependencies.workerAccounts) return context.json({ error: "worker_accounts_unavailable" }, 503);
    const fleet = context.req.query("fleet");
    if (fleet !== undefined && !/^[a-z][a-z0-9-]{0,63}$/u.test(fleet))
      return context.json({ error: "invalid_fleet" }, 400);
    try {
      return context.json(await dependencies.workerAccounts(fleet));
    } catch (error) {
      return context.json(
        { error: "worker_accounts_failed", detail: error instanceof Error ? error.message : "Unavailable" },
        409,
      );
    }
  });

  app.route("/", createWorkerAccountHoldsRoutes(authorizeOwnerSecrets, settingsSource));

  app.get("/v1/runtime-connections", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    return context.json({ connections: (await dependencies.runtimes?.list()) ?? [] });
  });
  app.post("/v1/runtime-connections", bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.runtimes) return context.json({ error: "runtimes_unavailable" }, 503);
    const input = ExecutionConnectSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json({ error: "invalid_runtime_connection" }, 400);
    try {
      const connected = await changeRuntime(dependencies, "connect", input.data);
      return context.json(connected);
    } catch (error) {
      return context.json(
        {
          error: "runtime_connection_refused",
          detail: error instanceof Error ? error.message : "Connection refused",
        },
        409,
      );
    }
  });
  app.get("/v1/runtime-connections/:id/harnesses", async (context) => {
    const authority = await authorizeOwnerSecrets(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    if (!dependencies.inspectFleetHarnesses) return context.json({ error: "runtimes_unavailable" }, 503);
    try {
      return context.json({
        machine: context.req.param("id"),
        harnesses: await dependencies.inspectFleetHarnesses(context.req.param("id")),
      });
    } catch {
      return context.json(
        {
          error: "harness_inspection_unavailable",
          detail:
            "Remote inspection requires a reachable fleet and the shipped harness inspector; run explicit owner preparation if missing.",
        },
        503,
      );
    }
  });
  app.get("/v1/runtime-connections/:id/membership", async (context) => {
    const authority = await authorizeOwnerSecrets(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    if (!dependencies.inspectFleetMembership) return context.json({ error: "runtimes_unavailable" }, 503);
    try {
      const report = await dependencies.inspectFleetMembership(context.req.param("id"));
      const current = await authorizeOwnerSecrets(context.req.raw);
      if (current !== true) return context.json({ error: current }, current === "forbidden" ? 403 : 401);
      return context.json(report);
    } catch {
      return context.json({ error: "membership_inspection_unavailable" }, 503);
    }
  });
  // The owner's one step for native workers on an ssh fleet.
  app.post("/v1/runtime-connections/:id/prepare", bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.prepareFleet) return context.json({ error: "runtimes_unavailable" }, 503);
    const input = FleetPrepareRequestSchema.safeParse(
      await context.req
        .text()
        .then((raw) => (raw.length === 0 ? {} : JSON.parse(raw)))
        .catch(() => undefined),
    );
    if (!input.success) return context.json({ error: "invalid_fleet_prepare" }, 400);
    const options =
      input.data.codexSourceSetup === undefined ? {} : { codexSourceSetup: input.data.codexSourceSetup };
    try {
      const current = await settingsSource.load();
      const configured = current.execution.connections.find((entry) => entry.id === context.req.param("id"));
      if (!configured?.enabled || !configured.ssh) throw new Error("Configured ssh fleet unavailable");
      const fleet = structuredClone({ id: configured.id, session: configured.session, ssh: configured.ssh });
      const policy = await resolveFleetSettingsContext(
        current,
        {
          workingDirectory: input.data.workingDirectory,
          machine: context.req.param("id"),
          ...(input.data.projectId === undefined ? {} : { projectId: input.data.projectId }),
        },
        { runtimes: dependencies.runtimes, herdrBinding: dependencies.herdrBinding },
      );
      if (
        input.data.expectedMachineRevision !== undefined &&
        input.data.expectedMachineRevision !== policy.machine.targetRevision
      )
        return context.json({ error: "machine_setup_target_changed" }, 409);
      if (
        !input.data.ownerApproved &&
        (policy.effective.machineSetup === "owner" || input.data.codexSourceSetup !== undefined)
      )
        return context.json({ error: "machine_setup_owner_approval_required" }, 403);
      if (!input.data.ownerApproved && !policy.machine.linked)
        return context.json({ error: "machine_setup_link_required" }, 403);
      if (JSON.stringify(await settingsSource.load()) !== JSON.stringify(current))
        throw new Error("Machine setup settings changed");
      const currentOperator = await authenticateOperator(context.req.raw, dependencies);
      if (
        !currentOperator ||
        currentOperator === "unavailable" ||
        currentOperator.operatorId !== operator.operatorId
      )
        return context.json({ error: "operator_authentication_required" }, 401);
      if (JSON.stringify(await settingsSource.load()) !== JSON.stringify(current))
        throw new Error("Machine setup settings changed");
      return context.json({
        ok: true,
        prepared: await dependencies.prepareFleet(context.req.param("id"), options, fleet),
        ownerApproval: input.data.ownerApproved ? "claimed" : "not_claimed",
      });
    } catch (error) {
      return context.json(
        { error: "fleet_prepare_failed", detail: error instanceof Error ? error.message : "Prepare failed" },
        409,
      );
    }
  });
  app.delete("/v1/runtime-connections/:id", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.runtimes) return context.json({ error: "runtimes_unavailable" }, 503);
    try {
      await changeRuntime(dependencies, "disconnect", context.req.param("id"));
      return context.json({ ok: true });
    } catch (error) {
      return context.json(
        {
          error: "runtime_disconnect_refused",
          detail: error instanceof Error ? error.message : "Disconnect refused",
        },
        409,
      );
    }
  });

  app.route(
    "/",
    createAgentSessionRoutes(
      dependencies.agentSessions,
      async (request) => {
        const operator = await authenticateOperator(request, dependencies);
        return operator === "unavailable" ? operator : Boolean(operator);
      },
      async (seat, brief, conversationId) => {
        const result = await dependencies.captain.serveOperatorConversation({
          schemaVersion: 1,
          op: "spawn_seat",
          conversationId,
          seat,
          ...(brief === undefined ? {} : { brief }),
        });
        if (result.op !== "spawn_seat") throw new Error("The captain did not return a hire result");
        return result.result;
      },
      dependencies.runtimes?.machines,
    ),
  );

  app.all("/v1/worker-mcp", async (context) =>
    dependencies.workerMcp
      ? dependencies.workerMcp.handle(context.req.raw)
      : context.json({ error: "worker_mcp_unavailable" }, 503),
  );
  // Local/relay admission proves a pane. A bearer link admits its fleet's tools
  // without claiming a pane; it still confers no native project or mailbox proof.
  app.all("/v1/fleet/mcp", async (context) => {
    const identity =
      dependencies.localFleet?.identity(context.req.raw) ??
      dependencies.fleetLinks?.identity?.(context.req.raw);
    if (identity && dependencies.workerMcp)
      return dependencies.workerMcp.handleLocalFleet(context.req.raw, identity);
    const header = context.req.header("authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;
    const fleet = token === undefined ? undefined : dependencies.fleetLinks?.authenticate(token);
    if (fleet === undefined) return context.json({ error: "fleet_link_required" }, 401);
    if (!dependencies.workerMcp) return context.json({ error: "worker_mcp_unavailable" }, 503);
    return dependencies.workerMcp.handleFleet(
      fleet,
      context.req.raw,
      (presented) => dependencies.fleetLinks?.authenticate(presented) === fleet,
    );
  });
  app.use("/v1/worker-grants/*", async (context, next) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (!dependencies.workerMcp) return context.json({ error: "worker_mcp_unavailable" }, 503);
    context.header("Cache-Control", "no-store");
    return next();
  });
  app.get("/v1/worker-grants/", async (context) =>
    context.json(
      (await dependencies.workerMcp!.list()).map((record) =>
        record.fleet === undefined
          ? record
          : {
              ...record,
              status: "retired",
              detail:
                "This fleet grant no longer gives tools. Admitted fleet members use connected tools independently; inspect clankie fleet status and explicitly revoke this old record.",
            },
      ),
    ),
  );
  app.post("/v1/worker-grants/", async (context) => {
    const input = await context.req.json().catch(() => undefined);
    if (input && typeof input === "object" && "fleet" in input)
      return context.json(
        {
          error: "fleet_grants_retired",
          detail:
            "Fleet grants are retired. Admitted fleet members use connected tools; inspect clankie fleet status and revoke old records with clankie access revoke ID.",
        },
        400,
      );
    const parsed = WorkerGrantRequestSchema.safeParse(input);
    if (!parsed.success) return context.json({ error: "invalid_worker_grant" }, 400);
    try {
      const issued = await dependencies.workerMcp!.issue(parsed.data);
      // A project grant travels by verified membership; it never hands out a bearer.
      if (issued.project !== undefined) {
        const { token: _token, ...grant } = issued;
        return context.json(grant, 201);
      }
      return context.json(issued, 201);
    } catch (error) {
      return context.json(
        {
          error: "worker_grant_refused",
          detail: error instanceof Error ? error.message : "Grant unavailable",
        },
        409,
      );
    }
  });
  app.delete("/v1/worker-grants/:id", async (context) => {
    try {
      return context.json(await dependencies.workerMcp!.revoke(context.req.param("id")));
    } catch {
      return context.json({ error: "worker_grant_unavailable" }, 404);
    }
  });
  app.get("/v1/worker-grants/linear/account", async (context) =>
    context.json(await dependencies.workerMcp!.linearAccount()),
  );
  app.post("/v1/worker-grants/linear/account", async (context) => {
    try {
      return context.json(await dependencies.workerMcp!.linearAccount(true));
    } catch (error) {
      return context.json(
        {
          error: "account_verification_failed",
          detail: error instanceof Error ? error.message : "Verification failed",
        },
        409,
      );
    }
  });

  app.get(HERDR_BINDING_PATH, async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const connection = context.req.query("connection");
    const binding = connection
      ? await dependencies.runtimes?.binding(connection)
      : dependencies.herdrBinding?.();
    if (!binding) return context.json({ error: "herdr_binding_unavailable" }, 503);
    return context.json(binding);
  });

  app.get(GAME_EXTENSIONS_PATH, async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    context.header("Cache-Control", "no-store");
    if (!dependencies.gameExtensions) return context.json({ error: "game_extensions_unavailable" }, 503);
    try {
      return context.json(await dependencies.gameExtensions.catalog());
    } catch {
      return context.json({ error: "game_extensions_unavailable" }, 503);
    }
  });

  app.post("/v1/internal/minecraft-login-code/authorize", async (context) => {
    const body = await authenticateCaptain(context.req.raw, dependencies);
    if (!body || body === "unavailable" || body.steerSourceLane !== "discord_text")
      return context.body(null, 403);
    const input = await context.req.json().catch(() => undefined);
    if (!input || typeof input !== "object" || typeof input.capability !== "string")
      return context.body(null, 403);
    const { capability, ...payload } = input;
    const allowed = await dependencies.minecraftPrivateDelivery
      ?.authorize(capability, payload)
      .catch(() => false);
    context.header("Cache-Control", "no-store");
    return context.body(null, allowed ? 204 : 403);
  });

  const gameRouteOptions = {
    settings: settingsSource,
    authorize: async (request: Request) => {
      const operator = await authenticateOperator(request, dependencies);
      if (!operator || operator === "unavailable") return undefined;
      return operatorBodyIdentity(
        request.headers.get("x-clankie-conversation-id") ??
          dependencies.captain.seatContext()?.conversationId,
        request,
      );
    },
  };
  if (dependencies.gameExtensions === undefined) {
    app.route(
      "/",
      createMinecraftRoutes({
        ...gameRouteOptions,
        ...(dependencies.minecraft === undefined ? {} : { service: dependencies.minecraft }),
        ...(dependencies.minecraftHost === undefined ? {} : { host: dependencies.minecraftHost }),
      }),
    );
  } else {
    app.use("*", async (context, next) => {
      for (const projection of dependencies.gameExtensions!.projections()) {
        if (projection.paths.includes(context.req.path))
          return projection.routes(gameRouteOptions).fetch(context.req.raw);
      }
      await next();
    });
  }

  if (dependencies.gameExtensions === undefined)
    app.post("/v1/rivals", async (context) => {
      const operator = await authenticateOperator(context.req.raw, dependencies);
      if (operator === "unavailable")
        return context.json({ error: "operator_authentication_unavailable" }, 503);
      if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
      const parsed = RivalsCommandSchema.safeParse(await context.req.json().catch(() => undefined));
      if (!parsed.success) return context.json({ error: "invalid_rivals_command" }, 400);
      if (!dependencies.rivals)
        return context.json({ outcome: "refused", reason: "rivals_unavailable" }, 503);
      return context.json(
        await dependencies.rivals.call(
          parsed.data,
          operatorBodyIdentity(
            context.req.raw.headers.get("x-clankie-conversation-id") ??
              dependencies.captain.seatContext()?.conversationId,
            context.req.raw,
          ),
        ),
      );
    });

  // Optional execution and doorway failures do not make the captain unhealthy.
  app.get("/health", (context) => {
    if (dependencies.hostedBody !== undefined && deviceSessionSigner === undefined)
      return context.json({ error: "hosted_security_unavailable" }, 503);
    const herdr = dependencies.herdrRuntime?.();
    const doorway = dependencies.publicGatewayDoorway?.();
    const power = dependencies.hostPower?.();
    let runtime;
    try {
      const identity = z
        .object({
          pid: z.number().int().safe().min(2),
          commit: z.string().regex(/^[a-f0-9]{40}$/iu),
          root: z.string().min(1).max(4096),
          instanceId: z.string().uuid(),
        })
        .safeParse(dependencies.runtimeUpdater?.runtime);
      if (identity.success) runtime = identity.data;
    } catch {
      // Optional boot identity must not turn updater diagnostics into liveness failure.
    }
    return context.json({
      ok: true,
      service: "clankie",
      processHealth: ProcessHealthSnapshotSchema.parse(
        (() => {
          const cpu = process.cpuUsage();
          return {
            schemaVersion: 1,
            instanceId,
            pid: process.pid,
            uptimeMs: process.uptime() * 1000,
            cpu: { userMicros: cpu.user, systemMicros: cpu.system },
          };
        })(),
      ),
      ...(herdr === undefined ? {} : { herdr }),
      ...(doorway === undefined ? {} : { doorway }),
      ...(power === undefined ? {} : { power }),
      ...(runtime === undefined ? {} : { runtime }),
      ...(() => {
        try {
          const observation = RuntimeHealthObservationSchema.safeParse(dependencies.runtimeHealth?.());
          return observation.success ? { runtimeHealth: observation.data } : {};
        } catch {
          return {};
        }
      })(),
    });
  });
  const { laneMcp } = registerSeatRoutes({
    get dependencies() {
      return dependencies;
    },
    get app() {
      return app;
    },
    get authenticateLane() {
      return authenticateLane;
    },
  });
  registerDiscordRoutes({
    get app() {
      return app;
    },
    get dependencies() {
      return dependencies;
    },
    get instanceId() {
      return instanceId;
    },
    get settingsSource() {
      return settingsSource;
    },
    get clock() {
      return clock;
    },
    get captainPresence() {
      return captainPresence;
    },
    get discordPresenceSessions() {
      return discordPresenceSessions;
    },
    get discordStreamWatch() {
      return discordStreamWatch;
    },
    get embodiment() {
      return embodiment;
    },
    get recordEvent() {
      return recordEvent;
    },
    get idFactory() {
      return idFactory;
    },
    get discordPresenceLiveSessions() {
      return discordPresenceLiveSessions;
    },
    get discordUserSessionOptIns() {
      return discordUserSessionOptIns;
    },
    get discordPresenceSessionLocks() {
      return discordPresenceSessionLocks;
    },
    get recentEvents() {
      return recentEvents;
    },
    get appendEvent() {
      return appendEvent;
    },
    get discordVoiceHistory() {
      return discordVoiceHistory;
    },
    get authorizeRoom() {
      return authorizeRoom;
    },
    get voiceTranscriptStore() {
      return voiceTranscriptStore;
    },
    get authenticateCaptainOrOperator() {
      return authenticateCaptainOrOperator;
    },
    get discordPresenceLocks() {
      return discordPresenceLocks;
    },
    get discordPresenceResults() {
      return discordPresenceResults;
    },
    get discordTurnReceipts() {
      return discordTurnReceipts;
    },
    get captainTurnResults() {
      return captainTurnResults;
    },
    get channelProjectionResults() {
      return channelProjectionResults;
    },
  });
  registerMemoryRoutes({
    get app() {
      return app;
    },
    get dependencies() {
      return dependencies;
    },
    get recordEvent() {
      return recordEvent;
    },
    get clock() {
      return clock;
    },
    get idFactory() {
      return idFactory;
    },
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

  app.get("/v1/games/configuration", async (context) => {
    const authorization = await authenticateCaptainOrOperator(context);
    if ("denial" in authorization) return authorization.denial;
    return context.json({ games: (await settingsSource.load()).gameplay, restart: "clankie restart" });
  });

  app.put("/v1/games/configuration", async (context) => {
    const authorization = await authorizeOwnerSecrets(context.req.raw);
    if (authorization !== true)
      return context.json({ error: authorization }, authorization === "forbidden" ? 403 : 401);
    const parsed = GameplaySettingsSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_game_configuration" }, 400);
    if (settingsSource.update === undefined) return context.json({ error: "settings_unavailable" }, 503);
    const updated = await settingsSource.update((current) => ({ ...current, gameplay: parsed.data }));
    return context.json({ games: updated.gameplay, restart: "clankie restart" });
  });

  app.post("/v1/embodiment/sessions/live/guide", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = z
      .strictObject({ text: z.string().trim().min(1).max(400), conversationId: z.string().min(1).max(256) })
      .safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_play_direction" }, 400);
    if (dependencies.guidePokemonPlay === undefined)
      return context.json({ error: "play_direction_unavailable" }, 503);
    const identity = operatorBodyIdentity(parsed.data.conversationId, context.req.raw);
    if (identity === undefined) return context.json({ error: "conversation_authority_required" }, 403);
    try {
      return context.json(await dependencies.guidePokemonPlay(parsed.data.text, identity));
    } catch {
      return context.json({ error: "play_direction_not_authorized" }, 409);
    }
  });

  app.post("/v1/embodiment/intents", async (context) => {
    if (dependencies.bodyLeases !== undefined) {
      const operator = await authenticateOperator(context.req.raw, dependencies);
      if (operator === "unavailable")
        return context.json({ error: "operator_authentication_unavailable" }, 503);
      if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
      const parsed = EmbodimentIntentSchema.safeParse(await readJson(context.req.raw));
      if (!parsed.success) return context.json({ error: "invalid_embodiment_intent" }, 400);
      if (dependencies.bodyPlaySessions === undefined)
        return context.json({ error: "body_play_unavailable" }, 503);
      const selected = operatorBodyIdentity(parsed.data.conversationId, context.req.raw);
      const identity =
        selected === undefined
          ? undefined
          : {
              ...selected,
              authorize: async () => {
                const current = await authenticateOperator(context.req.raw, dependencies);
                return Boolean(
                  current && current !== "unavailable" && current.operatorId === operator.operatorId,
                );
              },
            };
      const result = await dependencies.bodyPlaySessions.submit(
        { ...parsed.data, originLane: "operator", requestedBy: operator.operatorId },
        identity,
        embodiment,
      );
      return context.json(result, result.outcome === "refused" && result.bodyLease !== undefined ? 409 : 200);
    }
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
    const result = await embodiment.submit(
      {
        kind: "stop",
        schemaVersion: 1,
        intentId: `operator-stop-${idFactory()}`,
        originLane: "operator",
        requestedBy: operator.operatorId,
        requestedAt: clock().toISOString(),
        sessionId: live.sessionId,
      },
      {
        guard: async () => {
          const current = await authenticateOperator(context.req.raw, dependencies);
          if (
            context.req.raw.signal.aborted ||
            !current ||
            current === "unavailable" ||
            current.operatorId !== operator.operatorId
          )
            throw new Error("Operator stop authority changed");
        },
        beforeStart: async () => {
          throw new Error("A stop override cannot start a play session");
        },
      },
    );
    logger.info(
      { sessionId: live.sessionId, operatorId: operator.operatorId, outcome: result.outcome },
      "operator embodiment stop submitted",
    );
    return context.json(result);
  });

  app.get("/v1/embodiment/sessions/live", async (context) => {
    const authorization = await authenticateCaptainOrOperator(context);
    if ("denial" in authorization) return authorization.denial;
    return context.json({ session: (await embodiment.observe()) ?? null });
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

    const live = await embodiment.observe();
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

  const authorizePlaySight = async (context: Context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain !== "unavailable" && captain) return { ok: true as const };
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable") {
      if (captain === "unavailable") {
        return {
          ok: false as const,
          response: context.json({ error: "play_sight_authentication_unavailable" }, 503),
        };
      }
      return {
        ok: false as const,
        response: context.json({ error: "play_sight_authentication_required" }, 401),
      };
    }
    if (!operator) {
      return {
        ok: false as const,
        response: context.json({ error: "play_sight_authentication_required" }, 401),
      };
    }
    return { ok: true as const };
  };

  /** One still of his own live screen. Read-only; no controller. */
  app.get(PLAY_STILL_PATH, async (context) => {
    const authorization = await authorizePlaySight(context);
    if (!authorization.ok) return authorization.response;
    if (dependencies.playSight === undefined) {
      return context.json({ schemaVersion: 1, outcome: "not_playing" });
    }
    const live = await embodiment.observe();
    const sight = dependencies.playSight.still();
    if (live === undefined) {
      return context.json({ schemaVersion: 1, outcome: "not_playing" });
    }
    if (sight.outcome === "still" && sight.sessionId !== live.sessionId) {
      return context.json({ error: "play_sight_identity_mismatch" }, 502);
    }
    if (sight.outcome === "pending" && sight.sessionId !== live.sessionId) {
      return context.json({ error: "play_sight_identity_mismatch" }, 502);
    }
    if (sight.outcome === "not_playing") {
      return context.json({
        schemaVersion: 1,
        outcome: "pending",
        sessionId: live.sessionId,
        environmentId: live.environmentId,
      });
    }
    return context.json(sight);
  });

  /** Bounded journal story of the live playthrough. Not the raw log. */
  app.get(PLAY_STORY_PATH, async (context) => {
    const authorization = await authorizePlaySight(context);
    if (!authorization.ok) return authorization.response;
    if (dependencies.playSight === undefined) {
      return context.json({ schemaVersion: 1, outcome: "not_playing" });
    }
    const live = await embodiment.observe();
    const sight = dependencies.playSight.story();
    if (live === undefined) {
      return context.json({ schemaVersion: 1, outcome: "not_playing" });
    }
    if (sight.outcome === "card" && sight.card.sessionId !== live.sessionId) {
      return context.json({ error: "play_sight_identity_mismatch" }, 502);
    }
    if (sight.outcome === "pending" && sight.sessionId !== live.sessionId) {
      return context.json({ error: "play_sight_identity_mismatch" }, 502);
    }
    if (sight.outcome === "not_playing") {
      return context.json({
        schemaVersion: 1,
        outcome: "pending",
        sessionId: live.sessionId,
        environmentId: live.environmentId,
      });
    }
    return context.json(sight);
  });

  // Which harnesses here can drive the owner's apps and Chrome (ADR 0199). It
  // describes the owner's machine and sessions, so only the operator reads it;
  // an explicit read re-probes rather than trusting the prompt's cache.
  app.post("/v1/discord/voice-reconcile-guard", async (context) => {
    const input = BodyVoiceReconcileGuardSchema.safeParse(await readJson(context.req.raw));
    if (!input.success) return context.json({ authorized: false }, 400);
    const principal = await authenticateCaptain(context.req.raw, dependencies);
    const body = input.data;
    const registered = () =>
      [...discordPresenceLiveSessions.values()].find(
        (session) =>
          session.sessionId === body.presenceSessionId &&
          session.characterId === body.subject.characterId &&
          session.credentialRef === body.subject.credentialRef &&
          session.transportKind === body.subject.transportKind &&
          session.gatewayConnected,
      );
    if (
      principal === undefined ||
      principal === "unavailable" ||
      captainTransportKind(principal) !== body.subject.transportKind ||
      registered() === undefined ||
      (body.subject.transportKind === "user_session" &&
        discordUserSessionOptIns.resolveActive(PROFILE_HASH) === undefined)
    )
      return context.json({ authorized: false }, 403);
    const allowed = await dependencies.bodyVoiceStays?.authorizeReconciliation(
      BodyVoiceReconcileRequestSchema.parse({ nonce: body.nonce, subject: body.subject, stays: body.stays }),
      body.presenceSessionId,
    );
    return context.json({
      authorized: allowed === true && !context.req.raw.signal.aborted && registered() !== undefined,
    });
  });

  app.post("/v1/discord/voice-lease", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === undefined || captain === "unavailable")
      return context.json({ error: "captain_authentication_required" }, 401);
    const parsed = BodyVoiceLeaseRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_voice_lease_request" }, 400);
    const voice = dependencies.bodyVoiceStays;
    if (voice === undefined) return context.json({ outcome: "rejected", reason: "unavailable" }, 409);
    const input = parsed.data;
    const target = input.stay.target;
    const transport = captainTransportKind(captain);
    const registered = () =>
      [...discordPresenceLiveSessions.values()].find(
        (session) =>
          session.sessionId === target.presenceSessionId && session.transportKind === target.transportKind,
      );
    if (transport !== target.transportKind || registered() === undefined)
      return context.json({ outcome: "rejected", reason: "identity_required" }, 409);
    const authorize = async () => {
      const current = await authenticateCaptain(context.req.raw, dependencies);
      return (
        current !== undefined &&
        current !== "unavailable" &&
        captainTransportKind(current) === transport &&
        registered() !== undefined &&
        (transport !== "user_session" || discordUserSessionOptIns.resolveActive(PROFILE_HASH) !== undefined)
      );
    };
    // Only registered body ingress can resolve this room; the request has no conversation ID.
    const identity: BodyConversationIdentity = {
      conversationId: dependencies.captain.bodyRoomConversation(
        "discord_voice",
        `${target.guildId}:${target.channelId}`,
      ),
      current: () =>
        !context.req.raw.signal.aborted &&
        registered() !== undefined &&
        (input.action === "finish" || registered()?.gatewayConnected === true),
      authorize,
    };
    try {
      if (!(await authorize()) || !identity.current())
        return context.json({ outcome: "rejected", reason: "not_authorized" }, 409);
      const result =
        input.action === "claim"
          ? await voice.claim(input.stay, identity, input.ticket, {
              characterId: registered()!.characterId,
              credentialRef: registered()!.credentialRef,
              transportKind: target.transportKind,
            })
          : input.action === "heartbeat"
            ? await voice.heartbeat(input.stay, input.incarnation, identity)
            : voice.finish(input.stay, input.incarnation);
      return context.json(result, result.outcome === "rejected" || result.outcome === "busy" ? 409 : 200);
    } catch {
      return context.json({ outcome: "rejected", reason: "store_unavailable" }, 503);
    }
  });

  app.post(CONVERSATION_HEAD_PATH, async (context) => {
    const parsed = ConversationHeadRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_conversation_head" }, 400);
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === undefined || operator === "unavailable")
      return context.json({ error: "operator_authentication_required" }, 401);
    if (context.req.raw.signal.aborted) return context.json({ error: "request_aborted" }, 409);
    try {
      return context.json(
        await dependencies.captain.setDesignatedConversationHead(
          parsed.data.conversationId,
          parsed.data.headConversationId,
        ),
      );
    } catch {
      return context.json({ error: "conversation_head_unavailable" }, 409);
    }
  });

  app.get("/v1/body-leases", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (!operator || operator === "unavailable") {
      const device = await authenticateDevice(context.req.raw);
      if (device === "unavailable") return context.json({ error: "device_authentication_unavailable" }, 503);
      if ("denied" in device) return deviceDenialResponse(context, device);
      if (!device.grants.terminalObserve)
        return context.json({ error: "terminal_observe_grant_required" }, 403);
    }
    context.header("cache-control", "no-store");
    if (dependencies.bodyLeases === undefined) return context.json({ error: "body_leases_unavailable" }, 503);
    try {
      return context.json({
        // The computer contract is opt-in; old clients have a closed body-resource enum.
        leases: BodyResourceSchema.options
          .filter((resource) => resource !== "computer")
          .flatMap((resource) => {
            const lease = dependencies.bodyLeases!.store.status(resource);
            return lease === undefined ? [] : [lease];
          }),
      });
    } catch {
      return context.json({ error: "body_leases_unavailable" }, 503);
    }
  });

  registerComputerRoutes(app, {
    ...(dependencies.computer === undefined ? {} : { body: dependencies.computer }),
    ...(dependencies.joinedComputer === undefined ? {} : { joined: dependencies.joinedComputer }),
    async identity(request, conversationId) {
      const operator = await authenticateOperator(request, dependencies);
      if (!operator || operator === "unavailable") return undefined;
      return operatorBodyIdentity(conversationId, request);
    },
  });

  app.post("/v1/body-leases", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (!operator || operator === "unavailable")
      return context.json({ error: "operator_authentication_required" }, 401);
    const parsed = BodyLeaseRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_body_lease_request" }, 400);
    const body = dependencies.bodyLeases;
    if (body === undefined) return context.json({ error: "body_leases_unavailable" }, 503);
    const input = parsed.data;
    if (input.resource === "computer") return context.json({ error: "use_computer_contract" }, 409);
    // An operator bearer can select its own existing writable thread. Room inspection is insufficient.
    const identity = operatorBodyIdentity(input.conversationId, context.req.raw);
    if (identity === undefined)
      return context.json({ outcome: "rejected", reason: "identity_required" }, 409);
    try {
      if (input.action === "queue" || input.action === "ask")
        return context.json(
          await body.router.request(identity, {
            kind: input.action,
            resource: input.resource,
            text: input.request,
            ttlMs: input.ttlMs,
          }),
        );
      if (input.action === "recover")
        return context.json(
          await body.router.recover(
            identity,
            input.resource,
            (guard) => confirmBodyStopped(input.resource, guard),
            "operator_override",
          ),
        );
      // Parsing and seat lookup may yield; fence the final synchronous transition.
      if (!(await identity.authorize(input.resource, "effect")) || !identity.current())
        return context.json({ outcome: "rejected", reason: "not_authorized" }, 409);
      if (input.action === "acquire") {
        const result = body.store.acquire(input.resource, input.conversationId, input.ttlMs, identity.route);
        if (result.outcome === "busy") return context.json({ ...result, actions: ["queue", "ask"] }, 409);
        if (result.outcome !== "acquired") return context.json(result, 409);
        return context.json({
          outcome: "acquired",
          lease: body.store.status(input.resource),
          incarnation: result.lease.token,
        });
      }
      const held = body.store.recoveryReference(input.resource);
      if (held?.conversationId !== input.conversationId || held.token !== input.incarnation)
        return context.json({ outcome: "rejected", reason: "stale_lease" }, 409);
      if (input.action === "renew") {
        const result = body.store.renew(held, input.ttlMs);
        return context.json(
          result.outcome === "renewed"
            ? { outcome: "renewed", lease: body.store.status(input.resource) }
            : result,
        );
      }
      // Ordinary release still proves actual stop. A token cannot assert a running body ended.
      return context.json(
        await body.router.recover(identity, input.resource, (guard) =>
          confirmBodyStopped(input.resource, guard),
        ),
      );
    } catch {
      return context.json({ outcome: "rejected", reason: "store_unavailable" }, 503);
    }
  });

  async function confirmBodyStopped(
    resource: import("@clankie/protocol").BodyResource,
    guard: () => Promise<void>,
  ): Promise<boolean> {
    const body = dependencies.bodyLeases;
    if (body === undefined) return false;
    if (resource !== "discord_mouth") return body.confirmStopped(resource, guard);
    await guard();
    const held = body.store.recoveryReference(resource);
    return held !== undefined && discordTurnReceipts.writesSettled(held.conversationId);
  }

  function operatorBodyIdentity(
    conversationId: string | undefined,
    request: Request,
  ): BodyConversationIdentity | undefined {
    if (
      conversationId === undefined ||
      dependencies.captain.seatContext(conversationId)?.conversationId !== conversationId
    )
      return undefined;
    return {
      conversationId,
      route: { owner: { conversationId }, mode: "machine" },
      current: () =>
        !request.signal.aborted &&
        dependencies.captain.seatContext(conversationId)?.conversationId === conversationId,
      authorize: async () => {
        const operator = await authenticateOperator(request, dependencies);
        return (
          operator !== undefined &&
          operator !== "unavailable" &&
          (await dependencies.captain.validateConversationOwner({ conversationId }))
        );
      },
    };
  }

  app.get("/v1/browser/harnesses", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    const harnesses = (await dependencies.computerUseHarnesses?.refresh()) ?? [];
    return context.json(
      { schemaVersion: 1, detected: dependencies.computerUseHarnesses !== undefined, harnesses },
      200,
      { "cache-control": "no-store" },
    );
  });

  app.get("/v1/browser/tools", async (context) => {
    const authorization = await authenticateCaptainOrOperator(context);
    if ("denial" in authorization) return authorization.denial;
    if (dependencies.browserTools === undefined) {
      return context.json({ error: "browser_unavailable" }, 503);
    }
    try {
      const catalog = await dependencies.browserTools.catalog(context.req.raw.signal);
      const visible = {
        ...catalog,
        tools: catalog.tools.filter(
          (tool) => !tool.requiresShell || authorization.principal.kind === "operator",
        ),
      };
      return context.json({ catalog: visible }, 200, {
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
    const body = await readJson(context.req.raw);
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
    if (descriptor.requiresShell && authorization.principal.kind !== "operator") {
      return context.json(
        {
          result: {
            outcome: "refused",
            tool: parsed.data.tool,
            reason: "approval_required",
            detail: "Browser JavaScript needs operator authentication.",
          },
        },
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
      if (dependencies.bodyLeases !== undefined) {
        if (authorization.principal.kind !== "operator")
          return context.json({ outcome: "rejected", reason: "identity_required" }, 409);
        const identity = operatorBodyIdentity(
          context.req.header("x-clankie-conversation-id"),
          context.req.raw,
        );
        if (identity === undefined)
          return context.json({ outcome: "rejected", reason: "identity_required" }, 409);
        const result = await dependencies.bodyLeases.router.run(
          identity,
          "browser",
          (guard) =>
            dependencies.browserTools!.call(parsed.data, context.req.raw.signal, { shell: true, guard }),
          {
            lifetime: parsed.data.tool === "browser_use_close" ? "operation" : "session",
            uncertain: (value) => value.outcome !== "ok" || value.isError === true,
          },
        );
        return context.json({ result: result.outcome === "completed" ? result.value : result });
      }
      return context.json({
        result: await dependencies.browserTools.call(parsed.data, context.req.raw.signal, {
          shell: authorization.principal.kind === "operator",
        }),
      });
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
      const body = await readJson(context.req.raw);
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
    generator.generateVideo(request, { signal }),
  );

  app.get("/v1/embodiment/sessions/:id", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    const session = await embodiment.observe(context.req.param("id"));
    if (session === undefined) return context.json({ error: "embodiment_session_not_found" }, 404);
    return context.json({ session });
  });

  // Work items in the repo's own convention (ADR 0191). The operator bearer is
  // a local caller: the CLI, the captain, or a hire on this machine. It may name
  // a repo path, which registers it for the app to read later.
  app.post("/v1/work", async (context) => {
    const operator = await authenticateOperator(context.req.raw, dependencies);
    if (operator === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!operator) return context.json({ error: "operator_authentication_required" }, 401);
    if (dependencies.workItems === undefined) return context.json({ error: "work_items_unavailable" }, 503);
    const input = WorkHttpRequestSchema.safeParse(await readJson(context.req.raw));
    if (!input.success)
      return context.json({ error: "invalid_work_request", detail: input.error.issues[0]?.message }, 400);
    try {
      if (input.data.action === "write" || input.data.action === "write_receipt") {
        const owner = await workOwnerAuthority(context.req.raw);
        return context.json(await serveWorkWrite(input.data.request, owner, input.data.action === "write"));
      }
      return context.json(await dependencies.workItems.handle(input.data, true));
    } catch (error) {
      if (error instanceof WorkRequestError) {
        const status =
          error.code === "not_found" || error.code === "unknown_repo"
            ? 404
            : error.code === "invalid"
              ? 400
              : 409;
        return context.json(
          {
            error: error.code,
            detail: error.message,
            ...(error.question === undefined ? {} : { question: error.question }),
            ...(error.signals === undefined ? {} : { signals: error.signals }),
          },
          status,
        );
      }
      return context.json(
        {
          error: "work_request_failed",
          detail: error instanceof Error ? error.message.slice(0, 500) : "failed",
        },
        502,
      );
    }
  });

  registerLinearRoutes({
    app,
    dependencies,
    settingsSource,
    clock,
    authorizeOwnerSettings: authorizeOwnerSecrets,
  });
  const { wakeRevocationTimer } = registerPairingRoutes({
    get supportGrants() {
      return supportGrants;
    },
    get questionOwnerAuthority() {
      return questionOwnerAuthority;
    },
    get dependencies() {
      return dependencies;
    },
    get app() {
      return app;
    },
    get deviceSessionSigner() {
      return deviceSessionSigner;
    },
    get clock() {
      return clock;
    },
    get pairingOffers() {
      return pairingOffers;
    },
    get idFactory() {
      return idFactory;
    },
    get recordEvent() {
      return recordEvent;
    },
    get authenticateDevice() {
      return authenticateDevice;
    },
    get publishHostedSupportDevice() {
      return publishHostedSupportDevice;
    },
    get deviceDenialResponse() {
      return deviceDenialResponse;
    },
    get deviceLocks() {
      return deviceLocks;
    },
    get devices() {
      return devices;
    },
    get completionTokens() {
      return completionTokens;
    },
    get hostDisplayName() {
      return hostDisplayName;
    },
  });
  const { questionOwnerAuthority, workOwnerAuthority, serveWorkWrite } = registerConversationRoutes({
    get app() {
      return app;
    },
    get dependencies() {
      return dependencies;
    },
    get hostedOriginalRequests() {
      return hostedOriginalRequests;
    },
    get authenticateDevice() {
      return authenticateDevice;
    },
    get devices() {
      return devices;
    },
    get hostedRequests() {
      return hostedRequests;
    },
    get clock() {
      return clock;
    },
    get recordEvent() {
      return recordEvent;
    },
  });

  /**
   * Delivery for devices that authorized it. The dispatcher owns coalescing and
   * the send; clearing a binding the gateway has dropped runs here, where the
   * device lock and the event log already live.
   */
  const clearPushBinding = async (deviceId: string, binding: DevicePushBinding): Promise<void> => {
    await withSerializedLock(deviceLocks, deviceId, async () => {
      const record = devices.get(deviceId);
      // Conditional on the exact version that was sent: a late acknowledgement
      // must never take away a registration the app has since replaced, turn a
      // disable back into an event, or land a push change on a device revoked
      // while the wake was in flight.
      if (
        record === undefined ||
        record.status !== "active" ||
        record.push === undefined ||
        !record.push.enabled ||
        record.push.registrationId !== binding.registrationId ||
        record.push.sequence !== binding.sequence
      ) {
        return;
      }
      const cleared = recordEvent("device.push.changed", `device:${deviceId}`, clock().toISOString(), {
        schemaVersion: 1,
        deviceId,
        ...binding,
        enabled: false,
      });
      applyDeviceEvent(devices, cleared);
      logger.info({ deviceId }, "device push registration cleared by the gateway");
      return await Promise.resolve();
    });
  };

  const pushDispatcher: PushDispatcher | undefined =
    dependencies.pushWake === undefined
      ? undefined
      : createPushDispatcher({
          devices: () => devices.values(),
          sender: dependencies.pushWake,
          clearBinding: clearPushBinding,
          logger,
        });
  // Subscribed through this captain, not a process-wide bus: a second service
  // instance in one process must never be woken by another's transcripts.
  const stopObservingRoomFailures =
    pushDispatcher === undefined
      ? undefined
      : dependencies.roomObservations?.observeFailures((id) => pushDispatcher.notify(id));
  const stopObservingMessages =
    pushDispatcher === undefined
      ? undefined
      : dependencies.captain.observeDurableMessages((notice) => {
          pushDispatcher.notify(notice.conversationId);
        });

  return {
    app,
    embodiment,
    captainPresence,
    presenceSessions: () => discordPresenceSessions.list(),
    streamWatch: () => discordStreamWatch.current(),
    voiceHistory: (limit: number) => discordVoiceHistory.list(limit),
    recentVoiceSpeech: (limit: number) => {
      const room = discordPresenceSessions
        .list()
        .flatMap((session) => session.voiceRooms ?? [])
        .find((candidate) => candidate.channelId !== undefined);
      return readVoiceSpeechSnapshot(
        defaultDiscordLiveReceiptPath(),
        limit,
        room?.channelId === undefined ? undefined : { guildId: room.guildId, channelId: room.channelId },
      );
    },
    conversationBodyRouteAuthorized,
    stopBodyRequests,
    close: () => {
      dependencies.modelKeys?.close?.();
      managedDiscordClosed = true;
      if (managedDiscordTimer !== undefined) clearInterval(managedDiscordTimer);
      stopBodyRequests();
      securityClosed = true;
      supportSyncClosed = true;
      clearInterval(supportTimer);
      dependencies.composerTranscriptions?.close();
      if (securityRetryTimer !== undefined) clearInterval(securityRetryTimer);
      if (wakeRevocationTimer !== undefined) clearInterval(wakeRevocationTimer);
      stopObservingMessages?.();
      stopObservingRoomFailures?.();
      pushDispatcher?.close();
      captainPresence.close();
      void laneMcp.close();
      void dependencies.workerMcp?.close();
      dependencies.activitySharing?.close();
    },
  };
}
