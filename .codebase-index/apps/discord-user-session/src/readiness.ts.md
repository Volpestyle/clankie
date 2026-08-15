# apps/discord-user-session/src/readiness.ts

assertUserSessionAdmissible: every precondition
for wearing the user-session body, in one place,
ordered cheapest first and fail-closed — the
brokered token is resolved last, so a refused run
never materialises a user credential in memory.

Gates: DISCORD_USER_SESSION_ENABLED, non-empty
guild and channel allowlists, a recorded
non-revoked owner opt-in whose profile hash
matches the service's current doctrine (an
opt-in must not survive a policy change it never
weighed) and whose character matches, configured
scope within the recorded scope (narrowing
allowed, widening refused per id), and finally
the brokered discord_user_session API credential.

Failures throw DiscordUserSessionRefused with a
typed UserSessionRefusalCode; success returns the
opt-in, profile hash, and user token.
