import { ClankieApiClient } from "@clankie/api-client";
import {
  createDefaultCredentialStore,
  DISCORD_BOT_PROVIDER_ID,
  resolveDiscordBridgeCredential,
  resolveDiscordVoiceBridgeCredential,
} from "@clankie/credential-broker";
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
  parseRoleIds,
  refuseAmbientApproval,
  type DiscordRoleBindings,
} from "./authority.ts";
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
  type DiscordInboundContextMessage,
  type DiscordVoiceEvidence,
} from "@clankie/discord-presence-core";
import { applyDiscordSettingsToEnvironment, SettingsStore } from "@clankie/settings";
import { commands } from "./commands.ts";
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
const settingsFilledNames = applyDiscordSettingsToEnvironment(storedSettings.discord);

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
  approvalRoleIds: parseRoleIds(process.env.DISCORD_APPROVAL_ROLE_IDS),
};
const receipts = new DiscordBridgeReceiptStore({
  path: bridgeReceiptPath(),
});
const textIngressEnabled = process.env.DISCORD_TEXT_INGRESS_ENABLED === "true";
const textIngressContextLimit = parseContextMessageLimit(process.env.DISCORD_INGRESS_CONTEXT_MESSAGES);
const textIngress = textIngressEnabled
  ? new DiscordTextIngress(
      createAdvertisedDiscordPresencePort(api, presenceSession),
      {
        characterId,
        credentialRef: "discord_bot",
        transportKind: "bot",
        guildIds: parseDiscordIdSet(process.env.DISCORD_INGRESS_GUILD_IDS),
        channelIds: parseDiscordIdSet(process.env.DISCORD_INGRESS_CHANNEL_IDS),
        dmPolicy: parseDiscordDmPolicy(process.env.DISCORD_INGRESS_DM_POLICY),
        ...(process.env.DISCORD_OWNER_USER_ID === undefined
          ? {}
          : { ownerUserId: process.env.DISCORD_OWNER_USER_ID }),
        dmUserIds: parseDiscordIdSet(process.env.DISCORD_INGRESS_DM_USER_IDS),
        contextMessageLimit: textIngressContextLimit,
        authenticatedSurfaceUrl,
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
if (voiceEnabled && (voiceGuildIds.size === 0 || voiceChannelIds.size === 0)) {
  throw new Error(
    "Discord voice is enabled but DISCORD_VOICE_GUILD_IDS or DISCORD_VOICE_CHANNEL_IDS is empty.",
  );
}
const openAiCredential = voiceEnabled ? await credentialStore.get("openai") : undefined;
if (voiceEnabled && openAiCredential?.type !== "api") {
  throw new Error(
    "Discord voice requires the existing brokered openai API credential; OAuth and environment credentials are not accepted by the speech boundary.",
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
    throw new Error("Discord voice is enabled but OpenAI speech readiness is incomplete.");
  }
}
const voiceSession =
  voiceSpeech === undefined || voiceApi === undefined
    ? undefined
    : new DiscordVoiceSession({
        ingress: new DiscordVoiceIngress(voiceApi, {
          characterId,
          credentialRef: "discord_bot",
          transportKind: "bot",
        }),
        speech: voiceSpeech,
        presenceSessionId: () => presenceSession.record.sessionId,
        emit: recordVoiceEvidence,
      });
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
  const guildId = process.env.DISCORD_GUILD_ID;
  const route = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId);
  await rest.put(route, { body: commands });

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
    commandCount: commands.length,
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
    `Discord bot ready as ${client.user?.tag ?? "unknown"}; registered ${commands.length} commands, restored ${registry.entries().length} mission thread(s), text ingress ${textIngressEnabled ? "enabled" : "disabled"}, voice ${voiceEnabled ? "enabled" : "disabled"}.`,
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
    void presenceSession
      .voiceStateChanged(current.guild.id, current.channelId !== null)
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
    const result = await textIngress.handle({
      id: message.id,
      ...(message.guildId === null ? {} : { guildId: message.guildId }),
      channelId: message.channelId,
      authorId: message.author.id,
      authorIsBot: message.author.bot || message.author.id === client.user?.id,
      mentionsBot: client.user !== null && message.mentions.users.has(client.user.id),
      body: message.content,
      loadContextMessages: () => readDiscordContext(message, textIngressContextLimit),
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
  switch (interaction.commandName) {
    case "captain-status": {
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
    case "captain-mission": {
      const authority = authorizeAmbientCommand(memberRoleIds(interaction), roleBindings);
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
    case "captain-steer": {
      const missionId = missionIdForInteraction(interaction);
      if (!missionId) {
        await interaction.reply(
          "Refused visibly: steering is accepted only inside a bound Clankie mission thread.",
        );
        return;
      }
      const authority = authorizeAmbientCommand(memberRoleIds(interaction), roleBindings);
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
    case "captain-approval": {
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
    case "captain-memory": {
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
      const authority = authorizeAmbientCommand(memberRoleIds(interaction), roleBindings);
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
    case "captain-person-memory": {
      if (!interaction.guildId) {
        await interaction.reply({
          content: "Discord person memory is guild-scoped and is unavailable in DMs.",
          ephemeral: true,
        });
        return;
      }
      const authority = authorizeAmbientCommand(memberRoleIds(interaction), roleBindings);
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
    case "captain-join": {
      const authority = authorizeAmbientCommand(memberRoleIds(interaction), roleBindings);
      if (!authority.allowed) {
        await interaction.reply(authority.message);
        return;
      }
      if (voiceSession === undefined) {
        await interaction.reply({
          content: "Discord voice participation is disabled or brokered speech is not ready.",
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
      if (!voiceGuildIds.has(interaction.guild.id) || !voiceChannelIds.has(channel.id)) {
        await interaction.reply({
          content: "This guild voice channel is outside Clankie's configured voice allowlist.",
          ephemeral: true,
        });
        return;
      }
      await interaction.deferReply();
      const status = await voiceSession.join({
        channelId: channel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        invokingUserId: interaction.user.id,
      });
      await interaction.editReply({
        content:
          `Joined with DAVE protocol ${String(status.daveProtocolVersion)}. ` +
          `Only you are opted in: I send only explicitly consented, bounded utterances to OpenAI for transcription, ` +
          `discard raw audio after each turn, and never treat speech as privileged approval. ` +
          `My spoken responses use an AI-generated OpenAI voice. ` +
          `Other participants can use **/captain-voice-consent opt-in** and revoke at any time.`,
        allowedMentions: { parse: [] },
      });
      return;
    }
    case "captain-voice-consent": {
      if (voiceSession === undefined) {
        await interaction.reply({
          content: "Discord voice participation is disabled or brokered speech is not ready.",
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
        content: consented
          ? `You are opted in for this voice session. ${String(status.consentedParticipantCount)} participant(s) are now opted in.`
          : "Your voice consent is revoked and any active capture for you was discarded.",
        ephemeral: true,
      });
      return;
    }
    case "captain-voice-status": {
      const status = voiceSession?.status();
      await interaction.reply({
        content:
          status?.active === true
            ? `Voice is active with DAVE protocol ${String(status.daveProtocolVersion)}; ${String(status.consentedParticipantCount)} participant(s) opted in and ${String(status.activeCaptureCount)} bounded capture(s) active. Raw audio and transcripts are not retained.`
            : `Voice is ${voiceEnabled ? "enabled but not connected" : "disabled"}.`,
        ephemeral: true,
        allowedMentions: { parse: [] },
      });
      return;
    }
    case "captain-leave": {
      const authority = authorizeAmbientCommand(memberRoleIds(interaction), roleBindings);
      if (!authority.allowed) {
        await interaction.reply(authority.message);
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

function memberRoleIds(interaction: ChatInputCommandInteraction): ReadonlySet<string> {
  if (interaction.member instanceof GuildMember) return new Set(interaction.member.roles.cache.keys());
  const roles = interaction.member?.roles;
  return new Set(Array.isArray(roles) ? roles : []);
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
  switch (evidence.type) {
    case "joined":
      await recordReceipt("discord.voice.joined", evidence);
      return;
    case "consent":
      await recordReceipt("discord.voice.consent", evidence);
      return;
    case "utterance":
      await recordReceipt("discord.voice.utterance", evidence);
      return;
    case "response":
      await recordReceipt("discord.voice.response", evidence);
      return;
    case "overlap":
      await recordReceipt("discord.voice.overlap", evidence);
      return;
    case "interrupted":
      await recordReceipt("discord.voice.interrupted", evidence);
      return;
    case "failed":
      await recordReceipt("discord.voice.failed", evidence);
      return;
    case "left":
      await recordReceipt("discord.voice.left", evidence);
      return;
  }
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

await presenceSession.start().catch(reportPresencePhaseFailure);
await client.login(token);
