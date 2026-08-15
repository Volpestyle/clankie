# packages/environment-runtime/src/runtime.ts

`EnvironmentRuntime`: the durable, single-writer
environment lifecycle owned by the trusted runner.
Persists one JSON record per session (atomic tmp+
rename, filename = sha256 of session id) under
`<rootDir>/environment-sessions/`, serializes all
operations on an internal promise queue, and
drives a caller-supplied `EnvironmentAdapter`.

Key exports:

- `EnvironmentRuntime` — public methods `start`,
  `heartbeat`, `renew`, `pause`, `resume`,
  `startAction`, `finishAction`, `actionStatus`,
  `cancelAction`, `stop`, `emergencyStop`,
  `publishTelemetry`, `reconcile`, `sweep`, `list`.
- `EnvironmentAdapter` / `EnvironmentAdapterSession`
  — the provider seam (start/attach; pause/resume/
  startAction/cancelAction/stop). `startAction`
  may return a bounded synchronous completion, a
  `running` handle with an out-of-band completion
  promise, or void.
- `EnvironmentAdapterActionError` (typed, carries
  errorCode + retryable),
  `EnvironmentLeaseExpiredError` (recoverable —
  `renew` re-acquires; revocation never does).
- `EnvironmentEventSink`, `EnvironmentRuntime
Retention`, `MAX_ENVIRONMENT_LEASE_MS` (5 min).

Behavior worth knowing:

- Leases: every authorized call renews; expiry
  cancels in-flight actions and pauses the body in
  place (`leaseLapse` remembers whether the lapse
  itself paused, so `renew` never undoes a
  deliberate safety pause). One live writer per
  character/world; a lapsed claim does not block a
  new writer, and once taken the old token cannot
  renew back in.
- Actions: registered+persisted before dispatch
  (idempotent retries), goal-version checked
  (`stale` result), deadline-cancelled by `sweep`
  and on each dispatch so a hung completion never
  wedges the body.
- `emergencyStop`: no token, bypasses the queue,
  revokes synchronously before any await, bounds
  each adapter teardown call to 1 s.
- Redaction: per-session secret set (grant token +
  connection values, re-provided via `reconcile`)
  scrubbed recursively from outcomes, events,
  telemetry, and persisted records; key names
  matching token/secret/password/etc. are redacted
  outright.
- Retention: `maxActionRecords` rolls oldest
  terminal action results (counted on the record),
  `maxEndedSessionRecords` prunes oldest ended
  session files.
- Telemetry must be an `artifact://` reference,
  validated and sanitized before the event sink.
