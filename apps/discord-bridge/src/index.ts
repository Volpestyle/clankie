import { ClankieApiClient } from "@clankie/api-client";
import {
  createDefaultCredentialStore,
  DISCORD_BOT_PROVIDER_ID,
  ensurePlayVoiceCredential,
  resolveDiscordBridgeCredential,
  resolveDiscordVoiceBridgeCredential,
} from "@clankie/credential-broker";
import { createPlayVoiceListener, PLAY_VOICE_DEFAULT_PORT, PLAY_VOICE_PATH } from "@clankie/play-voice";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { isAbsolute, join, relative } from "node:path";
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  GuildMember,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
} from "discord.js";
import {
  authorizeAmbientCommand,
  authorizeVoicePresenceCommand,
  parseDiscordVoiceJoinPolicy,
  type DiscordCommandPrincipal,
  type DiscordRoleBindings,
} from "./authority.ts";
import {
  CATCH_UP_INTERVAL_MS,
  createAdvertisedDiscordPresencePort,
  createVoiceBriefingProvider,
  createVoiceLookAtScreenProvider,
  createVoiceRealtimePorts,
  discordVoiceTranscriptLogPath,
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
  tryHandleCaptainDiscordActionRequest,
  tryHandleMusicControlRequest,
  resolveOwnerFollowTarget,
  tryHandleVoicePresenceControlRequest,
  VoiceIdleAutoLeave,
  voiceEvidenceReceiptData,
  voiceEvidenceReceiptType,
  type DiscordBridgeReceipt,
  type DiscordBridgeReceiptType,
  type DiscordInboundContextMessage,
  type VoicePresenceControlAction,
  type VoicePresenceControlInput,
} from "@clankie/discord-presence-core";
import { discordPresenceLaneAddress } from "@clankie/interactive-environment";
import {
  DiscordPresenceWriteSchema,
  type DiscordCaptainActionInput,
  type DiscordCaptainActionResult,
  type DiscordVoiceEvidence,
} from "@clankie/protocol";
import {
  applyDiscordSettingsToEnvironment,
  applyVoiceSettingsToEnvironment,
  characterNames,
  SettingsStore,
} from "@clankie/settings";
import { commands, DISCORD_COMMAND_NAME, DISCORD_SUBCOMMANDS } from "./commands.ts";
import {
  describeVoiceResponse,
  renderVoiceConsentReply,
  renderVoiceJoinDisclosure,
  renderVoiceStatusReply,
} from "./voice-composition.ts";
import { executeVoicePresenceIntent } from "./voice-presence.ts";
import { sanitizeDiscordText } from "./text.ts";
import { shutdownDiscordBridge } from "./shutdown.ts";
import { DiscordVoxGatewayBridge } from "./vox-gateway.ts";
import { startOfficialBotVox } from "./vox-process.ts";
import { assertOfficialBotBodyActive, discordBridgeHealth } from "./lifecycle.ts";

// Fill unset DISCORD_* names from the operator settings file before anything
// reads them, so TUI-configured deployments need no .env. Deliberately ahead of
// the token guards below: settings hold non-secret values only, and running the
// guards afterwards means a token-shaped value that ever reached the settings
// schema by mistake would still be caught here rather than used.
const settingsStore = new SettingsStore();
const storedSettings = await settingsStore.load();
const settingsFilledNames = [
  ...applyDiscordSettingsToEnvironment(storedSettings.discord),
  ...applyVoiceSettingsToEnvironment(storedSettings.voice),
];
assertOfficialBotBodyActive(process.env);

if (process.env.DISCORD_USER_TOKEN) {
  throw new Error("DISCORD_USER_TOKEN must not be set for the official Discord bot bridge.");
}
if (process.env.DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN must not be set. Store discord_bot in the credential broker.");
}
if (process.env.CLANKIE_CAPTAIN_TOKEN) {
  throw new Error(
    "CLANKIE_CAPTAIN_TOKEN must not be set for the Discord bridge. Its local identity is brokered as clankie_discord_bridge.",
  );
}
const credentialStore = createDefaultCredentialStore();
const voiceEnabled = process.env.DISCORD_VOICE_ENABLED === "true";
const voiceTranscriptLoggingEnabled = process.env.DISCORD_VOICE_TRANSCRIPT_LOGGING_ENABLED === "true";
const credential = await credentialStore.get(DISCORD_BOT_PROVIDER_ID);
const token = credential?.type === "api" ? credential.key : undefined;
const applicationId = process.env.DISCORD_APPLICATION_ID;
if (!token || !applicationId) {
  throw new Error(
    "A brokered discord_bot API credential and DISCORD_APPLICATION_ID are required. Normal Discord user credentials are unsupported.",
  );
}

const apiUrl = process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310";
const bridgeToken = await resolveDiscordBridgeCredential({ store: credentialStore });
if (!bridgeToken) {
  throw new Error(
    "The brokered clankie_discord_bridge credential is missing. Start the clankie service once before the Discord bridge.",
  );
}
const voiceBridgeToken = voiceEnabled
  ? await resolveDiscordVoiceBridgeCredential({ store: credentialStore })
  : undefined;
if (voiceEnabled && voiceBridgeToken === undefined) {
  throw new Error(
    "The brokered clankie_discord_voice_bridge credential is missing. Restart the clankie service before enabling Discord voice.",
  );
}
if (voiceEnabled && process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY must not be set. Reuse the brokered openai credential.");
}
if (voiceEnabled && process.env.XAI_API_KEY) {
  throw new Error("XAI_API_KEY must not be set. Reuse the brokered xai credential.");
}
if (voiceEnabled && (process.env.ELEVENLABS_API_KEY ?? process.env.XI_API_KEY)) {
  throw new Error(
    "ELEVENLABS_API_KEY and XI_API_KEY must not be set. Store the ElevenLabs key under the brokered elevenlabs provider.",
  );
}
const authenticatedSurfaceUrl = process.env.CLANKIE_AUTHENTICATED_SURFACE_URL ?? "http://127.0.0.1:4310";
const api = new ClankieApiClient({ baseUrl: apiUrl, captainToken: bridgeToken });
const voiceApi =
  voiceBridgeToken === undefined
    ? undefined
    : new ClankieApiClient({ baseUrl: apiUrl, captainToken: voiceBridgeToken });
const characterId = process.env.CLANKIE_CHARACTER_ID ?? "clankie";
let terminalFailure: string | undefined;
const presenceSession = new DiscordPresenceSession({
  sessionId: `discord:bot:${applicationId}:${randomUUID()}`,
  characterId,
  credentialRef: "discord_bot",
  transportKind: "bot",
  emit: async (event) => {
    const result = await api.recordDiscordPresencePhase(event);
    console.info(event, "Discord presence phase event");
    return result.session;
  },
  onPublicationFailure: reportPresencePhaseFailure,
  onTerminalFailure: (error, event) => {
    terminalFailure ??= `presence publication failed: ${error.disposition}`;
    console.error(
      {
        disposition: error.disposition,
        attempts: error.attempts,
        event,
      },
      "Discord presence session entered terminal publication failure",
    );
  },
});
const roleBindings: DiscordRoleBindings = {
  ambientRoleIds: parseDiscordIdSet(process.env.DISCORD_AMBIENT_ROLE_IDS),
  ambientUserIds: parseDiscordIdSet(process.env.DISCORD_AMBIENT_USER_IDS),
};
const voiceJoinPolicy = parseDiscordVoiceJoinPolicy(process.env.DISCORD_VOICE_JOIN_POLICY);
const receipts = new DiscordBridgeReceiptStore({
  path: bridgeReceiptPath(),
});
const textIngressEnabled = process.env.DISCORD_TEXT_INGRESS_ENABLED === "true";
const textIngressContextLimit = parseContextMessageLimit(process.env.DISCORD_INGRESS_CONTEXT_MESSAGES);
const ingressGuildIds = parseDiscordIdSet(process.env.DISCORD_INGRESS_GUILD_IDS);
const ingressChannelIds = parseDiscordIdSet(process.env.DISCORD_INGRESS_CHANNEL_IDS);
const ownerUserId = process.env.DISCORD_OWNER_USER_ID?.trim();
// One advertised port for every bridge-side presence write: text ingress
// replies and the slash-invoked activity launch go through the same live-claim
// and tool-exposure guards.
const presencePort = createAdvertisedDiscordPresencePort(api, presenceSession);
const toolProgressMessageIds = new Set<string>();
const textIngress = textIngressEnabled
  ? new DiscordTextIngress(
      presencePort,
      {
        characterId,
        credentialRef: "discord_bot",
        transportKind: "bot",
        guildIds: ingressGuildIds,
        channelIds: ingressChannelIds,
        dmPolicy: parseDiscordDmPolicy(process.env.DISCORD_INGRESS_DM_POLICY),
        ...(process.env.DISCORD_OWNER_USER_ID === undefined
          ? {}
          : { ownerUserId: process.env.DISCORD_OWNER_USER_ID }),
        dmUserIds: parseDiscordIdSet(process.env.DISCORD_INGRESS_DM_USER_IDS),
        contextMessageLimit: textIngressContextLimit,
        authenticatedSurfaceUrl,
        // Persona owns who he is and when he speaks; the bridge only carries it.
        replyPolicy: storedSettings.persona.replyPolicy,
        characterNames: characterNames(storedSettings.persona),
        liveMessageWindow: storedSettings.persona.liveMessageWindow,
      },
      (event) => {
        console.info(event, "Discord text ingress event");
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
    )
  : undefined;
const voiceGuildIds = parseDiscordIdSet(process.env.DISCORD_VOICE_GUILD_IDS);
const voiceChannelIds = parseDiscordIdSet(process.env.DISCORD_VOICE_CHANNEL_IDS);
// The guild allowlist stays required: it is what bounds voice to servers the
// owner chose. The channel allowlist is optional refinement — empty admits any
// voice channel *within* those guilds, which is still gated by the ambient role
// check on /clankie join and by per-participant consent (ADR 0045).
if (voiceEnabled && voiceGuildIds.size === 0) {
  throw new Error("Discord voice is enabled but DISCORD_VOICE_GUILD_IDS is empty.");
}
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    ...(textIngressEnabled
      ? [GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent]
      : []),
  ],
  partials: textIngressEnabled ? [Partials.Channel] : [],
});
let shuttingDown = false;
// Validated at startup like the rest of the env: truncation and idle auto-leave
// are always configured, never defaulted to unbounded (ADR 0057, mission T6).
const voiceRealtimeConfig = voiceEnabled ? parseVoiceRealtimeEnv(process.env) : undefined;
const realtimeCredential =
  voiceRealtimeConfig === undefined
    ? undefined
    : await credentialStore.get(voiceRealtimeConfig.realtimeProvider);
if (voiceEnabled && realtimeCredential?.type !== "api") {
  const provider = voiceRealtimeConfig?.realtimeProvider ?? "openai";
  throw new Error(
    `Discord voice requires a brokered ${provider} API credential; OAuth and environment credentials are not accepted by the realtime boundary.`,
  );
}
// The external voice (ADR 0070) follows the exact openai credential shape:
// broker-resolved, API-type only, resolved once at startup.
const elevenLabsCredential =
  voiceRealtimeConfig?.ttsProvider === "elevenlabs" ? await credentialStore.get("elevenlabs") : undefined;
if (voiceRealtimeConfig?.ttsProvider === "elevenlabs" && elevenLabsCredential?.type !== "api") {
  throw new Error(
    "CLANKIE_VOICE_TTS_PROVIDER=elevenlabs requires a brokered elevenlabs API credential. " +
      "Store the ElevenLabs API key under provider elevenlabs via /auth.",
  );
}
// Who counts as consented to being heard (ADR 0045). Settings-backed like the
// rest of the voice configuration; anything but the exact "presence" value
// stays on the explicit opt-in policy.
const voiceConsentPolicy =
  process.env["DISCORD_VOICE_CONSENT_POLICY"] === "presence" ? ("presence" as const) : ("explicit" as const);
const vox = await startOfficialBotVox({
  enabled: voiceEnabled,
  env: process.env,
  onError: (message) => console.error({ message }, "Vox media process failed"),
  onLog: (message) => console.info({ message }, "Vox media process"),
});
const voiceSession =
  realtimeCredential?.type !== "api" ||
  voiceApi === undefined ||
  voiceRealtimeConfig === undefined ||
  vox === undefined
    ? undefined
    : new DiscordVoiceSession({
        vox,
        ingress: new DiscordVoiceIngress(voiceApi, {
          characterId,
          credentialRef: "discord_bot",
          transportKind: "bot",
        }),
        consentPolicy: voiceConsentPolicy,
        // The gateway holder answers "who is in the room"; the core package
        // never touches a Discord client. Read at conversation-open time, which
        // is always after the gateway is ready, so the closure over `client`
        // below is resolved rather than hoisted.
        channelOccupants: (guildId, channelId) => {
          const channel = client.guilds.cache.get(guildId)?.channels.cache.get(channelId);
          if (channel === undefined || !channel.isVoiceBased()) return [];
          // He is in his own channel and is not someone he needs memory of.
          return [...channel.members.values()]
            .filter((member) => member.id !== client.user?.id)
            .map((member) => ({ userId: member.id, displayName: member.displayName }));
        },
        realtime: createVoiceRealtimePorts({
          apiKey: realtimeCredential.key,
          ...(elevenLabsCredential?.type === "api" ? { elevenLabsApiKey: elevenLabsCredential.key } : {}),
          config: voiceRealtimeConfig,
        }),
        briefing: createVoiceBriefingProvider(voiceApi),
        lookAtScreen: createVoiceLookAtScreenProvider(voiceApi),
        floor: {
          // Persona owns who he is and when he speaks; the bridge only carries it.
          names: characterNames(storedSettings.persona),
          replyPolicy: storedSettings.persona.replyPolicy,
          chattiness: storedSettings.persona.chattiness,
          decayWindowMs: voiceRealtimeConfig.decayWindowMs,
        },
        presenceSessionId: () => presenceSession.record.sessionId,
        emit: recordVoiceEvidence,
      });
const voiceGateway =
  vox === undefined || voiceSession === undefined
    ? undefined
    : new DiscordVoxGatewayBridge(vox, voiceSession, {
        onError: (message) => {
          terminalFailure ??= message;
          console.error({ message }, "Discord Vox gateway adapter failed");
        },
        onLeaveConfirmed: async ({ guildId, channelId }) => {
          await recordReceipt("discord.voice.left", {
            guildId,
            channelId,
            gatewayConfirmed: true,
            mediaOwner: "vox",
          });
        },
      });
const voiceTranscriptStore = voiceTranscriptLoggingEnabled ? new DiscordVoiceTranscriptStore() : undefined;
if (voiceSession !== undefined && voiceTranscriptStore !== undefined) {
  voiceSession.subscribeTranscript((_line, transcript) => {
    void voiceTranscriptStore.append("bot", transcript).catch((error: unknown) => {
      console.error(
        { deliveryId: transcript.deliveryId, error: error instanceof Error ? error.message : String(error) },
        "Discord voice transcript append failed",
      );
    });
  });
  console.info({ path: discordVoiceTranscriptLogPath() }, "Full Discord voice transcript logging enabled");
}
const voiceIdleAutoLeave =
  voiceSession === undefined || voiceRealtimeConfig === undefined
    ? undefined
    : new VoiceIdleAutoLeave({
        idleLeaveMs: voiceRealtimeConfig.idleLeaveMs,
        isActive: () => voiceSession.status().active,
        leave: () => voiceGateway?.leave() ?? voiceSession.leave(),
        onLeave: (idleMs) => {
          console.info(`Discord voice session idle for ${String(idleMs)}ms; leaving the metered channel.`);
        },
        onLeaveError: (error) => {
          console.error(
            { error: error instanceof Error ? error.message : String(error) },
            "Discord voice idle auto-leave failed to close the session",
          );
        },
      });
// Clankie's play voice seam (ADR 0064): local or hosted play reports what it
// just did, and the active Discord body lets his live persona decide whether to
// commentate. No voice session means no listener and no Discord capability.
const playVoiceListener =
  voiceSession === undefined
    ? undefined
    : createPlayVoiceListener({
        // The active body owns the listener, so it owns first-run minting.
        token: await ensurePlayVoiceCredential({ store: credentialStore }),
        narrate: (text, options) => voiceSession.narrate(text, options),
        emit: (evidence) => {
          const stayId = voiceSession.status().stayId;
          return recordVoiceEvidence(
            stayId === undefined || evidence.stayId !== undefined ? evidence : { ...evidence, stayId },
          );
        },
        // Read at attach time so a play loop that starts mid-call learns the
        // room immediately instead of waiting for the next join or leave.
        room: () => ({ listening: voiceSession.status().active }),
      });
let stopPlayVoiceTranscript: (() => void) | undefined;
if (playVoiceListener !== undefined && voiceSession !== undefined) {
  const port = await playVoiceListener.listen(PLAY_VOICE_DEFAULT_PORT);
  // Hearing is push-only, so the bridge starts retaining nothing new: lines
  // that already passed the consent boundary are handed on as they happen.
  stopPlayVoiceTranscript = voiceSession.subscribeTranscript((line) =>
    playVoiceListener.publishUtterance(line),
  );
  // Text lands on the same seam (see `messageCreate`), so the room can steer a
  // playthrough without anyone opting into voice capture.
  console.info({ port, path: PLAY_VOICE_PATH }, "Discord bridge play voice seam listening on loopback");
}
// The gateway is the authority on which servers he is in and how much of each
// he can see; the presence record is how that knowledge reaches the captain.
// Synced before every ready/resume publication (membership rides the phase
// event instead of costing a second one) and again whenever membership or
// channel reach changes.
const guildChannelAccess = (guild: Guild) => {
  // The bot's own member is delivered with GUILD_CREATE; without it there is
  // no permission subject, so reach is honestly "unknown" rather than a guess.
  const me = guild.members.me;
  if (me === null) return undefined;
  // Threads inherit their parent's visibility and categories are grouping
  // chrome — neither is what "channels" means in "can you see all of them?".
  const channels = [...guild.channels.cache.values()].filter(
    (channel) => !channel.isThread() && channel.type !== ChannelType.GuildCategory,
  );
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const channel of channels) {
    (channel.permissionsFor(me).has(PermissionFlagsBits.ViewChannel) ? visible : hidden).push(channel.name);
  }
  // Sorted by name, not position: a server reorder then changes nothing in
  // the record, and the presence core drops the no-op sync instead of
  // publishing a fresh durable event.
  visible.sort((left, right) => left.localeCompare(right));
  hidden.sort((left, right) => left.localeCompare(right));
  return {
    total: channels.length,
    viewable: visible.length,
    ...(visible.length === 0 ? {} : { visible }),
    ...(hidden.length === 0 ? {} : { hidden }),
  };
};
const syncGuildMembership = () => {
  // An empty cache at shardReady means "not populated yet", not "in no
  // servers" — guilds stream in after READY. Skipping keeps the record at
  // "unknown" instead of briefly claiming zero membership; the ready handler
  // and guild events re-sync once the cache is real.
  if (client.guilds.cache.size === 0) return;
  const guilds = [...client.guilds.cache.values()].map((guild) => {
    const channelAccess = guildChannelAccess(guild);
    return {
      guildId: guild.id,
      guildName: guild.name,
      ...(channelAccess === undefined ? {} : { channelAccess }),
    };
  });
  void presenceSession.guildMembershipChanged(guilds).catch(reportPresencePhaseFailure);
};
// Channel and role churn arrives in bursts (a server reorganization fires one
// event per change); a trailing coalesce keeps that from spraying the durable
// stream. The presence core additionally drops syncs that change nothing.
let membershipSyncTimer: NodeJS.Timeout | undefined;
let catchUpTimer: NodeJS.Timeout | undefined;
const scheduleGuildMembershipSync = () => {
  if (membershipSyncTimer !== undefined) clearTimeout(membershipSyncTimer);
  membershipSyncTimer = setTimeout(() => {
    membershipSyncTimer = undefined;
    syncGuildMembership();
  }, 1_500);
  membershipSyncTimer.unref?.();
};

client.once("ready", async () => {
  syncGuildMembership();
  void presenceSession.gatewayReady().catch(reportPresencePhaseFailure);
  const rest = new REST({ version: "10" }).setToken(token);
  // Guild-scoped to every server he reads, not just the home guild: a member
  // who can talk to him should see his command surface. Global registration
  // stays the no-config fallback and is otherwise avoided — a global PUT
  // overwrites ALL global commands, including the Discord-managed Entry Point
  // command that makes the activity launchable from the launcher.
  const commandGuildIds = new Set(
    [process.env.DISCORD_GUILD_ID, ...ingressGuildIds].filter(
      (id): id is string => id !== undefined && id.length > 0,
    ),
  );
  if (commandGuildIds.size === 0) {
    await rest.put(Routes.applicationCommands(applicationId), { body: commands });
  } else {
    for (const commandGuildId of commandGuildIds) {
      await rest.put(Routes.applicationGuildCommands(applicationId, commandGuildId), { body: commands });
    }
  }

  await recordReceipt("discord.bridge.ready", {
    // The registered command count is always 1 now; the useful number for an
    // operator checking what landed is how many subcommands it carries.
    commandCount: DISCORD_SUBCOMMANDS.length,
    textIngressEnabled,
    voiceEnabled,
    mediaOwner: voiceEnabled ? "vox" : "none",
    voxProcessReady: vox?.status === "ready",
    settingsFilledCount: settingsFilledNames.length,
  });
  if (settingsFilledNames.length > 0) {
    // Which knobs came from the settings file rather than the shell. Silent
    // configuration provenance is exactly what wastes an hour of debugging.
    console.info({ names: settingsFilledNames }, "Discord configuration filled from operator settings");
  }
  console.log(
    `Discord bot ready as ${client.user?.tag ?? "unknown"}; registered /${DISCORD_COMMAND_NAME} with ${DISCORD_SUBCOMMANDS.length} subcommands, text ingress ${textIngressEnabled ? "enabled" : "disabled"}, voice ${voiceEnabled ? "enabled" : "disabled"}.`,
  );
});

client.on("shardReady", () => {
  syncGuildMembership();
  void presenceSession.gatewayReady().catch(reportPresencePhaseFailure);
});

client.on("shardResume", () => {
  syncGuildMembership();
  void presenceSession.gatewayResumed().catch(reportPresencePhaseFailure);
});

// A membership change while disconnected is invisible until the next
// ready/resume sync; these keep the record live in between.
client.on("guildCreate", syncGuildMembership);
client.on("guildDelete", syncGuildMembership);
// Channel reach and server names drift without membership changing: channels
// appear and vanish, permission overwrites move, his roles change, servers
// rename. Coalesced — see scheduleGuildMembershipSync.
client.on("guildUpdate", scheduleGuildMembershipSync);
client.on("channelCreate", scheduleGuildMembershipSync);
client.on("channelDelete", scheduleGuildMembershipSync);
client.on("channelUpdate", scheduleGuildMembershipSync);
client.on("roleCreate", scheduleGuildMembershipSync);
client.on("roleUpdate", scheduleGuildMembershipSync);
client.on("roleDelete", scheduleGuildMembershipSync);
client.on("guildMemberUpdate", (_previous, current) => {
  if (current.id === client.user?.id) scheduleGuildMembershipSync();
});

client.on("shardReconnecting", () => {
  void presenceSession.gatewayReconnecting().catch(reportPresencePhaseFailure);
});

client.on("shardDisconnect", () => {
  void presenceSession.gatewayDisconnected().catch(reportPresencePhaseFailure);
});

client.on("invalidated", () => {
  terminalFailure ??= "Discord gateway session was invalidated";
  void presenceSession.fail().catch(reportPresencePhaseFailure);
});

const observedStreams = new Map<string, { guildId: string; channelId: string; userId: string }>();

function reportObservedStreams(): void {
  const streams = [...observedStreams.values()].map((stream) => ({
    schemaVersion: 1 as const,
    streamKey: `guild:${stream.guildId}:${stream.channelId}:${stream.userId}`,
    kind: "guild" as const,
    guildId: stream.guildId,
    channelId: stream.channelId,
    userId: stream.userId,
    watching: false,
    hasFrame: false,
    updatedAt: new Date().toISOString(),
  }));
  void api
    .reportDiscordStreamWatch({ schemaVersion: 1, source: "bot", streams, decoder: "idle" })
    .catch((error: unknown) => {
      console.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Discord stream-watch metadata report failed",
      );
    });
}

client.on("voiceStateUpdate", (previous, current) => {
  if (previous.streaming !== current.streaming) {
    const key = `${current.guild.id}:${current.id}`;
    if (current.streaming && current.channelId !== null) {
      observedStreams.set(key, {
        guildId: current.guild.id,
        channelId: current.channelId,
        userId: current.id,
      });
    } else {
      observedStreams.delete(key);
    }
    reportObservedStreams();
  }
  voiceSession?.memberChannelChanged(current.guild.id, current.id, current.channelId ?? undefined);
  if (current.id === client.user?.id) {
    // Names and occupants ride the presence record (VUH-939): this is the one
    // point where the gateway objects are in hand. Occupants exclude the bot
    // itself, are sorted by userId for byte-stable record JSON, and are capped
    // to the schema bound. Cached voice states are the source, so members who
    // joined before this process connected may be absent — ids stay authority.
    const joinedChannel = current.channel;
    void presenceSession
      .voiceStateChanged(
        current.guild.id,
        current.channelId !== null,
        current.channelId === null || joinedChannel === null
          ? undefined
          : {
              guildName: current.guild.name,
              channelId: current.channelId,
              channelName: joinedChannel.name,
              occupants: [...joinedChannel.members.values()]
                .filter((member) => member.id !== client.user?.id)
                .map((member) => ({ userId: member.id, displayName: member.displayName }))
                .sort((left, right) => (left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0))
                .slice(0, 32),
            },
      )
      .catch(reportPresencePhaseFailure);
    const activeVoiceSession = voiceSession;
    const status = activeVoiceSession?.status();
    if (activeVoiceSession !== undefined && status?.active && current.channelId !== status.channelId) {
      void (voiceGateway?.leave() ?? activeVoiceSession.leave()).catch((error) => {
        console.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Discord voice session failed to close after a bot channel move",
        );
      });
    }
  }
});

client.on("messageCreate", async (message) => {
  if (shuttingDown || !textIngress) return;
  try {
    const selection = selectDiscordMessageImages(message);
    const authorIsBot = message.author.bot || message.author.id === client.user?.id;
    const inbound = {
      id: message.id,
      ...(message.guildId === null ? {} : { guildId: message.guildId }),
      channelId: message.channelId,
      authorId: message.author.id,
      authorIsBot,
      mentionsBot: client.user !== null && message.mentions.users.has(client.user.id),
      body: message.content,
      attachments: selection.attachments,
      attachmentsOmitted: selection.omitted,
    };
    const routedRoomText = routeDiscordRoomText(
      { guildIds: ingressGuildIds, channelIds: ingressChannelIds },
      {
        ...(message.guildId === null ? {} : { guildId: message.guildId }),
        channelId: message.channelId,
        authorIsBot,
        body: message.content,
        userId: message.author.id,
        displayName: message.member?.displayName ?? message.author.globalName ?? message.author.username,
        deliveryId: message.id,
        hasAttachments: selection.attachments.length > 0 || selection.omitted > 0,
      },
      voiceSession,
    );
    // The playthrough and realtime voice room are local threads of the same
    // character. Both inherit the event; only the active voice room owns the
    // reply, so the separate text captain does not race it.
    if (routedRoomText.text !== null) playVoiceListener?.publishUtterance(routedRoomText.text);
    if (routedRoomText.voiceOwned) return;
    let contextRead: Promise<readonly DiscordInboundContextMessage[]> | undefined;
    const loadContextOnce = () => (contextRead ??= readDiscordContext(message, textIngressContextLimit));
    const result = await textIngress.handle({
      ...inbound,
      loadContextMessages: loadContextOnce,
    });
    if (result.state === "failed") {
      console.error(
        { deliveryId: message.id, channelId: message.channelId, code: result.code },
        "Discord text ingress failed",
      );
    } else if (result.state === "settled" || result.state === "waiting_user") {
      await recordReceipt("discord.text.reply", {
        deliveryId: message.id,
        ...(message.guildId === null ? {} : { guildId: message.guildId }),
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
      "Discord text ingress handler failed",
    );
  }
});

client.on("interactionCreate", async (interaction) => {
  if (shuttingDown || !interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction);
  } catch (error) {
    const message = sanitizeDiscordText(error instanceof Error ? error.message : String(error));
    if (interaction.deferred || interaction.replied)
      await interaction.editReply({
        content: `Command failed: ${message}`,
        allowedMentions: { parse: [] },
      });
    else
      await interaction.reply({
        content: `Command failed: ${message}`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
  }
});

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  // Everything lives under one `/clankie` namespace, so the dispatch key is the
  // subcommand. Guarding the top-level name first keeps an unrelated command
  // from ever reaching a case that assumes our option shape.
  if (interaction.commandName !== DISCORD_COMMAND_NAME) {
    await interaction.reply({ content: "Unknown command.", ephemeral: true });
    return;
  }
  switch (interaction.options.getSubcommand()) {
    case "status": {
      const response = await fetch(new URL("/health", apiUrl));
      await interaction.reply({
        content: response.ok
          ? "Clankie's service is healthy."
          : `Clankie's service returned ${response.status}.`,
        ephemeral: true,
      });
      return;
    }
    case "tools": {
      if (interaction.guildId === null) {
        await interaction.reply({
          content: "Tool activity cards are channel-scoped and unavailable in DMs.",
          ephemeral: true,
        });
        return;
      }
      if (ownerUserId === undefined || interaction.user.id !== ownerUserId) {
        await interaction.reply({
          content: "Only Clankie's owner can change tool activity visibility.",
          ephemeral: true,
        });
        return;
      }
      const mode = interaction.options.getString("mode", true);
      const current = (await settingsStore.load()).discord.toolProgressChannelIds.includes(
        interaction.channelId,
      );
      if (mode === "status") {
        await interaction.reply({
          content: `Tool activity cards are ${current ? "on" : "off"} in this channel.`,
          ephemeral: true,
        });
        return;
      }
      const enabled = mode === "on";
      await settingsStore.update((settings) => ({
        ...settings,
        discord: {
          ...settings.discord,
          toolProgressChannelIds: enabled
            ? [...new Set([...settings.discord.toolProgressChannelIds, interaction.channelId])]
            : settings.discord.toolProgressChannelIds.filter(
                (channelId) => channelId !== interaction.channelId,
              ),
        },
      }));
      await interaction.reply({
        content: `Tool activity cards are now ${enabled ? "on" : "off"} in this channel.`,
        ephemeral: true,
      });
      return;
    }
    case "person-memory": {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "Discord person memory is guild-scoped and is unavailable in DMs.",
          ephemeral: true,
        });
        return;
      }
      const authority = authorizeAmbientCommand(commandPrincipal(interaction), roleBindings);
      if (!authority.allowed) {
        await interaction.reply(authority.message);
        return;
      }
      const person = interaction.options.getUser("person", true);
      if (person.bot) {
        await interaction.reply({
          content: "Person memory is limited to human Discord identities.",
          ephemeral: true,
        });
        return;
      }
      const identity = { guildId: interaction.guildId, userId: person.id };
      const action = interaction.options.getString("action", true);
      if (action === "recall") {
        await interaction.deferReply({ ephemeral: true });
        const controlPlaneReadiness = await api.inspectDiscordReadiness();
        const projection = await api.recallDiscordPersonMemory(identity, {
          channelId: interaction.channelId,
          ...(interaction.options.getString("query") === null
            ? {}
            : { query: interaction.options.getString("query", true) }),
        });
        await interaction.editReply({
          content: renderDiscordPersonMemoryProjection(projection.facts, projection.recallCard),
          allowedMentions: { parse: [] },
        });
        if (projection.facts.length === 0) {
          await recordReceipt("discord.person-memory.recalled", {
            guildId: identity.guildId,
            userId: identity.userId,
            channelId: interaction.channelId,
            controlPlaneInstanceId: controlPlaneReadiness.instanceId,
            factCount: 0,
          });
        } else {
          for (const fact of projection.facts) {
            await recordReceipt("discord.person-memory.recalled", {
              guildId: identity.guildId,
              userId: identity.userId,
              channelId: interaction.channelId,
              controlPlaneInstanceId: controlPlaneReadiness.instanceId,
              factId: fact.factId,
              factCount: projection.facts.length,
            });
          }
        }
        return;
      }
      if (action !== "propose") {
        await interaction.reply({ content: "Unknown person-memory action.", ephemeral: true });
        return;
      }
      const body = interaction.options.getString("fact")?.trim();
      if (!body) {
        await interaction.reply({
          content: "The fact option is required when proposing person memory.",
          ephemeral: true,
        });
        return;
      }
      const occurredAt = new Date();
      const expiresDays = interaction.options.getInteger("expires-days");
      const visibility = interaction.options.getString("visibility") ?? "guild";
      const factId = `discord-person-fact-${randomUUID()}`;
      const proposalId = `discord-person-proposal-${randomUUID()}`;
      const controlPlaneReadiness = await api.inspectDiscordReadiness();
      await api.proposeDiscordPersonMemory({
        schemaVersion: 1,
        proposalId,
        fact: {
          schemaVersion: 1,
          factId,
          subject: identity,
          kind:
            (interaction.options.getString("kind") as
              | "person-fact"
              | "preference"
              | "relationship-note"
              | null) ?? "person-fact",
          body,
          visibility:
            visibility === "channel"
              ? { scope: "channel", channelId: interaction.channelId }
              : { scope: "guild" },
          provenance: {
            correlationId: `discord-interaction:${interaction.id}`,
            sourceEventId: interaction.id,
            sourceSurface: "discord_text",
            rawTranscript: false,
          },
          confidence: 1,
          createdAt: occurredAt.toISOString(),
          updatedAt: occurredAt.toISOString(),
          ...(expiresDays === null
            ? {}
            : {
                expiresAt: new Date(occurredAt.getTime() + expiresDays * 24 * 60 * 60 * 1_000).toISOString(),
              }),
          ...(interaction.options.getString("supersedes-fact-id") === null
            ? {}
            : {
                supersedesFactId: interaction.options.getString("supersedes-fact-id", true),
              }),
        },
      });
      await interaction.reply({
        content: `Stored fact **${sanitizeDiscordText(factId)}** in Clankie's long-term person memory.`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      await recordReceipt("discord.person-memory.proposed", {
        guildId: identity.guildId,
        userId: identity.userId,
        channelId: interaction.channelId,
        controlPlaneInstanceId: controlPlaneReadiness.instanceId,
        proposalId,
        factId,
      });
      return;
    }
    case "join": {
      const authority = authorizeVoicePresenceCommand(
        commandPrincipal(interaction),
        roleBindings,
        voiceJoinPolicy,
      );
      if (!authority.allowed) {
        await interaction.reply(authority.message);
        return;
      }
      if (voiceSession === undefined) {
        await interaction.reply({
          content: "Discord voice participation is disabled or brokered realtime voice is not ready.",
          ephemeral: true,
        });
        return;
      }
      const member = interaction.member instanceof GuildMember ? interaction.member : undefined;
      const channel = member?.voice.channel;
      if (!interaction.guild || !channel) {
        await interaction.reply({
          content: "Join a voice channel first, then invoke this command.",
          ephemeral: true,
        });
        return;
      }
      // An empty channel allowlist admits every voice channel in an allowlisted
      // guild. The guild check is never skipped, so this widens reach within
      // chosen servers rather than opening voice everywhere.
      const channelAllowed = voiceChannelIds.size === 0 || voiceChannelIds.has(channel.id);
      if (!voiceGuildIds.has(interaction.guild.id) || !channelAllowed) {
        await interaction.reply({
          content: "This guild voice channel is outside Clankie's configured voice allowlist.",
          ephemeral: true,
        });
        return;
      }
      // Ephemeral by owner decision: no bot-chatter in the text channel on
      // join — his public presence is sitting in the voice channel like
      // anyone else. The residency disclosure goes privately to the invoker
      // here and to every other participant in their own opt-in reply.
      await interaction.deferReply({ ephemeral: true });
      const current = voiceSession.status();
      // Joining the room Clankie already occupies is an opt-in, not a new
      // media session. Rebuilding here used to erase every other participant's
      // consent, transcript context, and floor state when a second person ran
      // the same command.
      const status =
        current.active && current.guildId === interaction.guild.id && current.channelId === channel.id
          ? await voiceSession.setConsent(interaction.guild.id, channel.id, interaction.user.id, true)
          : await voiceGateway!.join(interaction.guild, {
              channelId: channel.id,
              guildId: interaction.guild.id,
              invokingUserId: interaction.user.id,
            });
      await interaction.editReply({
        // Live-session audio residency (ADR 0057): the wording must never
        // promise per-turn discard.
        content: renderVoiceJoinDisclosure(
          status.daveProtocolVersion,
          voiceRealtimeConfig?.ttsProvider ?? "openai",
          voiceConsentPolicy,
          voiceRealtimeConfig?.realtimeProvider ?? "openai",
          voiceTranscriptLoggingEnabled,
        ),
        allowedMentions: { parse: [] },
      });
      return;
    }
    case "watch": {
      // The launch link is the activity plane's designed entry (ADR 0047): an
      // EMBEDDED_APPLICATION invite posted by the bot, not the client's
      // activity launcher. Same tier as join — who may put him on a stage is
      // who may point a camera at him.
      const authority = authorizeVoicePresenceCommand(
        commandPrincipal(interaction),
        roleBindings,
        voiceJoinPolicy,
      );
      if (!authority.allowed) {
        await interaction.reply(authority.message);
        return;
      }
      const member = interaction.member instanceof GuildMember ? interaction.member : undefined;
      const channel = member?.voice.channel;
      if (!interaction.guild || !channel) {
        await interaction.reply({
          content: "Join a voice channel first, then invoke this command.",
          ephemeral: true,
        });
        return;
      }
      const channelAllowed = voiceChannelIds.size === 0 || voiceChannelIds.has(channel.id);
      if (!voiceGuildIds.has(interaction.guild.id) || !channelAllowed) {
        await interaction.reply({
          content: "This guild voice channel is outside Clankie's configured voice allowlist.",
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply({ ephemeral: true });
      const health = await presencePort.getHealth();
      const write = DiscordPresenceWriteSchema.parse({
        schemaVersion: 1,
        // Deterministic per channel: a repeat within the dedup window returns
        // the already-posted link rather than piling up invites.
        idempotencyKey: `activity-start:gba:${channel.id}:v2`,
        action: "discord.presence.activity_start",
        identity: {
          presenceSessionId: `discord:${interaction.guild.id}:${channel.id}`,
          correlationId: `discord-activity-start:${channel.id}`,
          profileHash: health.profileHash,
          characterId,
          credentialRef: "discord_bot",
          transportKind: "bot",
        },
        payload: {
          kind: "activity_start",
          guildId: interaction.guild.id,
          channelId: channel.id,
          surface: "gba_emulator",
        },
      });
      try {
        await presencePort.executeDiscordPresenceAction(write);
        await interaction.editReply({
          content: "Launch link posted in the voice channel's chat — click it to open the watch surface.",
          allowedMentions: { parse: [] },
        });
      } catch (error) {
        // Surface the refusal reason rather than pretending the link went out.
        const message = sanitizeDiscordText(error instanceof Error ? error.message : String(error));
        await interaction.editReply({
          content: `The launch was not posted: ${message}`,
          allowedMentions: { parse: [] },
        });
      }
      return;
    }
    case "voice-consent": {
      if (voiceSession === undefined) {
        await interaction.reply({
          content: "Discord voice participation is disabled or brokered realtime voice is not ready.",
          ephemeral: true,
        });
        return;
      }
      const member = interaction.member instanceof GuildMember ? interaction.member : undefined;
      const channel = member?.voice.channel;
      if (!interaction.guild || !channel) {
        await interaction.reply({
          content: "Join Clankie's active voice channel before changing consent.",
          ephemeral: true,
        });
        return;
      }
      const activeStatus = voiceSession.status();
      if (activeStatus.guildId !== interaction.guild.id || activeStatus.channelId !== channel.id) {
        await interaction.reply({
          content: "Join Clankie's active voice channel before changing consent.",
          ephemeral: true,
        });
        return;
      }
      const consented = interaction.options.getString("action", true) === "opt-in";
      const status = await voiceSession.setConsent(
        interaction.guild.id,
        channel.id,
        interaction.user.id,
        consented,
      );
      await interaction.reply({
        // Opt-in is where consent is actually granted, so the residency
        // disclosure travels in this private reply (the join disclosure was
        // only ever shown to the invoker).
        content: renderVoiceConsentReply(
          consented,
          status.consentedParticipantCount,
          voiceRealtimeConfig?.ttsProvider ?? "openai",
          voiceConsentPolicy,
          voiceRealtimeConfig?.realtimeProvider ?? "openai",
          voiceTranscriptLoggingEnabled,
        ),
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    case "voice-status": {
      await interaction.reply({
        content: renderVoiceStatusReply(
          voiceSession?.status(),
          voiceEnabled,
          voiceConsentPolicy,
          voiceRealtimeConfig?.realtimeProvider ?? "openai",
          voiceTranscriptLoggingEnabled,
        ),
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    case "leave": {
      const authority = authorizeVoicePresenceCommand(
        commandPrincipal(interaction),
        roleBindings,
        voiceJoinPolicy,
      );
      if (!authority.allowed) {
        await interaction.reply(authority.message);
        return;
      }
      // An open join policy must not let a member of one allowlisted guild hang
      // up a call happening in another. Under the ambient policy the role
      // binding is already guild-scoped, so this bound only ever matters for
      // `guild_members` — but stating it here keeps the rule in one place.
      const active = voiceSession?.status();
      if (active?.active === true && active.guildId !== interaction.guildId) {
        await interaction.reply({
          content: "Clankie's active voice session is in another server.",
          ephemeral: true,
        });
        return;
      }
      await voiceGateway?.leave();
      await interaction.reply({ content: "Left the voice channel.", ephemeral: true });
      return;
    }
    default:
      await interaction.reply({ content: "Unknown command.", ephemeral: true });
  }
}

async function executeCaptainVoicePresence(
  action: VoicePresenceControlAction,
  input: VoicePresenceControlInput,
) {
  const target = await resolveVoicePresenceControlTarget(action, input);
  if ("reason" in target) {
    return {
      action: action === "join" ? ("join_refused" as const) : ("leave_refused" as const),
      reason: target.reason,
    };
  }
  const result = await executeVoicePresenceIntent(
    {
      bindings: roleBindings,
      joinPolicy: voiceJoinPolicy,
      voiceGuildIds,
      voiceChannelIds,
      voiceSession:
        voiceSession === undefined || voiceGateway === undefined
          ? undefined
          : {
              status: () => voiceSession.status(),
              canHear: (userId) => voiceSession.canHear(userId),
              join: (joinInput) => voiceGateway.join(target.guild, joinInput),
              leave: () => voiceGateway.leave(),
            },
      transcriptLoggingEnabled: voiceTranscriptLoggingEnabled,
    },
    {
      intent: action,
      guildId: target.guildId,
      principal: { userId: target.actorId, roleIds: new Set(target.member.roles.cache.keys()) },
      memberVoiceChannelId: target.member.voice.channelId ?? undefined,
    },
  );
  console.info(
    {
      action,
      guildId: target.guildId,
      actorId: target.actorId,
      outcome: result.action,
      ...(result.action === "join_refused" || result.action === "leave_refused"
        ? { reason: result.reason }
        : {}),
    },
    "Captain voice presence tool",
  );
  return result;
}

async function resolveVoicePresenceControlTarget(
  action: VoicePresenceControlAction,
  input: VoicePresenceControlInput,
): Promise<
  | {
      readonly guildId: string;
      readonly actorId: string;
      readonly guild: Guild;
      readonly member: GuildMember;
    }
  | { readonly reason: "failed" | "no_owner" | "not_in_voice" | "ambiguous" }
> {
  if (input.guildId !== undefined || input.actorId !== undefined) {
    if (input.guildId === undefined || input.actorId === undefined) return { reason: "failed" };
    const located = await locateVoiceMember(input.guildId, input.actorId);
    return located ?? { reason: "failed" };
  }
  const ownerUserId = process.env.DISCORD_OWNER_USER_ID?.trim();
  if (ownerUserId === undefined || ownerUserId.length === 0) return { reason: "no_owner" };
  if (action === "leave") {
    const active = voiceSession?.status();
    const preferred = active?.active === true ? active.guildId : undefined;
    const guildIdsToTry =
      preferred !== undefined && voiceGuildIds.has(preferred)
        ? [preferred, ...[...voiceGuildIds].filter((id) => id !== preferred)]
        : [...voiceGuildIds];
    for (const guildId of guildIdsToTry) {
      const located = await locateVoiceMember(guildId, ownerUserId);
      if (located !== undefined) return located;
    }
    return { reason: "failed" };
  }
  const candidates: {
    guildId: string;
    channelId: string;
    located: Awaited<ReturnType<typeof locateVoiceMember>>;
  }[] = [];
  for (const guild of client.guilds.cache.values()) {
    if (!voiceGuildIds.has(guild.id)) continue;
    const located = await locateVoiceMember(guild.id, ownerUserId);
    const channelId = located?.member.voice.channelId;
    if (located === undefined || channelId === undefined || channelId === null) continue;
    if (voiceChannelIds.size > 0 && !voiceChannelIds.has(channelId)) continue;
    candidates.push({ guildId: guild.id, channelId, located });
  }
  const follow = resolveOwnerFollowTarget(
    candidates.map(({ guildId, channelId }) => ({ guildId, channelId })),
    voiceSession?.status(),
  );
  if (follow.outcome === "none") return { reason: "not_in_voice" };
  if (follow.outcome === "ambiguous") return { reason: "ambiguous" };
  const match = candidates.find(
    (candidate) => candidate.guildId === follow.guildId && candidate.channelId === follow.channelId,
  );
  return match?.located ?? { reason: "failed" };
}

async function locateVoiceMember(
  guildId: string,
  actorId: string,
): Promise<{ guildId: string; actorId: string; guild: Guild; member: GuildMember } | undefined> {
  const guild = client.guilds.cache.get(guildId);
  const member =
    guild === undefined
      ? undefined
      : (guild.members.cache.get(actorId) ?? (await guild.members.fetch(actorId).catch(() => undefined)));
  if (guild === undefined || member === undefined) return undefined;
  return { guildId, actorId, guild, member };
}

async function executeCaptainDiscordAction(
  input: DiscordCaptainActionInput,
): Promise<DiscordCaptainActionResult> {
  if (input.guildId === undefined) {
    return { ok: false, message: "That Discord action is not available in DMs." };
  }
  let channelId = input.channelId;
  let plan = planNonWatchCaptainDiscordAction(input);
  if (plan !== undefined) {
    if (
      input.action === "tool_progress" &&
      input.progressMessageId !== undefined &&
      !toolProgressMessageIds.has(input.progressMessageId)
    ) {
      return { ok: false, message: "That tool activity card does not belong to this process." };
    }
    if (
      !ingressGuildIds.has(input.guildId) ||
      (ingressChannelIds.size > 0 && !ingressChannelIds.has(input.channelId))
    ) {
      return {
        ok: false,
        message:
          input.action === "react" || input.action === "unreact"
            ? "That message is outside my admitted Discord channels."
            : input.action === "send_text_update" || input.action === "tool_progress"
              ? "That channel is outside my admitted Discord channels."
              : "Threads only work in my admitted server channels.",
      };
    }
  } else {
    const guild = client.guilds.cache.get(input.guildId);
    const member =
      guild === undefined
        ? undefined
        : (guild.members.cache.get(input.actorId) ??
          (await guild.members.fetch(input.actorId).catch(() => undefined)));
    if (
      guild === undefined ||
      member === undefined ||
      !authorizeVoicePresenceCommand(
        { userId: input.actorId, roleIds: new Set(member.roles.cache.keys()) },
        roleBindings,
        voiceJoinPolicy,
      ).allowed
    ) {
      return { ok: false, message: "You aren't allowed to put my play surface in voice." };
    }
    channelId = member.voice.channelId ?? "";
    const active = voiceSession?.status();
    if (
      channelId.length === 0 ||
      !voiceGuildIds.has(input.guildId) ||
      (voiceChannelIds.size > 0 && !voiceChannelIds.has(channelId)) ||
      active?.active !== true ||
      active.guildId !== input.guildId ||
      active.channelId !== channelId
    ) {
      return { ok: false, message: "I need to be in your admitted voice channel first." };
    }
    plan = {
      action:
        input.action === "watch_start" ? "discord.presence.activity_start" : "discord.presence.activity_stop",
      payload:
        input.action === "watch_start"
          ? { kind: "activity_start", guildId: input.guildId, channelId, surface: "gba_emulator" }
          : { kind: "activity_stop", guildId: input.guildId, channelId },
      successMessage:
        input.action === "watch_start"
          ? "I posted the live play launch in voice."
          : "I stopped offering the live play launch.",
    };
  }

  try {
    const health = await presencePort.getHealth();
    const action = await presencePort.executeDiscordPresenceAction(
      DiscordPresenceWriteSchema.parse({
        schemaVersion: 1,
        idempotencyKey: `captain:${input.callId}:${input.action}`,
        action: plan.action,
        identity: {
          presenceSessionId: discordPresenceLaneAddress({ guildId: input.guildId, channelId }),
          correlationId: `discord-captain-action:${input.callId}`,
          profileHash: health.profileHash,
          characterId,
          credentialRef: "discord_bot",
          transportKind: "bot",
        },
        payload: plan.payload,
      }),
    );
    if (input.action === "tool_progress") {
      if (action.messageId !== undefined) toolProgressMessageIds.add(action.messageId);
      if (input.phase !== "running" && input.progressMessageId !== undefined) {
        toolProgressMessageIds.delete(input.progressMessageId);
      }
    }
    return {
      ok: true,
      message: plan.successMessage,
      ...(action.messageId === undefined ? {} : { messageId: action.messageId }),
    };
  } catch (error) {
    return {
      ok: false,
      message: `My Discord body refused that action: ${sanitizeDiscordText(
        error instanceof Error ? error.message : String(error),
      )}`,
    };
  }
}

function memberRoleIds(interaction: ChatInputCommandInteraction): ReadonlySet<string> {
  if (interaction.member instanceof GuildMember) return new Set(interaction.member.roles.cache.keys());
  const roles = interaction.member?.roles;
  return new Set(Array.isArray(roles) ? roles : []);
}

function commandPrincipal(interaction: ChatInputCommandInteraction): DiscordCommandPrincipal {
  return { userId: interaction.user.id, roleIds: memberRoleIds(interaction) };
}

function renderDiscordPersonMemoryProjection(
  facts: readonly { factId: string; kind: string; body: string; confidence: number }[],
  recallCard: string | undefined,
): string {
  if (recallCard !== undefined) return sanitizeDiscordText(recallCard).slice(0, 1_900);
  if (facts.length === 0) return "No visible approved facts are stored for this person in the current scope.";
  return facts
    .slice(0, 12)
    .map(
      (fact) =>
        `• ${sanitizeDiscordText(fact.factId)} · ${sanitizeDiscordText(fact.kind)} · ${fact.confidence.toFixed(2)} — ${sanitizeDiscordText(fact.body)}`,
    )
    .join("\n")
    .slice(0, 1_900);
}

function parseContextMessageLimit(value: string | undefined): number {
  const parsed = Number(value ?? "10");
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 50) {
    throw new Error("DISCORD_INGRESS_CONTEXT_MESSAGES must be an integer from 0 to 50");
  }
  return parsed;
}

async function readDiscordContext(
  message: Message,
  limit: number,
): Promise<readonly DiscordInboundContextMessage[]> {
  if (limit === 0) return [];
  const messages = await message.channel.messages.fetch({ before: message.id, limit });
  return [...messages.values()]
    .sort((left, right) => left.createdTimestamp - right.createdTimestamp)
    .map((candidate) => {
      const selection = selectDiscordMessageImages(candidate);
      return {
        id: candidate.id,
        authorId: candidate.author.id,
        body: candidate.content,
        createdAt: candidate.createdAt.toISOString(),
        attachments: selection.attachments,
        ...(selection.omitted === 0 ? {} : { attachmentsOmitted: selection.omitted }),
      };
    });
}

function selectDiscordMessageImages(message: Message) {
  return selectInboundImageAttachments(
    [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      url: attachment.url,
      contentType: attachment.contentType,
      filename: attachment.name,
      size: attachment.size,
    })),
    message.embeds.map((embed) => ({
      ...(embed.data.type === undefined ? {} : { type: embed.data.type }),
      ...(embed.url === null ? {} : { url: embed.url }),
      ...(embed.thumbnail === null ? {} : { thumbnailUrl: embed.thumbnail.url }),
      ...(embed.thumbnail?.proxyURL === undefined ? {} : { thumbnailProxyUrl: embed.thumbnail.proxyURL }),
      ...(embed.video === null ? {} : { videoUrl: embed.video.url }),
      ...(embed.video?.proxyURL === undefined ? {} : { videoProxyUrl: embed.video.proxyURL }),
    })),
  );
}

function bridgeReceiptPath(): string {
  const configured = process.env.DISCORD_BRIDGE_RECEIPT_PATH;
  if (configured) {
    const fromWorkspace = relative(process.cwd(), configured);
    if (
      !isAbsolute(configured) ||
      fromWorkspace === "" ||
      (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace))
    ) {
      throw new Error("DISCORD_BRIDGE_RECEIPT_PATH must be absolute and outside the repository workspace");
    }
    return configured;
  }
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  if (!isAbsolute(stateHome)) throw new Error("XDG_STATE_HOME must be absolute");
  return join(stateHome, "clankie", "discord-live-receipts.jsonl");
}

function recordReceipt(
  type: DiscordBridgeReceiptType,
  data: DiscordBridgeReceipt["data"],
): Promise<DiscordBridgeReceipt> {
  return receipts.append(type, data).catch((error) => {
    console.error(
      { type, error: error instanceof Error ? error.message : String(error) },
      "Discord live receipt append failed",
    );
    throw error;
  });
}

async function recordVoiceEvidence(evidence: DiscordVoiceEvidence): Promise<void> {
  // The idle auto-leave watches the same stream the receipts do, so "activity"
  // is exactly what the evidence says happened.
  voiceIdleAutoLeave?.observe(evidence);
  // Play authors for its own surfaces until it learns it has an audience
  // (ADR 0074). These two transitions are the whole of "is anyone listening",
  // and they are already the authority the idle watcher trusts.
  if (evidence.type === "joined" || evidence.type === "left") {
    playVoiceListener?.publishRoom({ listening: evidence.type === "joined" });
  }
  if (evidence.type === "response") {
    // Printed as well as recorded: "it felt slow" is only actionable next to
    // the per-stage split, and an operator should see it without opening the
    // receipt file.
    console.info(describeVoiceResponse(evidence));
  }
  await recordReceipt(voiceEvidenceReceiptType(evidence), voiceEvidenceReceiptData(evidence));
}

function reportPresencePhaseFailure(error: unknown): void {
  console.error(
    { error: error instanceof Error ? error.message : String(error) },
    "Discord presence phase publication failed",
  );
}

let shutdownPromise: Promise<void> | undefined;
let musicControlServer: ReturnType<typeof createServer> | undefined;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shutdownPromise = (async () => {
    await shutdownDiscordBridge({
      stopIngress: async () => {
        shuttingDown = true;
        voiceIdleAutoLeave?.stop();
        if (membershipSyncTimer !== undefined) clearTimeout(membershipSyncTimer);
        if (catchUpTimer !== undefined) clearInterval(catchUpTimer);
        await Promise.all([
          (async () => {
            stopPlayVoiceTranscript?.();
            stopPlayVoiceTranscript = undefined;
            await playVoiceListener?.close();
          })(),
          new Promise<void>((resolve) => {
            if (musicControlServer?.listening !== true) return resolve();
            musicControlServer.close(() => resolve());
          }),
        ]);
      },
      leaveVoice: () =>
        voiceGateway?.leave("bridge_shutdown") ?? voiceSession?.leave("bridge_shutdown") ?? Promise.resolve(),
      disposeVoiceSession: () => voiceSession?.dispose() ?? Promise.resolve(),
      disposeVoiceGateway: () => voiceGateway?.dispose(),
      closeVox: () => vox?.close(),
      destroyDiscord: () => client.destroy(),
      stopPresence: async () => {
        await presenceSession.stop();
      },
      recordStopped: async () => {
        await recordReceipt("discord.bridge.stopped", { signal });
      },
    });
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).catch((error) => {
      console.error(
        { signal, error: error instanceof Error ? error.message : String(error) },
        "Discord bridge shutdown failed",
      );
      process.exitCode = 1;
    });
  });
}

/**
 * He glances at channels that piled up while he was not reading them.
 *
 * A tick with nothing waiting returns without a turn, so an idle server costs
 * nothing — the interval is an upper bound on how stale a backlog gets, not a
 * poll. Unref'd so it never holds the process open on its own, and serialized
 * by awaiting the previous pass, because a slow catch-up must not stack.
 */
if (textIngress !== undefined) {
  let catchingUp = false;
  catchUpTimer = setInterval(() => {
    if (catchingUp) return;
    catchingUp = true;
    void textIngress
      .catchUp()
      .catch((error: unknown) => {
        console.error(
          { errorName: error instanceof Error ? error.name.slice(0, 64) : "Error" },
          "Discord catch-up pass failed",
        );
      })
      .finally(() => {
        catchingUp = false;
      });
  }, CATCH_UP_INTERVAL_MS[storedSettings.persona.chattiness]);
  catchUpTimer.unref();
}

const musicControlPort = Number.parseInt(process.env.CLANKIE_DISCORD_BRIDGE_CONTROL_PORT ?? "4313", 10);
const musicServer = createServer((request, response) => {
  const url = request.url ?? "/";
  if (request.method === "GET" && (url === "/" || url === "/health")) {
    const health = discordBridgeHealth({
      discordReady: client.isReady(),
      shuttingDown,
      ...(terminalFailure === undefined ? {} : { terminalFailure }),
      voiceEnabled,
      ...(vox === undefined ? {} : { vox }),
    });
    response.writeHead(health.ok ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(health));
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
musicControlServer = musicServer;
await new Promise<void>((resolve, reject) => {
  musicServer.once("error", reject);
  musicServer.listen(musicControlPort, "127.0.0.1", () => resolve());
});

await presenceSession.start().catch(reportPresencePhaseFailure);
await client.login(token);
