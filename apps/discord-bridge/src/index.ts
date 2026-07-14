import { getVoiceConnection, joinVoiceChannel } from "@discordjs/voice";
import { ClankieApiClient } from "@clankie/api-client";
import { createDefaultCredentialStore, DISCORD_BOT_PROVIDER_ID } from "@clankie/credential-broker";
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
import { commands } from "./commands.ts";
import { projectBoundMissionRecord, renderMissionSummary, sanitizeDiscordText } from "./mission-state.ts";
import { createAdvertisedDiscordPresencePort } from "./presence-action-advertiser.ts";
import { MissionThreadProjector } from "./projector.ts";
import { DiscordPresenceSession } from "./presence-session.ts";
import {
  issueMissionSteering,
  renderMissionSteeringReply,
  workerSteerIntentForDiscordChoice,
} from "./steering.ts";
import { MissionThreadRegistry, ZERO_RETENTION_STATUS, threadNameForMission } from "./thread-registry.ts";
import {
  DiscordTextIngress,
  parseDiscordDmPolicy,
  parseDiscordIdSet,
  type DiscordInboundContextMessage,
} from "./text-ingress.ts";

if (process.env.DISCORD_USER_TOKEN) {
  throw new Error("DISCORD_USER_TOKEN must not be set for the official Discord bot bridge.");
}
if (process.env.DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN must not be set. Store discord_bot in the credential broker.");
}
const credential = await createDefaultCredentialStore().get(DISCORD_BOT_PROVIDER_ID);
const token = credential?.type === "api" ? credential.key : undefined;
const applicationId = process.env.DISCORD_APPLICATION_ID;
if (!token || !applicationId) {
  throw new Error(
    "A brokered discord_bot API credential and DISCORD_APPLICATION_ID are required. Normal Discord user credentials are unsupported.",
  );
}

const apiUrl = process.env.CLANKIE_API_URL ?? "http://127.0.0.1:4310";
const captainToken = process.env.CLANKIE_CAPTAIN_TOKEN;
if (!captainToken) {
  throw new Error("CLANKIE_CAPTAIN_TOKEN is required for authenticated ambient steering.");
}
const authenticatedSurfaceUrl =
  process.env.CLANKIE_AUTHENTICATED_SURFACE_URL ?? "http://127.0.0.1:4311/approvals";
const api = new ClankieApiClient({ baseUrl: apiUrl, captainToken });
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
const textIngressEnabled = process.env.DISCORD_TEXT_INGRESS_ENABLED === "true";
const textIngressContextLimit = parseContextMessageLimit(process.env.DISCORD_INGRESS_CONTEXT_MESSAGES);
const textIngress = textIngressEnabled
  ? new DiscordTextIngress(
      createAdvertisedDiscordPresencePort(api, presenceSession),
      {
        characterId,
        credentialRef: "discord_bot",
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
      (event) => console.info(event, "Discord text ingress event"),
    )
  : undefined;
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
    }
  }
  projector.start();
  console.log(
    `Discord bot ready as ${client.user?.tag ?? "unknown"}; registered ${commands.length} commands, restored ${registry.entries().length} mission thread(s), text ingress ${textIngressEnabled ? "enabled" : "disabled"}.`,
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
  if (current.id !== client.user?.id) return;
  void presenceSession
    .voiceStateChanged(current.guild.id, current.channelId !== null)
    .catch(reportPresencePhaseFailure);
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
    case "captain-join": {
      const member = interaction.member instanceof GuildMember ? interaction.member : undefined;
      const channel = member?.voice.channel;
      if (!interaction.guild || !channel) {
        await interaction.reply({
          content: "Join a voice channel first, then invoke this command.",
          ephemeral: true,
        });
        return;
      }
      joinVoiceChannel({
        channelId: channel.id,
        guildId: interaction.guild.id,
        adapterCreator: interaction.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      await interaction.reply(
        "Joined with explicit command consent. This bridge does not record or transcribe audio.",
      );
      return;
    }
    case "captain-leave": {
      const connection = interaction.guildId ? getVoiceConnection(interaction.guildId) : undefined;
      connection?.destroy();
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

function reportPresencePhaseFailure(error: unknown): void {
  console.error(
    { error: error instanceof Error ? error.message : String(error) },
    "Discord presence phase publication failed",
  );
}

await presenceSession.start().catch(reportPresencePhaseFailure);
await client.login(token);
