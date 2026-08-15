# apps/discord-user-session/src/gateway.ts

DiscordUserGateway: a minimal hand-rolled Discord
gateway client for a normal-user credential
(discord.js refuses user tokens; implementing
only the needed slice keeps the surface
auditable). The token lives in one private field,
never logged, never on an event.

Speaks identify (bare token, `capabilities: 0`
instead of bot intents), heartbeat with
missed-ack zombie detection, resume via the
READY-supplied resume URL, and op 4 voice-state
updates (plus raw payload passthrough for the
voice adapter). Dispatches surfaced as typed
events: ready/resumed/reconnecting/disconnected/
failed, messageCreate (with attachments read into
the transport-neutral shape, malformed entries
skipped), voiceStateUpdate (carrying the raw
payload untouched for the media stack), and
voiceServerUpdate.

Reconnects on a bounded exponential ladder (1s →
60s, 10 attempts); close code 4004
(authentication) is terminal rather than retried —
repeated failed identifies are what get an
account flagged.
