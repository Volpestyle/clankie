# ADR 0108: The effect line has two readers

Status: accepted (2026-08-16). Amends
[ADR 0074](0074-the-room-hears-one-voice.md): the seam still carries the turn's
effect and never a sentence, but what counts as "the effect" is narrowed to the
observation. Builds on
[ADR 0064](0064-possessor-voice-seam.md) (the possessor supplies the event, the
persona supplies the words) and
[ADR 0099](0099-he-can-look-at-his-own-play.md)'s story card, which reads the
same field.

## Current status (2026-08-19)

The summary/advice split remains current. The audience reader is Clankie's own
`@clankie/play-voice` seam, not an external possessor; GBA MCP receives only its
private runtime's tool results under
[ADR 0129](0129-each-player-owns-a-body.md).

## Context

Every turn of a free-play run ends with one line saying what the action did.
That line was written for one reader — the mind choosing the next press — and it
is written to him, in the second person, with the harness's coaching attached:

- `turned to face north without stepping — hold the direction longer to move`
- `screen changed though the decoded state did not — possibly ambient animation; trust the frame`
- `rejected, nothing ran — this cartridge has no decoded state profile yet — use raw button presses and the visible screen`
- `walked 2 of 37 steps, then a battle started at (23,25) — use advance_dialog to read the intro`

The coaching is the point. Told only "position unchanged", he re-derived a wall
that was not there; told "hold the direction longer", he steps. ADR 0074 kept
that line and gave it a second reader anyway: the possessor seam reports it to a
voice room, where the realtime persona composes the words. The story card
([ADR 0099](0099-he-can-look-at-his-own-play.md)) and the activity overlay
read it too.

A persona handed `use raw button presses and the visible screen` relays it. The
2026-08-16 world run is what surfaced this: in voice he sounded like he was
directing the people listening — telling the room what to press and where to go
— through a game none of them was holding a controller for. Nothing in the
seam, the throttle, or the volition gate was wrong. The string was addressed to
the wrong person, and it had two readers.

ADR 0074 already named the shape of this failure — turn diagnostics "written for
his own next decision" that "read as telemetry out of context" — and answered it
by reporting fewer turns. Filtering _which_ turns cross does not change what
crosses.

## Decision

**An effect is an observation plus, optionally, advice; only the observation has
an audience.**

`ObservedEffect` splits into `summary` (what happened) and `advice` (what to do
about it). Every describer that had been appending coaching to its summary now
returns both halves — the dialog, entry, menu, walk, and rejection vocabularies,
and the rewind port's account of a restored checkpoint.

The mind reads `summary; advice`, unchanged in substance from the single line it
read before. Everything else reads `summary` alone: the possessor seam into a
voice room, the activity overlay, the story card, the stuck-signature key.

The advice is journalled beside the effect as `FreePlayTurn.effectAdvice` rather
than dropped. The trail has to show what he was actually told, and a refusal
whose reason lives only in memory is a refusal nobody can debug afterwards.

The voice briefing states the matching fact in words, because the split removes
the instructions but not the ambiguity of who is playing: he is the only one at
the controls, the room is watching, and there is no move of theirs to direct.

## Consequences

- The room hears his game, in the first person. It cannot hear an imperative the
  harness wrote, because no imperative reaches the seam.
- The single-agent path benefits too: the Voice agent's view of the turn
  ([ADR 0056](0056-voice-is-a-separate-agent-from-the-player.md)) is now the
  observation, so an overlay aside cannot relay coaching either.
- One more field on the journal turn, defaulted so runs written before the split
  keep parsing.
- Every new effect string now carries a question its author must answer: is this
  what happened, or what he should do next? Putting coaching in `summary` is the
  regression to watch for, and it is the one thing the guard in
  `free-play.test.ts` pins.
