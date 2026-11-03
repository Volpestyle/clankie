# ADR 0350: The owner switches Clankie on and off from his app

Status: Proposed, 2026-11-03, from James's ask, relayed by his lead, to switch
Clankie's own main agent on and off from the Clankie iPhone app and see in the
Message Clankie box when he's off. Amends
[ADR 0304](0304-the-owner-hands-the-lead-to-connected-apps.md) and
[ADR 0346](0346-the-fleet-says-who-is-leading.md).

## Context

ADR 0304 made who leads Clankie's lead threads one owner setting, `clankie` or
`apps`, that only the owner's CLI at the Mac could hand back to Clankie. James
handed the lead to the apps on 2026-10-30 and then believed he couldn't reach
Clankie at all. In fact his own messages were still answered. Only Clankie's
unprompted turns had stopped: lead rounds, watches and worker wakes. The phone
could switch him off, but nothing on it could switch him back on, and nothing
on it said which state he was in.

Two gaps showed in the live state. First, a "native worker question resolved
elsewhere" notice is queued with owner authority but is not the owner's words,
and it slipped past the hold: six model turns ran on 2026-11-03 while the
switch was off. Second, the hearth (ADR 0346) lit Clankie's figure for ten
minutes after any turn, so answering James made him look on while he was off.

## Decision

The `clankie`/`apps` setting is Clankie's on/off switch. "On" is `clankie`. "Off"
is `apps`: he still answers the owner's own messages and answers, but takes no
turn of his own.

- **The owner sets it from his app, too.** `lead set` in either direction rides
  the paired-device relay as an owner op on the device's own signed identity
  (`deviceDispatch`), like turning unprompted work back on (ADR 0264). The relay
  requires the Take Control grant. The service accepts it only from this
  machine's operator or the owner's own active Take Control device, and rechecks
  that authority at the write, as the CLI path does. An app signed in to the
  connector holds Take Control grants too, but never sets the switch: the
  connector allowlist refuses it at the relay, and the service refuses
  connector-scope devices. A captain bearer, worker or Discord actor sets it in
  neither direction. This is narrower than ADR 0304, which let a captain bearer
  hand the lead to the apps.
- **Status says on, off or can't start.** Lead `status` and `set` results carry
  `status.clankie = { state, reason?, message? }`. `state` is `on`, `off`, or
  `cant_start` when the switch is on but his own model can't run. The reason
  comes only from Clankie's own model readiness, the check `clankie doctor`
  reports as `captain` (`no_model`, `no_credential`, or `unavailable` when it
  couldn't be read). A worker harness account never decides it. While off, a
  model that can't run still carries its reason, so the app can say so before
  he's turned on.
- **Off runs only what the owner verifiably sent.** While off, a turn in a
  global or workspace lead thread runs only when it is published input whose
  owner proof is still current: question authority (this machine's operator or
  a Take Control device, including his answers), or a host-verified sender. A
  sender is a guarded linked owner channel, or a paired phone that relays its
  message on the captain route with its own session token beside it
  (`x-clankie-sender-device-session`). The service verifies that token itself,
  as it would any device bearer, and accepts only an active, owner-paired,
  non-connector device with the chat grant. That proof is never question or
  machine authority. Everything else is held: his own wakes and watches,
  notices that carry owner authority but are not the owner's words (a worker
  question resolved elsewhere), and any send with no verified owner proof,
  such as one on the bare captain bearer or from a worker or connector app.
  Whether off should also stop the owner's own messages is one condition,
  `ownerSent` in `LeadStore.holdsTurn`.
- **Turning him on spends nothing by itself.** Setting `clankie` flips the
  setting only. Held turns stay in `lead-held.json` for the apps and are not
  replayed.
- **The hearth follows the switch.** `/v1/fleet/leads` shows Clankie active
  exactly when the switch is on. A turn he takes while off (answering the owner)
  updates `lastActiveAt` but never lights his figure.

## Consequences

- The app needs no new route: it reads `op: "lead"` `status` and sends `set`
  through the existing relay dispatch, then renders `status.clankie`.
- The CLI path is unchanged: `clankie connector lead [clankie|apps]` still uses
  the operator credential.
- A notice the hold now catches is listed in the apps' inbox with origin
  `message`.
