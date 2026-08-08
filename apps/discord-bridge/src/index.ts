import { ClankieApiClient } from "@clankie/api-client";
import {
  createDefaultCredentialStore,
  DISCORD_BOT_PROVIDER_ID,
  ensurePossessorVoiceCredential,
  resolveDiscordBridgeCredential,
  resolveDiscordVoiceBridgeCredential,
} from "@clankie/credential-broker";
import {
  createPossessorVoiceListener,
  POSSESSOR_VOICE_DEFAULT_PORT,
  POSSESSOR_VOICE_PATH,
} from "@clankie/possessor-voice";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import {
  Client,
  GatewayIntentBits,
  GuildMember,
  Partials,
  REST,
  Routes,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import {
  authorizeAmbientCommand,
  authorizeVoicePresenceCommand,
  parseDiscordVoiceJoinPolicy,
  parseRoleIds,
  refuseAmbientApproval,
  type DiscordCommandPrincipal,
  type DiscordRoleBindings,
} from "./authority.ts";
import {
  CATCH_UP_INTERVAL_MS,
  createAdvertisedDiscordPresencePort,
  DiscordBridgeReceiptStore,
  DiscordPresenceSession,
  DiscordTextIngress,
  DiscordVoiceIngress,
  DiscordVoiceSession,
  parseDiscordDmPolicy,
  parseDiscordIdSet,
  selectInboundImageAttachments,
  type DiscordBridgeReceipt,
  type DiscordInboundContextMessage,
} from "@clankie/discord-presence-core";
import { DiscordPresenceWriteSchema, type DiscordVoiceEvidence } from "@clankie/protocol";
import {
  applyDiscordSettingsToEnvironment,
  applyVoiceSettingsToEnvironment,
  characterNames,
  SettingsStore,
} from "@clankie/settings";
import { commands, DISCORD_COMMAND_NAME, DISCORD_SUBCOMMANDS } from "./commands.ts";
import {
  createVoiceBriefingProvider,
  createVoiceRealtimePorts,
  createVoiceVolitionDecider,
  describeVoiceResponse,
  parseVoiceRealtimeEnv,
  renderVoiceConsentReply,
  renderVoiceJoinDisclosure,
  renderVoiceStatusReply,
  VoiceIdleAutoLeave,
  voiceEvidenceReceiptData,
  voiceEvidenceReceiptType,
} from "./voice-composition.ts";
import {
  createVoicePresenceIntentDecider,
  handleVoicePresenceAsk,
  VoicePresenceRetryWindow,
  type VoicePresenceAskOptions,
  type VoicePresenceMember,
} from "./voice-intent.ts";
import { projectBoundMissionRecord, renderMissionSummary, sanitizeDiscordText } from "./mission-state.ts";
import { MissionThreadProjector } from "./projector.ts";
import {
  issueMissionSteering,
  renderMissionSteeringReply,
  workerSteerIntentForDiscordChoice,
} from "./steering.ts";
import { MissionThreadRegistry, ZERO_RETENTION_STATUS, threadNameForMission } from "./thread-registry.ts";

// Fill unset DISCORD_* names from the operator settings file before anything
// reads them, so TUI-configured deployments need no .env. Deliberately ahead of
// the token guards below: settings hold non-secret values only, and running the
// guards afterwards means a token-shaped value that ever reached the settings
// schema by mistake would still be caught here rather than used.
const storedSettings = await new SettingsStore().load();
const settingsFilledNames = [
  ...applyDiscordSettingsToEnvironment(storedSettings.discord),
  ...applyVoiceSettingsToEnvironment(storedSettings.voice),
];

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
    "The brokered clankie_discord_bridge credential is missing. Start the control plane once before the Discord bridge.",
  );
}
const voiceBridgeToken = voiceEnabled
  ? await resolveDiscordVoiceBridgeCredential({ store: credentialStore })
  : undefined;
if (voiceEnabled && voiceBridgeToken === undefined) {
  throw new Error(
    "The brokered clankie_discord_voice_bridge credential is missing. Restart the control plane before enabling Discord voice.",
  );
}
if (voiceEnabled && process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY must not be set. Reuse the brokered openai credential.");
}
if (voiceEnabled && (process.env.ELEVENLABS_API_KEY ?? process.env.XI_API_KEY)) {
  throw new Error(
    "ELEVENLABS_API_KEY and XI_API_KEY must not be set. Store the ElevenLabs key under the brokered elevenlabs provider.",
  );
}
const authenticatedSurfaceUrl =
  process.env.CLANKIE_AUTHENTICATED_SURFACE_URL ?? "http://127.0.0.1:4311/approvals";
const api = new ClankieApiClient({ baseUrl: apiUrl, captainToken: bridgeToken });
const voiceApi =
  voiceBridgeToken === undefined
    ? undefined
    : new ClankieApiClient({ baseUrl: apiUrl, captainToken: voiceBridgeToken });
const characterId = process.env.CLANKIE_CHARACTER_ID ?? "clankie";
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
  ambientRoleIds: parseRoleIds(process.env.DISCORD_AMBIENT_ROLE_IDS),
  ambientUserIds: parseRoleIds(process.env.DISCORD_AMBIENT_USER_IDS),
  approvalRoleIds: parseRoleIds(process.env.DISCORD_APPROVAL_ROLE_IDS),
};
const voiceJoinPolicy = parseDiscordVoiceJoinPolicy(process.env.DISCORD_VOICE_JOIN_POLICY);
const receipts = new DiscordBridgeReceiptStore({
  path: bridgeReceiptPath(),
});
const textIngressEnabled = process.env.DISCORD_TEXT_INGRESS_ENABLED === "true";
const textIngressContextLimit = parseContextMessageLimit(process.env.DISCORD_INGRESS_CONTEXT_MESSAGES);
const ingressGuildIds = parseDiscordIdSet(process.env.DISCORD_INGRESS_GUILD_IDS);
const ingressChannelIds = parseDiscordIdSet(process.env.DISCORD_INGRESS_CHANNEL_IDS);
// One advertised port for every bridge-side presence write: text ingress
// replies and the slash-invoked activity launch go through the same live-claim
// and tool-exposure guards.
const presencePort = createAdvertisedDiscordPresencePort(api, presenceSession);
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
const openAiCredential = voiceEnabled ? await credentialStore.get("openai") : undefined;
if (voiceEnabled && openAiCredential?.type !== "api") {
  throw new Error(
    "Discord voice requires the existing brokered openai API credential; OAuth and environment credentials are not accepted by the realtime boundary.",
  );
}
// Validated at startup like the rest of the env: truncation and idle auto-leave
// are always configured, never defaulted to unbounded (ADR 0057, mission T6).
const voiceRealtimeConfig = voiceEnabled ? parseVoiceRealtimeEnv(process.env) : undefined;
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
const voiceSession =
  openAiCredential?.type !== "api" || voiceApi === undefined || voiceRealtimeConfig === undefined
    ? undefined
    : new DiscordVoiceSession({
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
          return [...channel.members.keys()].filter((userId) => userId !== client.user?.id);
        },
        realtime: createVoiceRealtimePorts({
          apiKey: openAiCredential.key,
          ...(elevenLabsCredential?.type === "api" ? { elevenLabsApiKey: elevenLabsCredential.key } : {}),
          config: voiceRealtimeConfig,
        }),
        briefing: createVoiceBriefingProvider(voiceApi),
        floor: {
          // Persona owns who he is and when he speaks; the bridge only carries it.
          names: characterNames(storedSettings.persona),
          replyPolicy: storedSettings.persona.replyPolicy,
          chattiness: storedSettings.persona.chattiness,
          decayWindowMs: voiceRealtimeConfig.decayWindowMs,
        },
        volitionDecider: createVoiceVolitionDecider({
          apiKey: openAiCredential.key,
          model: voiceRealtimeConfig.volitionModel,
        }),
        presenceSessionId: () => presenceSession.record.sessionId,
        emit: recordVoiceEvidence,
      });
const voiceIdleAutoLeave =
  voiceSession === undefined || voiceRealtimeConfig === undefined
    ? undefined
    : new VoiceIdleAutoLeave({
        idleLeaveMs: voiceRealtimeConfig.idleLeaveMs,
        isActive: () => voiceSession.status().active,
        leave: () => voiceSession.leave(),
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
// The possessor voice seam (ADR 0064): a harness driving Clankie's GBA body
// reports what it just did, and he commentates it in his own voice. Off by
// default and composed only when he actually has a voice — with no realtime
// session there is nothing for a report to reach, so the listener never binds
// and a possessor's `clankie_say` refuses with a reason.
const possessorVoiceListener =
  process.env["CLANKIE_POSSESSOR_VOICE_ENABLED"] === "true" && voiceSession !== undefined
    ? createPossessorVoiceListener({
        // The bridge owns the listener, so the bridge owns the mint; a
        // possessor only ever resolves.
        token: await ensurePossessorVoiceCredential(),
        narrate: (text) => voiceSession.narrate(text),
        emit: (evidence) => recordVoiceEvidence(evidence),
        // Read at attach time so a play loop that starts mid-call learns the
        // room immediately instead of waiting for the next join or leave.
        room: () => ({ listening: voiceSession.status().active }),
      })
    : undefined;
if (possessorVoiceListener !== undefined && voiceSession !== undefined) {
  const port = await possessorVoiceListener.listen(
    Number(process.env["CLANKIE_POSSESSOR_VOICE_PORT"] ?? POSSESSOR_VOICE_DEFAULT_PORT),
  );
  // Hearing is push-only, so the bridge starts retaining nothing new: lines
  // that already passed the consent boundary are handed on as they happen.
  voiceSession.subscribeTranscript((line) => possessorVoiceListener.publishUtterance(line));
  console.info(
    { port, path: POSSESSOR_VOICE_PATH },
    "Discord bridge possessor voice seam listening on loopback",
  );
}
// Asked voice presence (ADR 0062): "clankie hop in vc" in an admitted text
// channel moves him under exactly the slash tier, executed here at the ingress
// boundary before the same message's captain turn. Composed only when both
// text ingress and brokered realtime voice exist — without voice there is no
// decider budget and nothing to execute, so the gate machinery never runs.
const voicePresenceAsk: VoicePresenceAskOptions | undefined =
  textIngress === undefined || openAiCredential?.type !== "api" || voiceRealtimeConfig === undefined
    ? undefined
    : {
        gate: {
          ingressGuildIds,
          ingressChannelIds,
          characterNames: characterNames(storedSettings.persona),
        },
        decider: createVoicePresenceIntentDecider({
          apiKey: openAiCredential.key,
          model: voiceRealtimeConfig.volitionModel,
        }),
        execution: {
          bindings: roleBindings,
          joinPolicy: voiceJoinPolicy,
          voiceGuildIds,
          voiceChannelIds,
          voiceSession,
        },
        // A refused not-in-voice join listens briefly for the asker's
        // follow-up, so "try now" from inside voice retries instead of
        // making them repeat the ask.
        retry: new VoicePresenceRetryWindow(),
        // Content-free by construction (ids, booleans, enums — never the body).
        onTrace: (trace) => console.info(trace, "Discord voice presence ask"),
      };
const registry = new MissionThreadRegistry({
  statePath: bridgeStatePath(),
});
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
const projector = new MissionThreadProjector(
  registry,
  api,
  {
    async send(threadId, message) {
      const channel = await client.channels.fetch(threadId);
      const binding = registry.bindings().find((candidate) => candidate.threadId === threadId);
      if (!channel?.isThread() || !binding || channel.guildId !== binding.guildId) {
        throw new Error(`Discord mission thread ${threadId} is unavailable or outside its trusted guild`);
      }
      await channel.send({ content: message, allowedMentions: { parse: [] } });
    },
  },
  pollInterval(),
  (error, missionId) => {
    console.error({ missionId, error }, "Discord mission projection refresh failed");
  },
);

client.once("ready", async () => {
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

  for (const binding of registry.bindings()) {
    const channel = await client.channels.fetch(binding.threadId).catch(() => undefined);
    if (!channel?.isThread() || channel.guildId !== binding.guildId) {
      console.error(
        { missionId: binding.missionId, threadId: binding.threadId, guildId: binding.guildId },
        "Persisted Discord mission binding does not match an active guild thread",
      );
      continue;
    }
    await recordReceipt("discord.mission.restored", {
      missionId: binding.missionId,
      threadId: binding.threadId,
      guildId: binding.guildId,
    });
  }
  projector.start();
  await recordReceipt("discord.bridge.ready", {
    // The registered command count is always 1 now; the useful number for an
    // operator checking what landed is how many subcommands it carries.
    commandCount: DISCORD_SUBCOMMANDS.length,
    restoredMissionCount: registry.entries().length,
    textIngressEnabled,
    voiceEnabled,
    settingsFilledCount: settingsFilledNames.length,
  });
  if (settingsFilledNames.length > 0) {
    // Which knobs came from the settings file rather than the shell. Silent
    // configuration provenance is exactly what wastes an hour of debugging.
    console.info({ names: settingsFilledNames }, "Discord configuration filled from operator settings");
  }
  console.log(
    `Discord bot ready as ${client.user?.tag ?? "unknown"}; registered /${DISCORD_COMMAND_NAME} with ${DISCORD_SUBCOMMANDS.length} subcommands, restored ${registry.entries().length} mission thread(s), text ingress ${textIngressEnabled ? "enabled" : "disabled"}, voice ${voiceEnabled ? "enabled" : "disabled"}.`,
  );
});

client.on("shardReady", () => {
  void presenceSession.gatewayReady().catch(reportPresencePhaseFailure);
});

client.on("shardResume", () => {
  void presenceSession.gatewayResumed().catch(reportPresencePhaseFailure);
});

client.on("shardReconnecting", () => {
  void presenceSession.gatewayReconnecting().catch(reportPresencePhaseFailure);
});

client.on("shardDisconnect", () => {
  void presenceSession.gatewayDisconnected().catch(reportPresencePhaseFailure);
});

client.on("invalidated", () => {
  void presenceSession.fail().catch(reportPresencePhaseFailure);
});

client.on("voiceStateUpdate", (previous, current) => {
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
      void activeVoiceSession.leave().catch((error) => {
        console.error(
          { error: error instanceof Error ? error.message : String(error) },
          "Discord voice session failed to close after a bot channel move",
        );
      });
    }
  }
});

client.on("messageCreate", async (message) => {
  if (!textIngress) return;
  try {
    const selection = selectInboundImageAttachments(
      [...message.attachments.values()].map((attachment) => ({
        id: attachment.id,
        url: attachment.url,
        contentType: attachment.contentType,
        filename: attachment.name,
        size: attachment.size,
      })),
    );
    const inbound = {
      id: message.id,
      ...(message.guildId === null ? {} : { guildId: message.guildId }),
      channelId: message.channelId,
      authorId: message.author.id,
      authorIsBot: message.author.bot || message.author.id === client.user?.id,
      mentionsBot: client.user !== null && message.mentions.users.has(client.user.id),
      body: message.content,
      attachments: selection.attachments,
      attachmentsOmitted: selection.omitted,
    };
    // One context fetch per message at most, shared by the ask's decider and
    // the captain turn — whichever reads first pays for both.
    let contextRead: Promise<readonly DiscordInboundContextMessage[]> | undefined;
    const loadContextOnce = () => (contextRead ??= readDiscordContext(message, textIngressContextLimit));
    // Decided and executed before the turn, and awaited, so his reply in the
    // same exchange reflects reality: he is the voice, the bridge is the
    // actor (ADR 0062). A closed gate resolves immediately at no cost.
    const voicePresenceNote =
      voicePresenceAsk === undefined
        ? undefined
        : await handleVoicePresenceAsk(
            voicePresenceAsk,
            {
              ...inbound,
              // Read before the ingress turn touches its counters, so this is
              // his engagement as of when the message arrived.
              engagedInChannel: textIngress.engagedInChannel(message.channelId),
              loadContext: async () =>
                (await loadContextOnce()).map((line) => ({
                  speaker:
                    line.authorId === client.user?.id
                      ? ("clankie" as const)
                      : line.authorId === message.author.id
                        ? ("asker" as const)
                        : ("other" as const),
                  body: line.body,
                })),
            },
            () => resolveVoiceMember(message),
          );
    const result = await textIngress.handle({
      ...inbound,
      ...(voicePresenceNote === undefined ? {} : { voicePresenceNote }),
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
  if (!interaction.isChatInputCommand()) return;
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
      const missionId = missionIdForInteraction(interaction);
      if (missionId) {
        await interaction.deferReply();
        const mission = projectBoundMissionRecord(await api.getMission(missionId), missionId);
        await interaction.editReply({
          content: renderMissionSummary(mission),
          allowedMentions: { parse: [] },
        });
        return;
      }
      const response = await fetch(new URL("/health", apiUrl));
      await interaction.reply({
        content: response.ok
          ? "Captain control plane is healthy. Run this command inside a Clankie mission thread for mission state."
          : `Control plane returned ${response.status}.`,
        ephemeral: true,
      });
      return;
    }
    case "mission": {
      const authority = authorizeAmbientCommand(commandPrincipal(interaction), roleBindings);
      if (!authority.allowed) {
        await interaction.reply(authority.message);
        return;
      }
      if (!interaction.inGuild() || interaction.channel?.isThread()) {
        await interaction.reply("Create missions from a top-level guild text channel.");
        return;
      }
      await interaction.deferReply();
      const goal = interaction.options.getString("goal", true);
      const doctrineId = interaction.options.getString("doctrine") ?? "structured";
      const previousCreation = registry.creationForInteraction(interaction.guildId, interaction.id);
      const previousMissionId = previousCreation?.missionId;
      if (previousCreation && !previousCreation.missionId) {
        await interaction.editReply(
          "A prior delivery of this Discord interaction may have created a mission but did not receive its id. " +
            "The retry is refused to avoid creating a duplicate mission; inspect the control plane before retrying with a new command.",
        );
        return;
      }
      if (!previousCreation) registry.beginCreation(interaction.guildId, interaction.id);
      const missionId = previousMissionId
        ? previousMissionId
        : (
            await api.createMission({
              goal,
              doctrineId,
              context: {
                channel: "discord",
                authorityTier: "ambient",
                guildId: interaction.guildId,
                requestedBy: interaction.user.id,
                transcriptRetention: "off",
                discordInteractionId: interaction.id,
              },
            })
          ).missionId;
      if (!previousCreation) registry.completeCreation(interaction.guildId, interaction.id, missionId);

      const existingBinding = registry.bindingForMission(missionId);
      if (existingBinding) {
        if (existingBinding.guildId !== interaction.guildId) {
          await interaction.editReply(
            "The mission already has a trusted binding in another guild; this retry was refused.",
          );
          return;
        }
        await interaction.editReply({
          content: `Mission **${sanitizeDiscordText(missionId)}** already uses <#${existingBinding.threadId}>; no duplicate thread was created.`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      await interaction.editReply({
        content: `Created mission **${sanitizeDiscordText(missionId)}** under doctrine **${sanitizeDiscordText(doctrineId)}**. Creating its lifecycle thread…`,
        allowedMentions: { parse: [] },
      });
      const reply = await interaction.fetchReply();
      const thread =
        reply.thread ??
        (await reply.startThread({
          name: threadNameForMission(missionId),
          autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
          reason: `Clankie mission ${sanitizeDiscordText(missionId)}`,
        }));
      if (thread.guildId !== interaction.guildId) {
        throw new Error("Discord created the mission thread outside the requesting guild");
      }
      const binding = registry.bind(thread.id, missionId, interaction.guildId, interaction.id);
      if (binding.threadId !== thread.id || binding.guildId !== interaction.guildId) {
        await thread.setName(`clankie-duplicate-refused-${thread.id}`.slice(0, 100));
        await thread.setArchived(true, "Duplicate mission thread refused by trusted binding registry");
        await interaction.editReply({
          content: `Mission **${sanitizeDiscordText(missionId)}** already has a different trusted thread binding; this retry was refused.`,
          allowedMentions: { parse: [] },
        });
        return;
      }
      await recordReceipt("discord.mission.bound", {
        missionId,
        threadId: thread.id,
        guildId: interaction.guildId,
        interactionId: interaction.id,
      });
      await thread.send({ content: ZERO_RETENTION_STATUS, allowedMentions: { parse: [] } });
      await projector.refresh(thread.id, missionId);
      return;
    }
    case "steer": {
      const missionId = missionIdForInteraction(interaction);
      if (!missionId) {
        await interaction.reply(
          "Refused visibly: steering is accepted only inside a bound Clankie mission thread.",
        );
        return;
      }
      const authority = authorizeAmbientCommand(commandPrincipal(interaction), roleBindings);
      if (!authority.allowed) {
        await interaction.reply(authority.message);
        return;
      }
      const intent = workerSteerIntentForDiscordChoice(interaction.options.getString("intent", true));
      if (!intent) {
        await interaction.reply(
          "Steering was refused: select one of the registered bounded steering choices.",
        );
        return;
      }
      await interaction.deferReply();
      const result = await issueMissionSteering(
        registry,
        api,
        interaction.channelId,
        intent,
        interaction.guildId ?? undefined,
      );
      await interaction.editReply(renderMissionSteeringReply(result));
      return;
    }
    case "approval": {
      const approvalId = interaction.options.getString("approval-id", true);
      const decision = interaction.options.getString("decision", true);
      const refusal = refuseAmbientApproval(
        memberRoleIds(interaction),
        roleBindings,
        authenticatedSurfaceUrl,
        approvalId,
      );
      await recordReceipt("discord.approval.refused", {
        approvalId,
        interactionId: interaction.id,
        ...(interaction.guildId === null ? {} : { guildId: interaction.guildId }),
      });
      await interaction.reply(
        `${refusal.message} Requested decision **${decision}** was not recorded by Discord.`,
      );
      return;
    }
    case "memory": {
      const action = interaction.options.getString("action") ?? "status";
      if (action === "status") {
        await interaction.reply(
          `${ZERO_RETENTION_STATUS} The control-plane event store is authoritative and is not changed by this bridge control.`,
        );
        return;
      }
      const thread = interaction.channel;
      if (
        !thread?.isThread() ||
        !interaction.guildId ||
        !registry.missionId(thread.id, interaction.guildId)
      ) {
        await interaction.reply(
          "Nothing was forgotten: this command must run inside a bound Clankie mission thread.",
        );
        return;
      }
      const authority = authorizeAmbientCommand(commandPrincipal(interaction), roleBindings);
      if (!authority.allowed) {
        await interaction.reply(authority.message);
        return;
      }
      await thread.setName(`clankie-forgotten-${thread.id}`.slice(0, 100));
      registry.forget(thread.id, interaction.guildId);
      projector.forget(thread.id);
      await interaction.reply(
        "Forgot the bridge-owned thread-to-mission correlation and stopped lifecycle projection. " +
          "Discord history and authoritative captain/control-plane memory were not deleted.",
      );
      await thread.setArchived(true, "Bridge mission correlation forgotten by explicit command");
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
      const result = await api.proposeDiscordPersonMemory({
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
      const approvalId = approvalIdFromPersonMemoryProposal(result);
      await interaction.reply({
        content:
          `Proposed fact **${sanitizeDiscordText(factId)}** for reviewed long-term memory. ` +
          `It is not committed until approval **${sanitizeDiscordText(approvalId)}** is decided on ${authenticatedSurfaceUrl}.`,
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
        approvalId,
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
      const status = await voiceSession.join({
        channelId: channel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        invokingUserId: interaction.user.id,
      });
      await interaction.editReply({
        // Live-session audio residency (ADR 0057): the wording must never
        // promise per-turn discard.
        content: renderVoiceJoinDisclosure(
          status.daveProtocolVersion,
          voiceRealtimeConfig?.ttsProvider ?? "openai",
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
        // Deterministic per channel: an operator approval recorded for this
        // write matches the retried command instead of minting a fresh
        // approval each attempt, and a repeat within the dedup window returns
        // the already-posted link rather than piling up invites. The
        // correlation id must be equally stable — approval matching compares
        // it, so a per-interaction id would orphan the approval it earned.
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
        // activity_start is publish-external, so the first use in a channel
        // typically parks on the authenticated approval surface. Point there
        // rather than pretending the link went out.
        const message = sanitizeDiscordText(error instanceof Error ? error.message : String(error));
        await interaction.editReply({
          content:
            `The launch was not posted: ${message}\n` +
            "If this is a pending approval, decide it in the clankie TUI (/approvals) and run /clankie watch again.",
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
        ),
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    case "voice-status": {
      await interaction.reply({
        content: renderVoiceStatusReply(voiceSession?.status(), voiceEnabled),
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
      await voiceSession?.leave();
      await interaction.reply({ content: "Left the voice channel.", ephemeral: true });
      return;
    }
    default:
      await interaction.reply({ content: "Unknown command.", ephemeral: true });
  }
}

/**
 * The asker as the gateway cache sees them right now: roles for the authority
 * check, their current voice channel as the only possible join target, and the
 * guild's voice adapter. Read at gate time and again at execution time so a
 * decider in flight never acts on a stale channel.
 */
function resolveVoiceMember(message: Message): VoicePresenceMember | undefined {
  const guild = message.guild;
  if (guild === null) return undefined;
  const member = message.member ?? guild.members.cache.get(message.author.id);
  if (!member) return undefined;
  return {
    roleIds: new Set(member.roles.cache.keys()),
    voiceChannelId: member.voice.channelId ?? undefined,
    adapterCreator: guild.voiceAdapterCreator,
  };
}

function memberRoleIds(interaction: ChatInputCommandInteraction): ReadonlySet<string> {
  if (interaction.member instanceof GuildMember) return new Set(interaction.member.roles.cache.keys());
  const roles = interaction.member?.roles;
  return new Set(Array.isArray(roles) ? roles : []);
}

function commandPrincipal(interaction: ChatInputCommandInteraction): DiscordCommandPrincipal {
  return { userId: interaction.user.id, roleIds: memberRoleIds(interaction) };
}

function approvalIdFromPersonMemoryProposal(result: Record<string, unknown>): string {
  const approval = result.approval;
  if (
    approval === null ||
    typeof approval !== "object" ||
    Array.isArray(approval) ||
    typeof (approval as Record<string, unknown>).id !== "string"
  ) {
    throw new Error("Discord person-memory proposal did not return an approval id");
  }
  return (approval as { id: string }).id;
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

function missionIdForInteraction(interaction: ChatInputCommandInteraction): string | undefined {
  const channel = interaction.channel;
  if (!channel?.isThread() || !interaction.guildId || channel.guildId !== interaction.guildId) {
    return undefined;
  }
  return registry.missionId(channel.id, interaction.guildId);
}

function pollInterval(): number {
  const configured = Number(process.env.DISCORD_MISSION_POLL_INTERVAL_MS ?? "5000");
  return Number.isFinite(configured) && configured >= 1_000 ? configured : 5_000;
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
    .map((candidate) => ({
      id: candidate.id,
      authorId: candidate.author.id,
      body: candidate.content,
      createdAt: candidate.createdAt.toISOString(),
    }));
}

function bridgeStatePath(): string {
  const configured = process.env.DISCORD_BRIDGE_STATE_PATH;
  if (configured) {
    const fromWorkspace = relative(process.cwd(), configured);
    if (
      !isAbsolute(configured) ||
      fromWorkspace === "" ||
      (!fromWorkspace.startsWith("..") && !isAbsolute(fromWorkspace))
    ) {
      throw new Error("DISCORD_BRIDGE_STATE_PATH must be absolute and outside the repository workspace");
    }
    return configured;
  }
  const stateHome = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  if (!isAbsolute(stateHome)) throw new Error("XDG_STATE_HOME must be absolute");
  return join(stateHome, "clankie", "discord-bridge.json");
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
  type: DiscordBridgeReceipt["type"],
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
  // A possessor authors for its own surfaces until it learns it has an audience
  // (ADR 0074). These two transitions are the whole of "is anyone listening",
  // and they are already the authority the idle watcher trusts.
  if (evidence.type === "joined" || evidence.type === "left") {
    possessorVoiceListener?.publishRoom({ listening: evidence.type === "joined" });
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
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shutdownPromise = (async () => {
    projector.stop();
    voiceIdleAutoLeave?.stop();
    await possessorVoiceListener?.close();
    await voiceSession?.leave();
    client.destroy();
    await presenceSession.stop().catch(reportPresencePhaseFailure);
    await recordReceipt("discord.bridge.stopped", { signal });
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
  const catchUpTimer = setInterval(() => {
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

await presenceSession.start().catch(reportPresencePhaseFailure);
await client.login(token);
