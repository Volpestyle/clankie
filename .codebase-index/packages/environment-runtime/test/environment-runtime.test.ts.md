# packages/environment-runtime/test/environment-runtime.test.ts

Fake-adapter contract suite for
`EnvironmentRuntime`. `FakeSession`/`FakeAdapter`
record calls and can hang or run background
completions; a controllable clock drives lease
and deadline time.

Covers: v1→v2 dual-read/single-write of legacy
session records; one-writer enforcement plus
expired/invalid capability rejection; use-renews-
lease and lapse→pause→`renew`→resume in place;
renewal never undoing a deliberate pause;
idempotent action registration, timeout sweep,
pause/resume, and terminal emergency stop
(revocation is final, second stop is a no-op);
adapter-owned background work settling without
blocking pause/cancel; restart reconciliation
attaching exactly once and never re-dispatching
completed actions (missing adapter session →
failed closed); credential/grant redaction across
results, events, telemetry, and disk — durable
across restart via `reconcile` re-provisioning;
emergency stop surviving hung adapter start/cancel
calls (VUH-770); retention rolling terminal action
records with an honest count and pruning ended
session files; and mid-run deadline enforcement
cancelling a wedged in-flight action on the next
dispatch.
