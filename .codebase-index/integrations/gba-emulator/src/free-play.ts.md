# integrations/gba-emulator/src/free-play.ts

The free-play turn loop (`runFreePlay`): a
model, not an algorithm, chooses each action.
Every turn the mind sees the decoded
observations, the rendered frame, its own
notes/objective, refusal memory, and history;
it returns monologue, intent, optional speech,
and one action — validated by
`FreePlayDecisionSchema`.

Actions are the emulator catalog plus two
body actions (`load_checkpoint`,
`restart_game`) dispatched to an injected
`FreePlayCheckpointPort`, never the frozen
adapter catalog. Failure is a turn outcome,
never an exception: `rejected_by_adapter`,
`invalid_decision`, and `mind_failed` are
recorded and the run continues; a rejection's
translated hint (REJECTION_HINTS) becomes the
turn's effect line so a refused action never
reads as a fabricated result. After each
accepted action the loop re-observes and diffs
via `observeEffect`, feeding the progress
tracker.

Speech: an `InterjectionQueue` delivers what
people said at turn boundaries (framed as a
person speaking, never a command); a separate
Voice agent (when wired) decides speak/reply
after the action settles, behind a mechanical
rate gate (cooldown), with volition counters
(offered/taken/suppressed/skipped) and a
`roomAuthors` seam that silences both authors
when a live room composes his speech. The
result reports progress, volition, accepted
count, `longestUnchangedRun`, and `coherence` — a keyword heuristic
(`intentMatchesAction`) comparing stated
intent to the next action, reported and never
gated. `shouldStop` ends an asked session
cleanly at a turn boundary. The loop surfaces
identical action+effect runs after three turns and
samples the framebuffer immediately before action
dispatch so console idling is not misattributed.
