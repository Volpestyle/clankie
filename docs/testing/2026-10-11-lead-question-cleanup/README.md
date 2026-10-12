# Lead question cleanup — VUH-2136

Tracks: https://linear.app/vuhlp/issue/VUH-2136

The operator lead lane exposes `cancel_question` with request ID, incarnation
and expected revision. The host binds the source conversation, including its
remote delegation, and rechecks current admission after authorization. It
cannot target another conversation. Cancellation is durable, attributed to the
service with `lead_cancelled`, and never queues an answer continuation. An
identical retry reconciles the original; stale revisions and incarnations are
refused. A lead may cancel an overtaken ask before asking its replacement.

Periodic fleet rounds surface questions older than 30 minutes to their source
lead with exact targets and bounded, explicitly untrusted prompt text. This
works even when the lead has no current workers. No question expires or is
cancelled automatically.

## Verification

55 focused tests pass across conversation questions, real fleet-round delivery
and model tool schemas. The registered tool settles the exact canonical ask,
reconciles a duplicate, starts no answer turn and allows a replacement with a
new request ID. Stale incarnation/revision, cross-source input and admission
revoked during authorization leave the question pending. A real stored aged
ask reaches its source lead's outbox with no workers, and not another lead's.

The service source and all 13 bounded test typecheck programs pass. Explicit
file formatter and lint pass. The integrator supplies the final exact-tree
landing gate; its retained record is the final landing evidence. App overlay
and fixture screenshots are the separate app slice, on the same issue.
