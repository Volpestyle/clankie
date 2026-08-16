# docs/adr/0094-a-render-that-outlives-the-turn-comes-back-to-the-room.md

Slow video renders are remembered against the
originating room after a one-shot turn ends. The
next turn in that room checks outstanding work and
adds a trusted ready/failed notice; collecting via
the existing `generate_video(requestId)` path
captures and attaches the result.

There is no background poller or unprompted send —
the turn is the clock. Records are room-scoped and
in memory, with bounded check/mention windows; a
quiet room receives nothing until somebody speaks.
