# apps/discord-user-session/test/readiness.test.ts

Covers every admission gate of
assertUserSessionAdmissible: admits a fully gated
config; refuses when disabled, allowlists empty,
opt-in absent/revoked, doctrine profile or
character mismatched, or scope widened (narrowing
is allowed); proves the user credential is never
resolved for a refused run; and refuses when the
broker holds no user credential.
