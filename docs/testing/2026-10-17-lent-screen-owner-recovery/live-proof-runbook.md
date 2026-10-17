# VUH-1803 daytime live proof: lend a screen

This runbook covers the owner-present checks that source and fixture evidence
cannot prove. It is written for the open acceptance items on
[VUH-1803](https://linear.app/vuhlp/issue/VUH-1803): a short task on a lent Mac
and a lent Windows PC with the pet indicator, Stop halting queued input, and a
held lease after an uncertain stop. It also covers the proposed host-local owner
recovery. Run it only with the owner at the lent machine, and only after the
owner authorizes real capture, input and permission changes for that run. No
worker drives the owner's desktop or changes its permissions on its own.

## Before you start

- **The owner is present** at the lent machine for the whole run. They grant
  macOS permissions themselves and can press Stop or take the mouse at any time.
- **Pick the lent machine.** One Mac and one Windows PC. A Mac already running
  its own local Clankie on the default state directory holds the body registry,
  and the join host cannot take it. Use a Mac without a local service, or give
  the join a separate `CLANKIE_STATE` directory.
- **Pick the Clankie side.** The acceptance item names hosted Clankie. Before you
  schedule the run, confirm with clankie-ops that the hosted gateway route for
  joined screens is deployed. That rollout is not in this repository. A
  self-hosted Clankie reached through its own gateway proves the same host
  boundaries, but it does not close the hosted item.
- **Keep secrets out of the evidence.** Keep the join approval CODE, gateway
  credentials and anything typed into sign-in fields out of recordings, logs and
  Linear. Pick a task with no account, payment or sign-in step; those remain
  ADR 0127 person-only stops.
- Each step's **Check** line says what to look for.

## 1. Prepare the Mac helper

From a checkout on the lent Mac:

```sh
mkdir -p libexec
clankie heavy -- xcrun swiftc -swift-version 5 -O -framework AppKit -framework ScreenCaptureKit -framework ApplicationServices -framework Carbon apps/tui/native/lent-screen.swift -o libexec/clankie-screen
```

The owner grants **Screen Recording** and **Input Monitoring** to the helper in
System Settings. **Accessibility** is needed only if input will be allowed.

**Check:** a missing permission makes the session refuse. The helper never opens
a permission prompt on its own.

## 2. Join at screen level

On the lent machine, keep this running in a terminal whose stdin you can type
into. The desktop app's supervised join is the other route.

```sh
clankie join --gateway https://YOUR_GATEWAY --host HOST_ID --directory /approved/workspace --json
```

From the owner's device, approve the printed code at `screen`:

```sh
clankie join approve CODE --access screen --directory /approved/workspace
```

**Check:** stdout prints a `joined` event with `machineId: "join-UUID"`. Write
that ID down.

## 3. Start the recording

The owner starts a screen recording of the lent display, using QuickTime or the
OS recorder. The pet panel is what's being captured, so keep it in frame.

## 4. Short task: Clankie drives, with consent and the pet

In the owner console, ask Clankie to do the task on the lent machine. For
example: "On my lent Mac join-UUID, open the TextEdit document I left in front
and append `hello from Clankie`." He uses `clankie computer request` with that
`machineId`.

**Check, in order:**

- The lent machine shows the local consent dialog. **Observe only** is the
  default. The owner chooses **Allow input**.
- The pet appears and says Clankie is observing or driving, with a Stop button.
- Clankie captures, reads the frame, then sends one text append with
  `foreground: true` and `expect: {field: "document_text", equals: …}`.
- The receipt is `confirmed`, and the text is visible in the document.

**Repeat on Windows** with `apps/tui/native/LentScreen.cs` and
`lent-screen.ps1` from the checkout. The join client starts the helper in the
interactive console session. Windows app packaging is still VUH-1796.

## 5. Stop from the pet halts queued input

1. While Clankie has a fresh capture, have him queue an input. A second request
   behind a slow inventory works.
2. The owner presses **Stop** on the pet before the input runs.

**Check:**

- The queued input gets a 409 and no text arrives.
- `clankie computer request '{"conversationId":"…","machineId":"join-UUID","command":{"action":"status"}}'`
  shows the lease as `recovery_required`.
- `recover` from Clankie's side is refused with `next` pointing at the owner's
  host-local recovery.

## 6. Person takeover

1. Start a bounded drag or scroll.
2. The owner moves the mouse or types during it.

**Check:** the remaining motion is cancelled, the pet shows Clankie stopped, the
lease stays held, and nothing is replayed.

## 7. Owner recovery on the lent host (proposed amendment)

Run this only if James accepts the ADR 0215 amendment and the branch lands.

1. Wait for the held lease to expire. A lease lasts at most five minutes.
2. In the join terminal, type each control as one line:

   ```text
   {"id":"<new UUID>","action":"screen_status"}
   ```

3. Copy `lease.conversationId` and `lease.expiresAt` from the reply, then type:

   ```text
   {"id":"<new UUID>","action":"screen_recover","recovery":{"reason":"I took over; accept unproven native drain","expectedHolder":"<conversationId>","expectedExpiresAt":<expiresAt>}}
   ```

**Check:**

- The reply is `released` with `recovery.kind: "owner_override"` and an
  `auditId`.
- The audit line exists in `<state>/body/lent-screen/computer-recoveries.jsonl`.
  It contains no lease token.
- When Clankie acquires again, the consent dialog appears again. The new helper
  did not carry over the old session's input choice.
- Before expiry, the same command returns `held` with `recovery_not_expired`.
- From Clankie's side, `recover` with `ownerRecovery` is refused.

## 8. Leave

```sh
clankie join leave --json
```

**Check:** the reply is `{ok: true, left: true}`. The owner then revokes any
permissions they granted only for this run.

## Evidence to attach to VUH-1803

- Both recordings, trimmed. They show the dialog, the pet, the typed effect, Stop
  and takeover.
- The computer API receipts: acquire, capture metadata, the input receipt, status
  after Stop, and the refused recover.
- The local `screen` events.
- The audit line. Strip nothing from it except paths that name the owner.
- The exact checkout SHA, the helper build command and output, and whether the
  run was hosted or self-hosted.

Leave the hosted acceptance item open until a hosted Clankie has completed the
task.
