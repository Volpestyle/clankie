# docs/adr/0042-discord-person-memory-projection.md

Facts about Discord people live in a separate
projection keyed by `(guildId, userId)` — never
merged into general memory — with bounded kinds,
visibility scopes (guild/channel/operator-
private), expiry, and correction lineage.

Read for the write path: text/voice may propose a
bounded fact but the provenance schema requires
`rawTranscript: false`; commits go through
operator approval; export and deletion are
operator-only with receipts. Renames never break
memory because display names are presentation
only; cross-guild isolation is a query invariant.
