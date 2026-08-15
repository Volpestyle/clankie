# apps/discord-bridge/test/subcommand-authority.test.ts

Asserts the ADR 0050 authority tiers against the
source text of index.ts (handleCommand cannot be
imported — its module logs into Discord at top
level). Slices each dispatch case body and
requires: person-memory on the ambient check
only; join/leave/watch on the voice presence
check only; status/voice-consent/voice-status
deliberately ungated; a guarded single namespace;
and a dispatch case for every registered
subcommand.
