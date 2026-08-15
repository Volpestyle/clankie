# apps/clankie/test/pairing.test.ts

The pairing-offer route: fails closed with no
operator surface configured, requires the
operator bearer, mints offers matching the
`clankie pair` client contract (a literal copy
of the TUI's schema is kept here so server
drift fails this suite), unique per request,
and records a secret-free audit event per
minted offer.
