import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder().setName("captain-status").setDescription("Show the local harness status."),
  new SlashCommandBuilder()
    .setName("captain-mission")
    .setDescription("Create a new governed mission.")
    .addStringOption((option) =>
      option.setName("goal").setDescription("The outcome to achieve.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("doctrine")
        .setDescription("Doctrine profile id.")
        .setRequired(false)
        .addChoices(
          { name: "Solo Builder", value: "solo-builder" },
          { name: "Careful Maintainer", value: "careful-maintainer" },
          { name: "High Assurance", value: "high-assurance" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("captain-join")
    .setDescription("Join your current voice channel after explicit consent."),
  new SlashCommandBuilder()
    .setName("captain-leave")
    .setDescription("Leave the current guild voice connection."),
].map((command) => command.toJSON());
