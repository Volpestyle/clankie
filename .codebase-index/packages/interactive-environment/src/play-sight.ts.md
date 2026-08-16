# packages/interactive-environment/src/play-sight.ts

Pull-on-demand read contracts for Clankie's own
live play (ADR 0099), separate from the digest-
only activity snapshot.

- `PlayStillReadSchema` at `PLAY_STILL_PATH` —
  `not_playing`, `pending`, or one bounded PNG
  still with dimensions, capture time, and
  SHA-256.
- `PlayStoryReadSchema` at `PLAY_STORY_PATH` —
  `not_playing`, `pending`, or a story card with
  session/environment/scenario identity,
  objective, turns, up to 16 maps, and the last
  eight notable moments.

Both version-1 schemas are strict read models.
They expose neither commands nor the raw play
journal.
