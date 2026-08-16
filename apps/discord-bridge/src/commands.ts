import { SlashCommandBuilder } from "discord.js";

/**
 * The single top-level command name.
 *
 * Deliberately a constant registered at deploy time, and deliberately **not**
 * derived from `persona.displayName`. Those are different things: this is a
 * fixed Discord API registration that a bulk overwrite replaces on startup,
 * while the display name is owner-editable character. Wiring one to the other
 * would make command registration change under an operator editing a
 * personality setting.
 *
 * One namespace with subcommands rather than bare names: `/join`, `/leave`,
 * and `/status` would collide with essentially every music and utility bot in
 * a shared server, and one entry reads better in the picker.
 */
export const DISCORD_COMMAND_NAME = "clankie";

/** Subcommand names, exported so authority tests can assert against the surface. */
export const DISCORD_SUBCOMMANDS = [
  "status",
  "person-memory",
  "join",
  "leave",
  "voice-consent",
  "voice-status",
  "watch",
] as const;
export type DiscordSubcommand = (typeof DISCORD_SUBCOMMANDS)[number];

export const commands = [
  new SlashCommandBuilder()
    .setName(DISCORD_COMMAND_NAME)
    .setDescription("Clankie: memory and voice.")
    .addSubcommand((sub) => sub.setName("status").setDescription("Show the local harness status."))
    .addSubcommand((sub) =>
      sub
        .setName("person-memory")
        .setDescription("Propose or recall governed long-term memory for one Discord member.")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Propose a reviewed fact or recall visible approved facts.")
            .setRequired(true)
            .addChoices(
              { name: "Propose fact", value: "propose" },
              { name: "Recall facts", value: "recall" },
            ),
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
    )
    .addSubcommand((sub) =>
      sub
        .setName("join")
        .setDescription("Join your current voice channel and consent to speaker-attributed speech."),
    )
    .addSubcommand((sub) => sub.setName("leave").setDescription("Leave the current guild voice connection."))
    .addSubcommand((sub) =>
      sub
        .setName("voice-consent")
        .setDescription("Opt in or out of Clankie's current speaker-attributed voice session.")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Explicitly enable or revoke capture for only your Discord user id.")
            .setRequired(true)
            .addChoices({ name: "Opt in", value: "opt-in" }, { name: "Opt out", value: "opt-out" }),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("voice-status")
        .setDescription("Show the consent-safe state of Clankie's current voice session."),
    )
    .addSubcommand((sub) =>
      sub
        .setName("watch")
        .setDescription("Post a launch link for the activity surface so the room can watch him play."),
    ),
].map((command) => command.toJSON());
