# docs/adr/0054-cross-lane-presence-and-episodic-self-memory.md

Fixes cross-lane amnesia without touching the
world-fact fences: `captainSelfState` projects his
open rooms (lanes, voice sessions, body lock,
recent voice stays) into every turn and
`get_self_state`; episodes — self-authored notes
via `remember_episode`, ring of 128 — are a
second trust class beside approved world facts.

Read for the fences: episode lane/target are
stamped by a hook from the trusted channel, never
chosen by the model; `operator_private` episodes
never surface in ambient lanes; recall is an
instruction, not a tool. Amended by ADR 0084,
which lifts the transcript fence in the operator
lane only.
