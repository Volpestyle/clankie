# apps/relay/src/protocol.ts

Zod schemas for the legacy dev WebSocket:
`RelayHelloSchema` (role runner/client,
workspaceId, deviceId, token min 16) and
`RelayEnvelopeSchema` (plane
control/terminal, sequence, opaque
payload).

Also `isApprovalCompletionPayload`: the
tunnel is opaque, so approval completion
is denied by semantic marker before
routing — an `approvalId` paired with a
decision/approved field, or a routing-ish
key (`type`/`op`/`action`/`path`/...)
whose value names approvals plus
complete/approve/reject/record, searched
recursively; depth beyond 8 fails closed
as a match. Approval reads/requests may
pass; completions never do.
