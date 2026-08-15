# docs/adr/0048-discord-user-session-transport.md

Implements ADR 0024's reserved user-session
transport: `apps/discord-user-session` is a
separate process (bounded raw-ws gateway, fetch
REST, no discord.js) sharing the transport-neutral
participation core so both bodies stay one
character.

Read for the enforcement: lane addresses derive
from where the conversation happens
(`discord:<guild>:<channel>`), never the
transport; four fail-closed gates (enablement,
doctrine, durable owner opt-in bound to the
policy hash, brokered credential); transport is
proven by which bearer authenticated, never by
the request body; per-action `transports` lists
(`go_live_*` user-only, `activity_*` bot-only).
