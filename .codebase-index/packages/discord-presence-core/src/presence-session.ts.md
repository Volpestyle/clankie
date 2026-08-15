# packages/discord-presence-core/src/presence-session.ts

`DiscordPresenceSession`: the single-writer
gateway/voice lifecycle owned by a bridge
process. Transitions (start, gatewayReady/
Resumed/Reconnecting/Disconnected, leaseLost,
fail, stop, voiceStateChanged,
guildMembershipChanged) build a validated
`DiscordPresenceSessionRecord`, emit a typed
`discord.presence.session.phase_changed` event
through the injected `emit`, and retry
publication with exponential backoff.

Key behavior:

- `DiscordPresenceAdvertisedToolCatalog` — a live
  catalog object consumers retain; phase changes
  replace its snapshot in place.
- Synchronous revoke fence: when a transition
  would revoke `discord_presence_act`, the
  live record and catalogs update _before_ the
  first publication await, so a retained catalog
  cannot advertise act tools while durability is
  retried. `liveRecord` exposes immediate gateway
  truth ahead of the durable `record`.
- Typed failure policy:
  `DiscordPresencePublicationError` carries a
  transient|permanent disposition (also inferred
  from `Clankie API <status>` messages);
  exhausted/permanent failures become
  `DiscordPresencePublicationTerminalError`, the
  session fails closed with a publication_failed
  event, and every later call rejects.
- Voice rooms: named room context per guild,
  sorted to mirror voiceGuildIds; guild
  memberships are normalized (dedupe, sort, name
  trim, channel-access caps with truncation
  counts) and kept across disconnects as
  last-known account standing.
