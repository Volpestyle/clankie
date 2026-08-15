# apps/clankie/src/captain-presence.ts

Captain liveness as a lease.
`CaptainPresenceManager` ingests
`CaptainPresenceReport`s (heartbeats and
lifecycle: turn started, waiting, settled) from
the authenticated captain and maintains one
lease `{ leaseId, generationId, heartbeatAt,
expiresAt, state }`.

Behavior:

- Renewal is idempotent per report event id;
  heartbeats are recorded sparsely (default
  every 10s against a 30s lease) — the rest is
  liveness noise kept off disk.
- A different captain, or a second lease
  claiming the live generation, throws
  `CaptainPresenceLeaseConflictError`; a new
  generation supersedes with explicit offline →
  online events.
- Expiry emits one `captain.presence.offline`
  (reason lease_expired), driven by an unref'd
  timer (`scheduleExpiry`) or explicit
  `expireStale()`.
- Replay of stored events restores the lease
  across restart; all entry points serialize
  through an internal promise queue.

Event ids are sha256 of a deterministic key so
duplicates dedupe by construction.
