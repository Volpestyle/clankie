import { ClankieApiClient } from "@clankie/api-client";
import {
  createDefaultCredentialStore,
  DISCORD_USER_SESSION_PROVIDER_ID,
  resolveDiscordUserBridgeCredential,
  resolveDiscordUserVoiceBridgeCredential,
} from "@clankie/credential-broker";
import {
  createAdvertisedDiscordPresencePort,
  createVoiceBriefingProvider,
  createVoiceLookAtScreenProvider,
  createVoiceRealtimePorts,
  DiscordBridgeReceiptStore,
  DiscordPresenceSession,
  DiscordTextIngress,
  DiscordVoiceIngress,
  DiscordVoiceSession,
  parseDiscordDmPolicy,
  parseDiscordIdSet,
  parseVoiceRealtimeEnv,
  selectInboundImageAttachments,
  VoiceIdleAutoLeave,
  VoiceMusicQueue,
  voiceEvidenceReceiptData,
  voiceEvidenceReceiptType,
  tryHandleCaptainDiscordActionRequest,
  tryHandleMusicControlRequest,
  resolveOwnerFollowTarget,
  tryHandleVoicePresenceControlRequest,
  type DiscordBridgeReceipt,
  type VoicePresenceControlAction,
  type VoicePresenceControlInput,
} from "@clankie/discord-presence-core";
import { discordPresenceLaneAddress } from "@clankie/interactive-environment";
import {
  DiscordPresenceWriteSchema,
  type DiscordCaptainActionInput,
  type DiscordCaptainActionResult,
  type DiscordPresenceWrite,
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
  isDiscordBodyActive,
  SettingsStore,
} from "@clankie/settings";
import { createServer } from "node:http";
import { DiscordUserGateway } from "./gateway.ts";
import { assertUserSessionAdmissible } from "./readiness.ts";
import { startStreamWatch } from "./stream-watch.ts";
import { DiscordUserVoiceAdapters } from "./voice-adapter.ts";

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
    console.error(
      { disposition: error.disposition, attempts: error.attempts, event },
      "Discord user session entered terminal publication failure",
    );
  },
});

const gateway = new DiscordUserGateway({ token: admission.userToken });
const voiceAdapters = new DiscordUserVoiceAdapters(gateway);

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

const streamWatch = startStreamWatch({
  gateway,
  api,
  joinMuted: !isDiscordBodyActive("user_session"),
  allowlisted: (guildId, channelId) =>
    (guildIds.size === 0 || guildIds.has(guildId)) &&
    (channelIds.size === 0 || channelIds.has(channelId) || voiceChannelIds.has(channelId)),
  onWatchEvent: (type, data) => {
    void recordReceipt(`discord.stream.${type}`, data);
  },
  onPublishEvent: (type, data) => {
    void recordReceipt(`discord.stream.${type}`, data);
  },
});

const music = new VoiceMusicQueue({
  sinkKind: "video",
  sink: {
    play(url) {
      if (streamWatch.playSource(url)) return;
      const status = voiceSession?.status();
      const guildId = status?.guildId ?? [...guildIds][0];
      const channelId = status?.channelId ?? [...voiceChannelIds][0];
      if (
        guildId === undefined ||
        channelId === undefined ||
        guildId.length === 0 ||
        channelId.length === 0 ||
        !streamWatch.requestPublish({ guildId, channelId, sourceUrl: url })
      ) {
        throw new Error("discord_music_not_in_voice");
      }
    },
    pause() {
      streamWatch.setPublishPaused(true);
    },
    resume() {
      streamWatch.setPublishPaused(false);
    },
    stop() {
      streamWatch.stopPublish();
    },
  },
});

const voiceSession =
  realtimeCredential?.type !== "api" || voiceApi === undefined || voiceConfig === undefined
    ? undefined
    : new DiscordVoiceSession({
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
        music,
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

const voiceIdleAutoLeave =
  voiceSession === undefined || voiceConfig === undefined
    ? undefined
    : new VoiceIdleAutoLeave({
        idleLeaveMs: voiceConfig.idleLeaveMs,
        isActive: () => voiceSession.status().active,
        leave: () => voiceSession.leave(),
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

gateway.on("ready", (identity) => {
  void presenceSession.gatewayReady().catch(reportPhaseFailure);
  streamWatch.publish();
  void recordReceipt("discord.user_session.ready", {
    userId: identity.userId,
    optInId: admission.optIn.optInId,
    guildCount: guildIds.size,
    channelCount: channelIds.size,
    voiceEnabled,
    settingsFilledCount: settingsFilledNames.length,
  });
  if (settingsFilledNames.length > 0) {
    console.info({ names: settingsFilledNames }, "Discord configuration filled from operator settings");
  }
  console.log(
    `Discord user session ready as ${identity.username}; ${String(channelIds.size)} allowlisted channel(s), voice ${voiceEnabled ? "enabled" : "disabled"}.`,
  );
});
gateway.on("resumed", () => void presenceSession.gatewayResumed().catch(reportPhaseFailure));
gateway.on("reconnecting", () => void presenceSession.gatewayReconnecting().catch(reportPhaseFailure));
gateway.on("disconnected", () => void presenceSession.gatewayDisconnected().catch(reportPhaseFailure));
gateway.on("failed", (reason) => {
  console.error({ reason }, "Discord user session gateway failed");
  void presenceSession.fail().catch(reportPhaseFailure);
});

gateway.on("messageCreate", (message) => {
  void (async () => {
    try {
      const selection = selectInboundImageAttachments(message.attachments, message.embeds);
      const result = await textIngress.handle({
        id: message.id,
        ...(message.guildId === undefined ? {} : { guildId: message.guildId }),
        channelId: message.channelId,
        authorId: message.authorId,
        // A user session must never answer itself; the account is a participant.
        authorIsBot: message.authorIsBot || message.authorId === gateway.userId,
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
});

gateway.on("raw", (packet) => {
  streamWatch.handleRaw(packet);
});

gateway.on("voiceStateUpdate", (state) => {
  if (state.guildId === undefined) return;
  voiceSession?.memberChannelChanged(state.guildId, state.userId, state.channelId);
  if (state.userId !== gateway.userId) return;
  void presenceSession
    .voiceStateChanged(state.guildId, state.channelId !== undefined)
    .catch(reportPhaseFailure);
  // A watch join just got a session id — retry connecting Vox.
  streamWatch.publish();
});

/**
 * Joins a consented voice channel on the user plane.
 *
 * Exported rather than command-driven because a user account has no slash
 * commands: the operator surface drives this plane, which also keeps voice
 * capture from being startable by anyone who can type in a channel.
 */
export async function joinUserSessionVoice(input: {
  readonly guildId: string;
  readonly channelId: string;
  readonly invokingUserId: string;
}): Promise<void> {
  if (voiceSession === undefined) throw new Error("discord_user_session_voice_disabled");
  if (!guildIds.has(input.guildId) || !voiceChannelIds.has(input.channelId)) {
    throw new Error("discord_user_session_voice_channel_not_allowlisted");
  }
  await voiceSession.join({
    guildId: input.guildId,
    channelId: input.channelId,
    invokingUserId: input.invokingUserId,
    adapterCreator: voiceAdapters.creatorFor(input.guildId),
  });
}

async function executeCaptainVoicePresence(
  action: VoicePresenceControlAction,
  input: VoicePresenceControlInput,
): Promise<DiscordVoicePresenceResult> {
  const refused = action === "join" ? ("join_refused" as const) : ("leave_refused" as const);
  const target = resolveUserSessionVoiceTarget(action, input);
  if ("reason" in target) return { action: refused, reason: target.reason };
  if (voiceSession === undefined) return { action: refused, reason: "voice_disabled" };
  const active = voiceSession.status();
  if (active.active && active.guildId !== target.guildId) {
    return { action: refused, reason: "other_guild" };
  }
  if (action === "leave") {
    try {
      await voiceSession.leave();
    } catch {
      return { action: "leave_refused", reason: "failed" };
    }
    return { action: "left", ...(active.channelId === undefined ? {} : { channelId: active.channelId }) };
  }
  if (!guildIds.has(target.guildId) || !voiceChannelIds.has(target.channelId)) {
    return { action: "join_refused", reason: "allowlist" };
  }
  if (active.active && active.channelId === target.channelId) {
    return { action: "joined", channelId: target.channelId, actorAutoOptedIn: false };
  }
  try {
    await joinUserSessionVoice({
      guildId: target.guildId,
      channelId: target.channelId,
      invokingUserId: target.actorId,
    });
  } catch {
    return { action: "join_refused", reason: "failed" };
  }
  return { action: "joined", channelId: target.channelId, actorAutoOptedIn: true };
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
    return {
      guildId: active?.guildId ?? "",
      actorId: ownerUserId,
      channelId: active?.channelId ?? "",
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
  if (input.guildId === undefined) {
    return { ok: false, message: "That Discord action is not available in DMs." };
  }
  let channelId = input.channelId;
  let action: DiscordPresenceWrite["action"];
  let payload: DiscordPresenceWrite["payload"];
  if (input.action === "react" || input.action === "unreact") {
    if (!guildIds.has(input.guildId) || (channelIds.size > 0 && !channelIds.has(input.channelId))) {
      return { ok: false, message: "That message is outside my admitted Discord channels." };
    }
    action = `discord.presence.${input.action}`;
    payload = { kind: input.action, channelId, messageId: input.messageId, emoji: input.emoji };
  } else if (input.action === "create_thread" || input.action === "join_thread") {
    if (!guildIds.has(input.guildId) || (channelIds.size > 0 && !channelIds.has(input.channelId))) {
      return { ok: false, message: "Threads only work in my admitted server channels." };
    }
    action = `discord.presence.${input.action}`;
    payload =
      input.action === "create_thread"
        ? { kind: "create_thread", channelId, messageId: input.messageId, name: input.name }
        : { kind: "join_thread", channelId };
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
    action =
      input.action === "watch_start" ? "discord.presence.go_live_start" : "discord.presence.go_live_stop";
    payload =
      input.action === "watch_start"
        ? { kind: "go_live_start", guildId: input.guildId, channelId }
        : { kind: "go_live_stop", guildId: input.guildId };
  }

  try {
    const health = await presencePort.getHealth();
    await presencePort.executeDiscordPresenceAction(
      DiscordPresenceWriteSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `captain:${input.callId}:${input.action}`,
        action,
        identity: {
          presenceSessionId: discordPresenceLaneAddress({ guildId: input.guildId, channelId }),
          correlationId: `discord-captain-action:${input.callId}`,
          profileHash: health.profileHash,
          characterId,
          credentialRef: DISCORD_USER_SESSION_PROVIDER_ID,
          transportKind: "user_session",
        },
        payload,
      }),
    );
    return {
      ok: true,
      message:
        input.action === "watch_start"
          ? "I'm sharing the live play surface."
          : input.action === "watch_stop"
            ? "I stopped sharing the live play surface."
            : input.action === "create_thread"
              ? "I started the thread."
              : input.action === "join_thread"
                ? "I joined the thread."
                : input.action === "react"
                  ? "I reacted."
                  : "I removed my reaction.",
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
  type: DiscordBridgeReceipt["type"],
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

async function recordVoiceEvidence(evidence: DiscordVoiceEvidence): Promise<void> {
  voiceIdleAutoLeave?.observe(evidence);
  await recordReceipt(voiceEvidenceReceiptType(evidence), voiceEvidenceReceiptData(evidence));
}

function reportPhaseFailure(error: unknown): void {
  console.error(
    { error: error instanceof Error ? error.message : String(error) },
    "Discord user-session presence phase publication failed",
  );
}

let shutdownPromise: Promise<void> | undefined;
let controlServer: ReturnType<typeof createServer> | undefined;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shutdownPromise = (async () => {
    voiceIdleAutoLeave?.stop();
    streamWatch.close();
    controlServer?.close();
    await voiceSession?.leave();
    voiceAdapters.destroyAll();
    gateway.close();
    await presenceSession.stop().catch(reportPhaseFailure);
    await recordReceipt("discord.user_session.stopped", { signal });
  })();
  return shutdownPromise;
}

const controlPort = Number.parseInt(process.env.CLANKIE_USER_SESSION_CONTROL_PORT ?? "4312", 10);
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  if (request.method === "GET" && (url === "/" || url === "/health")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "discord-user-session" }));
    return;
  }
  if (request.method === "POST" && url === "/go-live/start") {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
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
        const started = streamWatch.requestPublish({
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
    });
    return;
  }
  if (request.method === "POST" && url === "/go-live/stop") {
    streamWatch.stopPublish();
    response.writeHead(202);
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (tryHandleMusicControlRequest(request, response, music)) return;
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

await presenceSession.start().catch(reportPhaseFailure);
gateway.open();
