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
          { name: "Rawdog", value: "rawdog" },
          { name: "Structured", value: "structured" },
          { name: "Fine Control", value: "fine-control" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("captain-join")
    .setDescription("Join your current voice channel after explicit consent."),
  new SlashCommandBuilder()
    .setName("captain-leave")
    .setDescription("Leave the current guild voice connection."),
].map((command) => command.toJSON());
