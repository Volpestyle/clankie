# packages/credential-broker/src/discord-user-session-provider.ts

`DiscordUserSessionCredentialProvider` — the
user-plane twin of the bot provider (ADR 0048),
guarding the `discord_user_session` normal-user
token. Same expiring resource-scoped grants, plus
one extra gate the bot plane lacks: a durable
owner opt-in bound to the doctrine profile hash,
resolved through an injected `resolveOptIn`
callback (never from configuration, so an env
flag can never reach a user token).

The opt-in is re-checked at redemption, not only
at issue, so a revocation stops the very next
action instead of waiting for grant expiry. Every
denial is a typed `DiscordUserSessionDenied`
error code; unlike the bot plane, both guild and
channel allowlists are checked strictly and empty
channel lists do not widen.
