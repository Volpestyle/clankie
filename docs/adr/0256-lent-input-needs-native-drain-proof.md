# ADR 0256: Lent input needs native drain proof

Status: Accepted (2026-10-08), VUH-1840. Extends ADR 0255 and ADR 0199.

## Decision

The lent host accepts one bounded key, drag or scroll primitive through the
existing computer API and CLI. Host-local session consent and input opt-in,
the original join ceiling, fresh live screen policy, exact target/fresh frame,
explicit foreground choice and an exact changed accessibility field still apply.
There is no new input-enable setting or approval route.

Keys are a small named navigation/editing allowlist, never a command string or
arbitrary modifier chord. Drag points and scroll anchors remain inside the
captured window, with bounded event count and duration. Every effect rechecks
consent, policy, target, permissions and person takeover after each wait.

The host owns a native event observer and tags each authored event with a fresh
process/session-local identity. Only the exact expected native event can acknowledge
that pending identity. This is not target-queue drain proof. Foreign input fences driving immediately; observer loss,
missing/partial delivery, unexpected acknowledgment or timeout makes drain proof
unknown. The observer never grants consent and never absorbs person input into
an updated baseline. Both native UI loops remain available during input waits.

Stop first fences new and queued input. An active sequence cancels remaining
events and releases only its own held key/button; that cleanup also needs native
acknowledgment. After any attempted native effect, the parent and native helper permanently
withhold release for that session, even after all observer acknowledgments.
Only an untouched session can release with the same bound helper/session, no
active input, no pending native events, no held key/button and a healthy observer. A helper
restart or process exit cannot attest to an earlier session. AX/UIA calls likewise cannot prove an asynchronous provider is drained.
True native queue drain remains an explicit VUH-1840 gap; James accepted this
bounded landing on 2026-10-08. No app-cooperative drain mechanism is added.

An observed event establishes observer acknowledgment, not target-queue drain
or application completion.
A confirmed action additionally requires the exact changed accessibility field.
Uncertain effect receipts are never replayed. Missing drain evidence stays held;
the code never converts a timeout, process death or an effect receipt into proof.

## Verification and live gaps

Compile the authored Mac and Windows helpers only; execute no native helper,
permission request, capture or input. Real HTTP/encrypted join/receiver/journal
checks use an explicitly synthetic subprocess to prove event cancellation,
acknowledgment/session refusal, no replay and held recovery.

Native delivery ordering, actual key/drag/scroll effects, pet Stop and person
takeover on a real Mac and Windows PC remain owner-present live acceptance,
including the open VUH-1803 task. Compile and synthetic evidence cannot establish
native readiness. Hosted routing/rollout remains separate private work.
