import { ClankieApiClient } from "@clankie/api-client";
import {
  createDefaultCredentialStore,
  DISCORD_USER_SESSION_PROVIDER_ID,
  resolveDiscordUserBridgeCredential,
  resolveDiscordUserVoiceBridgeCredential,
} from "@clankie/credential-broker";
import {
  createAdvertisedDiscordPresencePort,
  DEFAULT_DECAY_WINDOW_MS,
  DiscordBridgeReceiptStore,
  DiscordPresenceSession,
  DiscordTextIngress,
  DiscordVoiceIngress,
  DiscordVoiceSession,
  dispatchVoiceMusicChat,
  openRealtimeConversationSession,
  openRealtimeTranscriptionSession,
  parseDiscordDmPolicy,
  parseDiscordIdSet,
  selectInboundImageAttachments,
  VoiceMusicQueue,
  type DiscordBridgeReceipt,
} from "@clankie/discord-presence-core";
import type { DiscordVoiceEvidence } from "@clankie/protocol";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import {
  applyDiscordSettingsToEnvironment,
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
const settingsFilledNames = applyDiscordSettingsToEnvironment(storedSettings.discord);

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

const textIngress = new DiscordTextIngress(
  createAdvertisedDiscordPresencePort(api, presenceSession),
  {
    characterId,
    credentialRef: DISCORD_USER_SESSION_PROVIDER_ID,
    transportKind: "user_session",
    guildIds,
    channelIds,
    dmPolicy: parseDiscordDmPolicy(process.env.DISCORD_USER_SESSION_DM_POLICY),
    ...(process.env.DISCORD_OWNER_USER_ID === undefined
      ? {}
      : { ownerUserId: process.env.DISCORD_OWNER_USER_ID }),
    dmUserIds: parseDiscordIdSet(process.env.DISCORD_USER_SESSION_DM_USER_IDS),
    // A user session cannot request bounded history without reading channels
    // wholesale, so ambient context stays off on this plane.
    contextMessageLimit: 0,
    authenticatedSurfaceUrl: process.env.CLANKIE_AUTHENTICATED_SURFACE_URL ?? "http://127.0.0.1:4310",
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

const openAiCredential = voiceEnabled ? await credentialStore.get("openai") : undefined;
if (voiceEnabled && openAiCredential?.type !== "api") {
  throw new Error(
    "User-session voice requires the brokered openai API credential; environment credentials are not accepted.",
  );
}
// Minimal parallel of the bot bridge's realtime wiring (ADR 0057). Same env
// names, same defaults, same always-explicit truncation.
const voiceConfig = voiceEnabled ? parseUserSessionVoiceRealtimeEnv(process.env) : undefined;

const goLiveMusic = {
  play: (_url: string): boolean => false,
  pause: (_paused: boolean): void => undefined,
  stop: (): void => undefined,
};
const music = new VoiceMusicQueue({
  sinkKind: "video",
  sink: {
    play(url) {
      if (!goLiveMusic.play(url)) throw new Error("discord_music_not_in_voice");
    },
    pause() {
      goLiveMusic.pause(true);
    },
    resume() {
      goLiveMusic.pause(false);
    },
    stop() {
      goLiveMusic.stop();
    },
  },
});

const voiceSession =
  openAiCredential?.type !== "api" || voiceApi === undefined || voiceConfig === undefined
    ? undefined
    : new DiscordVoiceSession({
        ingress: new DiscordVoiceIngress(voiceApi, {
          characterId,
          credentialRef: DISCORD_USER_SESSION_PROVIDER_ID,
          transportKind: "user_session",
        }),
        realtime: {
          openTranscription: (handlers) =>
            openRealtimeTranscriptionSession({
              apiKey: openAiCredential.key,
              model: voiceConfig.transcribeModel,
              ...(voiceConfig.language === undefined ? {} : { language: voiceConfig.language }),
              ...(voiceConfig.sessionLifetimeMs === undefined
                ? {}
                : { maxLifetimeMs: voiceConfig.sessionLifetimeMs }),
              onTranscript: handlers.onTranscript,
              onClose: handlers.onClose,
              onError: handlers.onError,
            }),
          openConversation: (open) =>
            openRealtimeConversationSession({
              apiKey: openAiCredential.key,
              model: voiceConfig.realtimeModel,
              voice: voiceConfig.voice,
              instructions: open.instructions,
              truncationRetentionRatio: voiceConfig.truncationRetentionRatio,
              postInstructionsTokenLimit: voiceConfig.postInstructionsTokenLimit,
              ...(voiceConfig.sessionLifetimeMs === undefined
                ? {}
                : { maxLifetimeMs: voiceConfig.sessionLifetimeMs }),
              onAudioDelta: open.onAudioDelta,
              onFunctionCall: open.onFunctionCall,
              onResponseDone: open.onResponseDone,
              onClose: open.onClose,
              onError: open.onError,
            }),
        },
        briefing: async (request) => {
          const briefing = await voiceApi.fetchDiscordVoiceBriefing({
            schemaVersion: 1,
            guildId: request.guildId,
            channelId: request.channelId,
            consentedUserIds: request.consentedUserIds,
          });
          return { instructions: briefing.instructions, briefing: briefing.briefing };
        },
        lookAtScreen: async () => {
          const still = await voiceApi.fetchPlayStill();
          if (still.outcome === "still") {
            return { outcome: "still" as const, pngBase64: still.pngBase64, mimeType: "image/png" as const };
          }
          if (still.outcome === "pending") return { outcome: "pending" as const };
          return { outcome: "not_playing" as const };
        },
        music,
        floor: {
          names: characterNames(storedSettings.persona),
          replyPolicy: storedSettings.persona.replyPolicy,
          chattiness: storedSettings.persona.chattiness,
          decayWindowMs: voiceConfig.decayWindowMs,
        },
        // When this process is the mouth, the floor still answers when
        // addressed. Unprompted volition uses the same decider as the bot
        // once that helper lives in presence-core.
        presenceSessionId: () => presenceSession.record.sessionId,
        emit: recordVoiceEvidence,
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
      const musicReply = await dispatchVoiceMusicChat({
        body: message.content,
        authorId: message.authorId,
        names: characterNames(storedSettings.persona),
        addressed: message.mentionsSelf,
        queue: music,
      });
      if (musicReply !== undefined) {
        await gateway.sendMessage(message.channelId, musicReply);
        return;
      }
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

goLiveMusic.play = (url) => {
  if (streamWatch.playSource(url)) return true;
  const status = voiceSession?.status();
  const guildId = status?.guildId ?? [...guildIds][0];
  const channelId = status?.channelId ?? [...voiceChannelIds][0];
  if (guildId === undefined || channelId === undefined || guildId.length === 0 || channelId.length === 0) {
    return false;
  }
  return streamWatch.requestPublish({ guildId, channelId, sourceUrl: url });
};
goLiveMusic.pause = (paused) => {
  streamWatch.setPublishPaused(paused);
};
goLiveMusic.stop = () => {
  streamWatch.stopPublish();
};

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
  // A watch join just got a session id — retry connecting ClankVox.
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
  observeVoiceIdle(evidence);
  // Evidence is content-free scalars by protocol construction; flattening
  // drops absent optional fields the receipt record type cannot carry.
  const data: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(evidence)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      data[key] = value;
    }
  }
  await recordReceipt(`discord.voice.${evidence.type}`, data);
}

/**
 * Minimal parallel of the bot bridge's realtime voice environment parsing
 * (`apps/discord-bridge/src/voice-composition.ts`): same names, same defaults,
 * same bounds, so one set of operator knobs configures both bodies. Truncation
 * and idle auto-leave are always configured, never unbounded (ADR 0057).
 */
function parseUserSessionVoiceRealtimeEnv(env: NodeJS.ProcessEnv): {
  readonly realtimeModel: string;
  readonly transcribeModel: string;
  readonly voice: string;
  readonly language?: string;
  readonly truncationRetentionRatio: number;
  readonly postInstructionsTokenLimit: number;
  readonly sessionLifetimeMs?: number;
  readonly decayWindowMs: number;
  readonly idleLeaveMs: number;
} {
  const retired = ["CLANKIE_VOICE_STT_MODEL", "CLANKIE_VOICE_TTS_MODEL", "CLANKIE_VOICE_TTS_VOICE"].filter(
    (name) => env[name] !== undefined,
  );
  if (retired.length > 0) {
    throw new Error(
      `${retired.join(", ")} belong to the removed STT→captain→TTS cascade. Use ` +
        "CLANKIE_VOICE_TRANSCRIBE_MODEL, CLANKIE_VOICE_REALTIME_MODEL, and CLANKIE_VOICE_REALTIME_VOICE.",
    );
  }
  const language = env.CLANKIE_VOICE_STT_LANGUAGE;
  const sessionLifetimeMs = boundedVoiceInteger(env, "CLANKIE_VOICE_SESSION_LIFETIME_MS", 10_000, 14_400_000);
  const retention = env.CLANKIE_VOICE_TRUNCATION_RETENTION;
  const retentionRatio = retention === undefined ? 0.7 : Number(retention);
  if (!Number.isFinite(retentionRatio) || retentionRatio <= 0 || retentionRatio > 1) {
    throw new Error("CLANKIE_VOICE_TRUNCATION_RETENTION must be a ratio within (0, 1]");
  }
  return {
    realtimeModel: nonEmptyVoiceEnv(env, "CLANKIE_VOICE_REALTIME_MODEL", "gpt-realtime-2.1"),
    transcribeModel: nonEmptyVoiceEnv(env, "CLANKIE_VOICE_TRANSCRIBE_MODEL", "gpt-realtime-whisper"),
    voice: nonEmptyVoiceEnv(env, "CLANKIE_VOICE_REALTIME_VOICE", "marin"),
    ...(language === undefined ? {} : { language }),
    truncationRetentionRatio: retentionRatio,
    postInstructionsTokenLimit:
      boundedVoiceInteger(env, "CLANKIE_VOICE_POST_INSTRUCTIONS_TOKEN_LIMIT", 1_000, 128_000) ?? 12_000,
    ...(sessionLifetimeMs === undefined ? {} : { sessionLifetimeMs }),
    decayWindowMs:
      boundedVoiceInteger(env, "CLANKIE_VOICE_DECAY_WINDOW_MS", 1, Number.MAX_SAFE_INTEGER) ??
      DEFAULT_DECAY_WINDOW_MS,
    idleLeaveMs: boundedVoiceInteger(env, "CLANKIE_VOICE_IDLE_LEAVE_MS", 1, 86_400_000) ?? 900_000,
  };
}

function nonEmptyVoiceEnv(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name];
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new Error(`${name} must be non-empty when set`);
  return trimmed;
}

function boundedVoiceInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum.toString()} and ${maximum.toString()}`);
  }
  return parsed;
}

let voiceIdleHandle: NodeJS.Timeout | undefined;

/**
 * Minimal parallel of the bot bridge's idle auto-leave: a joined channel is a
 * metered realtime session (ADR 0057), so a call with no utterance, response,
 * or floor movement for `CLANKIE_VOICE_IDLE_LEAVE_MS` ends itself.
 */
function observeVoiceIdle(evidence: DiscordVoiceEvidence): void {
  const idleLeaveMs = voiceConfig?.idleLeaveMs;
  if (idleLeaveMs === undefined || voiceSession === undefined) return;
  if (evidence.type === "left") {
    stopVoiceIdleTimer();
    return;
  }
  if (
    evidence.type !== "joined" &&
    evidence.type !== "utterance" &&
    evidence.type !== "response" &&
    evidence.type !== "floor"
  ) {
    return;
  }
  stopVoiceIdleTimer();
  voiceIdleHandle = setTimeout(() => {
    voiceIdleHandle = undefined;
    if (!voiceSession.status().active) return;
    console.info(
      `Discord user-session voice idle for ${String(idleLeaveMs)}ms; leaving the metered channel.`,
    );
    void voiceSession.leave().catch((error: unknown) => {
      console.error(
        { error: error instanceof Error ? error.message : String(error) },
        "Discord user-session voice idle auto-leave failed to close the session",
      );
    });
  }, idleLeaveMs);
}

function stopVoiceIdleTimer(): void {
  if (voiceIdleHandle === undefined) return;
  clearTimeout(voiceIdleHandle);
  voiceIdleHandle = undefined;
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
    stopVoiceIdleTimer();
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
