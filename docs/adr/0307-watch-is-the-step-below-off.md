# ADR 0307: Watch is the step below Off

Status: Accepted, 2026-10-31, on James's word approving the plan to make
Watch a level below Off and setup three steps ("yes we can use this order").
Builds on [ADR 0263](0263-one-autonomy-dial-over-the-decision-leaves.md) and
[ADR 0244](0244-machines-join-clankie-at-an-access-level.md).

## Context

The owner wants Clankie on a work laptop only to see his Herdr session and
his workers: no tracker writes, no autonomous action, nothing sent to a model
provider, and no model to set up first. Off is not that. Off sends every
decision to the owner, but Clankie still thinks, answers chat, takes wakes,
hires when asked, messages workers and writes to trackers.

Reading needs no model already. The service starts without one, and the
fleet, roster, presence, agent-session, machine, body-lease, feed and
appearance reads all work without a captain turn.

## Decision

**Watch** sits below Off on the one dial: Watch, Off, Low, High, Full. While
Clankie watches, he reads sessions and transcripts and shows them, and he
changes nothing.

- **Stored beside the leaves.** `autonomy.watch: true` in settings, present
  only while on. Choosing Watch also writes Off's leaves and records
  `autonomyConfirmedAt`, so a client that predates Watch reads Off.
- **One API.** `POST /v1/operator/fleet-settings` takes `changes.watch`.
  `true` turns Watch on. Any `changes.autonomyLevel` leaves Watch, so an older
  client's next level choice moves him up, as the dial does. `false` leaves
  Watch and keeps the leaves. Snapshots carry `watch` only on the opt-in read
  `?includeWatch=true`: the snapshot schema is strict, and an app that
  predates Watch would refuse a snapshot with a key it does not know. A
  snapshot without `watch` on that read comes from a service that cannot
  watch. While Watch is on it joins the snapshot revision, so a client that
  read Off before Watch was chosen gets a conflict instead of leaving it.
- **Every surface.** `clankie autonomy watch` and `/autonomy watch` set it,
  and status reports `level: "watch"`. The app shows Watch below Off.
- **Global.** Project overrides cannot lift it. Every refusal is checked when
  the write would happen, not when it was scheduled, so turning Watch on stops
  work already queued.

### What Watch refuses

- **Model turns.** The captain's model runtime refuses before choosing a
  model, so chat, wakes, routines, Auto rounds, Discord and Linear turns reach
  no provider. Each session also asks again before every request it sends, so
  a turn already running when Watch starts stops at its next tool result,
  retry or steered message. A session waiting to be compacted keeps waiting:
  compaction sends its history to a model. A message for a native lead's seat is
  refused before it goes in, since that harness sends it to its own model. Chat
  says Clankie is only watching.
- **Machines act at Portal.** Machine access treats every machine as Portal
  (ADR 0244), so hires, moves, deliveries into a worker, question answers,
  lead launches and anything else above Portal are refused. That holds on
  joined machines too, for Clankie's own hires and for a joined lead's hires and
  messages to its workers; the lead and its workers stay bound for when Watch
  ends. These refusals leave no doctor item: the fix is the dial, not the
  machine.
- **Wakes and alerts.** No wake reaches a lead, native or service, and no
  health alert is sent into a seat.
- **Restarts and tidying.** Lead relaunches (fresh restart, failover,
  failback), hired-seat restarts, auto-tidy closes and worktree prunes, the
  operator's close, and the evaluator all stop. A prune asked for by name
  through the service is refused too, before any tree is touched, and a close
  already under way asks again right before the worker exits. The evaluator
  asks again before each pane it closes, opens or starts, and an assessment it
  had not yet sent stays queued.
- **Connected apps.** A connected app cannot answer a prompt in a worker's
  pane.
- **Trackers.** No tracker write by Clankie, a lead or a worker goes through
  him, outward, to the built-in tracker or to a repo's private issue files.
  That covers `clankie work`, tracker calls with or without a repository,
  saved views, and the automatic notes a hire's issue gets when the hire
  exits. Nothing is held
  for later either.
  The owner's own writes (`clankie work owner`, or a post he approves) are
  his. A post held for Clankie before Watch was chosen keeps waiting; only the
  owner can let it out meanwhile. The Discord forum view binds no forum, so it copies nothing into the
  tracker. A change made meanwhile reaches the forum the next time its issue
  changes.
- **Auto.** Auto rounds do not run. The Auto switch keeps its saved value.

### What still works

- Every read: the fleet, sessions, transcripts, the feed and the pet.
- Stop. Interrupting a worker that is running is never blocked.
- Settings, including leaving Watch.
- The owner typing in his own Herdr panes, which is his and never passes
  through Clankie.

## Consequences

- Watch with no model is the base of the three-step setup: install, pick the
  Herdr session, watch. The model, Linear and Discord come later from
  Settings.
- Watch does not cover game bodies, media generation or voice. They start
  only on the owner's own command, and each uses a model he set up for it.
  A voice handoff to the captain is a turn, so Watch refuses it.
- A future write path must check Watch too. Most will inherit it through
  machine access or the captain's model runtime.
