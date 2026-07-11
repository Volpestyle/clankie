# @sapling/event-store

Append-only, hash-chained storage for `@sapling/protocol` domain events (ADR 0001 local-first, ADR 0002 event-sourced mission state), plus deterministic mission projections rebuilt from the log.

## Backends

Both backends implement the same `EventStore` interface (`append`, `readAll`, `verify`) and the same SHA-256 hash chain, so `verify()` detects any tampering or reordering.

- **`JsonlEventStore`** — one JSON envelope per line. Human-inspectable; used for eval artifacts and quick local audit trails.
- **`SqliteEventStore`** — the durable store (built on `node:sqlite`, no native dependency). WAL journaling with `synchronous=FULL`: once `append` resolves, the event is committed and survives an abrupt process kill. Adds `readMission(missionId)` and `close()`. Assumes a single writer per database; a second concurrent writer fails fast with `database is locked` rather than waiting.

## Guarantees

- **Ordering** — sequences are assigned monotonically inside a single write transaction; `readAll` returns events in sequence order.
- **Idempotency** — appends are keyed by event id. Re-appending a byte-identical event (same canonical JSON, including key order) is a no-op that returns the original stored envelope; anything else under an existing id is rejected loudly, so the chain can never fork or duplicate.
- **Integrity** — every envelope is sealed over `{sequence, previousHash, event}`; `verify()` recomputes the full chain.

## Schema versioning

The SQLite schema version is tracked with `PRAGMA user_version`. Migrations live in an ordered list in `src/sqlite.ts`; opening a store applies any pending migrations transactionally. Shipped migrations are never edited — new schema changes append a new migration. Opening a database written by a newer schema version fails fast rather than corrupting it.

## Projections

`projectMission(events, missionId?)` rebuilds mission state purely from the log: mission lifecycle state (mirroring the mission-engine state resolution), per-task states, approval count, and event count. Parity with the in-memory `MissionSnapshot` is asserted across the self-build eval in `apps/lead-agent-lab/test/sqlite-projection-parity.test.ts`. Tasks are observable from the log only once they emit an event.

## Crash safety

`test/crash.test.ts` SIGKILLs a child writer mid-stream (`test/crash-writer.ts`) and asserts that every acknowledged append survives reopen with a valid chain. The sqlite module deliberately avoids non-erasable TypeScript syntax (e.g. parameter properties) so plain `node` can execute it directly in that test.
