import { SlashCommandBuilder } from "discord.js";
import { DISCORD_WORKER_STEER_CHOICES } from "./steering.ts";

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
    .setName("captain-steer")
    .setDescription("Steer the active worker for this mission from its Discord thread.")
    .addStringOption((option) =>
      option
        .setName("intent")
        .setDescription("Choose a bounded, policy-checked steering intent.")
        .setRequired(true)
        .addChoices(...DISCORD_WORKER_STEER_CHOICES.map(({ name, value }) => ({ name, value }))),
    ),
  new SlashCommandBuilder()
    .setName("captain-approval")
    .setDescription("Open an approval on the authenticated operator surface.")
    .addStringOption((option) =>
      option.setName("approval-id").setDescription("The pending approval id.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("decision")
        .setDescription("The decision you intend to make on the authenticated surface.")
        .setRequired(true)
        .addChoices({ name: "Approve", value: "approve" }, { name: "Deny", value: "deny" }),
    ),
  new SlashCommandBuilder()
    .setName("captain-memory")
    .setDescription("Show or clear this bridge's zero-retention mission correlation.")
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Inspect retention or forget this thread-to-mission correlation.")
        .setRequired(false)
        .addChoices(
          { name: "Status", value: "status" },
          { name: "Forget bridge correlation", value: "forget" },
        ),
    ),
  new SlashCommandBuilder()
    .setName("captain-join")
    .setDescription("Join your current voice channel after explicit consent."),
  new SlashCommandBuilder()
    .setName("captain-leave")
    .setDescription("Leave the current guild voice connection."),
].map((command) => command.toJSON());
