# VUH-2314: revoke between grant read and dispatch

The reported race is already refused on unchanged product source at
`a36858a3f7ea431873d84be9c19f79892c3a1285`. No additional authorization fence or
revocation cache was added.

`WorkerMcp.revoke()` atomically replaces the durable grant record, removes each
session for that grant and awaits its SDK server closure. The SDK's protocol
close handler aborts every pending request controller. The worker passes that
request signal into its call operation; its existing synchronous `onDispatch`
check throws on the aborted signal. The real MCP host invokes that callback at
the provider dispatch boundary, after awaited account/configuration reads.
Thus a completed service-owned revoke cannot leave the paused call authorized.

The new integration extends the existing real worker/host/SDK HTTP fixture:

1. A live manual grant updates the isolated provider issue once (positive
   control, proving the account, grant and transport are usable).
2. A second call completes its worker grant read, enters the actual host, and
   pauses after async admission but before final account checking/dispatch.
3. The actual `revoke()` completes, including session teardown.
4. The host resumes and returns `outcome: refused`, `possiblyDispatched: false`.
   The provider still has exactly the one positive-control effect.

Revocation closes the worker transport, so the fixture observes the actual host
settlement before cancelling its own waiting HTTP read. That cancellation is
cleanup after the refusal; it does not supply the pre-dispatch abort being
tested. The test does not claim a new response is delivered on the closed MCP
session, or that already-dispatched provider effects can be undone.

The exact test passes against unchanged product source. As a negative control,
temporarily removing only `signal.throwIfAborted()` from the worker's dispatch
callback makes the test fail: the host instead returns `outcome: ok`. The
original product source was restored byte-for-byte before final verification.

Related worker/receipt tests: **18/18 passed** after restoring the original
source; the root landing gate is recorded on the issue. Documentation
now describes the existing revoke boundary. Raw test output, counterfactual
failure and source excerpts are retained through `evidence.json`.

Scope: service-owned revocation of manual grants and calls not yet dispatched.
This proof does not grant authority to edit grant files, steer a live worker or
recall provider effects. No live grants, accounts, settings or sessions were
touched.
