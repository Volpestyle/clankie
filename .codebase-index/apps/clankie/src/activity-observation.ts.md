# apps/clankie/src/activity-observation.ts

Latest-only, memory-only projection of Clankie's
current embodied activity — the present-tense
"what is on his screen" read model for the
captain's `observe_current_activity` tool and
the operator TUI. The append-only play journal
stays the durable record.

`ActivityObservationProjection` implements
`ActivityObservationWritePort`: `publish()`
schema-parses, rejects sequence regression
within a session, and stores/returns defensive
clones; `current()` clones out; `clear(id)` only
erases a matching session so a stale body can
never wipe a newer one.
