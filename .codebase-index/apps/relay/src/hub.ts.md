# apps/relay/src/hub.ts

`RelayHub`: the in-memory routing table
for the legacy development WebSocket. Per
workspace it holds one runner (a new
runner replaces and closes the old socket)
and a map of clients by deviceId.

`route` fans a runner's envelope out to
every open client in its workspace and a
client's envelope to the single runner,
returning the delivery count. It denies
cross-workspace sends and any control-
plane payload matching
`isApprovalCompletionPayload`. `snapshot`
feeds `/health`. Development-only: no
persistence, token equality stands in for
device-key auth.
