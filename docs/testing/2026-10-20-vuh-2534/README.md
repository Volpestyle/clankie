# VUH-2534: integration-safe runtime updates

Tracks: https://linear.app/vuhlp/issue/VUH-2534

Each active integration attempt holds deploy admission through composition, gate
and push, bounded at sixty minutes. Immediate update requests return a durable
waiting intent promptly; deferred updates reaching dueAt use the same protection.
A waiting or admitted deploy fences new attempts. Interrupted approved requests
receive one durable retry with the same resolved commit objects. Recovery fetches
remote main and skips an already-present candidate without sending another push.
Status names the protected batch UUIDs. ADRs 0136 and 0240 record the decision.

## Evidence

Real Git origins, gate processes, the hold registry, HTTP routes, update journal
and CLI formatter prove:

- Immediate and due deferred updates wait while a real batch gates, and update
  status identifies its automatic hold. An HTTP caller promptly receives 202
  with a waiting intent; a replacement coordinator reads the intent from disk.
- Automatic holds expire at the sixty-minute bound with an expiry receipt.
  A pending deploy fences subsequent attempts, which resume when it settles.
- Shutdown leaves a stopped gate's retry queued without starting it under the
  outgoing governor. The replacement queue resumes and lands the same approved
  object, with exactly two actual gate starts across both instances.
- A stopped real gate driver receives exactly one fresh attempt, then remains
  interrupted after another stop, with both sets of logs retained.
- A recovered request whose original send reached remote main reuses the exact
  approved object. The real bare origin's receive hook observes zero further
  pushes. The lead receives a recovery notice; another startup does not replay it.
- The existing app gate-reuse/main-move contract still holds when core needs no
  push. A no-op is recorded only after validation across all repositories.

The initial six targeted checks passed. A broader five-file run returned 59
passes and one failure in the existing app gate-reuse/main-move case: no-op push
bookkeeping made a held attempt read partial. The correction preserves the
pre-send validation boundary. The exact failing case and five acceptance checks
then passed (six total, `focused-final2.log`). Final acceptance includes durable
waiting-intent cancellation and shutdown/replacement recovery, with eight passing
checks (`acceptance-shutdown.log`). This is not a claim that the earlier
broader run was green. A separate typecheck found a test-only Promise/Response
union error; the fixture now normalizes the awaitable with Promise.resolve.

Final checks, checked revision/base, and landing evidence are recorded in the
issue's evidence comment and attached logs. Raw logs are retained in the evidence
store; only this README and its evidence receipt belong in Git.

## Remaining live proof

No installed runtime was deployed or restarted for this work. After the lead
deploys it, start a real integration batch, trigger an immediate update and then
a due deferred update, and observe their blocking batch IDs in update status.
Confirm the batch finishes before cutover, and retain the batch and update
receipts. This final live cutover proof remains with the lead as assigned.
