# apps/clankie/src/discord-user-session-opt-in.ts

Durable record of the owner's acceptance of
user-session transport risk — "may Clankie wear
a human Discord account" (ADR 0048).
Event-sourced singleton: at most one live opt-in,
recorded/revoked via the two event types this
file names.

`DiscordUserSessionOptInProjection.resolve()`
returns the raw record; execution gates use
`resolveActive(profileHash)`, which returns
nothing for a revoked or profile-mismatched
record so stale permission can never read as
permission. The record nests under `optIn` in
event data so audit fields ride the same event
without breaking strict-schema replay.
