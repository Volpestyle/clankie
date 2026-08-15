# ADR 0092: A repeat that changes nothing is something he should know

Status: proposed (2026-08-15). Extends
[ADR 0072](0072-the-harness-tells-him-the-truth.md) (the harness reports what
it knows, in the line he reads) inside the agency bounds
[ADR 0049](0049-free-play-agency-and-non-deterministic-evidence.md) set.

## Context

The loop keeps two signals for "getting nowhere", and both are blind in the
same place.

- `refusedHere` lists directions already refused **from this tile**.
- `stalledForTurns` counts turns since a new tile, and is deliberately
  suppressed when he has no position — `positionOf(observations) !== null`
  gates it, because mid-battle and mid-warp the tile counter stalls for
  reasons that need no telling.

So every wedge that happens off the overworld is invisible to the harness: a
battle whose Run keeps refusing, a menu whose cursor will not move, a script
that holds the screen. The GBA run-escape wedge was exactly this shape — one
action refused identically, chosen again, for as long as the session lasted —
and no counter the loop kept ever rose. The competence benchmark's
`longestRepeatedInputRun` does see repeats, but it counts identical _accepted_
actions whatever they did, is computed post-hoc for scoring, and never reaches
the running loop.

Meanwhile the diagnosis workflow for "he's stuck" is a human reading the play
journal for turn gaps. The harness knew, turn by turn, and said nothing.

## Decision

The loop tracks consecutive turns whose **action and observed effect were both
identical**, and reports the count in the view once it reaches
`FREE_PLAY_REPEAT_TURNS` (3):

> The last N turns were the same action with the same result.

Identical action _and_ identical effect is what makes this state-independent
and low-noise. A different effect means something moved — walking a corridor
repeats the action every turn and reports a new tile each time, so it never
fires. A different action means he tried something else. Refused turns count:
the failure this exists for is an action refused the same way forever, and a
rejection's line is its effect (ADR 0072). Turns that never reached an action
— the model errored, its decision did not parse — leave the counter untouched
rather than resetting it, because a transient failure inside a wedge is not
evidence the wedge broke.

It is a fact, not an intervention. No forced action, no interrupt, no cap: a
script that needs more time and a wedge look identical from here, and telling
them apart is the player's read (ADR 0049). This is the deliberate departure
from the prior art it was cribbed from — opencode's doom-loop detector raises
a permission prompt on three byte-identical tool calls, which works because a
human is sitting there. Nobody is sitting in a playthrough.

The longest such run in a session lands in the result, the journal summary,
and the finished-playthrough log line as `longestUnchangedRun`, so "was he
wedged, and for how long" is a number rather than a shape someone has to
notice by reading the whole journal. It is named apart from the benchmark's
`longestRepeatedInputRun` because they measure different things.

## Consequences

- Every wedge state is now visible to him and to us, including the ones with
  no position: battles, menus, naming screens, script holds.
- Whether the signal changes his behavior is now measurable — compare
  `longestUnchangedRun` across sessions the way the volition suppression count
  measures whether the speak gate binds. If long runs persist after he is
  told, the next step is a decision about escalation (a forced re-plan, a
  bounded intervention), and that is James's call to make on evidence rather
  than a mechanism to add on speculation.
- Three is a judgement about noise, not a proof. It is one constant with its
  reasoning written down, tunable if measured play says otherwise.
