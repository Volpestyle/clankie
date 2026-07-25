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
    .setName("captain-person-memory")
    .setDescription("Propose or recall governed long-term memory for one Discord member.")
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Propose a reviewed fact or recall visible approved facts.")
        .setRequired(true)
        .addChoices({ name: "Propose fact", value: "propose" }, { name: "Recall facts", value: "recall" }),
    )
    .addUserOption((option) =>
      option.setName("person").setDescription("The stable Discord member identity.").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("fact")
        .setDescription("A concise fact proposal; required only for propose.")
        .setMaxLength(2_048),
    )
    .addStringOption((option) =>
      option
        .setName("kind")
        .setDescription("Fact category.")
        .addChoices(
          { name: "Person fact", value: "person-fact" },
          { name: "Preference", value: "preference" },
          { name: "Relationship note", value: "relationship-note" },
        ),
    )
    .addStringOption((option) =>
      option
        .setName("visibility")
        .setDescription("Where the approved fact may be recalled.")
        .addChoices({ name: "This guild", value: "guild" }, { name: "This channel", value: "channel" }),
    )
    .addIntegerOption((option) =>
      option
        .setName("expires-days")
        .setDescription("Optional retention expiry in days.")
        .setMinValue(1)
        .setMaxValue(365),
    )
    .addStringOption((option) =>
      option
        .setName("supersedes-fact-id")
        .setDescription("Optional approved fact id corrected by this proposal.")
        .setMaxLength(256),
    )
    .addStringOption((option) =>
      option.setName("query").setDescription("Optional bounded recall query.").setMaxLength(512),
    ),
  new SlashCommandBuilder()
    .setName("captain-join")
    .setDescription("Join your current voice channel and consent to speaker-attributed speech."),
  new SlashCommandBuilder()
    .setName("captain-voice-consent")
    .setDescription("Opt in or out of Clankie's current speaker-attributed voice session.")
    .addStringOption((option) =>
      option
        .setName("action")
        .setDescription("Explicitly enable or revoke capture for only your Discord user id.")
        .setRequired(true)
        .addChoices({ name: "Opt in", value: "opt-in" }, { name: "Opt out", value: "opt-out" }),
    ),
  new SlashCommandBuilder()
    .setName("captain-voice-status")
    .setDescription("Show the consent-safe state of Clankie's current voice session."),
  new SlashCommandBuilder()
    .setName("captain-leave")
    .setDescription("Leave the current guild voice connection."),
].map((command) => command.toJSON());
