# Playit API fixture provenance

Both JSON files are real `/v1/agents/rundata` responses captured read-only
on 2026-10-04 while investigating Brief 9. The agent UUID is replaced with
a deterministic UUID; the remaining response is preserved. They contain
no credential or account identity. `playit-rundata-email-unverified.redacted.json`
preserves the initial email verification blocker; `playit-rundata.redacted.json`
preserves the subsequent verified account state, before live tunnel allocation.

The recovery integration tests clone the verified response and explicitly
simulate a ready tunnel. Those added ready/pending tunnel
fields follow `AgentTunnelV1` / `AgentPendingTunnelV1` in the pinned official
`playit-agent` source at commit
`3adf0fd4fb72c866511890eabb766732734f3cda`,
`packages/api_client/src/api.rs`. They are scenario data, not a recorded
successful allocation on the live account.
