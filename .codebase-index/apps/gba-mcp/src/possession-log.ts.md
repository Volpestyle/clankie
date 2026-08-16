# apps/gba-mcp/src/possession-log.ts

Durable record of possession transitions.
A stdio server's stderr dies with the
harness that launched it, so who held the
body is also appended to
`possession-events.jsonl` beside
`body.lock` in the shared body root — one
append-only file across every server that
ever serves the body.

Exports `createPossessionEventLog` (sync
`appendFileSync`, mode 0600; append errors
go to `onError` because the log observes
the lease, never gates it),
`PossessionEventRecordSchema` (strict zod:
schemaVersion 1, timestamp, type, holder,
optional previousHolder/reason), and
`parsePossessionEventLog`, which throws on
corrupt lines — a lying record is worse
than none.
