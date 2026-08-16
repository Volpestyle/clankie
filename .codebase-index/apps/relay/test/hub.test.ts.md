# apps/relay/test/hub.test.ts

Despite the name, tests `protocol.ts`:
hello/envelope schemas keep terminal and
control planes distinct, and
`isApprovalCompletionPayload` catches
completion markers (action strings,
approvalId+decision, deeply nested
variants, over-deep payloads fail closed)
while letting `approval.requested` pass.
