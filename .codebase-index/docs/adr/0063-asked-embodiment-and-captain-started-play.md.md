# docs/adr/0063-asked-embodiment-and-captain-started-play.md

"Hop in vc and play pokemon" reaches the body:
the captain gains `start_play` / `stop_play`
tools; the intent is recorded centrally, claimed
by the process that owns the body (poll, no new
transport), and lifecycle events flow back into a
bounded tool wait so his reply reflects reality.

Read for the ownership split: only the body-owning
host boots the emulator (the captain process never
imports it); the cross-process body lock stays
the mutex, and any collision returns a typed
`body_held` he can say out loud; play
start/stop are reversible-write ambient-allowed
actions; the owner's default is no session budget
cap — the stop ask, the lock, and lease-lapse
pause are the standing controls. Sessions resume
the newest checkpoint and mint one on stop.
