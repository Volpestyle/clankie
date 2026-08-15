# apps/discord-user-session/README.md

Operator guide for the user-session plane. States
the ToS risk framing (owner-accepted, off by
default), why bot and user credentials get
separate processes (ADR 0024/0048), the three
fail-closed admission gates checked cheapest
first (token resolved last), the curl recipe for
recording/revoking the owner opt-in, the
environment table, and the bot-vs-user capability
comparison.

The Go Live section explains why
discord.js-selfbot-v13 (GPL-3.0) is loaded
dynamically and never declared in this Apache-2.0
workspace, the deliberate install command, the
pnpm allowBuilds requirement, and the fail-closed
`go_live_media_unavailable` behavior.
