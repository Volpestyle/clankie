# apps/discord-bridge/src/commands.ts

The slash-command surface: one top-level
`/clankie` namespace (DISCORD_COMMAND_NAME, a
deploy-time constant deliberately not derived from
the persona display name) with subcommands
status, person-memory, join, leave, voice-consent,
voice-status, watch.

Exports `commands` (built with SlashCommandBuilder,
serialized to JSON for registration) and
DISCORD_SUBCOMMANDS so tests can assert the
surface. person-memory carries
action/person/fact/kind/visibility/expires-days/
supersedes-fact-id/query options; voice-consent
offers opt-in/opt-out only.
