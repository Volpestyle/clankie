# apps/clankie/src/discord-presence-session.ts

Durable projection of Discord presence sessions,
keyed by transport/character/credential binding.
`DiscordPresenceSessionProjection` applies
phase-changed events with strict rules: a new
binding must open as process_start/off →
connecting rev 1; stale revisions and mismatched
previous-phase claims throw typed conflict
errors; an ahead-of-durable bridge (lost ack) is
rebased onto the next contiguous revision so
both sides self-heal. `validate()` projects
without committing.

Also exports `discordPresenceDomainEvent()` (the
phase event as a stored DomainEvent) and
`deriveDiscordVoiceHistory()` (VUH-940):
completed voice stays derived from the phase
stream — a stay opens when a guild appears in
`voiceGuildIds` and closes when it disappears,
carrying the room context captured at join time;
open stays are never reported, newest first.
