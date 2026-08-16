# docs/adr/0056-voice-is-a-separate-agent-from-the-player.md

Free-play speech becomes its own agent: the
player acts and monologues (holds `io.act`); a
separate Voice agent, with no controller, decides
whether anything is worth saying. Measured
justification: `speak` as an optional field on
the player's call produced 0–1 remarks in 16
turns across four prompt revisions; a dedicated
agent wanted to speak 7 of 16.

Also a safety shape: a message that reaches only
Voice cannot steer the character. Narrowed by
ADR 0074 — while a voice room is listening the
realtime session is the sole author and this
agent serves only the overlay and journal. Read
for the consultation-skip mechanics and the
nullable-not-optional schema gotcha.
