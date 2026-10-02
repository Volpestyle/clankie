# VUH-1479: play delivery and lazy startup

The producer and consumer agree on the wire schema. They disagreed about
when a delivery attempt exists: both Discord bodies publish ordinary room
input to `startPlayVoiceListener`, while `runPlayOnSurface` connects its
`createBrokeredPlayVoiceClient` only for an actual play session. The listener
was minting `play_transcript_delivery` receipts even with no attached client.

The [recorded receipt sample](recorded-receipts.json) contains content-free
receipts read from the live trail without restarting it. All 421 deliveries
(the audit had counted 418) had zero attached clients and zero deliveries.
Joining their timestamps against the latest embodiment lifecycle event per
session found none during a recorded running or stopping session. This is
an idle-input accounting defect, not evidence of a parsing failure. Prior
successful sessions ended August 30; September 29's join was refused.

The listener now drops idle input without a delivery receipt. Once attached,
actual socket write attempts still report their delivered count. It retains
no room history and does not replay idle input.

The service now starts the play host once on its first join or authenticated
observation. Startup reconciles stale sessions before accepting new work and
runs outside the embodiment mutation queue to avoid deadlock. Passive internal
projections do not wake it. Observation alone never joins a world. Shutdown
continues to use the existing bounded stop path.

Verification:

- Five focused suites passed: 54 tests in 5.86 seconds.
- Service typecheck passed.
- The new one-turn fixture covers both direct HTTP join and observe-before-join:
  service creation and unauthorized observation do not start the host; an
  authenticated request starts it; the production transcript subscription,
  listener, real loopback WebSocket, client, interjection queue and play mind
  deliver the fixture transcript with `attachedCount: 1, deliveredCount: 1`.
  The journal records the same interjection. The world body and mind are
  deterministic test doubles, and transcript wording is synthetic; no model
  provider, live world, live Discord room or service restart is involved.
- A concurrent-start regression proves one reconciliation and poll loop, with
  a stale running session reported `lease_lapsed` before startup resolves.
- Full `pnpm check` was run. The final attempt passed format, lint and
  dead-code checks, then stopped at an unrelated broken link:
  `docs/testing/2026-09-30-claude-hire-routing/README.md` → `check.txt`.
  An earlier attempt passed docs, infra and workspace typecheck, but its
  test process loaded a journal assertion while it was being extended. That
  assertion was corrected from `interjection` to `turn.interjection`; the
  corrected play-voice suite passes all 13 tests. No full-suite pass is claimed.
  See [verification output](verification.txt).

The live service was not restarted. This change is committed locally on main;
no push or deployment was performed.
