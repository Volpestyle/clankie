# Worker channel restart during an acknowledgment

Tracks [VUH-2944](https://linear.app/vuhlp/issue/VUH-2944).

## Read-only diagnosis

The two PC Claude processes both loaded `clankie-worker@clankie` with
`--channels plugin:clankie-worker@clankie` and equivalent plugin settings. Kit's
session ran Claude 2.1.311; the affected session ran 2.1.312. Both reported worker
plugin 0.6.19 and the same current runtime revision. These observations do not
establish that their originally loaded plugin bytes were identical.

The affected session's last channel notification was a sender report receipt at
17:31:10.546Z. Service shutdown began at 17:31:10.899Z. That receipt has no durable
sender acknowledgment. The preceding real channel message was durably ACKed at
17:31:10.214Z. The replacement PC link was published at 17:31:24.213Z.

The bridge's `acknowledge` loop did not refresh its link and abandoned retries
after 20 seconds. `poll` then returned permanently on `receiptUnresolved`, leaving
`started=true`. Tools and outbound reports kept running independently. In contrast,
an ordinary parked poll retried after the restart. The service clears its in-memory
worker mailboxes at shutdown; the next authenticated native poll binds them again.
It cannot revive an old client loop that has exited. Bridge stderr was unavailable,
so the exact final HTTP error is inferred from this path, not directly observed.

No seat was messaged, typed into, relaunched or interrupted for diagnosis. The PC
was accessed through read-only SSH. The live service was never restarted.

## Automated proof

```sh
clankie heavy -- pnpm exec vitest run apps/clankie/test/worker-channel-restart.integration.test.ts
```

The proof bundles real service HTTP routes, mailbox fences and report stores into
a disposable Node process. Only native process admission is substituted. Two real
stdio bridge subprocesses share a scratch HOME and link descriptor. The proof
crashes only its own exact runtime PID while one bridge is ACKing a sender receipt,
then starts a new runtime with the same stores and a new listener/link. It covers
an ACK interrupted before commit and a committed ACK whose reply was lost.

The original bridge fails both cases: Kit binds, Sable stays unbound. The fixed
bridge must bind both within 10 seconds of link publication, deliver a subsequent
message to each, acknowledge the original receipt and remaining page, preserve
both bridge PIDs, emit every channel notification exactly once, and accept an
outbound report. A one-second request budget and 2.5-second outage exercise expiry
of the original ACK deadline without a twenty-second sleep. Children receive a
whitelisted environment, scratch HOME/USERPROFILE/XDG roots and `NODE_ENV=test`;
there is no real Claude, Herdr, SSH, owner tracker or live service in this proof.

The roster integration additionally checks that an older remote bridge with no
live receiver gets a pane-local reload instruction, that 0.6.21 does not get that
legacy instruction, and that the instruction disappears when a native poll binds.

The focused bridge run passed **25/25 tests** (the two crash windows and 23
existing bridge-health cases). The parent-routing file passed **50/50**, including
both roster diagnostic cases. The original-code crash proof failed **2/2** at
`{sable: false, kit: true}`, rather than the required two live receivers.

Raw check output is published through the adjacent evidence manifest. Early
fixture startup/assertion corrections are not product regressions; `baseline.log`
records the decisive original-code failure at the two-seat rebind assertion.

## Lead-owned live proof at a scheduled deploy (not run by the builder)

1. Deploy the landed runtime and worker 0.6.21 through the normal release route.
   Launch a **new, disposable PC Claude seat after that deploy**, with its approved
   channel. Use that seat only; do not use Kit or the already-stopped old seat.
   Record the new seat/session/native PID, birth, cwd, plugin version and
   `messageReceiver.state=live` from the roster and read-only process observation.
2. Give the new seat a short task through `message_seat`, asking it to send one
   report and continue working. Offer that report through `worker_reports`
   (without claiming model consumption). Keep the proof page to at most three
   sender-receipt ACKs. Start bounded, read-only observation of that session's
   channel transcript and the report's durable `senderEventAcks`.
3. Call `message_seat({seat: PROOF_SEAT, message: "VUH-2944 before restart NONCE"})`
   once to carry the sender receipts. At the scheduled restart, capture a
   notification whose exact `event_id` is present in the native transcript while
   its corresponding ACK is still pending. **The lead alone performs the normal
   service restart.** Keep the event ID, notification time, shutdown time and
   pre-shutdown receipt state. Do not resend an uncertain original.
4. Start the recovery clock when the replacement `fleet pc: link ready` event is
   logged and native admission is available. Observe the same seat/PID rebind to
   `messageReceiver.state=live` within **90 seconds**. This bounds the stale ACK
   request (10s), retry delay (2s), up to three successful ACK requests (30s), and
   a fresh poll request (35s), with scheduling margin. Outage time before link
   publication/admission recovery is recorded separately, not hidden in the bound.
5. Call `message_seat({seat: PROOF_SEAT, message: "VUH-2944 after restart NONCE; report this nonce once"})`
   once. Retain its exact delivered receipt and the seat's `message_clankie` report
   containing the nonce. Confirm the original notification appears only once,
   the pending ACK reconciled, and the Claude/bridge processes were not relaunched.
6. Attach the timestamps, IDs, delivery/report receipts, loaded plugin/runtime
   revisions and elapsed recovery time to VUH-2944. If shutdown missed the pending
   ACK window, label the attempt **inconclusive for the crash window**; ordinary
   restart recovery alone does not prove this fix. Do not restart live work again
   merely to improve the evidence. A still-uncertain original stays uncertain.

Old bridge recovery is intentionally owner-facing: the roster says to reload the
plugin in that pane (`/reload-plugins`). Updated files and another service restart
cannot replace already-loaded old code. No automated relaunch or terminal typing
is added. The live proof and issue closure remain with the lead.
