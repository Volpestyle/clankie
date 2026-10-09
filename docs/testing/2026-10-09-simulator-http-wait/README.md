# Simulator HTTP waits retain their FIFO ticket (VUH-1959)

The CLI previously bounded an hour-long simulator acquire with an AbortSignal
at wait + 60 seconds, but used the global fetch dispatcher's independent
300-second headers timeout. A fetch transport timeout disconnected the HTTP
request; the simulator manager then explicitly deleted its persisted ticket.
The worker saw only `fetch failed` and lost its original FIFO position.

Blocking acquire now supplies a request-scoped undici Agent whose headers and
body timeouts cover the requested wait plus the response budget. The Agent is
destroyed after consuming the response or an error. No process-global transport
policy changes, acquire retries or repeated CLI calls are needed.
Undici documents the independent 300-second defaults in its
[Client options](https://undici.nodejs.org/api/Client).

A disconnected or aborted wait stops waiting and preserves its ticket until the
existing five-minute stale deadline. It admits no further device effects through
that wait. Explicit holder cancellation, dead-owner expiry and revoked authority
remain enforced. The holder can inspect resources and resume the same selection
with `ticketId`. An admitted boot/lease remains owned as before. Transport errors
name the native code/type, retain their error cause, and distinguish malformed
JSON from a failed response-body transport.

## Real HTTP acceptance

The regression case in `fleet-resource-routes.integration.test.ts` uses the real
Hono HTTP server, real undici transport timers, real private governor journal and
live native seat process. Only CoreSimulator is replaced by the existing
file-backed subprocess fixture; it never boots a real device or reserves a live
fleet slot.

It holds one device, forces a 1,000-ms headers timeout in the first wait, checks
the named `UND_ERR_HEADERS_TIMEOUT: HeadersTimeoutError`, and retains the ticket's
ID, creation time and first position. A later holder takes position two. The CLI
resumes its original ticket using its own dispatcher and stays open while another
real HTTP wait exceeds the shortened deadline. Releasing the first lease grants
the original waiter, through exactly one acquire POST; the later holder waits and
then receives that same device in FIFO order. No mocked timer or fixed sleep
stands in for the transport timeout.

The first focused run passed 64 of 65 cases across the simulator manager, resource
routes and CLI files. The new real-HTTP case passed in 15.341 seconds. The one
failure was the existing stalled-doctor elapsed-time assertion (8.133 seconds
versus its 6.5-second bound); the post-run machine load/core was 7.744, above
the fleet guard of 1.5. This is evidence of load during the run, not proof of
the assertion's cause. The unchanged case then passed in isolation (5.300 seconds for fixture setup,
checks and teardown); nine other cases were not selected. No assertion or
timeout was widened. Verification results and raw logs are published in this
case's canonical `evidence.json`. The requested hour-long timeout policy is
verified with a shortened real transport deadline; no hour-long live wait or
simulator capture is claimed. Deployment remains held by the owner canary decision.

## Root gate on 29e57808

**Full-gate result:** checked head `78f436a0`, fixed base `29e57808`, source
stable, exit 1. Formatting, lint, deadcode, documentation/evidence checks and
all 31 typechecks passed. Tests bailed after 1,340 passes, one failure and
23 existing skips. The unchanged worker-bridge-health case
`keeps mailbox recovery for 503 'service_shutting_down'` failed during initial
catalog discovery at its 250-ms fixture request budget. The post-run load/core
was 11.28; that observation does not prove the failure's cause.

**Isolated passes:** the exact failed bridge case passed on unchanged source
(3.220 seconds including fixture lifecycle); 16 other cases were not selected.
The preceding root attempt was interrupted during lint when main advanced;
it supplies no acceptance. No assertion, timeout or selection was weakened.

The combined canonical proof
`clankie://evidence/sha256/d49f4d77378622b38c1875faf086edbe44174cac6a527f32f63e2f5c0a6b59d6`
retains the actual nonzero gate, exact failure, isolated results and load sample.
A timing-exception landing requires lead acceptance. This result is not a
green root gate or a live deployment.
