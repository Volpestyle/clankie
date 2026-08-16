# integrations/gba-emulator/test/free-play.test.ts

The big loop suite: `runFreePlay` with fake
io/minds — turn outcomes (accepted, rejected
with translated hints, invalid decisions,
mind failures that never end the run), notes
and objective carry-over, interjection queue
semantics, the speak rate gate and volition
counters, roomAuthors suppression, checkpoint
body actions with and without a port, stall
signaling, history bounds, and the
`intentMatchesAction` coherence heuristic.
