import { ClankieApiClient } from "@clankie/api-client";
import {
  createDefaultCredentialStore,
  DISCORD_USER_SESSION_PROVIDER_ID,
  ensurePlayVoiceCredential,
  resolveDiscordUserBridgeCredential,
  resolveDiscordUserVoiceBridgeCredential,
} from "@clankie/credential-broker";
import { createPlayVoiceListener, PLAY_VOICE_DEFAULT_PORT, PLAY_VOICE_PATH } from "@clankie/play-voice";
import {
  createAdvertisedDiscordPresencePort,
  discordVoiceTranscriptLogPath,
  createVoiceBriefingProvider,
  createVoiceLookAtScreenProvider,
  createVoiceRealtimePorts,
  DiscordBridgeReceiptStore,
  DiscordPresenceSession,
  DiscordTextIngress,
  DiscordVoiceIngress,
  DiscordVoiceSession,
  DiscordVoiceTranscriptStore,
  parseDiscordDmPolicy,
  parseDiscordIdSet,
  planNonWatchCaptainDiscordAction,
  parseVoiceRealtimeEnv,
  routeDiscordRoomText,
  selectInboundImageAttachments,
  VoiceIdleAutoLeave,
  voiceEvidenceReceiptData,
  voiceEvidenceReceiptType,
  tryHandleCaptainDiscordActionRequest,
  tryHandleMusicControlRequest,
  resolveOwnerFollowTarget,
  tryHandleVoicePresenceControlRequest,
  type DiscordBridgeReceipt,
  type DiscordBridgeReceiptType,
  type VoicePresenceControlAction,
  type VoicePresenceControlInput,
} from "@clankie/discord-presence-core";
import { discordPresenceLaneAddress } from "@clankie/interactive-environment";
import {
  DiscordPresenceWriteSchema,
  type DiscordCaptainActionInput,
  type DiscordCaptainActionResult,
  type DiscordVoiceEvidence,
  type DiscordVoicePresenceResult,
} from "@clankie/protocol";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  applyDiscordSettingsToEnvironment,
  applyVoiceSettingsToEnvironment,
  characterNames,
  SettingsStore,
} from "@clankie/settings";
import { createVoxClient, VOX_IPC_PROTOCOL_VERSION } from "@clankie/vox-client";
import { createServer } from "node:http";
import { DiscordUserGateway } from "./gateway.ts";
import { userSessionHealth, type UserSessionGatewayStatus } from "./health.ts";
import { assertUserSessionAdmissible } from "./readiness.ts";
import { createUserSessionShutdown } from "./shutdown.ts";
import { startStreamWatch } from "./stream-watch.ts";
import { VoiceMembershipCoordinator, VoxGatewayBridge } from "./vox-gateway.ts";

/**
 * Personal-lab user-session Discord plane (ADR 0048).
 *
 * A second, isolated process rather than a mode of the bot bridge: ADR 0024
 * forbids bot and user credentials sharing a gateway, and separate processes
 * are what make that structural instead of a convention. The launcher starts
 * this process only when it is the active body. Everything above the
 * transport — ingress shaping, captain lane addressing, consent, memory — is
 * the shared core, so this body is the same Clankie the bot is.
 */

// Fill unset DISCORD_* names from the operator settings file before anything
// reads them. `/discord` Lab user body writes the user-session allowlists into
// that file; they still cannot exceed the recorded opt-in. Ahead of the token
// guards on purpose — see the bot bridge for the reasoning.
const storedSettings = await new SettingsStore().load();
const settingsFilledNames = [
  ...applyDiscordSettingsToEnvironment(storedSettings.discord),
  ...applyVoiceSettingsToEnvironment(storedSettings.voice),
];

if (process.env.DISCORD_USER_TOKEN) {
  throw new Error(
    `DISCORD_USER_TOKEN must not be set. Store ${DISCORD_USER_SESSION_PROVIDER_ID} in the credential broker.`,
  );
}
if (process.env.DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN must not be set for the user-session plane.");
}
if (process.env.CLANKIE_CAPTAIN_TOKEN) {
  throw new Error(
    "CLANKIE_CAPTAIN_TOKEN must not be set for the user-session bridge. Its identity is brokered as clankie_discord_user_bridge.",
  );
}

const credentialStore = createDefaultCredentialStore();
const apiUrl = process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310";
const characterId = process.env.CLANKIE_CHARACTER_ID ?? "clankie";
const voiceEnabled = process.env.DISCORD_USER_SESSION_VOICE_ENABLED === "true";
const voiceTranscriptLoggingEnabled = process.env.DISCORD_VOICE_TRANSCRIPT_LOGGING_ENABLED === "true";
const ownerUserId = process.env.DISCORD_OWNER_USER_ID?.trim();
if (voiceEnabled && (process.env.OPENAI_API_KEY || process.env.XAI_API_KEY)) {
  throw new Error("Voice provider API keys must come from the credential broker, not the environment.");
}
if (voiceEnabled && (process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY)) {
  throw new Error("ElevenLabs API keys must come from the credential broker, not the environment.");
}

const bridgeToken = await resolveDiscordUserBridgeCredential({ store: credentialStore });
if (!bridgeToken) {
  throw new Error(
    "The brokered clankie_discord_user_bridge credential is missing. Start the clankie service once before the user-session bridge.",
  );
}
const voiceBridgeToken = voiceEnabled
  ? await resolveDiscordUserVoiceBridgeCredential({ store: credentialStore })
  : undefined;
if (voiceEnabled && voiceBridgeToken === undefined) {
  throw new Error(
    "The brokered clankie_discord_user_voice_bridge credential is missing. Restart the clankie service before enabling user-session voice.",
  );
}

const api = new ClankieApiClient({ baseUrl: apiUrl, captainToken: bridgeToken });
const voiceApi =
  voiceBridgeToken === undefined
    ? undefined
    : new ClankieApiClient({ baseUrl: apiUrl, captainToken: voiceBridgeToken });

const receipts = new DiscordBridgeReceiptStore({ path: receiptPath() });

// Every gate is checked before a single byte reaches Discord: enablement flag,
// brokered credential, durable owner opt-in, and non-empty allowlists. A
// refusal is recorded, not merely thrown.
const admission = await assertUserSessionAdmissible({
  env: process.env,
  store: credentialStore,
  api,
  characterId,
}).catch(async (error: unknown) => {
  await receipts
    .append("discord.user_session.refused", {
      reason: error instanceof Error ? error.message : "discord_user_session_refused",
    })
    .catch(() => undefined);
  throw error;
});

const guildIds = parseDiscordIdSet(process.env.DISCORD_USER_SESSION_GUILD_IDS);
const channelIds = parseDiscordIdSet(process.env.DISCORD_USER_SESSION_CHANNEL_IDS);
const voiceChannelIds = parseDiscordIdSet(process.env.DISCORD_USER_SESSION_VOICE_CHANNEL_IDS);
let presenceReady = false;
let terminalFailure: string | undefined;
let shuttingDown = false;
let fatalShutdown: ((reason: string) => void) | undefined;

const presenceSession = new DiscordPresenceSession({
  sessionId: `discord:user_session:${admission.optIn.optInId}:${randomUUID()}`,
  characterId,
  credentialRef: DISCORD_USER_SESSION_PROVIDER_ID,
  transportKind: "user_session",
  emit: async (event) => {
    const result = await api.recordDiscordPresencePhase(event);
    console.info(event, "Discord user-session presence phase event");
    return result.session;
  },
  onPublicationFailure: reportPhaseFailure,
  onTerminalFailure: (error, event) => {
    presenceReady = false;
    terminalFailure ??= `presence_publication_failed:${error.disposition}`;
    console.error(
      { disposition: error.disposition, attempts: error.attempts, event },
      "Discord user session entered terminal publication failure",
    );
    fatalShutdown?.(terminalFailure);
  },
});

const presencePort = createAdvertisedDiscordPresencePort(api, presenceSession);
const textIngress = new DiscordTextIngress(
  presencePort,
  {
    characterId,
    credentialRef: DISCORD_USER_SESSION_PROVIDER_ID,
    transportKind: "user_session",
    guildIds,
    channelIds,
    dmPolicy: parseDiscordDmPolicy(process.env.DISCORD_USER_SESSION_DM_POLICY),
    ...(ownerUserId === undefined ? {} : { ownerUserId }),
    dmUserIds: parseDiscordIdSet(process.env.DISCORD_USER_SESSION_DM_USER_IDS),
    // A user session cannot request bounded history without reading channels
    // wholesale, so ambient context stays off on this plane.
    contextMessageLimit: 0,
    authenticatedSurfaceUrl: process.env.CLANKIE_AUTHENTICATED_SURFACE_URL ?? "http://127.0.0.1:4310",
    replyPolicy: storedSettings.persona.replyPolicy,
    characterNames: characterNames(storedSettings.persona),
    liveMessageWindow: storedSettings.persona.liveMessageWindow,
  },
  (event) => {
    console.info(event, "Discord user-session text ingress event");
    void recordReceipt("discord.text.ingress", {
      deliveryId: event.deliveryId,
      correlationId: event.correlationId,
      presenceSessionId: event.presenceSessionId,
      ...(event.guildId === undefined ? {} : { guildId: event.guildId }),
      channelId: event.channelId,
      outcome: event.outcome,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
    });
  },
);

const voiceConfig = voiceEnabled ? parseVoiceRealtimeEnv(process.env) : undefined;
const realtimeCredential =
  voiceConfig === undefined ? undefined : await credentialStore.get(voiceConfig.realtimeProvider);
if (voiceEnabled && realtimeCredential?.type !== "api") {
  const provider = voiceConfig?.realtimeProvider ?? "openai";
  throw new Error(
    `User-session voice requires a brokered ${provider} API credential; environment credentials are not accepted.`,
  );
}
const elevenLabsCredential =
  voiceConfig?.ttsProvider === "elevenlabs" ? await credentialStore.get("elevenlabs") : undefined;
if (voiceConfig?.ttsProvider === "elevenlabs" && elevenLabsCredential?.type !== "api") {
  throw new Error("User-session ElevenLabs speech requires the brokered elevenlabs API credential.");
}

const gateway = new DiscordUserGateway({ token: admission.userToken });
const vox = createVoxClient({
  onError: (message) => console.error({ message }, "Vox process failure"),
  onLog: (message) => console.info({ message }, "Vox"),
});
let gatewayStatus: UserSessionGatewayStatus = "connecting";
let gatewayReadyAt: string | undefined;
let gatewayReadyIdentity: { readonly userId: string; readonly username: string } | undefined;
let gatewayGeneration = 0;
let voxProtocolVersion = vox.status === "ready" ? VOX_IPC_PROTOCOL_VERSION : undefined;
let voxProcessReadyAt = vox.status === "ready" ? new Date().toISOString() : undefined;
let activeReadyId: string | undefined;
let readySequence = 0;
let readyWrite: Promise<void> | undefined;
const gatewayUnsubscribes: (() => void)[] = [];
const lifecycleUnsubscribes = [
  vox.onEvent((event) => {
    if (shuttingDown || event.type !== "process_ready") return;
    voxProtocolVersion = event.protocolVersion;
    voxProcessReadyAt = new Date().toISOString();
    void recordReadyIfPossible();
  }),
  vox.onStatus((status, detail) => {
    if (shuttingDown) return;
    if (status === "ready") {
      voxProtocolVersion ??= VOX_IPC_PROTOCOL_VERSION;
      voxProcessReadyAt ??= new Date().toISOString();
      void recordReadyIfPossible();
      return;
    }
    if (status === "error" || status === "missing" || status === "closed") {
      terminalFailure ??= `vox_${status}:${detail}`;
      fatalShutdown?.(terminalFailure);
    }
  }),
];
const membership = new VoiceMembershipCoordinator(gateway);
const voxGateway = new VoxGatewayBridge({
  gateway,
  vox,
  membership,
  allowlisted: (guildId, channelId) => guildIds.has(guildId) && voiceChannelIds.has(channelId),
  onRejected: (reason) => console.warn({ reason }, "Rejected Vox gateway event"),
});

const voiceSession =
  realtimeCredential?.type !== "api" || voiceApi === undefined || voiceConfig === undefined
    ? undefined
    : new DiscordVoiceSession({
        vox,
        ingress: new DiscordVoiceIngress(voiceApi, {
          characterId,
          credentialRef: DISCORD_USER_SESSION_PROVIDER_ID,
          transportKind: "user_session",
        }),
        realtime: createVoiceRealtimePorts({
          apiKey: realtimeCredential.key,
          ...(elevenLabsCredential?.type === "api" ? { elevenLabsApiKey: elevenLabsCredential.key } : {}),
          config: voiceConfig,
        }),
        briefing: createVoiceBriefingProvider(voiceApi),
        lookAtScreen: createVoiceLookAtScreenProvider(voiceApi),
        floor: {
          names: characterNames(storedSettings.persona),
          replyPolicy: storedSettings.persona.replyPolicy,
          chattiness: storedSettings.persona.chattiness,
          decayWindowMs: voiceConfig.decayWindowMs,
        },
        // When this process is the mouth, the floor still answers when
        // addressed, and unprompted turns work exactly as they do for the bot:
        // the rate cap offers, his own realtime session decides.
        presenceSessionId: () => presenceSession.record.sessionId,
        emit: recordVoiceEvidence,
      });
let voiceOperationQueue: Promise<unknown> = Promise.resolve();
let pendingLeftEvidence: Extract<DiscordVoiceEvidence, { type: "left" }> | undefined;
const streamWatch = startStreamWatch({
  gateway,
  api,
  vox,
  membership,
  allowlisted: (guildId, channelId) =>
    guildIds.has(guildId) && (channelIds.has(channelId) || voiceChannelIds.has(channelId)),
  onWatchEvent: (type, data) => {
    const readyId = activeReadyId;
    if (readyId !== undefined) void recordReceipt(`discord.stream.${type}`, { ...data, readyId });
  },
  onPublishEvent: (type, data) => {
    const readyId = activeReadyId;
    if (readyId !== undefined) void recordReceipt(`discord.stream.${type}`, { ...data, readyId });
  },
});
const voiceTranscriptStore = voiceTranscriptLoggingEnabled ? new DiscordVoiceTranscriptStore() : undefined;
if (voiceSession !== undefined && voiceTranscriptStore !== undefined) {
  voiceSession.subscribeTranscript((_line, transcript) => {
    void voiceTranscriptStore.append("user_session", transcript).catch((error: unknown) => {
      console.error(
        { deliveryId: transcript.deliveryId, error: error instanceof Error ? error.message : String(error) },
        "Discord user-session voice transcript append failed",
      );
    });
  });
  console.info({ path: discordVoiceTranscriptLogPath() }, "Full Discord voice transcript logging enabled");
}

const playVoiceListener =
  voiceSession === undefined
    ? undefined
    : createPlayVoiceListener({
        token: await ensurePlayVoiceCredential({ store: credentialStore }),
        narrate: (text, options) => voiceSession.narrate(text, options),
        emit: (evidence) => {
          const stayId = voiceSession.status().stayId;
          return recordVoiceEvidence(
            stayId === undefined || evidence.stayId !== undefined ? evidence : { ...evidence, stayId },
          );
        },
        room: () => ({ listening: voiceSession.status().active }),
      });
let stopPlayVoiceTranscript: (() => void) | undefined;
if (playVoiceListener !== undefined && voiceSession !== undefined) {
  const port = await playVoiceListener.listen(PLAY_VOICE_DEFAULT_PORT);
  stopPlayVoiceTranscript = voiceSession.subscribeTranscript((line) =>
    playVoiceListener.publishUtterance(line),
  );
  console.info({ port, path: PLAY_VOICE_PATH }, "Discord user-session play voice seam listening on loopback");
}

const voiceIdleAutoLeave =
  voiceSession === undefined || voiceConfig === undefined
    ? undefined
    : new VoiceIdleAutoLeave({
        idleLeaveMs: voiceConfig.idleLeaveMs,
        isActive: () => voiceSession.status().active,
        leave: () =>
          runVoiceOperation(async () => {
            const guildId =
              voiceSession.status().guildId ??
              membership.targetFor("voice")?.guildId ??
              membership.actualTarget?.guildId;
            if (guildId === undefined || !(await leaveVoiceConfirmed(guildId))) {
              throw new Error("discord_user_session_voice_leave_unconfirmed");
            }
          }),
        onLeave: (idleMs) => {
          console.info(
            `Discord user-session voice idle for ${String(idleMs)}ms; leaving the metered channel.`,
          );
        },
        onLeaveError: (error) => {
          console.error(
            { error: error instanceof Error ? error.message : String(error) },
            "Discord user-session voice idle auto-leave failed to close the session",
          );
        },
      });

gatewayUnsubscribes.push(
  gateway.on("ready", (identity) => {
    gatewayStatus = "ready";
    gatewayReadyAt = new Date().toISOString();
    gatewayReadyIdentity = identity;
    presenceReady = false;
    void presenceSession
      .gatewayReady()
      .then(() => {
        presenceReady = true;
        return recordReadyIfPossible();
      })
      .catch(reportPhaseFailure);
    if (settingsFilledNames.length > 0) {
      console.info({ names: settingsFilledNames }, "Discord configuration filled from operator settings");
    }
    console.log(
      `Discord user session ready as ${identity.username}; ${String(channelIds.size)} allowlisted channel(s), voice ${voiceEnabled ? "enabled" : "disabled"}.`,
    );
  }),
);
gatewayUnsubscribes.push(
  gateway.on("resumed", () => {
    gatewayStatus = "ready";
    gatewayReadyAt = new Date().toISOString();
    presenceReady = false;
    void presenceSession
      .gatewayResumed()
      .then(() => {
        presenceReady = true;
        return recordReadyIfPossible();
      })
      .catch(reportPhaseFailure);
  }),
);
gatewayUnsubscribes.push(
  gateway.on("reconnecting", () => {
    gatewayStatus = "reconnecting";
    gatewayReadyAt = undefined;
    presenceReady = false;
    activeReadyId = undefined;
    gatewayGeneration += 1;
    void presenceSession.gatewayReconnecting().catch(reportPhaseFailure);
  }),
);
gatewayUnsubscribes.push(
  gateway.on("disconnected", () => {
    gatewayStatus = "reconnecting";
    gatewayReadyAt = undefined;
    presenceReady = false;
    activeReadyId = undefined;
    gatewayGeneration += 1;
    void presenceSession.gatewayDisconnected().catch(reportPhaseFailure);
  }),
);
gatewayUnsubscribes.push(
  gateway.on("failed", (reason) => {
    gatewayStatus = "failed";
    presenceReady = false;
    terminalFailure ??= reason;
    console.error({ reason }, "Discord user session gateway failed");
    void presenceSession.fail().catch(reportPhaseFailure);
    fatalShutdown?.(reason);
  }),
);

gatewayUnsubscribes.push(
  gateway.on("messageCreate", (message) => {
    if (shuttingDown) return;
    void (async () => {
      try {
        const selection = selectInboundImageAttachments(message.attachments, message.embeds);
        const authorIsBot = message.authorIsBot || message.authorId === gateway.userId;
        const routedRoomText = routeDiscordRoomText(
          { guildIds, channelIds },
          {
            ...(message.guildId === undefined ? {} : { guildId: message.guildId }),
            channelId: message.channelId,
            authorIsBot,
            body: message.content,
            userId: message.authorId,
            ...(message.authorDisplayName === undefined ? {} : { displayName: message.authorDisplayName }),
            deliveryId: message.id,
            hasAttachments: selection.attachments.length > 0 || selection.omitted > 0,
          },
          voiceSession,
        );
        if (routedRoomText.text !== null) playVoiceListener?.publishUtterance(routedRoomText.text);
        if (routedRoomText.voiceOwned) return;
        const result = await textIngress.handle({
          id: message.id,
          ...(message.guildId === undefined ? {} : { guildId: message.guildId }),
          channelId: message.channelId,
          authorId: message.authorId,
          // A user session must never answer itself; the account is a participant.
          authorIsBot,
          mentionsBot: message.mentionsSelf,
          body: message.content,
          attachments: selection.attachments,
          attachmentsOmitted: selection.omitted,
        });
        if (result.state === "failed") {
          console.error(
            { deliveryId: message.id, channelId: message.channelId, code: result.code },
            "Discord user-session text ingress failed",
          );
        } else if (result.state === "settled" || result.state === "waiting_user") {
          await recordReceipt("discord.text.reply", {
            deliveryId: message.id,
            ...(message.guildId === undefined ? {} : { guildId: message.guildId }),
            channelId: message.channelId,
            turnId: result.turnId,
            responseMessageId: result.responseMessageId,
            state: result.state,
          });
        }
      } catch (error) {
        if (shuttingDown) return;
        console.error(
          {
            deliveryId: message.id,
            channelId: message.channelId,
            error: error instanceof Error ? error.message : String(error),
          },
          "Discord user-session text ingress handler failed",
        );
      }
    })();
  }),
);

gatewayUnsubscribes.push(
  gateway.on("raw", (packet) => {
    if (shuttingDown) return;
    streamWatch.handleRaw(packet);
  }),
);

gatewayUnsubscribes.push(
  gateway.on("voiceStateUpdate", (state) => {
    if (shuttingDown) return;
    if (state.guildId === undefined) return;
    voiceSession?.memberChannelChanged(state.guildId, state.userId, state.channelId);
    if (state.userId !== gateway.userId) return;
    if (state.channelId === undefined) void recordConfirmedVoiceLeave(state.guildId);
    void presenceSession
      .voiceStateChanged(state.guildId, state.channelId !== undefined)
      .catch(reportPhaseFailure);
    // A watch join just got a session id — retry connecting Vox.
    if (
      state.channelId !== undefined &&
      membership.target?.guildId === state.guildId &&
      membership.target.channelId === state.channelId
    ) {
      streamWatch.publish();
    }
  }),
);

async function executeCaptainVoicePresence(
  action: VoicePresenceControlAction,
  input: VoicePresenceControlInput,
): Promise<DiscordVoicePresenceResult> {
  return runVoiceOperation(() => executeCaptainVoicePresenceNow(action, input));
}

async function executeCaptainVoicePresenceNow(
  action: VoicePresenceControlAction,
  input: VoicePresenceControlInput,
): Promise<DiscordVoicePresenceResult> {
  const refused = action === "join" ? ("join_refused" as const) : ("leave_refused" as const);
  if (shuttingDown) return { action: refused, reason: "failed" };
  const target = resolveUserSessionVoiceTarget(action, input);
  if ("reason" in target) return { action: refused, reason: target.reason };
  if (voiceSession === undefined) return { action: refused, reason: "voice_disabled" };
  const active = voiceSession.status();
  const currentTarget =
    membership.targetFor("voice") ??
    membership.actualTarget ??
    (active.guildId === undefined || active.channelId === undefined
      ? undefined
      : { guildId: active.guildId, channelId: active.channelId });
  if (currentTarget !== undefined && currentTarget.guildId !== target.guildId) {
    return { action: refused, reason: "other_guild" };
  }
  if (action === "leave") {
    const guildId = currentTarget?.guildId ?? active.guildId;
    if (guildId === undefined || !(await leaveVoiceConfirmed(guildId))) {
      return { action: "leave_refused", reason: "failed" };
    }
    const channelId = currentTarget?.channelId ?? active.channelId;
    return { action: "left", ...(channelId === undefined ? {} : { channelId }) };
  }
  if (!guildIds.has(target.guildId) || !voiceChannelIds.has(target.channelId)) {
    return { action: "join_refused", reason: "allowlist" };
  }
  if (active.active && currentTarget?.channelId === target.channelId) {
    return {
      action: "joined",
      channelId: target.channelId,
      actorCanBeHeard: voiceSession.canHear(target.actorId),
      transcriptLoggingEnabled: voiceTranscriptLoggingEnabled,
    };
  }
  if (currentTarget !== undefined && currentTarget.channelId !== target.channelId) {
    if (!(await leaveVoiceConfirmed(currentTarget.guildId))) {
      return { action: "join_refused", reason: "failed" };
    }
    if (shuttingDown) return { action: "join_refused", reason: "failed" };
  }
  if (!voxGateway.prepareVoiceTarget(target.guildId, target.channelId)) {
    return { action: "join_refused", reason: "failed" };
  }
  const confirmed = await voxGateway.confirmVoiceJoin(target.guildId, target.channelId, () =>
    voiceSession.join({
      guildId: target.guildId,
      channelId: target.channelId,
      invokingUserId: target.actorId,
    }),
  );
  if (!confirmed) {
    voxGateway.cancelPendingVoiceTarget(target.guildId, target.channelId);
    await voiceSession.leave("gateway_join_unconfirmed").catch(() => undefined);
    return { action: "join_refused", reason: "failed" };
  }
  return {
    action: "joined",
    channelId: target.channelId,
    actorCanBeHeard: voiceSession.canHear(target.actorId),
    transcriptLoggingEnabled: voiceTranscriptLoggingEnabled,
  };
}

function resolveUserSessionVoiceTarget(
  action: VoicePresenceControlAction,
  input: VoicePresenceControlInput,
):
  | { readonly guildId: string; readonly actorId: string; readonly channelId: string }
  | { readonly reason: "authority" | "no_owner" | "not_in_voice" | "ambiguous" | "failed" } {
  if (ownerUserId === undefined) return { reason: "no_owner" };
  if (input.guildId !== undefined || input.actorId !== undefined) {
    if (input.guildId === undefined || input.actorId === undefined) return { reason: "failed" };
    if (input.actorId !== ownerUserId) return { reason: "authority" };
    const channelId = gateway.voiceChannelFor(input.guildId, input.actorId);
    if (channelId === undefined) {
      return action === "leave"
        ? { guildId: input.guildId, actorId: input.actorId, channelId: "" }
        : { reason: "not_in_voice" };
    }
    return { guildId: input.guildId, actorId: input.actorId, channelId };
  }
  if (action === "leave") {
    const active = voiceSession?.status();
    const target = membership.targetFor("voice") ?? membership.actualTarget;
    return {
      guildId: active?.guildId ?? target?.guildId ?? "",
      actorId: ownerUserId,
      channelId: active?.channelId ?? target?.channelId ?? "",
    };
  }
  const follow = resolveOwnerFollowTarget(
    gateway
      .voiceChannelsFor(ownerUserId)
      .filter((candidate) => guildIds.has(candidate.guildId) && voiceChannelIds.has(candidate.channelId)),
    voiceSession?.status(),
  );
  if (follow.outcome === "none") return { reason: "not_in_voice" };
  if (follow.outcome === "ambiguous") return { reason: "ambiguous" };
  return { guildId: follow.guildId, actorId: ownerUserId, channelId: follow.channelId };
}

async function executeCaptainDiscordAction(
  input: DiscordCaptainActionInput,
): Promise<DiscordCaptainActionResult> {
  if (shuttingDown) return { ok: false, message: "My Discord body is shutting down." };
  if (input.guildId === undefined) {
    return { ok: false, message: "That Discord action is not available in DMs." };
  }
  let channelId = input.channelId;
  let plan = planNonWatchCaptainDiscordAction(input);
  if (plan !== undefined) {
    if (!guildIds.has(input.guildId) || (channelIds.size > 0 && !channelIds.has(input.channelId))) {
      return {
        ok: false,
        message:
          input.action === "react" || input.action === "unreact"
            ? "That message is outside my admitted Discord channels."
            : input.action === "send_text_update"
              ? "That channel is outside my admitted Discord channels."
              : "Threads only work in my admitted server channels.",
      };
    }
  } else {
    if (ownerUserId === undefined || input.actorId !== ownerUserId) {
      return { ok: false, message: "Only my owner can put my lab play surface in voice." };
    }
    channelId = gateway.voiceChannelFor(input.guildId, input.actorId) ?? "";
    const active = voiceSession?.status();
    if (
      channelId.length === 0 ||
      !guildIds.has(input.guildId) ||
      !voiceChannelIds.has(channelId) ||
      active?.active !== true ||
      active.guildId !== input.guildId ||
      active.channelId !== channelId
    ) {
      return { ok: false, message: "I need to be in your admitted voice channel first." };
    }
    plan = {
      action:
        input.action === "watch_start" ? "discord.presence.go_live_start" : "discord.presence.go_live_stop",
      payload:
        input.action === "watch_start"
          ? { kind: "go_live_start", guildId: input.guildId, channelId }
          : { kind: "go_live_stop", guildId: input.guildId },
      successMessage:
        input.action === "watch_start"
          ? "I'm sharing the live play surface."
          : "I stopped sharing the live play surface.",
    };
  }

  try {
    const health = await presencePort.getHealth();
    await presencePort.executeDiscordPresenceAction(
      DiscordPresenceWriteSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `captain:${input.callId}:${input.action}`,
        action: plan.action,
        identity: {
          presenceSessionId: discordPresenceLaneAddress({ guildId: input.guildId, channelId }),
          correlationId: `discord-captain-action:${input.callId}`,
          profileHash: health.profileHash,
          characterId,
          credentialRef: DISCORD_USER_SESSION_PROVIDER_ID,
          transportKind: "user_session",
        },
        payload: plan.payload,
      }),
    );
    return {
      ok: true,
      message: plan.successMessage,
    };
  } catch {
    return { ok: false, message: "My Discord body refused that action." };
  }
}

function receiptPath(): string {
  const configured = process.env.DISCORD_USER_SESSION_RECEIPT_PATH;
  if (configured) {
    const fromWorkspace = relative(process.cwd(), configured);
    if (
      !isAbsolute(configured) ||
      fromWorkspace === "" ||
      (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace))
    ) {
      throw new Error(
        "DISCORD_USER_SESSION_RECEIPT_PATH must be absolute and outside the repository workspace",
      );
    }
    return configured;
  }
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  if (!isAbsolute(stateHome)) throw new Error("XDG_STATE_HOME must be absolute");
  return join(stateHome, "clankie", "discord-user-session-receipts.jsonl");
}

function recordReceipt(
  type: DiscordBridgeReceiptType,
  data: DiscordBridgeReceipt["data"],
): Promise<DiscordBridgeReceipt> {
  return receipts.append(type, data).catch((error) => {
    console.error(
      { type, error: error instanceof Error ? error.message : String(error) },
      "Discord user-session receipt append failed",
    );
    throw error;
  });
}

async function recordReadyIfPossible(): Promise<void> {
  if (
    shuttingDown ||
    terminalFailure !== undefined ||
    !presenceReady ||
    gatewayStatus !== "ready" ||
    gatewayReadyAt === undefined ||
    gatewayReadyIdentity === undefined ||
    vox.status !== "ready" ||
    voxProtocolVersion !== VOX_IPC_PROTOCOL_VERSION ||
    voxProcessReadyAt === undefined ||
    activeReadyId !== undefined ||
    readyWrite !== undefined
  ) {
    return;
  }
  const generation = gatewayGeneration;
  const readyId = randomUUID();
  readySequence += 1;
  const sequence = readySequence;
  readyWrite = recordReceipt("discord.user_session.ready", {
    userId: gatewayReadyIdentity.userId,
    optInId: admission.optIn.optInId,
    guildCount: guildIds.size,
    channelCount: channelIds.size,
    voiceEnabled,
    settingsFilledCount: settingsFilledNames.length,
    mediaOwner: "vox",
    voxProcessReady: true,
    protocolVersion: voxProtocolVersion,
    readyId,
    readySequence: sequence,
    gatewayReadyAt,
    voxProcessReadyAt,
  })
    .then(() => {
      if (
        !shuttingDown &&
        terminalFailure === undefined &&
        gatewayStatus === "ready" &&
        gatewayGeneration === generation &&
        presenceReady &&
        vox.status === "ready"
      ) {
        activeReadyId = readyId;
        streamWatch.publish();
      }
    })
    .catch(() => undefined)
    .finally(() => {
      readyWrite = undefined;
      if (activeReadyId === undefined && gatewayGeneration !== generation) void recordReadyIfPossible();
    });
  await readyWrite;
}

async function recordVoiceEvidence(evidence: DiscordVoiceEvidence): Promise<void> {
  voiceIdleAutoLeave?.observe(evidence);
  if (evidence.type === "joined" || evidence.type === "left") {
    playVoiceListener?.publishRoom({ listening: evidence.type === "joined" });
  }
  if (evidence.type === "left") {
    const selfUserId = gateway.userId;
    if (
      selfUserId !== undefined &&
      gateway.voiceChannelFor(evidence.guildId, selfUserId) === undefined &&
      membership.actualTarget?.guildId !== evidence.guildId
    ) {
      await recordReceipt(voiceEvidenceReceiptType(evidence), {
        ...voiceEvidenceReceiptData(evidence),
        gatewayConfirmed: true,
        mediaOwner: "vox",
      });
      return;
    }
    pendingLeftEvidence = evidence;
    return;
  }
  await recordReceipt(voiceEvidenceReceiptType(evidence), voiceEvidenceReceiptData(evidence));
}

function runVoiceOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = voiceOperationQueue.then(operation, operation);
  voiceOperationQueue = result.catch(() => undefined);
  return result;
}

async function leaveVoiceConfirmed(guildId: string): Promise<boolean> {
  if (voiceSession === undefined) return false;
  const confirmed = await voxGateway.confirmVoiceLeave(guildId, () => voiceSession.leave());
  if (confirmed) await recordConfirmedVoiceLeave(guildId);
  return confirmed;
}

async function recordConfirmedVoiceLeave(guildId: string): Promise<void> {
  const evidence = pendingLeftEvidence;
  if (evidence === undefined || evidence.guildId !== guildId) return;
  pendingLeftEvidence = undefined;
  await recordReceipt(voiceEvidenceReceiptType(evidence), {
    ...voiceEvidenceReceiptData(evidence),
    gatewayConfirmed: true,
    mediaOwner: "vox",
  });
}

function reportPhaseFailure(error: unknown): void {
  console.error(
    { error: error instanceof Error ? error.message : String(error) },
    "Discord user-session presence phase publication failed",
  );
}

let controlServer: ReturnType<typeof createServer> | undefined;
const shutdown = createUserSessionShutdown({
  quiesceCallbacks: () => {
    shuttingDown = true;
    gatewayStatus = "closed";
    activeReadyId = undefined;
    for (const unsubscribe of gatewayUnsubscribes.splice(0)) unsubscribe();
    for (const unsubscribe of lifecycleUnsubscribes.splice(0)) unsubscribe();
  },
  stopControls: async () => {
    voiceIdleAutoLeave?.stop();
    controlServer?.close();
    stopPlayVoiceTranscript?.();
    stopPlayVoiceTranscript = undefined;
    await playVoiceListener?.close();
  },
  stopStreams: () => streamWatch.close(),
  disposeGatewayBridge: () => voxGateway.dispose(),
  leaveVoice: async () => voiceSession?.leave(),
  releaseVoiceMembership: () => {
    membership.release("voice");
  },
  disposeVoice: async () => voiceSession?.dispose(),
  closeVox: () => vox.close(),
  closeGateway: () => gateway.close(),
  stopPresence: async () => {
    await presenceSession.stop().catch(reportPhaseFailure);
  },
  recordStopped: async (signal) => {
    await recordReceipt("discord.user_session.stopped", { signal });
  },
});
fatalShutdown = (reason) => {
  terminalFailure ??= reason;
  gatewayStatus = "failed";
  process.exitCode = 1;
  void shutdown("SIGTERM").catch((error) => {
    console.error(
      { reason, error: error instanceof Error ? error.message : String(error) },
      "Discord user-session terminal shutdown failed",
    );
  });
};
if (terminalFailure !== undefined) {
  const reason = terminalFailure;
  fatalShutdown(reason);
  await shutdown("SIGTERM");
  throw new Error(reason);
}

const controlPort = Number.parseInt(process.env.CLANKIE_USER_SESSION_CONTROL_PORT ?? "4312", 10);
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  if (shuttingDown) {
    response.writeHead(503, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "user_session_shutting_down" }));
    return;
  }
  if (request.method === "GET" && (url === "/" || url === "/health")) {
    const health = userSessionHealth({
      gatewayStatus,
      presenceReady,
      vox,
      ...(voxProtocolVersion === undefined ? {} : { voxProtocolVersion }),
      ...(terminalFailure === undefined ? {} : { terminalFailure }),
    });
    response.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(health));
    return;
  }
  if (request.method === "POST" && url === "/go-live/start") {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        if (shuttingDown) {
          response.writeHead(503);
          response.end(JSON.stringify({ error: "user_session_shutting_down" }));
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            guildId?: string;
            channelId?: string;
            sourceUrl?: string;
          };
          if (typeof body.guildId !== "string" || typeof body.channelId !== "string") {
            response.writeHead(400);
            response.end(JSON.stringify({ error: "guildId_and_channelId_required" }));
            return;
          }
          const started = await streamWatch.requestPublish({
            guildId: body.guildId,
            channelId: body.channelId,
            ...(typeof body.sourceUrl === "string" ? { sourceUrl: body.sourceUrl } : {}),
          });
          response.writeHead(started ? 202 : 503);
          response.end(JSON.stringify({ ok: started }));
        } catch {
          response.writeHead(400);
          response.end(JSON.stringify({ error: "invalid_json" }));
        }
      })();
    });
    return;
  }
  if (request.method === "POST" && url === "/go-live/stop") {
    const stopped = streamWatch.stopPublish();
    response.writeHead(stopped ? 202 : 503);
    response.end(JSON.stringify({ ok: stopped }));
    return;
  }
  if (
    tryHandleMusicControlRequest(
      request,
      response,
      voiceSession?.music,
      voiceSession?.status().active === true,
    )
  )
    return;
  if (tryHandleVoicePresenceControlRequest(request, response, executeCaptainVoicePresence)) return;
  if (tryHandleCaptainDiscordActionRequest(request, response, executeCaptainDiscordAction)) return;
  response.writeHead(404);
  response.end();
});
controlServer = server;
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(controlPort, "127.0.0.1", () => resolve());
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error(
        { signal, error: error instanceof Error ? error.message : String(error) },
        "Discord user-session shutdown failed",
      );
      process.exitCode = 1;
    });
  });
}

try {
  await presenceSession.start();
} catch (error) {
  presenceReady = false;
  terminalFailure ??= "presence_startup_failed";
  fatalShutdown(terminalFailure);
  await shutdown("SIGTERM").catch(() => undefined);
  throw error;
}
if (!shuttingDown) gateway.open();
