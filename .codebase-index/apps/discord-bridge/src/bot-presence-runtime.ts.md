# apps/discord-bridge/src/bot-presence-runtime.ts

DiscordBotPresenceRuntime: the bot-transport
executor for the transport-agnostic presence
action catalog (ADR 0024 P1). Takes a
DiscordPresenceWrite plus the projected session
record, checks the action is available for the
session phase, and performs it via discord.js
REST.

Handles reply, reply_with_media (one message with
a generated picture, ADR 0085), send_message,
react/unreact, edit/delete own message,
typing_start, create_thread/join_thread,
send_attachment (via the injected hash-bound
resolver), and the activity plane:
activity_start mints a unique 6h
EMBEDDED_APPLICATION invite for a
deny-by-default surface→application-id map and
posts the launch link (revoking older invites for
configured surfaces); activity_stop revokes them
best-effort — Discord cannot evict viewers, so
stop means "no further launches". Voice and Go
Live payloads are rejected (other transports own
them). All posts suppress mentions.

Also exports encodeReactionEmoji (unicode,
name:id, and <a:name:id> forms) and
createDiscordBotPresenceRuntime. Invite revocation
is deliberately stateless: live invites are read
back rather than remembered, since the runtime is
constructed per action.
