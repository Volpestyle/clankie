# Native security review: VUH-1527 no-launch settlement

Reviewer: native subagent `/root/receipt_security`, read-only. Final verdict on
2026-10-06: **Approved final deltas. No remaining blocking security findings.**
Approval is conditional on Tess completing the required focused checks. The
reviewer did not edit files, rerun checks or contact the PC, lead or tracker.

The review resolved these findings before handoff:

- Revalidate operator authority before host sealing and before the local durable
  settlement; a revoked authority leaves the local receipt fenced.
- Persist irreversible service-owned launch intent before the remote exclusive
  launch transition, including controller preparation, adapter preparation and
  resume/reuse. Committed failures keep their original fence.
- Never treat an already committed remote transition as fresh launch permission.
  Launch and seal use the same cross-process host lock; abandoned locks refuse.
- Retained tombstones cannot be completed, reconciled, pruned or bypassed through
  an undefined launch-flag update. Original keys stay blocked permanently.
- Pin the original SSH target/session, refuse disconnected SSH admission, and
  allow only explicitly known named local runtimes to omit the SSH reservation.
- Validate fresh Herdr/process census rows and stable pane inventory. Current
  absence alone cannot establish historical absence.
- Use a compressed literal host program, avoiding checkout-transpiler closures;
  bound Windows commands before dispatch. The actual PC command was 15,562
  characters and passed through the configured SSH transport.

Reviewed implementation: `apps/clankie/src/remote-hire-receipt-program.ts`,
`remote-hire-receipts.ts`, `captain/herdr-watch.ts`, `captain/delivery-fence.ts`,
`captain/captain-operator-service.ts`, and `app/conversation-routes.ts`, together
with the native integration and existing HTTP authority regression coverage.

The trust boundary is the service's controlled hire path and the configured SSH
host/OS principal. The service-owned launch guard prevents a reset remote journal
from downgrading its own committed launch. A compromised host cannot attest its
own history, and this mechanism does not claim to audit arbitrary external launches.

The reviewer specifically rejected retrospective no-launch settlement for both
old originals: Claude `seat-71022bcd…` was delivered, while Codex
`9a42ada0…` allocated a shell and lacks a recorded window. Neither is eligible.
Independent future hires require an explicit new-intent mechanism; changing a
title, brief or cwd cannot escape the original fence.

## Positive delivery and legacy abandonment (follow-up)

Native subagent `/root/receipt_security` reviewed the final source delta and
approved it on 2026-10-06, with no remaining security blocker. Approval covers
historical native insertion as delivered and explicit retained abandonment; it
does not authorize a no-launch reclassification, relaunch or adoption.

The review required and verified:

- Exact canonical mailbox original/ACK identity; corrupt or conflicting journals
  refuse, including competing mailbox files. Missing legacy bindings require the
  retained exact bridge ACK and unique historical native event corroboration.
- Native channel-origin metadata, exact event ID/recipient/body/cwd, independently
  derived session UUID, canonical baseline IDs and unambiguous native attributes.
- Confined original workspace/profile traversal, bounded no-follow FD reads,
  bigint file identity/time comparisons and path identity checks. Windows path
  stats report `dev=0`; handles report the real volume. Path comparisons retain
  exact bigint inode/size/times; FD comparisons also retain device identity.
- Fresh authenticated census on every unsettled attempt, final native allocation
  identity recheck after transcript observation, and retained host recovery history.
- A durable irreversible recovery barrier before asynchronous observation,
  original-hire activity fencing, and no ordinary adoption, completion, reconciliation
  or replay of an intent under explicit recovery.

[Real PC program proof](pc-recovery-proof.json) uses an isolated test receipt and
the retained real `seat-71022bcd` native event. It proves Windows compatibility
and historical insertion; production originals are unchanged. The live operator
API still [returns HTTP 400](production-api-refusal.json) before deployment.
Focused checks must pass before handoff; production settlement and fresh-pane
acceptance remain gated on integrator deployment.
