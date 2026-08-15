# packages/discord-presence-core/README.md

Module-by-module responsibility table for the
package, the `discord.voice.*` receipt vocabulary
(all content-free scalars), the rules (no
discord.js import; lane addresses from
`discordPresenceLaneAddress`; transportKind is
configuration, not inference; attachment
selection lives here for both bodies; the package
never fetches attachment bytes), and the two
consumers (the bot bridge and the user-session
bridge).
