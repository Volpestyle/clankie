# apps/relay/README.md

Boundary documentation for the relay: the
authenticated operator-conversation
HTTP/NDJSON surface versus the legacy
loopback dev WebSocket, and why Tailscale
identity is never accepted as
authorization.

Details the dispatch and tail routes, the
device-bearer verification points, the
captain-credential upstream hop, the
redaction guarantee, the `expectedRevision`
fence and idempotent turn delivery, the
no-approval-route invariant (with a mermaid
flowchart), bounded structured logging, and
the env configuration
(`CLANKIE_CONTROL_PLANE_URL`,
`CLANKIE_CAPTAIN_URL`,
`CLANKIE_CAPTAIN_TOKEN`,
`CLANKIE_RELAY_HOST`,
`CLANKIE_RELAY_DEV_TOKEN`).
