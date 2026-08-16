# packages/discord-presence-core/README.md

Module-by-module responsibility table for the
package, the `discord.voice.*` receipt vocabulary
(all content-free scalars), the rules (no
discord.js import; lane addresses from
`discordPresenceLaneAddress`; transportKind is
configuration, not inference; attachment
selection including `gifv` lives here for both
bodies; the package never fetches attachment
bytes). It also records the per-speaker
transcription identity/capacity rules and the two
consumers (bot bridge and user-session bridge).
