# apps/discord-user-session/src/user-presence-runtime.ts

DiscordUserPresenceRuntime: the user-session
executor for the transport-agnostic presence
catalog (ADR 0048), built on plain fetch —
keeping discord.js out is what stops the two
planes from ever sharing a client, gateway, or
credential. The user token is presented bare
(never `Bot `-prefixed), never logged, never
returned.

Handles reply, reply_with_media and
send_attachment via multipart FormData with the
injected hash-bound resolver, send_message,
react/unreact, edit/delete own message, typing,
threads, and Go Live: go_live_start fails closed
(`go_live_media_unavailable`) without the
injected publisher and source resolver —
reporting a stream nobody can watch is worse than
refusing — and go_live_stop of an inactive stream
is not an error. voice_join/leave are rejected
(the media session drives gateway op 4 directly)
and activities are rejected (they belong to the
bot application, ADR 0047). REST failures report
status and route only — Discord error bodies can
echo message content. Mentions suppressed on
every outbound message.

Also exports its own encodeReactionEmoji for the
REST reaction path.
