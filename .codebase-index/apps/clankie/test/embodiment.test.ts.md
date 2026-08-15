# apps/clankie/test/embodiment.test.ts

`EmbodimentManager` unit tests over a recorded
event list: the full asked lifecycle (submit →
claim → running → stop → stopped), a repeat
start for the environment already playing
answered with the live session, starts refused
while winding down, non-allow verdicts refusing
`policy` (approval-shaped means no), stops with
nothing playing refused, unclaimed and
claimed-then-dead sessions expiring `no_runner`,
wrong-runner reports and illegal transitions
rejected, and identical state rebuilt from
replayed events after restart.
