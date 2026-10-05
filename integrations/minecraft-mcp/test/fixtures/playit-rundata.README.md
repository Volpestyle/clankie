# Playit API fixture provenance

`playit-create-rejection.redacted.json` is the actual HTTP 400 rejection
of Clankie's original `/v1/tunnels/create` request, captured on 2026-10-04.
Its API envelope and `validation` error are preserved. It contains no
credential or account identity. The original request followed the pinned
Rust client's obsolete `ports`/`alloc` contract; the live API requires
the current official TypeScript client's `protocol`/`endpoint` contract.
The corrected request schema is `ReqTunnelsCreateV1` in
<https://github.com/playit-cloud/playit-minecraft-plugin/blob/4888f44ef09c30b7fb76fc64fa2f6c0ad1adbc8a/agentkey_schema.ts>.

`playit-create-agent-version-rejection.redacted.json` preserves the live
HTTP 400 response to that corrected request. The API accepted the body
shape and rejected the agent registration with `AgentVersionTooOld`.

The rundown JSON files are real `/v1/agents/rundata` responses captured read-only
on 2026-10-04 while investigating Brief 9. They contain no credential or
account identity. For the two empty responses, only the agent UUID is
replaced with a deterministic UUID. `playit-rundata-email-unverified.redacted.json`
preserves the initial email verification blocker; `playit-rundata.redacted.json`
preserves the subsequent verified account state, before live tunnel allocation.

`playit-create-success.redacted.json` is the real HTTP 200 response after
native agent startup registered its version and the corrected request
allocated one tunnel. `playit-rundata-ready.redacted.json` is the subsequent
read-only rundown response containing that ready tunnel. UUIDs, numeric
internal ID, and public address are replaced with deterministic fixtures.
The response shapes and origin configuration are preserved.

The recovery integration tests use these actual successful response shapes
for allocation and adoption. Pending, ambiguous, and mismatched assignments
are explicitly simulated variations of the captured tunnel. Pending fields
follow `AgentPendingTunnelV1` in the official TypeScript client linked above.

The automated integration tests replay these captures through a fixture-owned
local HTTP server, native executable, and filesystem directory. The capture
evidence came from the live API; request loss, retry timing, process startup,
and conflicting-controller scenarios run entirely in the local fixture.
