# packages/credential-broker/src/activity-producer-credential.ts

Local bearer for the activity plane's loopback
frame-producer endpoint (ADR 0047), under
`clankie_activity_producer`. Same
mint/resolve/ensure trio, with one stricter rule:
`assertNoEnvironmentActivityProducerToken` makes
a set `CLANKIE_ACTIVITY_PRODUCER_TOKEN` a hard
startup error — a process accepting both sources
would silently prefer the weaker one. The
activity server owns the listener, so it owns the
mint; the runner only resolves.
