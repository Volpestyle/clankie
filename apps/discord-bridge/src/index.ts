import { getVoiceConnection, joinVoiceChannel } from "@discordjs/voice";
import { SaplingApiClient } from "@sapling/api-client";
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { commands } from "./commands.ts";

const token = process.env.DISCORD_BOT_TOKEN;
const applicationId = process.env.DISCORD_APPLICATION_ID;
if (!token || !applicationId) {
  throw new Error(
    "DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are required. Normal Discord user credentials are unsupported.",
  );
}

const api = new SaplingApiClient({ baseUrl: process.env.SAPLING_API_URL ?? "http://127.0.0.1:4310" });
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("ready", async () => {
  const rest = new REST({ version: "10" }).setToken(token);
  const guildId = process.env.DISCORD_GUILD_ID;
  const route = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId);
  await rest.put(route, { body: commands });
  console.log(
    `Discord bot ready as ${client.user?.tag ?? "unknown"}; registered ${commands.length} commands.`,
  );
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await handleCommand(interaction);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (interaction.deferred || interaction.replied)
      await interaction.editReply(`Command failed: ${message}`);
    else await interaction.reply({ content: `Command failed: ${message}`, ephemeral: true });
  }
});

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  switch (interaction.commandName) {
    case "captain-status": {
      const response = await fetch(`${process.env.SAPLING_API_URL ?? "http://127.0.0.1:4310"}/health`);
      await interaction.reply({
        content: response.ok
          ? "Captain control plane is healthy."
          : `Control plane returned ${response.status}.`,
        ephemeral: true,
      });
      return;
    }
    case "captain-mission": {
      await interaction.deferReply({ ephemeral: true });
      const goal = interaction.options.getString("goal", true);
      const doctrineId = interaction.options.getString("doctrine") ?? "careful-maintainer";
      const mission = await api.createMission({ goal, doctrineId });
      await interaction.editReply(
        `Created mission **${mission.missionId}** under doctrine **${doctrineId}**. Plan approval is the next gate.`,
      );
      return;
    }
    case "captain-join": {
      const member = interaction.member as GuildMember | null;
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
        "Joined with explicit command consent. This skeleton does not record or transcribe audio; add that only with visible disclosure and retention controls.",
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

await client.login(token);
