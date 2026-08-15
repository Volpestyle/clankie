# apps/gba-mcp/test/possession.test.ts

Lease semantics: deny-by-default with an
empty allowlist, refusal of unnamed
holders, one holder at a time (second
acquire needs `force` and logs "stolen"),
`onHeldChange` suspend/resume as the body
changes hands, TTL expiry, sliding expiry
while acting (only idleness lapses),
ignored wrong-token release, and
`parsePossessionHolders` treating unset as
off.
