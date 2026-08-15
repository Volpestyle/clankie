# docs/adr/0075-rewinding-is-a-play-choice.md

Owner ruling: restarting or loading a save is
part of playing. The free-play decision gains
loop-owned `load_checkpoint` (absent id = list)
and `restart_game`, dispatched to an injected
`FreePlayCheckpointPort` — outside the frozen
emulator catalog, refusing truthfully when
uncomposed.

Read for the safety shape: every rewind banks a
`before-rewind` checkpoint first (verified-refusal
loads mint nothing), the world rewinds but his
notes/objective/refusal memory do not, load gates
(`readGbaCheckpoint`) are unchanged, and the
prompt never suggests rewinding — it is volition.
External stops and the body lock are untouched.
