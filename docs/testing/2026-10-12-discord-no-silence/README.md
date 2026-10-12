# VUH-2142: Discord no-silence and recovery counters

Tracks: https://linear.app/vuhlp/issue/VUH-2142

The remaining acceptance uses an isolated loopback proof, per Clankie's lead
instruction on 2026-10-12. No live Discord posts, channels, credential changes,
or installed-service restarts were performed. Live room proof is pending a test
room James designates; Clankie handles deployment after landing.

## Proof

`apps/discord-bridge/test/room-recovery.integration.test.ts` runs real Pi against
a loopback model HTTP server, the service HTTP routes, discord.js REST against
a loopback Discord server, SQLite inboxes, durable turn/write receipts, and the
body lease registry. It forces the model down, restores it, and answers a fresh
message after restoration. Its fixture inbox restarts do not restart the live
service.

- A failed accepted request retries once and posts its saved answer once.
- Exhausted model retries produce one confirmed short resend notice, retained
  across fixture inbox restarts.
- Legacy `done=1` deliveries with a NULL or `{}` request and a failed ingress
  receipt reopen, post one resend notice each, and run no additional model turn.
  Upgrading an already seeded v2 inbox and reseeding v3 are covered.
- A real owner-directed `room_turn` reads loopback channel metadata and refuses
  the public audience. Caller summaries, including an already structured result,
  carry `discord_owner_audience_required`; the service logs the same cause.
- The authenticated rooms HTTP endpoint reports failed=1 after failure, then
  failed=0, unrecoveredFailed=0 and pending=0 after recovery. Bridge observation
  reports are deliberately omitted, proving durable service outcomes repair the
  counters. Reopening durable receipts reconstructs the same final counts.
- A lost Discord acknowledgement is reconciled from history without another
  post or model run. Unavailable history, changed targets and stale live claims
  retain the existing refusals. Confirmed reconciliation permits the existing
  mouth recovery, restoring the fixture before the next message.

`proof-bundle.json` contains the inspected final room counters, exact notice counts,
caller cause, restoration flag and loopback Discord posts. Its `logs.proof-run.log`
contains the focused run and real service logs. The final focused selection is
four files / 47 tests. Service and Discord bridge typecheck results and scoped
format/lint logs and the tested candidate diff are retained in the same bundle.
The service compiler run predates the final reason-only polish; the final focused
run covers that correction and the integrator owns the final-tree compiler gate.

## Landing

The worker submits its source through `clankie integrate SHA --push`. The queue
owns the exact-tree root landing gate and push. Integration outcome and its
receipt belong in the issue comment; this README does not claim deployment or
live-room validation.
