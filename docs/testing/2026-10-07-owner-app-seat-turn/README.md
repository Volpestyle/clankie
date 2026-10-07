# Ordinary owner app turns — VUH-1817

An authenticated owner's app send to a seat-held operator conversation now
arrives as an ordinary native `turn`. The seat answers with normal text in the
same synced conversation. No separate `reply` target is created, eliminating
the route that produced a tool answer followed by another native answer.

The relay already forwards owner-capable sends with their original device
token. Core device authentication supplies host-only owner authority to the
conversation store. The bug was in core's seat event classification: all
non-internal inputs became `escalation`, regardless of their authenticated
principal. Classification now uses host authority, never a client-selected
surface name such as `command-center-mobile`.

The store revalidates owner authority before accepting the message, and native
dispatch revalidates it after attachment preparation. The journal and seat event
carry `ownerOrigin` with the verified device/operator principal and self-reported
surface. Claude channel metadata and Codex native turns retain that distinction.
An admission acknowledgment establishes delivery, not that the model answered;
the existing native transcript synchronization supplies the final answer.

Real room handoffs keep their escalation/reply route, original actor checks and
tool grants. Worker messages remain agent output. This change adds no device
grant, room authority or fallback dispatch after uncertain native delivery.

## Verification

Covering integration exercises the real device signer and owner HTTP route,
conversation store/runner, seat outbox and transcript synchronization. It checks
device/operator ordinary sends, one synced answer, device attribution, spoofed
surface names, worker routing and device revocation before acceptance and native
dispatch. All seven cases passed in 2.48 seconds (170 ms of test execution),
including simultaneous authenticated sends with the same revision: one is
accepted, the other gets a typed revision conflict, and only one is dispatched.
The signed-device HTTP sends and shared conversation projection are real; the
fixture supplies its own head mailbox and transcript rather than a live model
or native pane. Reads use the captain-side route that the relay uses, while
sends preserve the original owner device token.

Three whole protocol/bridge/plugin test files also passed: 36 tests in 2.26
seconds, with no skips. Codex plugin regeneration, scoped formatting and lint
passed. Receipts are retained in ignored `.local/`.

The first landing run found an existing runtime-provider integration expectation
that authenticated owners use the escalation reply tool. It now verifies an
ordinary owner turn and one synced native answer; separate escalation reply and
cancellation coverage remains. The real-captain runtime-provider fixture and
seven owner-route cases passed together: nine tests in 4.27 seconds.

A later landing run exposed a CLI isolation fixture comparing mutable live
owner descriptor bytes across its run. The descriptor disappeared during that
interval; the writer was not identified. The fixture now uses a private parent
HOME sentinel alongside its existing private child descriptor, checking that
both remain unchanged without observing live owner state. All five CLI
integration cases passed in 17.96 seconds.

Final `clankie heavy -- env TURBO_CONCURRENCY=1 pnpm check:landing` passed
against main `829e974b`: formatting, lint, deadcode, documentation checks,
all 29 workspace typechecks, and 642 affected test files / 6,105 tests.
The affected test phase took 338.65 seconds. Its 18 skipped files / 48 skipped
tests are existing suite exclusions; this change introduces no skip or retry.

The app already uses the authenticated device send route and shared response
parser, which tolerates additive response fields. No app send/UI source change
was identified. Updating the core runtime and native seat bridge/instructions is
required before live verification. iPhone and iPad with a live seat remain
unverified by these local integration fixtures; the app lane should perform that
acceptance check. No app build, simulator, live model probe, eval, deploy or
service restart was used for this core change.
