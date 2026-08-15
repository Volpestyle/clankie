# apps/discord-bridge/test/bot-presence-runtime.test.ts

Covers the bot presence executor with a mocked
REST client: a mid-action gateway disconnect
degrades the session and fences further actions
while the in-flight one completes; replies and
reactions post correctly; activity_start mints a
target_type-2 invite (never revoking its own
fresh code) and activity_stop revokes only
configured surfaces; unconfigured surfaces are
refused; threads without a message id send an
explicit PublicThread type; attachments go
through rest files[]; Go Live is rejected on bot
transport; encodeReactionEmoji round-trips
unicode/custom/mention forms and rejects
malformed colon strings.
