# apps/relay/test/operator-conversations.test.ts

End-to-end suite for the conversation
boundary, run against real local HTTP
servers with injected authorizers and
dispatchers. Covers: list/get/create
through the unchanged callable contract;
Tailscale headers never substituting for
app auth; immediate revocation and the
chat-grant requirement; duplicate-turn
collapse with preserved typed
revision_conflict results; fail-closed 502
when upstream leaks private state and
[REDACTED] substitution inside allowed
strings; the absent approval route/op; and
bounded logs free of message text and
credentials.

The NDJSON section proves tail streams
fail closed on private continuation state,
resume from opaque cursors without gaps or
duplicates, emit one typed recovery frame,
and recheck device auth between polls and
after in-flight dispatches before
emitting. Final tests pin the two auth
hops: device bearer to the control-plane
projection, captain credential only
upstream. Also validates the recorded RN
fixtures under `fixtures/`.
