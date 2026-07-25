import { ClankieApiClient } from "@clankie/api-client";
import {
  createDefaultCredentialStore,
  DISCORD_USER_SESSION_PROVIDER_ID,
  resolveDiscordUserBridgeCredential,
  resolveDiscordUserVoiceBridgeCredential,
} from "@clankie/credential-broker";
import {
  createAdvertisedDiscordPresencePort,
  DiscordBridgeReceiptStore,
  DiscordPresenceSession,
  DiscordTextIngress,
  DiscordVoiceIngress,
  DiscordVoiceSession,
  OpenAiVoiceSpeechRuntime,
  parseDiscordDmPolicy,
  parseDiscordIdSet,
  type DiscordBridgeReceipt,
  type DiscordVoiceEvidence,
} from "@clankie/discord-presence-core";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { applyDiscordSettingsToEnvironment, SettingsStore } from "@clankie/settings";
import { DiscordUserGateway } from "./gateway.ts";
import { assertUserSessionAdmissible } from "./readiness.ts";
import { DiscordUserVoiceAdapters } from "./voice-adapter.ts";

/**
 * Personal-lab user-session Discord plane (ADR 0048).
 *
 * A second, isolated process rather than a mode of the bot bridge: ADR 0024
 * forbids bot and user credentials sharing a gateway, and separate processes
 * are what make that structural instead of a convention. Everything above the
 * transport — ingress shaping, Eve lane addressing, consent, memory — is the
 * shared core, so this body is the same Clankie the bot is.
 */

// Fill unset DISCORD_* names from the operator settings file before anything
// reads them. The settings schema currently carries no `DISCORD_USER_SESSION_*`
// fields, so today this supplies only the shared `DISCORD_OWNER_USER_ID` that
// the default `owner_only` DM policy needs; the plane's own allowlists still
// come from the environment and remain ceilinged by the recorded opt-in.
// Ahead of the token guards on purpose — see the bot bridge for the reasoning.
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
    "The brokered clankie_discord_user_bridge credential is missing. Start the control plane once before the user-session bridge.",
  );
}
const voiceBridgeToken = voiceEnabled
  ? await resolveDiscordUserVoiceBridgeCredential({ store: credentialStore })
  : undefined;
if (voiceEnabled && voiceBridgeToken === undefined) {
  throw new Error(
    "The brokered clankie_discord_user_voice_bridge credential is missing. Restart the control plane before enabling user-session voice.",
  );
}

const api = new ClankieApiClient({ baseUrl: apiUrl, captainToken: bridgeToken });
const voiceApi =
  voiceBridgeToken === undefined
    ? undefined
    : new ClankieApiClient({ baseUrl: apiUrl, captainToken: voiceBridgeToken });

const receipts = new DiscordBridgeReceiptStore({ path: receiptPath() });

// Every gate is checked before a single byte reaches Discord: enablement flag,
// brokered credential, durable owner opt-in for the doctrine in force, and
// non-empty allowlists. A refusal is recorded, not merely thrown.
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
    authenticatedSurfaceUrl:
      process.env.CLANKIE_AUTHENTICATED_SURFACE_URL ?? "http://127.0.0.1:4311/approvals",
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
const voiceSpeech =
  openAiCredential?.type === "api"
    ? new OpenAiVoiceSpeechRuntime({
        apiKey: openAiCredential.key,
        ...(process.env.CLANKIE_VOICE_STT_MODEL === undefined
          ? {}
          : { sttModel: process.env.CLANKIE_VOICE_STT_MODEL }),
        ...(process.env.CLANKIE_VOICE_TTS_MODEL === undefined
          ? {}
          : { ttsModel: process.env.CLANKIE_VOICE_TTS_MODEL }),
        ...(process.env.CLANKIE_VOICE_TTS_VOICE === undefined
          ? {}
          : { voice: process.env.CLANKIE_VOICE_TTS_VOICE }),
      })
    : undefined;
if (voiceSpeech !== undefined) {
  const readiness = await voiceSpeech.readiness();
  if (!readiness.ready) {
    throw new Error("User-session voice is enabled but OpenAI speech readiness is incomplete.");
  }
}
const voiceSession =
  voiceSpeech === undefined || voiceApi === undefined
    ? undefined
    : new DiscordVoiceSession({
        ingress: new DiscordVoiceIngress(voiceApi, {
          characterId,
          credentialRef: DISCORD_USER_SESSION_PROVIDER_ID,
          transportKind: "user_session",
        }),
        speech: voiceSpeech,
        presenceSessionId: () => presenceSession.record.sessionId,
        emit: recordVoiceEvidence,
      });

gateway.on("ready", (identity) => {
  void presenceSession.gatewayReady().catch(reportPhaseFailure);
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
      const result = await textIngress.handle({
        id: message.id,
        ...(message.guildId === undefined ? {} : { guildId: message.guildId }),
        channelId: message.channelId,
        authorId: message.authorId,
        // A user session must never answer itself; the account is a participant.
        authorIsBot: message.authorIsBot || message.authorId === gateway.userId,
        mentionsBot: message.mentionsSelf,
        body: message.content,
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

gateway.on("voiceStateUpdate", (state) => {
  if (state.guildId === undefined) return;
  voiceSession?.memberChannelChanged(state.guildId, state.userId, state.channelId);
  if (state.userId !== gateway.userId) return;
  void presenceSession
    .voiceStateChanged(state.guildId, state.channelId !== undefined)
    .catch(reportPhaseFailure);
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
  await recordReceipt(`discord.voice.${evidence.type}` as DiscordBridgeReceipt["type"], evidence);
}

function reportPhaseFailure(error: unknown): void {
  console.error(
    { error: error instanceof Error ? error.message : String(error) },
    "Discord user-session presence phase publication failed",
  );
}

let shutdownPromise: Promise<void> | undefined;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shutdownPromise = (async () => {
    await voiceSession?.leave();
    voiceAdapters.destroyAll();
    gateway.close();
    await presenceSession.stop().catch(reportPhaseFailure);
    await recordReceipt("discord.user_session.stopped", { signal });
  })();
  return shutdownPromise;
}

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
