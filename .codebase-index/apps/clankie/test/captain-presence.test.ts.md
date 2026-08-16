# apps/clankie/test/captain-presence.test.ts

`CaptainPresenceManager` and its route:
idempotent renewal with sparse heartbeat
recording, ingestion through captain auth with
the background reaper flipping an expired lease
offline, exactly one offline event at expiry
with replay restoring the lease across restart,
lease-theft rejection (same generation, new
leaseId), and generation supersession emitting
offline(superseded) → online → heartbeat.
