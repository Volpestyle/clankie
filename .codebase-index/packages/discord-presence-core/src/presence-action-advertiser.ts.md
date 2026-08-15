# packages/discord-presence-core/src/presence-action-advertiser.ts

`createAdvertisedDiscordPresencePort(delegate,
session)` — wraps a `DiscordPresenceActionDelivery
Port` (health, captain channel turns, presence
writes) as the `DiscordTextIngressPort` text
ingress consumes. Before executing any presence
write it checks the retained live catalog still
advertises `discord_presence_act` and that the
live record's phase matches the exposure,
throwing the typed
`DiscordPresenceActToolUnavailableError`
otherwise; accepted writes are forwarded with a
`DiscordPresenceLiveClaim` (sessionId, phase,
revision) as an authenticated execution fence.
