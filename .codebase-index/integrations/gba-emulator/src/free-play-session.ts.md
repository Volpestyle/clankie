# integrations/gba-emulator/src/free-play-session.ts

`createFreePlaySession` — composes a free-play
session: adapter behind the durable
`EnvironmentRuntime` with a lease, exactly
like the deterministic scenarios. Free play
changes who decides, not how actions dispatch,
so an illegal model request is refused by the
same machinery that refuses a script.

Uses the rolling evidence policy, a per-run
session id (`gba-free-play:<scenario>:v<n>:
<run-stamp>` — a stable id once destroyed the
previous run's records), and bounded runtime
retention (newest 128 action outcomes / 16
ended records; the journal is the full
history). Takes the cross-process body lock
unless `acquireBody: false` (an MCP server
must pass false — observation is not driving,
and a lock at process start would make servers
contend over existing). `withLease` re-renews
and retries once on lease expiry, because a
mind thinks between moves and thinking can
outlive the lease; `renew` still refuses fenced
sessions. Exports `FREE_PLAY_ACTION_LIMITS`
(64 inputs / 1800 frames / 5 s), sized for
composite actions so a rival monologue or a
lab-length walk fits in one decision.
